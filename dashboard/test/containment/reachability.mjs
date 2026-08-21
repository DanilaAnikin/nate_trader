#!/usr/bin/env node
/**
 * Prove that no production entrypoint can reach a routine migration 0022
 * tombstoned.
 *
 * WHY A GRAPH, NOT A GREP
 * -----------------------
 * "maintenanceBlock appears in the file" is not proof of anything. Neither is
 * "the handler returns 503 today". Both are claims about control flow, which is
 * undecidable in general and, worse, silently falsified by an ordinary
 * refactor. What IS decidable is the module graph: if a tombstoned routine is
 * not in the transitive import closure of any production entrypoint, no code
 * path through those entrypoints can call it, regardless of branching.
 *
 * WHAT THE SECOND AUDIT CHANGED
 * -----------------------------
 * An independent proof-honesty audit demonstrated eight ways this file stayed
 * green while the property it names was false, and they were all one defect:
 *
 *   it enumerated from disk, then narrowed to ONE SYNTACTIC FORM and treated
 *   every other form as ABSENT rather than as UNKNOWN.
 *
 * `import` but not `import()`. `.ts` but not `.js`. `.rpc(` but not `.rpc<T>(`.
 * A file-level directive in the first 200 bytes but not at byte 201, and not a
 * function-level one. Each narrowing turned a thing it could not see into a
 * thing it reported as safe.
 *
 * So the rule now is: anything this analyzer cannot classify is an ERROR, not
 * an absence. That is the only honest verdict available to a static tool — it
 * can say "I checked and it is not there", or "I could not check", and the
 * second must never be printed as the first.
 *
 * FAIL-CLOSED, specifically. Each of these is an error:
 *   - an import specifier that does not resolve to a file
 *   - a dynamic import() or require() whose argument is not a literal
 *   - any `.rpc` that is not a direct call with a literal name
 *   - a forbidden routine's NAME appearing as a string literal anywhere in a
 *     closure, whatever the call syntax around it
 *   - fewer entrypoints than there are route files on disk
 *   - zero entrypoints, or zero modules walked
 *
 * The alternative — skipping what it cannot understand — is how a scanner ends
 * up reporting a clean tree it never actually read.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCommentsAndStrings, hasUseServer } from "./source-scan.mjs";

const DASH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = resolve(DASH, "..");

const errors = [];

/**
 * The tombstoned routines, derived from EVERY migration.
 *
 * Three rounds of adversarial audit walked this outwards one step at a time,
 * and each step was the same mistake at a wider radius:
 *
 *   a hardcoded list of three
 *   -> the five in migration 0022's section-5 loop
 *   -> plus resolve_create_operation, which 0022 tombstones INLINE
 *   -> plus the two that migration 0017 tombstones, in a different file
 *
 * Each version was a derivation scoped to whatever the previous finding had
 * pointed at, which is a hand-pinned list wearing a derivation's clothes.
 *
 * WHY THE LOOP SCAN IS NOT SIMPLY WIDENED
 * ---------------------------------------
 * `p.proname in (...)` appears in EIGHT migrations, and only 0022's is a
 * tombstone loop. The others are ACL loops — 0016 is literally named
 * global_function_acl — and widening the scan to all of them would forbid
 * get_account_credentials, publish_broker_refresh and ten other LIVE routines,
 * failing the proof for routines that are supposed to work. Measured, not
 * assumed. So a loop counts only when its own file also installs a tombstone
 * BODY: a `create or replace function %s` whose text raises "superseded".
 *
 * LAST DEFINITION WINS
 * --------------------
 * A routine tombstoned in one migration could be revived in a later one, and
 * forbidding it then would be a false positive that fails the build. Inline
 * definitions are therefore walked in migration order and the final one
 * decides. (Checked: none of the eight is revived. The five from 0022's loop
 * do have later LIVE bodies in earlier files — 0008, 0020, 0021 — which is
 * exactly why the dynamic loop has to be read as well: it tombstones at
 * runtime via execute format(), leaving no literal text for a text scan.)
 */
