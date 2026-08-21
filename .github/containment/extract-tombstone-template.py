#!/usr/bin/env python3
# ============================================================================
# extract-tombstone-template.py — read the refusal-shim ("tombstone") contract
# OUT of supabase/migrations instead of keeping a copy of it that can drift.
#
# WHAT CHANGED IN ROUND 3, AND WHY
# --------------------------------
# The previous version derived the contract from ONE PLACE: migration 0022
# section 5's `do $$ ... $$;` loop. That loop is one MECHANISM for producing a
# tombstone, not the definition of one. Migration 0022 also tombstones
# `public.resolve_create_operation(uuid,uuid)` INLINE, with a different message
# and a different security mode, sixty lines above the loop; and migration 0017
# turns `reconcile_cash_flow_mirror` and `replace_equity_snapshots` into the
# same kind of hard failure. None of those three was in the derived set, so
# none of them carried an expectation row, so granting EXECUTE on one of them
# to `anon` — or reviving it to its original SECURITY DEFINER body — produced a
# clean PASS.
#
# A section-scoped derivation reports itself whole. So this file now scans the
# WHOLE MIGRATION SET, finds every refusal shim by its MECHANISM, and takes the
# UNION, with a per-mechanism non-vacuity floor:
#
#   mechanism `inline`    a top-level `create [or replace] function` whose body
#                         — with comments stripped — is nothing but
#                         `begin raise exception <literals> [using errcode=..];
#                         end;` and whose message says `superseded`.
#   mechanism `template`  a top-level `do $$ ... $$;` block that builds exactly
#                         that shape with format() from a `$fn$ ... $fn$`
#                         template, over a `p.proname in ( ... )` name list.
#
# Each mechanism must yield at least one target, and the scan must span at
# least two migration files, or the extraction FAILS. "The union is complete"
# is then a checked claim about a scan that has been shown to be non-vacuous in
# both of its arms, rather than a property of whichever arm was written first.
#
# TWO FALSE POSITIVES THIS PARSER IS BUILT TO AVOID (both were hit for real)
# -------------------------------------------------------------------------
#   1. `is superseded` matched inside a COMMENT. Every match below runs against
#      a copy in which `--` and (nestable) `/* */` comments outside string and
#      dollar-quoted literals have been blanked — offsets preserved, so slicing
#      still lines up with the original text.
#   2. A body sliced "to the start of the next thing I recognise" absorbed the
#      following `do $$ ... $$` block and attributed ITS format() string to the
#      preceding function. Every body here is bounded by its OWN dollar-quote
#      terminator, found by matching the exact opening tag.
#
# A THIRD, RELATED TRAP: `finish_account_verification` contains
# `raise exception 'verification token % was superseded by a later
# verification'` in the middle of a long live body. It is not a tombstone, and
# the shape test rejects it because the WHOLE body must be the raise.
#
# THE 0022 NAME LIST IS STILL EXTRACTED TWICE.
# Migration 0022 states which routines its LOOP tombstones in section 5 and
# again in section 6 (the post-condition asserting none of them is executable).
# Both lists are parsed independently and required to be EQUAL. That
# cross-check applies to the `template` mechanism only — section 6 does not
# know about the inline tombstone — and the extractor says so rather than
# quietly widening the claim.
#
# Output: shell-quoted `KEY=value` assignments on stdout, for `eval`/`source`.
#
# Usage: extract-tombstone-template.py [--emit-tombstone-do FILE] <migrations-dir>
# Exit:  0 ok, 2 the migration set does not contain the expected contract
# ============================================================================
import hashlib
import json
import os
import re
import shlex
import sys

EXIT_BAD = 2

# The phrase that identifies migration 0022 section 5's DO block, and the word
# every refusal shim's message must contain. If this stops matching, the
# extractor fails rather than silently producing an empty expectation.
MARKER = "is superseded and must not be called"
SUPERSEDED = "superseded"

# A single-quoted SQL literal, with '' as the embedded-quote escape.
LITERAL = r"'(?:[^']|'')*'"

# The whole-body shape a refusal shim must have. Anchored at both ends: a body
# that raises AND does something else is not a shim, and must not be invoked by
# the classifier's privileged probe.
SHIM_BODY_RE = re.compile(
    r"^begin\s+raise\s+exception\s+"
    r"(?P<msg>" + LITERAL + r"(?:\s+" + LITERAL + r")*)"
    r"(?:\s+using\s+errcode\s*=\s*(?P<errcode>" + LITERAL + r"))?"
    r"\s*;\s*end\s*;?$",
    re.I | re.S,
)


def die(msg):
    sys.stderr.write("extract-tombstone-template: %s\n" % msg)
    sys.exit(EXIT_BAD)