function forbiddenRoutines() {
  const dir = join(REPO, "supabase", "migrations");
  if (!existsSync(dir)) {
    errors.push("cannot find supabase/migrations — the forbidden list has no source");
    return [];
  }
  const files = readdirSync(dir).filter((f) => /\.sql$/.test(f)).sort();
  if (files.length < 20) {
    errors.push(`only ${files.length} migrations found — the scan is looking in the wrong place`);
  }

  const strip = (t) => t.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  // A tombstone announces ITSELF. Every real one in this tree reads
  // "<routine>(<sig>) is superseded ...", and the loop's format() template is
  // "%s is superseded and must not be called".
  //
  // The looser test — any raise mentioning "supersed" — reported
  // finish_account_verification as dead. It is live, and its body raises
  // "verification token % was superseded by a later verification": a TOKEN
  // being superseded, not the routine. The word was right and the subject was
  // not. Requiring the routine to name itself is what separates the two.
  const supersededSelf = (body, name) =>
    new RegExp(`raise\\s+exception\\s+'\\s*(?:${name}|%s)\\s*(?:\\([^']*?\\))?\\s+is superseded`, "i").test(body);
  const INSTALLS_TOMBSTONE = /raise\s+exception\s+'\s*%s\s+is superseded/i;

  let fromLoop = [];
  const inlineState = new Map(); // routine -> true when its LAST definition is a tombstone

  for (const f of files) {
    const sql = strip(readFileSync(join(dir, f), "utf8"));

    // MECHANISM 1 — a loop that installs tombstone bodies. Only a file that
    // also contains `create or replace function %s` with a superseded raise
    // is doing that; the rest are ACL loops.
    const installsTombstones =
      /create\s+or\s+replace\s+function\s+%s/i.test(sql) && INSTALLS_TOMBSTONE.test(sql);
    if (installsTombstones) {
      const loop = sql.match(/p\.proname\s+in\s*\(([\s\S]*?)\)\s*\n/);
      if (loop) fromLoop = [...loop[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    }

    // MECHANISM 2 — an inline `create or replace` whose own body raises
    // "superseded". Each body is bounded by ITS OWN dollar-quote terminator:
    // slicing to the next `create or replace` absorbed 0022's do-block and
    // attributed its format() string to the preceding function, which reported
    // audit_log_detail_guard — the guard that ARMS the audit rules — as dead.
    const CREATE_FN = /create\s+or\s+replace\s+function\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)\s*\(/gi;
    for (const m of sql.matchAll(CREATE_FN)) {
      const name = m[1].toLowerCase();
      if (name === "%s") continue;
      const after = sql.slice(m.index);
      const tag = after.match(/\bas\s+(\$[a-z_]*\$)/i);
      if (!tag) continue;
      const b0 = after.indexOf(tag[1]) + tag[1].length;
      const b1 = after.indexOf(tag[1], b0);
      if (b1 < 0) continue;
      inlineState.set(name, supersededSelf(after.slice(b0, b1), name));
    }
  }

  const fromInline = [...inlineState.entries()].filter(([, t]) => t).map(([n]) => n);
  const names = [...new Set([...fromLoop, ...fromInline])].sort();

  // Non-vacuity per mechanism. A union is only as good as its narrowest input,
  // and a silently-empty contributor is invisible in the total. These floors
  // are the counts measured against this migration set; a scan that finds
  // fewer is broken, not looking at a cleaner tree.
  if (fromLoop.length < 5) {
    errors.push(`the tombstone-installing loop yielded ${fromLoop.length} routines — expected at least 5`);
  }
  if (fromInline.length < 3) {
    errors.push(`the inline-tombstone scan yielded ${fromInline.length} routines — expected at least 3`);
  }
  for (const known of ["resolve_create_operation", "reconcile_cash_flow_mirror", "replace_equity_snapshots"]) {
    if (!names.includes(known)) {
      errors.push(`${known} is tombstoned inline but is not in the derived set — the scan is broken`);
    }
  }
  return names;
}

const FORBIDDEN_ROUTINES = forbiddenRoutines();

/**
 * Modules whose mere presence in an entrypoint closure is a finding, because
 * they are the mutation surface even when no routine name appears.
 *
 * DERIVED, NOT PINNED.
 *
 * This was a two-entry hardcoded list — credentials.ts and service.ts — and an
 * auditor was right to call it out: renaming or copying either one defeats it,
 * and only the routine-name rule would remain. Two adversarial audits landed on
 * the same shape the same day, in two other components: a verdict that
 * certifies a subset as whole, and an expectation catalogue naming three of the
 * five routines its own migration tombstones. A hand-pinned list is narrower
 * than the contract it claims to enforce, and nothing checks the two against
 * each other.
 *
 * So the set is computed: a module is mutation surface if it performs a
 * PostgREST TABLE WRITE. `.from("x")` followed by insert/update/upsert/delete.
 *
 * `.from(` is required in the chain deliberately. A bare `.delete(` matches
 * `cache.delete(key)` on a Map — measured, in lib/status/github-api.ts, which
 * is legitimately inside a closure and writes nothing. A rule that cannot tell
 * a Map from a table would fail this proof for a false reason, and a proof that
 * fails for false reasons gets relaxed.
 *
 * An `.rpc()` call is NOT sufficient on its own either: lib/status/broker.ts
 * calls get_account_credentials, a read, and is legitimately reachable. RPCs
 * are covered by the routine-name rule below, which is about which routine, not
 * about the call.
 *
 * A module is ALSO mutation surface if it names a tombstoned routine, because
 * that is how credentials.ts mutates — through the vault_* wrappers, never
 * through `.from()`. The first version of this derivation used table writes
 * alone and did not find it; the non-vacuity guard below caught that
 * immediately, which is the whole reason the guard is there. A derivation you
 * cannot see failing is not better than the list it replaced.
 *
 * Measured on this tree: three modules qualify — credentials.ts (tombstoned
 * RPCs), service.ts (table writes), and equity-backfill.ts (table writes),
 * which the old two-entry list MISSED.
 */
const TABLE_WRITE_RE =
  /\.\s*from\s*(?:\?\.)?\s*\(\s*["'`][^"'`]+["'`]\s*\)[\s\S]{0,300}?\.\s*(?:insert|update|upsert|delete)\s*(?:\?\.)?\s*\(/;

/** THE RULE, in one place, so the set that is DERIVED and the set that is
 *  DECIDED cannot be different sets.
 *
 *  They were. `forbiddenModules()` enumerated only app/, lib/ and components/
 *  minus SKIP_DIRS, while `closureOf()` follows resolved import edges ANYWHERE
 *  under the dashboard. So a module at dashboard/server/writer.ts — or at
 *  dashboard/lib/e2e/writer.ts, inside a skipped directory — could do a
 *  textbook `svc.from("accounts").delete()`, be imported by a route, and never
 *  enter the derived set. Demonstrated: modulesWalked rose from 363 to 364, so
 *  the analyzer WALKED INTO the file, and still printed PASS. None of the three
 *  newer detectors covers it either: the table name is a literal, there is no
 *  computed access, and the import edge is a plain static one.
 *
 *  The offence loop now applies this rule to the closure member it is holding,
 *  rather than looking the member up in a list derived over a different walk.
 *  The derived list is still computed, because it is what gets REPORTED — and
 *  a closure member that this rule flags but that list does not contain is now
 *  an error, so the report cannot quietly understate the surface either. */
function isMutationSurface(src) {
  if (isTableWrite(src)) return true;
  return FORBIDDEN_ROUTINES.some((r) => new RegExp(`["'\`]${r}["'\`]`).test(src));
}

/** Does this module write a table? ONE predicate, used by the derivation and by
 *  the offence loop alike. They diverged the moment a second condition was
 *  added to only one of them: the derived list gained the module-level pairing
 *  rule while the offence loop still tested TABLE_WRITE_RE on its own, so a
 *  write the window could not pair entered the reported surface and produced no
 *  offence. That is the same two-rules-for-one-question defect this file has now
 *  had three times, at three different scales. */
function isTableWrite(src) {
  return TABLE_WRITE_RE.test(src) || unpairedTableWrite(src);
}

/** A `.from(` and a write method in the same module that the windowed rule
 *  could not pair.
 *
 *  TABLE_WRITE_RE looks for a write within 300 characters of the `.from(`. The
 *  headline of the commit that introduced it said it had closed "the 200-byte
 *  window they shared" — and what replaced that was a 300-CHARACTER window with
 *  the same defeat. Hold the query builder in a variable across a dozen
 *  ordinary statements and a literal-table write is invisible to TABLE_WRITE_RE
 *  and, because the table name IS a literal, invisible to
 *  FROM_NONLITERAL_WRITE_RE too.
 *
 *  Widening the window only moves the number. This asks the question the window
 *  was approximating: does this module both select a table and call a write
 *  method? If so it is mutation surface, whatever the distance between them.
 *  Deliberately over-inclusive — an extra module in the surface makes the proof
 *  stricter, a missed one makes it a lie — and measured against this tree,
 *  which still derives exactly the same three modules. */
function unpairedTableWrite(src) {
  FROM_WITH_RECEIVER_RE.lastIndex = 0;
  const selectsTable = [...src.matchAll(FROM_WITH_RECEIVER_RE)].some(
    (m) => !(m[1] && FROM_BUILTIN_RECEIVERS.has(m[1])),
  );
  if (!selectsTable) return false;
  return /\.\s*(?:insert|update|upsert|delete)\s*(?:\?\.)?\s*\(/.test(src);
}

function forbiddenModules() {
  const found = [];
  for (const root of ["app", "lib", "components"]) {
    for (const f of walkFiles(join(DASH, root))) {
      let src;
      try {
        src = stripComments(readFileSync(f, "utf8"), f);
      } catch {
        errors.push(`${relative(DASH, f)}: unreadable while deriving the mutation surface`);
        continue;
      }
      if (isMutationSurface(src)) found.push(relative(DASH, f));
    }
  }
  // Non-vacuity: a derivation that finds nothing would make the whole rule
  // silently inert, which is exactly the failure being repaired. These two are
  // known to write and must always be in the derived set; if they are not, the
  // derivation is broken rather than the tree being clean.
  for (const known of ["lib/accounts/credentials.ts", "lib/accounts/service.ts"]) {
    if (!found.includes(known)) {
      errors.push(`mutation-surface derivation did not find ${known} — the rule is not working`);
    }
  }
  return found.sort();
}

// BUILD ARTEFACTS ONLY. `dist` and `e2e` used to be here, and walkFiles is what
// entrypoints() AND the routeFileCount floor both use — so a real Next route at
// app/api/e2e/route.ts was dropped from the entrypoint set and from the count
// it is checked against, and `eps.length < routeFileCount` stayed false. The
// floor's comment says it is "derived from the disk instead of guessed"; it was
// derived from the same crippled walk, so it could not notice.
//
// Skipping a directory that can hold application code is a decision about which
// code counts, and this file exists to not make that decision. node_modules and
// .next are not application code; test FILES are excluded by TEST_RE, by name,
// wherever they live.
const SKIP_DIRS = new Set(["node_modules", ".next"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXT = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Every source file. `.js` and friends are included in DISCOVERY, not just in
 * resolution — the audit added `app/api/danger/route.js` with a static import
 * of the credentials module and this file reported 26 entrypoints, unchanged,
 * PASS.
 */
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      // a dangling symlink is not "nothing here" — it is something unreadable
      errors.push(`${relative(DASH, p)}: cannot stat (dangling symlink?)`);
      continue;
    }
    if (st.isDirectory()) walkFiles(p, out);
    else if (SOURCE_RE.test(p) && !TEST_RE.test(p)) out.push(p);
  }
  return out;
}


/**
 * Does this module contain a Server Action?
 *
 * Deliberately crude: the string anywhere outside a comment. The audit defeated
 * the precise version twice — once by putting a banner comment above the
 * directive so it fell past the 200-byte window, once by using a
 * function-level `"use server"` inside a page, which is the more common React
 * form and which a file-head test cannot see by construction.
 *
 * Over-inclusion costs nothing here. An extra entrypoint makes the proof
 * stricter; a missed one makes it a lie.
 */
// `hasUseServer`, imported at the top of this file, IS this rule. There used
// to be a byte-identical local copy here called `hasServerAction`, and it was
// the copy that entrypoints() called — so the import was dead. eslint said so,
// in a warning that `npm run lint` does not fail on, which is how a commit
// footer claiming "lint clean" managed to be true and misleading at once.
//
// Two copies of the rule that decides which files are entrypoints is exactly
// the divergence that produced the 200-byte-window finding: tighten one and
// the other silently keeps answering the old way.

/** Production entrypoints, enumerated from disk. */
const ROUTE_FILE_RE = /\/(route|page|layout|template|error|global-error|loading|not-found|default)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function entrypoints() {
  const eps = new Set();
  for (const f of walkFiles(join(DASH, "app"))) {
    if (ROUTE_FILE_RE.test(f)) eps.add(f);
  }
  for (const name of ["proxy.ts", "middleware.ts", "instrumentation.ts"]) {
    const p = join(DASH, name);
    if (existsSync(p)) eps.add(p);
  }
  // Server Actions are production entrypoints too. A "use server" module is
  // invoked by a POST to a PAGE path carrying a Next-Action header — not by
  // anything under /api — so it is reached by neither the route enumeration
  // above nor the proxy's `isApi` freeze. Whether each is ALLOWED to exist is
  // a separate, explicit judgement asserted in server-actions.test.ts.
  for (const root of ["app", "lib", "components"]) {
    for (const f of walkFiles(join(DASH, root))) {
      let src;
      try {
        src = readFileSync(f, "utf8");
      } catch {
        errors.push(`${relative(DASH, f)}: unreadable while scanning for "use server"`);
        continue;
      }
      if (hasUseServer(src, f)) eps.add(f);
    }
  }
  return [...eps].sort();
}

/** Resolve an import specifier to a real file, or return null (a hard error). */
function resolveSpec(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return "EXTERNAL";
  const base = spec.startsWith("@/") ? join(DASH, spec.slice(2)) : resolve(dirname(fromFile), spec);
  for (const e of ["", ...EXT]) {
    const cand = base + e;
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  for (const e of EXT) {
    const cand = join(base, "index" + e);
    if (existsSync(cand)) return cand;
  }
  return null;
}

// A STATEMENT boundary, not a line boundary. These were anchored `(?:^|\n)\s*`,
// so only the FIRST import on a physical line was ever seen:
//
//     import a from "@/lib/x"; import { createAccount } from "@/lib/accounts/service";
//
// yielded one edge, and — worse than being wrong — said nothing about it. The
// second specifier simply did not exist as far as the walk was concerned, which
// put a whole subgraph inside a route closure with `modulesWalked` unchanged.
// `;`, `{` and `}` join `\n` as places a statement can begin. The accounting
// below is ONE-SIDED, deliberately and stated as such: it errors when there are
// MORE specifiers present than edges found, which is the direction that loses
// an edge. It does not police the other direction, so a `from "…"` inside a
// string literal inflates specCount and can only produce a false ERROR, never a
// missed edge. An earlier version of this comment said the two counts must be
// "equal", which is not what the code does.
const IMPORT_RE = /(?:^|[\n;{}])\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|[\n;{}])\s*import\s*["']([^"']+)["']/g;
/** Every `from "…"` / `import "…"` in the file, however it is positioned. */
const ANY_SPEC_RE = /\bfrom\s*["'][^"']+["']|(?:^|[\n;{}(])\s*import\s*["'][^"']+["']/g;
/** Computed access to a data-plane method: svc["rpc"], client['from'], … */
// FOLLOWED BY A CALL. Without that this matched any bracket access whose key
// happened to be one of these words, so `params["from"]` on a query-string
// record, `range["from"]` on a date filter, or the array literal `["delete"]`
// were all refused as "computed access to a data-plane method". `from` and
// `delete` are ordinary object keys in a dashboard; the attack is a CALL.
const COMPUTED_DATAPLANE_RE = /\[\s*["'`](rpc|from|insert|update|upsert|delete)["'`]\s*\]\s*(?:\?\.)?\s*\(/g;
/** WHICH VIEW EACH RULE READS IS PART OF THE RULE.
 *
 *  Rules that read a LITERAL — the quoted method name here, the table name in
 *  `.from("accounts")` — must see the comment-only view, because the
 *  string-blanked view empties exactly the token they match on. Rules that look
 *  for a SHAPE — a bare `from(`, a computed call, a Reflect.get — read the
 *  blanked view, so prose that happens to look like code is not a finding.
 *  Moving these two to the blanked view turned mutants 33 and 52 green, which
 *  is how this note came to exist.
 *
 *  The same bracket key NOT followed by a call: `const m = svc["rpc"]`.
 *
 *  Scoping the rule above to a CALL — done to stop `params["from"]` on a record
 *  being refused — reopened the reference form, which is the bracket spelling
 *  of exactly what FROM_REFERENCED_RE was added to close for the dotted one. A
 *  method taken now and called later is the oldest trick here; `.rpc` has
 *  refused it since mutant 18. Read over the string-blanked view, so a key
 *  appearing inside prose is not a finding. */
//  BOUND AND THEN CALLED, which is what separates the attack from a record
//  read. `const m = svc["rpc"]; m(...)` is the bracket spelling of taking a
//  method now and calling it later; `const a = params["from"]` is a query-string
//  lookup and must not be a finding. Matching the reference alone refused both —
//  green control 54 said so the moment it existed. The binding's name is
//  captured here and the caller checks whether it is invoked anywhere in the
//  module.
const COMPUTED_DATAPLANE_BOUND_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\[\s*["'`](rpc|from|insert|update|upsert|delete)["'`]\s*\](?!\s*(?:\?\.)?\s*\()/g;
/** …and the form with no literal key at all: `svc[m](…)`, `svc[k]?.(…)`.
 *
 *  The rule above only ever saw a QUOTED key, so `const m = "rpc"; svc[m]("…")`
 *  walked past it — and past the literal-name rule too, since the routine name
 *  can be concatenated. A call through a member this analyzer cannot read is
 *  unclassifiable by definition, which under the governing rule at the top of
 *  this file is an ERROR and not an absence.
 *
 *  Matches a CALL only. Ordinary computed READS (`obj[k].field`, `rows[i]`,
 *  `map[key] = v`) are untouched, which is why the tree still passes. */
// The lookahead excludes only a COMPLETE single literal — the form the rule
// above reads. `svc["r" + "pc"](...)` starts with a quote and is not one
// literal, so under the old `(?!["'`])` it was refused by neither rule, in a
// file whose header says an unclassifiable call must be an error.
const COMPUTED_CALL_RE =
  /\[\s*(?!["'`][^"'`]*["'`]\s*\])[^\]\n]{1,60}\]\s*(?:\?\.)?\s*\(/g;
/** A table write whose table name is NOT a literal.
 *
 * Scoped to the write, deliberately. A bare `.from(` matches `Buffer.from(...)`
 * — measured: exactly one, at lib/status/zip.ts:315 — an earlier note said
 * "four in lib/status/zip.ts", which counted Buffer.from across the whole tree
 * (zip.ts, read-model.test.ts, zip.test.ts, test/zip-builder.ts) and attributed
 * the total to one file — so counting every `.from(` against
 * the literal ones reports a ZIP reader as an unreadable data-plane call. What
 * matters is the shape TABLE_WRITE_RE is blind to: a `.from()` the rule cannot
 * read, feeding a method that writes. */
// The receiver is captured so builtins can be excluded. Without that,
// `Array.from(xs)` sitting within 300 characters of ANY `.delete(` or
// `.update(` — a Map, a Set, `headers.delete`, `searchParams.delete`, a crypto
// digest's `.update` — was reported as an unreadable data-plane write. The
// scoping was meant to stop `Buffer.from` tripping the rule and only half did.
// The receiver is captured so BUILTINS can be excluded — but capturing it as a
// required identifier made an identifier receiver MANDATORY, and
// `getSupabaseService().from(TABLE)` is the idiomatic spelling in this
// codebase. So the narrowing added to stop `Array.from` producing a false
// positive turned every factory-call receiver into a false NEGATIVE, which is
// strictly the worse direction. A call-expression receiver (`)`) is now matched
// too, and group 1 is simply absent for it, so only a named builtin is excused.
const FROM_NONLITERAL_WRITE_RE =
  /(?:([A-Za-z_$][\w$]*)|\))\s*\??\.\s*from\s*(?:\?\.)?\s*\(\s*(?!["'`])[^)]*\)[\s\S]{0,300}?\.\s*(insert|update|upsert|delete)\s*(?:\?\.)?\s*\(/g;

/* THE `.from` FAMILY GETS THE SAME ACCOUNTING `.rpc` HAS.
 *
 * Both write rules used to require the literal token `.from(`, so two ordinary
 * spellings defeated them at once and emitted nothing:
 *
 *     const { from } = svc; from("equity_snapshots").upsert(rows)   // no dot
 *     svc?.from?.("accounts")?.update?.({ … })                      // ?. between
 *
 * `.rpc` has had both halves of this since an earlier round — an explicit `\??`
 * for optional chaining AND RPC_ANY_RE to catch every mention it cannot
 * classify. The `.from` rules had neither, so an UNREADABLE `.from` was
 * reported as an ABSENT `.from` — the exact failure mode the header of this
 * file says is forbidden.
 *
 * A receiver allowlist is unavoidable because `Array.from` and `Buffer.from`
 * are ordinary code (measured: four `Buffer.from` in lib/status/zip.ts). It is
 * small, explicit, and has a positive control in the mutant suite so it cannot
 * quietly grow into a hole. */
const FROM_BUILTIN_RECEIVERS = new Set([
  "Array", "Buffer", "Object", "Date", "Promise", "Map", "Set", "WeakMap", "WeakSet",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);
/** `X.from(` / `X?.from?.(` with the receiver captured. */
// Same shape, same reason: a call-expression receiver must be seen. This one
// also feeds unpairedTableWrite, so the mandatory identifier silently narrowed
// the module-level pairing rule that exists to not depend on a window.
const FROM_WITH_RECEIVER_RE = /(?:([A-Za-z_$][\w$]*)|\))\s*\??\.\s*from\s*(?:\?\.)?\s*\(/g;
/** A `from(` call with no receiver at all — an alias or a destructured method. */
const FROM_BARE_CALL_RE = /(?:^|[^.\w$])from\s*(?:\?\.)?\s*\(/g;
/** `const { from } = …` / `const { from: alias } = …` */
const FROM_DESTRUCTURED_RE = /(?:const|let|var)\s*\{[^}]*\bfrom\b[^}]*\}\s*=/g;
/** A `.from` that is REFERENCED rather than called: `const tbl = svc.from;`.
 *  `.rpc` has had this since mutant 18 (`svc.rpc.bind(svc)` is an error); the
 *  `.from` rules stopped at the syntactic form their own mutant used, so
 *  `const tbl = svc.from; tbl(t).upsert(rows)` was invisible to both of them. */
// BOUND AND THEN CALLED, the same discrimination the bracket form needs. As a
// bare "any non-call `.from`" this fired on ordinary property access —
// `range.from` on a date filter, `obj.from.bar()`, `d.from = 1` — none of which
// is a method being taken to call later. The attack is
// `const tbl = svc.from; tbl(t).upsert(...)`.
const FROM_BOUND_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\.\s*from\s*(?![\w$]|\s*\(|\s*\?\.\s*\()/g;
/** `Reflect.get(svc, "rpc")` — a dot-free, bracket-free way to take the method,
 *  which combined with a concatenated routine name silences every other rule. */
const REFLECT_GET_RE = /\bReflect\s*\.\s*get\s*\(/g;
/** `const { rpc } = svc` — destructuring the RPC entry point, the `.from`
 *  equivalent of which has been refused since the round-9 repair. */
const RPC_DESTRUCTURED_RE = /(?:const|let|var)\s*\{[^}]*\brpc\b[^}]*\}\s*=/g;
/** `import(...)` and `require(...)`, literal or not — both are edges. */
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g;
/** Every mention of `.rpc`, however it is spelled. */
const RPC_ANY_RE = /\.rpc\b/g;
/** A directly classifiable call: optional generics, optional `?.`, literal name. */
const RPC_CALL_RE = /\.rpc\s*(?:<[^>]*>)?\s*\??\s*\(\s*([^,)]*)/g;

const closures = new Map();

function closureOf(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let raw;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      errors.push(`${relative(DASH, f)}: unreadable`);
      continue;
    }
    // WITH THE FILENAME. Without it guessKind returns TSX for every module, so
    // the same file was stripped one way here and another way in
    // forbiddenModules() and the offence loop — two views of one file inside a
    // single run, which is the "two copies of one rule" failure this file has
    // now had four times.
    const src = stripComments(raw, f);
    const code = stripCommentsAndStrings(raw, f);
    const rel = relative(DASH, f);

    // Every `.rpc` must be a direct call with a literal name. Anything else —
    // a generic argument, an alias, a `.bind`, a computed name — is a call this
    // analyzer cannot classify, and an unclassifiable call is a hole in the
    // proof, not an absence of one. The audit reached a tombstoned routine
    // through `.rpc<void>(...)` and through `svc.rpc.bind(svc)` while this
    // printed PASS.
    const mentions = (src.match(RPC_ANY_RE) ?? []).length;
    let classified = 0;
    for (const m of src.matchAll(RPC_CALL_RE)) {
      classified += 1;
      const arg = m[1].trim();
      if (!/^["'`][a-zA-Z0-9_]+["'`]$/.test(arg)) {
        errors.push(`${rel}: .rpc() called with a non-literal name (${arg.slice(0, 40)}) — cannot be classified`);
      }
    }
    if (mentions > classified) {
      errors.push(
        `${rel}: ${mentions - classified} reference(s) to .rpc that are not a direct call ` +
          `(alias, .bind, property access) — cannot be classified`,
      );
    }

    // Computed access to a data-plane method is not analyzable, and the two
    // RPC controls above both miss it: `svc["rpc"]("vault_" + "create_secret")`
    // contains no `.rpc` at all, and the concatenated name is not a literal.
    COMPUTED_DATAPLANE_RE.lastIndex = 0;
    for (const m of src.matchAll(COMPUTED_DATAPLANE_RE)) {
      errors.push(`${rel}: computed access to the data-plane method ${m[1]} (${m[0]}) — cannot be classified`);
    }
    for (const m of code.matchAll(REFLECT_GET_RE)) {
      errors.push(`${rel}: Reflect.get(...) takes a member this analyzer cannot read (${m[0].trim()}) — cannot be classified`);
    }
    for (const m of code.matchAll(RPC_DESTRUCTURED_RE)) {
      errors.push(`${rel}: \`rpc\` is destructured (${m[0].slice(0, 48)}) — a later rpc(...) call has no receiver this analyzer can read`);
    }
    COMPUTED_DATAPLANE_BOUND_RE.lastIndex = 0;
    for (const m of src.matchAll(COMPUTED_DATAPLANE_BOUND_RE)) {
      const bound = m[1];
      if (!new RegExp(`\\b${bound}\\s*(?:\\?\\.)?\\s*\\(`).test(code)) continue;
      errors.push(
        `${rel}: the data-plane method ${m[2]} is taken by computed reference as \`${bound}\` ` +
          `and called later — cannot be classified`,
      );
    }
    COMPUTED_CALL_RE.lastIndex = 0;
    for (const m of code.matchAll(COMPUTED_CALL_RE)) {
      errors.push(`${rel}: a call through a computed, non-literal member (${m[0].trim().slice(0, 40)}) — cannot be classified`);
    }

    // `.from(` with a non-literal argument. TABLE_WRITE_RE needs a quoted table
    // name, so `const T = "equity_snapshots"; svc.from(T).upsert(rows)` was not
    // a table write and the module never became mutation surface. Counted the
    // same way `.rpc` is: every occurrence must be one the rule can read.
    for (const m of code.matchAll(FROM_DESTRUCTURED_RE)) {
      errors.push(`${rel}: \`from\` is destructured (${m[0].slice(0, 48)}) — a later from(...) call has no receiver this analyzer can read`);
    }
    FROM_BOUND_RE.lastIndex = 0;
    for (const m of code.matchAll(FROM_BOUND_RE)) {
      const bound = m[1];
      if (!new RegExp(`\\b${bound}\\s*(?:\\?\\.)?\\s*\\(`).test(code)) continue;
      errors.push(
        `${rel}: \`.from\` is taken by reference as \`${bound}\` and called later — the ` +
          `table-write rules only read a direct call, so this is unclassifiable`,
      );
    }
    FROM_WITH_RECEIVER_RE.lastIndex = 0;
    for (const m of src.matchAll(FROM_WITH_RECEIVER_RE)) {
      if (m[1] && FROM_BUILTIN_RECEIVERS.has(m[1])) continue;
      const after = src.slice(m.index + m[0].length).trimStart();
      if (!/^["'`]/.test(after)) {
        errors.push(`${rel}: ${m[1]}.from(...) without a literal table name — the table-write rule cannot read it`);
      }
    }
    FROM_BARE_CALL_RE.lastIndex = 0;
    for (const m of code.matchAll(FROM_BARE_CALL_RE)) {
      errors.push(`${rel}: a from(...) call with no receiver (${m[0].trim().slice(0, 32)}) — cannot be classified`);
    }

    FROM_NONLITERAL_WRITE_RE.lastIndex = 0;
    for (const m of src.matchAll(FROM_NONLITERAL_WRITE_RE)) {
      if (m[1] && FROM_BUILTIN_RECEIVERS.has(m[1])) continue;
      errors.push(
        `${rel}: ${m[1]}.from(<non-literal>) feeding .${m[2]}() — the table-write rule needs a literal ` +
          `table name, so this write is invisible to it`,
      );
    }

    // And the imports must ADD UP. Widening the anchor fixes the case that was
    // found; this makes the next one an error instead of a silence, which is
    // the whole difference between a scanner that is right today and one that
    // says when it stops being right.
    // The stripper BLANKS comments to spaces rather than removing them, so a
    // stripped file is exactly as long as the raw one. Both counters below are
    // computed from the stripped source, so a stripper that DELETED a line
    // holding an import would drop specCount and edgeCount together and the
    // guard would be silent by construction — blind spot #4 quietly reopening
    // blind spot #1. This makes that impossible to miss rather than reasoning
    // that it cannot happen.
    if (src.length !== raw.length) {
      errors.push(
        `${rel}: the comment stripper changed the file's length (${raw.length} -> ${src.length}); ` +
          `it must blank comments, not delete them, or every count taken from it is unsafe`,
      );
    }
    const specCount = (src.match(ANY_SPEC_RE) ?? []).length;
    let edgeCount = 0;
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      edgeCount += [...src.matchAll(re)].length;
    }
    if (specCount > edgeCount) {
      errors.push(
        `${rel}: ${specCount} module specifier(s) present but only ${edgeCount} import edge(s) matched — ` +
          `the import scanner is dropping ${specCount - edgeCount} of them`,
      );
    }

    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const target = resolveSpec(m[1], f);
        if (target === "EXTERNAL") continue;
        if (target === null) {
          errors.push(`${rel}: unresolved import '${m[1]}'`);
          continue;
        }
        stack.push(target);
      }
    }

    // Dynamic edges. `await import("@/lib/accounts/credentials")` is an import
    // by any reasonable reading, and following only the static form let the
    // audit put the entire credentials subgraph one `await` away from a GET
    // with the module count unchanged.
    for (const m of src.matchAll(DYNAMIC_RE)) {
      const arg = m[1].trim();
      const lit = arg.match(/^["'`]([^"'`]+)["'`]$/);
      if (!lit) {
        // an unresolvable dynamic edge could go anywhere, including here
        errors.push(`${rel}: dynamic import/require with a non-literal specifier (${arg.slice(0, 40)})`);
        continue;
      }
      const target = resolveSpec(lit[1], f);
      if (target === "EXTERNAL") continue;
      if (target === null) {
        errors.push(`${rel}: unresolved dynamic import '${lit[1]}'`);
        continue;
      }
      stack.push(target);
    }
  }
  return seen;
}

const FORBIDDEN_MODULES = forbiddenModules();

const eps = entrypoints();

// Enumeration must not silently degrade. A floor of 5 against a population of
// 26 would let four fifths of the surface vanish unnoticed, so the floor is
// derived from the disk instead of guessed: there cannot be fewer entrypoints
// than there are route files.
const routeFileCount = walkFiles(join(DASH, "app")).filter((f) => ROUTE_FILE_RE.test(f)).length;
if (eps.length < routeFileCount) {
  errors.push(`${eps.length} entrypoints but ${routeFileCount} route files on disk — enumeration is dropping files`);
}
if (eps.length === 0) errors.push("zero entrypoints discovered — enumeration is broken");
if (FORBIDDEN_ROUTINES.length === 0) errors.push("no forbidden routines — there is nothing to prove");

let modulesWalked = 0;
const offences = [];

for (const ep of eps) {
  const cl = closureOf(ep);
  closures.set(ep, cl);
  modulesWalked += cl.size;
  const rel = relative(DASH, ep);

  for (const f of cl) {
    const fr = relative(DASH, f);
    const src = stripComments(readFileSync(f, "utf8"), f);
    for (const routine of FORBIDDEN_ROUTINES) {
      // The NAME as a string literal, not a particular call syntax. Production
      // code has no reason to name a routine that exists only to raise. This
      // catches aliasing, dispatch tables and generics in one rule, where
      // matching `.rpc("name")` caught only the shape already thought of.
      if (new RegExp(`["'\`]${routine}["'\`]`).test(src)) {
        offences.push(`${rel} -> ${fr}: names tombstoned routine ${routine}`);
      }
    }
    // Applied to THIS module's source, not looked up in a list built by a
    // different walk. `namesTombstone` is already reported above with the
    // routine named, so only report the table-write half here to avoid
    // duplicating one offence as two.
    if (isTableWrite(src)) {
      offences.push(`${rel} -> ${fr}: mutation surface in a production entrypoint closure`);
      if (!FORBIDDEN_MODULES.includes(fr)) {
        errors.push(
          `${fr} is mutation surface reachable from ${rel}, but the derivation's roots ` +
            `(app, lib, components minus ${[...SKIP_DIRS].join("/")}) never scanned it — ` +
            `the reported surface understates what the walk reaches`,
        );
      }
    }
  }
}

if (modulesWalked === 0) errors.push("zero modules walked — the graph walk is vacuous");

// POSITIVE CONTROL: the walker must actually be finding real edges. If the
// closure of a known route does not contain a module we know it imports, the
// resolver is broken and every "absent" above is meaningless.
const probe = eps.find((e) => e.endsWith(join("app", "api", "accounts", "route.ts")));
if (!probe) {
  errors.push("positive control: app/api/accounts/route.ts not among entrypoints");
} else if (!closures.get(probe).has(join(DASH, "lib", "accounts", "read.ts"))) {
  errors.push("positive control FAILED: accounts route closure lacks lib/accounts/read.ts — the resolver is broken");
}

console.log(`entrypoints: ${eps.length} (route files on disk: ${routeFileCount})`);
console.log(`modules walked (with repeats): ${modulesWalked}`);
console.log(`forbidden routines (derived from every migration): ${FORBIDDEN_ROUTINES.join(", ")}`);
console.log(`mutation surface (derived: table writes + tombstoned-routine names): ${FORBIDDEN_MODULES.join(", ")}`);

// EVERY FINDING CARRIES A MARKER, and no informational line does.
//
// The falsification harness matched its required substring against the whole
// of stdout+stderr, and this program prints
//     mutation surface (derived: table writes + tombstoned-routine names): …
// unconditionally, on green runs too. Fifteen of the mutants required only the
// bare words "mutation surface", so the banner alone satisfied them and their
// scoring collapsed to "non-zero exit means detected" — the very thing the
// harness header says it fixed ("a crash is not a detection; each case has to
// produce ITS OWN offence string"). With a marker the harness can grep only
// lines that are actually findings, so an informational line can never stand
// in for one again.
if (errors.length) {
  console.error("\nFAIL-CLOSED ERRORS:");
  for (const e of errors) console.error("  FINDING[error] " + e);
}
if (offences.length) {
  console.error("\nREACHABILITY OFFENCES:");
  for (const o of offences) console.error("  FINDING[offence] " + o);
}
if (errors.length || offences.length) {
  console.error(`\nREACHABILITY: FAIL (${errors.length} errors, ${offences.length} offences)`);
  process.exit(1);
}
console.log("\nREACHABILITY: PASS — no production entrypoint closure reaches a tombstoned routine");