# ---------------------------------------------------------------------------
# lexing: blank comments, remember literal spans
# ---------------------------------------------------------------------------
def lex(src):
    """Return (blanked, literal_spans).

    `blanked` is `src` with every SQL comment that is NOT inside a string or
    dollar-quoted literal replaced by spaces, character for character, so every
    offset in `blanked` is the same offset in `src`.

    `literal_spans` is the sorted list of [start, end) spans occupied by string
    and dollar-quoted literals, so a later scan can refuse to match inside one.
    """
    out = list(src)
    spans = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "'":
            j = i + 1
            while j < n:
                if src[j] == "'":
                    if j + 1 < n and src[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            spans.append((i, j))
            i = j
            continue
        if c == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", src[i:])
            if m:
                tag = m.group(0)
                close = src.find(tag, i + len(tag))
                j = n if close < 0 else close + len(tag)
                spans.append((i, j))
                i = j
                continue
        if src.startswith("--", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if src.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth > 0:
                if src.startswith("/*", j):
                    depth += 1
                    j += 2
                elif src.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out), spans


def in_span(pos, spans):
    for a, b in spans:
        if a <= pos < b:
            return True
        if a > pos:
            return False
    return False


def strip_comments(text):
    """Comment-blanked copy of a standalone fragment (e.g. a function body)."""
    blanked, _ = lex(text)
    return blanked


def norm(text):
    return re.sub(r"\s+", " ", text).strip()


def unquote_sql(lit):
    return lit[1:-1].replace("''", "'")


def concat_literals(msg_blob):
    """PostgreSQL concatenates adjacent string constants. Do the same."""
    return "".join(unquote_sql(m.group(0))
                   for m in re.finditer(LITERAL, msg_blob))


def ere_escape(text):
    """Escape only what is special to a POSIX ERE. re.escape also escapes
    whitespace for re.VERBOSE, and `\\ ` is not portable across PostgreSQL's
    ARE dialect."""
    return re.sub(r"([\\.^$*+?()\[\]{}|])", r"\\\1", text)


def body_shape(body):
    """Turn a normalised body into a `raise and nothing else` regex by making
    every single-quoted literal a wildcard. A body matching this shape cannot
    mutate anything, so the classifier is willing to invoke it even when the
    message or the SQLSTATE is wrong — which is exactly the case that has to
    reach the probe."""
    parts = norm(body).split("'")
    if len(parts) % 2 != 1:
        die("unbalanced single quotes in the normalised shim body")
    bits = []
    for i, part in enumerate(parts):
        bits.append(ere_escape(part) if i % 2 == 0 else "'[^']*'")
    return "^" + "".join(bits) + "$"


# ---------------------------------------------------------------------------
# parsing one `create [or replace] function` statement
# ---------------------------------------------------------------------------
CREATE_RE = re.compile(
    r"\bcreate\s+(?:or\s+replace\s+)?function\s+"
    r"(?:(?P<nsp>[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*|%s)\s*\(",
    re.I,
)


def match_parens(blanked, spans, open_idx):
    depth, i, n = 0, open_idx, len(blanked)
    while i < n:
        if not in_span(i, spans):
            if blanked[i] == "(":
                depth += 1
            elif blanked[i] == ")":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def split_top_level(text):
    out, depth, cur = [], 0, []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        out.append("".join(cur))
    return [p.strip() for p in out if p.strip()]


ARGMODE_RE = re.compile(r"^(in|out|inout|variadic)\s+", re.I)


def arg_types(argtext):
    """`p_owner uuid, p_rows jsonb DEFAULT NULL::jsonb` -> ['uuid','jsonb'].

    Returns None when any argument cannot be reduced with confidence; the
    caller then treats the target as name-scoped rather than guessing a
    signature that would silently resolve to the wrong overload.
    """
    argtext = argtext.strip()
    if not argtext:
        return []
    types = []
    for raw in split_top_level(argtext):
        piece = ARGMODE_RE.sub("", raw.strip())
        piece = re.split(r"\bdefault\b", piece, flags=re.I)[0]
        piece = re.split(r"(?<![:<>!=])=(?!=)", piece)[0]
        piece = piece.strip()
        toks = piece.split()
        if len(toks) < 2:
            return None
        # first token is the parameter name; the rest is the type
        typ = " ".join(toks[1:]).strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_ ]*(\[\])?", typ):
            return None
        types.append(re.sub(r"\s+", " ", typ).lower())
    return types


def parse_create_function(src, blanked, spans, m):
    """Parse one create-function statement. Returns a dict, or dies."""
    open_idx = m.end() - 1
    close_idx = match_parens(blanked, spans, open_idx)
    if close_idx < 0:
        die("unbalanced parentheses in the argument list of %r at offset %d"
            % (m.group("name"), m.start()))
    argtext = src[open_idx + 1:close_idx]

    body_open = re.compile(r"\bas\s+(\$[A-Za-z_0-9]*\$)", re.I)
    bm = None
    for cand in body_open.finditer(blanked, close_idx + 1):
        if not in_span(cand.start(), spans):
            bm = cand
            break
    if bm is None:
        die("no `as $tag$` body opener after %r at offset %d — refusing to "
            "guess where its body starts" % (m.group("name"), m.start()))
    tag = bm.group(1)
    body_start = bm.end()
    # BOUND BY ITS OWN TERMINATOR. Not "the start of the next thing I
    # recognise": that is how a section-5 `do $$ ... $$` block was once
    # absorbed into the preceding function and its format() string attributed
    # to it.
    body_end = src.find(tag, body_start)
    if body_end < 0:
        die("the body of %r opened with %s and is never closed by it"
            % (m.group("name"), tag))
    header = blanked[close_idx + 1:bm.start()]
    return {
        "nsp": (m.group("nsp") or "public").lower(),
        "name": m.group("name"),
        "argtext": argtext,
        "header": header,
        "body": src[body_start:body_end],
        "stmt_end": body_end + len(tag),
        "offset": m.start(),
    }


def header_props(header, what):
    m = re.search(r"\blanguage\s+([A-Za-z_][A-Za-z0-9_]*)", header, re.I)
    if not m:
        die("no `language <name>` in the header of %s" % what)
    lang = m.group(1).lower()
    m = re.search(r"\bset\s+search_path\s*=\s*([^\n]+)", header, re.I)
    searchpath = m.group(1).strip().rstrip(";").strip() if m else None
    m = re.search(r"\bsecurity\s+(definer|invoker)\b", header, re.I)
    # Absent means SECURITY INVOKER: `create or replace` assigns every property
    # it does not name its default value, it does not inherit the old one.
    secdef = bool(m and m.group(1).lower() == "definer")
    m = re.search(r"\b(immutable|stable|volatile)\b", header, re.I)
    volatility = {"immutable": "i", "stable": "s", "volatile": "v"}[
        m.group(1).lower()] if m else "v"
    m = re.search(r"\breturns\s+(.+?)(?=\blanguage\b|\bsecurity\b|\bset\b|"
                  r"\bimmutable\b|\bstable\b|\bvolatile\b|\bas\b|$)",
                  header, re.I | re.S)
    rettype = re.sub(r"\s+", " ", m.group(1)).strip() if m else None
    return lang, searchpath, secdef, volatility, rettype


def classify_shim(body):
    """Is this body a refusal shim? Decided on a COMMENT-STRIPPED copy."""
    sm = SHIM_BODY_RE.match(norm(strip_comments(body)))
    if not sm:
        return None
    message = concat_literals(sm.group("msg"))
    if SUPERSEDED not in message.lower():
        return None
    errcode = unquote_sql(sm.group("errcode")) if sm.group("errcode") else None
    return {"message": message, "errcode": errcode}


# ---------------------------------------------------------------------------
# the two mechanisms
# ---------------------------------------------------------------------------
def scan_inline(path, file_idx, src, blanked, spans, events, defs_seen):
    for m in CREATE_RE.finditer(blanked):
        if in_span(m.start(), spans):
            continue          # inside a $fn$ template: the other mechanism
        fn = parse_create_function(src, blanked, spans, m)
        if fn["name"] == "%s":
            continue
        lang, searchpath, secdef, volatility, rettype = header_props(
            fn["header"], "%s.%s in %s" % (fn["nsp"], fn["name"], path))
        types = arg_types(fn["argtext"])
        sig = None
        if types is not None:
            sig = "%s.%s(%s)" % (fn["nsp"], fn["name"], ",".join(types))
        shim = classify_shim(fn["body"])
        defs_seen.append({
            "order": (file_idx, fn["offset"]),
            "source": os.path.basename(path),
            "nsp": fn["nsp"],
            "name": fn["name"],
            "sig": sig,
            "is_shim": shim is not None,
            "body_sha256": hashlib.sha256(
                norm(fn["body"]).encode("utf-8")).hexdigest(),
        })
        events.append({
            "order": (file_idx, fn["offset"]),
            "mechanism": "inline",
            "source": os.path.basename(path),
            "scope": "signature" if sig else "name",
            "proname": fn["name"],
            "sig": sig,
            "shim": shim,
            "lang": lang,
            "searchpath": searchpath,
            "secdef": secdef,
            "volatility": volatility,
            "rettype": rettype,
            "body": fn["body"],
            "revoked_from": None,
        })


# ---------------------------------------------------------------------------
# ACL statements — literal, and the `execute format(...)` loops
#
# The expected grantee set of a refusal shim is NOT the same for every shim, and
# assuming it was is how a shim that keeps `service_role` (0017's) and a shim
# revoked from everything (0022's) would be held to one contract. So the ACL is
# DERIVED per target, from statements in the migration set, by the same
# mechanism-scan discipline the shim itself gets:
#
#   literal   `revoke|grant ... on routine|function nsp.name(args) from|to roles;`
#   loop      `execute format('revoke all on routine %s from roles', ...)` — or
#             the grant form — inside a `for ... loop ... end loop;` whose
#             header carries a `p.proname in ( ... )` list. An ACL format()
#             this parser cannot attribute to such a list is a REFUSAL, never a
#             silently skipped statement.
#
# Only the four client roles decide the derivation's admissibility: a target is
# `acl_derivable` only when its own tombstone migration revokes it from
# `public, anon, authenticated` (and possibly `service_role`) — i.e. from every
# role a client can arrive as. Anything granted after that revoke, in the same
# file, is the derived expectation. Without such a revoke the pre-existing ACL
# would carry over from default privileges and no honest set could be derived,
# so the extractor refuses rather than guessing.
# ---------------------------------------------------------------------------
CLIENT_ROLES = ("public", "anon", "authenticated", "service_role")

ACL_LITERAL_RE = re.compile(
    r"\b(?P<action>grant|revoke)\s+"
    r"(?:all\s+privileges|all|execute)\s+"
    r"(?:privileges\s+)?on\s+(?:routine|function)\s+"
    r"(?:(?P<nsp>[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\((?P<args>[^)]*)\)\s*"
    r"(?P<dir>from|to)\s+(?P<roles>[^;]+);",
    re.I | re.S,
)

ACL_FORMAT_RE = re.compile(
    r"format\(\s*'(?P<action>revoke|grant)\s+(?:all|execute)"
    r"(?:\s+privileges)?\s+on\s+(?:routine|function)\s+%s\s+"
    r"(?P<dir>from|to)\s+(?P<roles>[^']*)'",
    re.I,
)

LOOP_RE = re.compile(r"\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b(?P<head>.*?)\bloop\b"
                     r"(?P<body>.*?)\bend\s+loop\s*;", re.I | re.S)


def role_list(text):
    return [r.strip().lower() for r in text.split(",") if r.strip()]


def acl_types(argtext):
    """Argument list of an ACL statement -> type list.

    ACL statements normally name types only (`(uuid, uuid)`), but PostgreSQL
    also accepts the full parameter list, so both shapes are handled.
    """
    argtext = argtext.strip()
    if not argtext:
        return []
    pieces = split_top_level(argtext)
    if any(len(p.split()) > 1 for p in pieces):
        typed = arg_types(argtext)
        if typed is not None:
            return typed
    out = []
    for p in pieces:
        p = re.sub(r"\s+", " ", p.strip()).lower()
        if not re.fullmatch(r"[a-z_][a-z0-9_ ]*(\[\])?", p):
            return None
        out.append(p)
    return out


def scan_acl(path, file_idx, src, blanked, spans, events):
    """Append ACL events. Ordered by (file_idx, offset) like every other scan."""
    base = os.path.basename(path)

    # --- literal statements, outside every literal and dollar-quoted body
    for m in ACL_LITERAL_RE.finditer(blanked):
        if in_span(m.start(), spans):
            continue
        types = acl_types(m.group("args"))
        if types is None:
            die("cannot reduce the argument list of an ACL statement in %s at "
                "offset %d: %r" % (base, m.start(), m.group("args")))
        events.append({
            "order": (file_idx, m.start()),
            "source": base,
            "scope": "signature",
            "sig": "%s.%s(%s)" % ((m.group("nsp") or "public").lower(),
                                  m.group("name").lower(), ",".join(types)),
            "proname": m.group("name").lower(),
            "action": m.group("action").lower(),
            "roles": role_list(m.group("roles")),
        })

    # --- `execute format('... %s ...')` inside a `for ... loop`
    for dm in re.finditer(r"\bdo\s+(\$[A-Za-z_0-9]*\$)", blanked):
        if in_span(dm.start(), spans):
            continue
        tag = dm.group(1)
        start = dm.end()
        end = src.find(tag, start)
        if end < 0:
            die("a `do %s` block in %s is never closed by %s" % (tag, base, tag))
        block = strip_comments(src[start:end])
        # Attribute every ACL format() to the loop that contains it. A loop
        # body is bounded by its OWN `end loop;`.
        claimed = []
        for lm in LOOP_RE.finditer(block):
            head, body = lm.group("head"), lm.group("body")
            if re.search(r"\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b", body, re.I):
                die("nested loops in a `do` block of %s; this parser attributes "
                    "an ACL statement to exactly one enclosing loop" % base)
            acls = list(ACL_FORMAT_RE.finditer(body))
            claimed.append((lm.start("body"), lm.end("body")))
            if not acls:
                continue
            nl = re.search(r"p\.proname\s+in\s*\((.*?)\)", head, re.S)
            names = None
            if nl:
                names = re.findall(r"'([a-z_][a-z0-9_]*)'", nl.group(1))
                if not names:
                    die("the `p.proname in ( ... )` list of an ACL loop in %s "
                        "is empty" % base)
            elif (re.search(r"\bpg_proc\b", head, re.I)
                  and re.search(r"nspname\s*=\s*'public'", head, re.I)):
                # 0015's sweep: every routine in `public`, no name list. That is
                # not an unattributable statement, it is a WIDER one, and
                # dropping it would make the walk under-count.
                names = ["*"]
            if names is None:
                die("a loop in %s issues `%s ... %%s ...` but its header carries "
                    "neither a `p.proname in ( ... )` list nor a whole-schema "
                    "`pg_proc ... nspname = 'public'` selection, so the routines "
                    "it changes cannot be read"
                    % (base, acls[0].group("action").lower()))
            for am in acls:
                for nm in names:
                    events.append({
                        "order": (file_idx, dm.start() + am.start()),
                        "source": base,
                        "scope": "all_public" if nm == "*" else "name",
                        "sig": None,
                        "proname": None if nm == "*" else nm,
                        "action": am.group("action").lower(),
                        "roles": role_list(am.group("roles")),
                    })
        # An ACL format() outside every loop cannot be attributed at all.
        for am in ACL_FORMAT_RE.finditer(block):
            if not any(a <= am.start() < b for a, b in claimed):
                die("an `execute format('%s ... %%s ...')` in %s sits outside "
                    "every `for ... loop`; this parser cannot tell which "
                    "routines it changes" % (am.group("action").lower(), base))


def derive_grantees(target, acl_events):
    """The explicit grantee set a shim is expected to carry, and why.

    Walks the ACL events for this target in migration order and requires a
    client-wide revoke inside the target's own source migration. Returns
    (grantees, revoked_from, granted_to, note) or dies.
    """
    rel = [e for e in acl_events
           if e["scope"] == "all_public"
           or (e["proname"] == target["proname"]
               and (e["scope"] == "name" or target["sig"] is None
                    or e["sig"] == target["sig"]))]
    rel.sort(key=lambda e: e["order"])
    same_file = [e for e in rel if e["source"] == target["source"]]
    cut = None
    for i, e in enumerate(same_file):
        if e["action"] == "revoke" and all(
                r in e["roles"] for r in ("public", "anon", "authenticated")):
            cut = i
    if cut is None:
        die("no `revoke ... from public, anon, authenticated` for %s in %s, the "
            "migration that tombstones it; its expected grantee set cannot be "
            "derived and this tool refuses to guess one"
            % (target["sig"] or target["proname"], target["source"]))
    grantees = set()
    revoked_from = list(same_file[cut]["roles"])
    granted_to = []
    for e in same_file[cut:]:
        if e["action"] == "revoke":
            for r in e["roles"]:
                grantees.discard("PUBLIC" if r == "public" else r)
        else:
            for r in e["roles"]:
                grantees.add("PUBLIC" if r == "public" else r)
                granted_to.append(r)
    return (sorted(grantees), revoked_from, sorted(set(granted_to)),
            "derived from %s: revoke from %s, then grant to %s"
            % (target["source"], ",".join(revoked_from),
               ",".join(sorted(set(granted_to))) or "<nobody>"))


def scan_template(path, file_idx, src, blanked, spans, events):
    """Migration 0022 section 5's loop: a DO block that builds the shape with
    format() from a $fn$ template over a `p.proname in ( ... )` list."""
    found = []
    for m in re.finditer(r"\bdo\s+(\$[A-Za-z_0-9]*\$)", blanked):
        if in_span(m.start(), spans):
            continue
        tag = m.group(1)
        start = m.end()
        end = src.find(tag, start)
        if end < 0:
            die("a `do %s` block in %s is never closed by %s" % (tag, path, tag))
        block_raw = src[start:end]
        block = strip_comments(block_raw)
        fn_blocks = re.findall(r"\$fn\$(.*?)\$fn\$", block_raw, re.S)
        if not fn_blocks:
            continue
        if len(fn_blocks) != 1:
            die("expected exactly one $fn$...$fn$ template, found %d in the DO "
                "block at offset %d of %s"
                % (len(fn_blocks), m.start(), path))
        template = fn_blocks[0]
        tblank, tspans = lex(template)
        tm = CREATE_RE.search(tblank)
        if not tm:
            continue
        fn = parse_create_function(template, tblank, tspans, tm)
        shim = classify_shim(fn["body"])
        if shim is None:
            continue
        lang, searchpath, secdef, volatility, rettype = header_props(
            fn["header"], "the $fn$ template in %s" % path)
        namelist = re.search(r"p\.proname\s+in\s*\((.*?)\)", block, re.S)
        if not namelist:
            die("the $fn$ tombstone template in %s has no `p.proname in ( ... )` "
                "list, so the set of routines it rewrites cannot be read"
                % path)
        names = re.findall(r"'([a-z_][a-z0-9_]*)'", namelist.group(1))
        if not names:
            die("the `p.proname in ( ... )` list of the tombstone loop in %s "
                "is empty" % path)
        if len(set(names)) != len(names):
            die("the tombstone loop name list in %s repeats a name: %r"
                % (path, names))
        rv = re.search(r"'revoke\s+all\s+on\s+routine\s+%s\s+from\s+([^']+)'",
                       block, re.I)
        revoked = ([r.strip().lower() for r in rv.group(1).split(",")]
                   if rv else None)
        found.append({
            "order": (file_idx, m.start()),
            "mechanism": "template",
            "source": os.path.basename(path),
            "names": names,
            "shim": shim,
            "lang": lang,
            "searchpath": searchpath,
            "secdef": secdef,
            "volatility": volatility,
            "body": fn["body"],
            "revoked_from": revoked,
            "template_body": fn["body"],
            "template_message": shim["message"],
        })
    events.extend(found)
    return found


# ---------------------------------------------------------------------------
# section 6's independent restatement of the loop's name list
# ---------------------------------------------------------------------------
POSTCOND_MARKER = "superseded routines are still executable"


def postcondition_names(path, src, blanked):
    at = blanked.find(POSTCOND_MARKER)
    if at < 0:
        # The marker lives inside a string literal, which lex() preserves.
        return None
    lists = list(re.finditer(r"p\.proname\s+in\s*\((.*?)\)", blanked[:at], re.S))
    if len(lists) < 2:
        die("only %d `p.proname in ( ... )` list(s) precede the post-condition "
            "marker in %s; section 6 must carry its own" % (len(lists), path))
    names = re.findall(r"'([a-z_][a-z0-9_]*)'", lists[-1].group(1))
    if not names:
        die("the post-condition's `p.proname in ( ... )` list in %s is empty"
            % path)
    return names


# ---------------------------------------------------------------------------
# `--emit-tombstone-do`: hand the mutation suite the real section-5 block
# ---------------------------------------------------------------------------
def emit_tombstone_do(path):
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    blanked, _ = lex(src)
    at = src.find(MARKER)
    if at < 0:
        die("no %r: %s is not the tombstone migration" % (MARKER, path))
    start = src.rfind("do $$", 0, at)
    if start < 0:
        die("no `do $$` opens the block that contains the tombstone template")
    end = src.find("\n$$;", at)
    if end < 0:
        die("no `$$;` closes the block that contains the tombstone template")
    block = src[start:end + len("\n$$;")]
    if "$fn$" not in block or "revoke all on routine" not in block:
        die("the sliced DO block is not section 5: it lacks the template or the REVOKE")
    sys.stdout.write(block + "\n")


# ---------------------------------------------------------------------------
def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--emit-tombstone-do":
        if len(argv) != 2:
            die("usage: --emit-tombstone-do <path-to-0022.sql>")
        emit_tombstone_do(argv[1])
        return
    if len(argv) != 1:
        die("usage: extract-tombstone-template.py [--emit-tombstone-do FILE] "
            "<migrations-dir>")
    root = argv[0]
    if not os.path.isdir(root):
        die("not a directory: %s (this tool now scans the whole migration set, "
            "not a single file)" % root)

    files = sorted(f for f in os.listdir(root)
                   if re.fullmatch(r"[0-9]{4}_[A-Za-z0-9_.-]+\.sql", f))
    if len(files) < 8:
        die("only %d migration file(s) in %s; refusing to derive a contract "
            "from a partial migration set" % (len(files), root))

    events = []
    defs_seen = []
    acl_events = []
    template_blocks = []
    postcond = {}
    for file_idx, base in enumerate(files):
        path = os.path.join(root, base)
        with open(path, "r", encoding="utf-8") as fh:
            src = fh.read()
        blanked, spans = lex(src)
        scan_inline(path, file_idx, src, blanked, spans, events, defs_seen)
        template_blocks.extend(
            scan_template(path, file_idx, src, blanked, spans, events))
        scan_acl(path, file_idx, src, blanked, spans, acl_events)
        pc = postcondition_names(path, src, blanked)
        if pc is not None:
            postcond[base] = pc

    if not defs_seen:
        die("no `create function` statement was parsed in any of the %d "
            "migration files; the scanner is not working" % len(files))
    if not acl_events:
        die("no GRANT or REVOKE statement was parsed in any of the %d migration "
            "files; the ACL scanner is not working" % len(files))

    # ---- resolve last-definition-wins, in migration order ------------------
    events.sort(key=lambda e: e["order"])
    state = {}      # sig -> event   (signature-scoped)
    by_name = {}    # proname -> set of sigs seen
    name_scoped = {}  # proname -> template event (applies to every overload)
    for ev in events:
        if ev["mechanism"] == "inline":
            key = ev["sig"] or ("%s.%s" % ("public", ev["proname"]))
            by_name.setdefault(ev["proname"], set()).add(key)
            state[key] = ev
            # a later live definition of a name-scoped tombstone revives it
            if ev["shim"] is None:
                name_scoped.pop(ev["proname"], None)
        else:
            for nm in ev["names"]:
                name_scoped[nm] = ev
                for key in by_name.get(nm, ()):
                    state[key] = dict(ev, proname=nm, sig=key.split("(")[0] and key,
                                      scope="signature")

    targets = []
    for key, ev in sorted(state.items()):
        if ev["shim"] is None:
            continue
        proname = ev.get("proname")
        if ev["mechanism"] == "template":
            # instantiated below with the name-scoped entry
            continue
        targets.append({
            "proname": proname,
            "sig": ev["sig"],
            "scope": "signature" if ev["sig"] else "name",
            "mechanism": "inline",
            "source": ev["source"],
            "lang": ev["lang"],
            "searchpath": ev["searchpath"],
            "secdef": ev["secdef"],
            "volatility": ev["volatility"],
            "errcode": ev["shim"]["errcode"],
            "message": ev["shim"]["message"],
            "body": ev["body"],
            "body_norm": norm(ev["body"]),
            "body_shape": body_shape(ev["body"]),
            "revoked_from": ev["revoked_from"],
        })
    for nm, ev in sorted(name_scoped.items()):
        targets.append({
            "proname": nm,
            "sig": None,
            "scope": "name",
            "mechanism": "template",
            "source": ev["source"],
            "lang": ev["lang"],
            "searchpath": ev["searchpath"],
            "secdef": ev["secdef"],
            "volatility": ev["volatility"],
            "errcode": ev["shim"]["errcode"],
            "message": ev["shim"]["message"] % nm
                       if "%s" in ev["shim"]["message"] else ev["shim"]["message"],
            "body": ev["body"] % nm if "%s" in ev["body"] else ev["body"],
            "body_norm": norm(ev["body"] % nm if "%s" in ev["body"]
                              else ev["body"]),
            "body_shape": body_shape(ev["body"] % nm if "%s" in ev["body"]
                                     else ev["body"]),
            "revoked_from": ev["revoked_from"],
        })

    # ---- per-mechanism non-vacuity floor -----------------------------------
    n_inline = sum(1 for t in targets if t["mechanism"] == "inline")
    n_template = sum(1 for t in targets if t["mechanism"] == "template")
    if n_inline == 0:
        die("the `inline` mechanism found no refusal shim in %d migration "
            "files. A union whose second arm is empty is a single-arm scan "
            "wearing a union's name; refusing to emit it." % len(files))
    if n_template == 0:
        die("the `template` mechanism found no `do $$ ... $fn$ ... $$` "
            "tombstone loop in %d migration files. Same reason." % len(files))
    sources = sorted({t["source"] for t in targets})
    if len(sources) < 2:
        die("every derived tombstone comes from %s. This scan exists because a "
            "single-file derivation reported itself whole; refusing to emit a "
            "single-file result." % sources[0])

    # ---- the 0022 loop list, cross-checked against 0022's post-condition ---
    tmpl_names = sorted({t["proname"] for t in targets
                         if t["mechanism"] == "template"})
    if not postcond:
        die("no migration restates a tombstone set in a post-condition "
            "(%r); the template mechanism's list cannot be cross-checked"
            % POSTCOND_MARKER)
    pc_names = sorted({n for lst in postcond.values() for n in lst})
    if pc_names != tmpl_names:
        die("migration 0022 states its tombstone set twice and the two "
            "disagree: the loop has %s, the post-condition has %s"
            % (",".join(tmpl_names), ",".join(pc_names)))

    # ---- the expected grantee set, DERIVED per target ----------------------
    # Not one contract for every shim: 0022's are revoked from every client
    # role, 0017's keep service_role. Assuming the first shape for all of them
    # would either fail the pristine schema or, worse, be relaxed until it
    # passed. Each target's set comes from the ACL statements of the migration
    # that tombstoned it.
    for t in targets:
        grantees, revoked_from, granted_to, note = derive_grantees(t, acl_events)
        t["expected_grantees"] = grantees
        t["revoked_from"] = revoked_from
        t["granted_to"] = granted_to
        t["acl_note"] = note
        t["client_grantees_derivable"] = all(
            r in revoked_from for r in CLIENT_ROLES)
        # A shim revoked from every client role must end with an empty set; a
        # derivation that produced one anyway would be reading the wrong
        # statements.
        if t["client_grantees_derivable"] and grantees:
            die("%s is revoked from every client role in %s yet the derivation "
                "leaves grantees %s; the ACL walk is wrong"
                % (t["sig"] or t["proname"], t["source"], ",".join(grantees)))

    # ---- the last LIVE body of every signature, per generation -------------
    # The classifier pins the pre-tombstone body of each object by digest. Those
    # digests used to be typed into the classifier by hand, which is the same
    # "a list nobody can see is short" failure the tombstone name set had. They
    # are derived here instead, and the classifier cross-checks its pins
    # against them.
    def live_map(max_prefix):
        out = {}
        for d in sorted(defs_seen, key=lambda d: d["order"]):
            if d["sig"] is None:
                continue
            if d["source"][:4] > max_prefix:
                continue
            if d["is_shim"]:
                continue
            out[d["sig"]] = d["body_sha256"]
        return out

    live_0008 = live_map("0008")
    live_latest = live_map("9999")
    if not live_0008 or not live_latest:
        die("the live-body map is empty for a generation; the definition "
            "scanner is not working")

    # ---- the template mechanism's own values, for controls C05/C06/C07 -----
    tev = next(e for e in template_blocks if True)
    tmpl_body = tev["template_body"]
    tmpl_msg = tev["template_message"]
    if tmpl_body.count("%s") != 1:
        die("the tombstone template body must carry exactly one %%s (the "
            "routine name); found %d" % tmpl_body.count("%s"))
    if "%s" not in tmpl_msg:
        die("the tombstone template message carries no %%s: it would not name "
            "the routine")
    if tev["revoked_from"] is None:
        die("no `revoke all on routine %s from ...` alongside the template")
    for required in ("public", "anon", "authenticated", "service_role"):
        if required not in tev["revoked_from"]:
            die("the template REVOKE does not name %r; refusing to derive a "
                "contract that leaves a client role able to call it" % required)
    tmpl_shape = body_shape(tmpl_body)
    if not re.fullmatch(tmpl_shape.strip("^$"), norm(tmpl_body % "X")):
        die("the derived shape does not match the derived body; refusing to emit it")
    if re.fullmatch(tmpl_shape.strip("^$"), "begin return null; end;"):
        die("the derived shape matches a live no-op body; it is a tautology")

    # ---- every target's own shape must accept its own body, and reject a
    #      live one. A tautological shape would let the classifier invoke
    #      anything.
    for t in targets:
        if not re.fullmatch(t["body_shape"].strip("^$"), norm(t["body"])):
            die("the derived shape for %s does not match its own body"
                % (t["sig"] or t["proname"]))
        if re.fullmatch(t["body_shape"].strip("^$"), "begin return null; end;"):
            die("the derived shape for %s is a tautology"
                % (t["sig"] or t["proname"]))
        if t["errcode"] is None:
            die("the refusal shim %s raises without `using errcode = '...'`; "
                "refusing to derive a contract with no SQLSTATE to check"
                % (t["sig"] or t["proname"]))
        if not re.fullmatch(r"[0-9A-Z]{5}", t["errcode"]):
            die("errcode %r for %s is not a 5-character SQLSTATE"
                % (t["errcode"], t["sig"] or t["proname"]))

    names = sorted({t["proname"] for t in targets})
    by_source = ";".join(
        "%s:%s" % (s, ",".join(sorted({t["proname"] for t in targets
                                       if t["source"] == s})))
        for s in sources)

    out = {
        "NT_CC_TOMB_NAMES": ",".join(names),
        "NT_CC_TOMB_SIGS": ";".join(sorted(t["sig"] or ("%s.%s" % ("public",
                                                                   t["proname"]))
                                           for t in targets)),
        "NT_CC_LIVE_BODY_0008_JSON": json.dumps(live_0008, sort_keys=True),
        "NT_CC_LIVE_BODY_LATEST_JSON": json.dumps(live_latest, sort_keys=True),
        "NT_CC_TOMB_ACL_BY_TARGET": ";".join(
            "%s=%s" % (t["sig"] or t["proname"],
                       ",".join(t["expected_grantees"]) or "<none>")
            for t in sorted(targets, key=lambda x: x["proname"])),
        "NT_CC_TOMB_TEMPLATE_NAMES": ",".join(tmpl_names),
        "NT_CC_TOMB_POSTCOND_NAMES": ",".join(pc_names),
        "NT_CC_TOMB_NAMES_BY_SOURCE": by_source,
        "NT_CC_TOMB_MECHANISMS": "inline=%d,template=%d" % (n_inline, n_template),
        "NT_CC_TOMB_SOURCES": ",".join(sources),
        "NT_CC_TOMB_MIGRATION_COUNT": str(len(files)),
        "NT_CC_TOMB_TARGETS_JSON": json.dumps(targets, sort_keys=True),
        # template-mechanism values, kept for the derived-template controls
        "NT_CC_TOMB_LANG": tev["lang"],
        "NT_CC_TOMB_SEARCHPATH": tev["searchpath"] or "",
        "NT_CC_TOMB_SECDEF": "t" if tev["secdef"] else "f",
        "NT_CC_TOMB_VOLATILITY": tev["volatility"],
        "NT_CC_TOMB_ERRCODE": tev["shim"]["errcode"],
        "NT_CC_TOMB_MSG_TEMPLATE": tmpl_msg,
        "NT_CC_TOMB_BODY_TEMPLATE": tmpl_body,
        "NT_CC_TOMB_BODY_SHAPE": tmpl_shape,
        "NT_CC_TOMB_REVOKE_ROLES": ",".join(tev["revoked_from"]),
        "NT_CC_TOMB_BODY_SHA256": hashlib.sha256(
            tmpl_body.encode("utf-8")).hexdigest(),
        "NT_CC_TOMB_SOURCE": root,
    }
    for k, v in out.items():
        sys.stdout.write("%s=%s\n" % (k, shlex.quote(v)))


if __name__ == "__main__":
    main()
