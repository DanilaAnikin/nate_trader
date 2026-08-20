#!/usr/bin/env bash
# ============================================================================
# Falsification for the reachability analyzer.
#
# A static proof that never goes red is indistinguishable from no proof. Each
# mutation below reintroduces a way for a production entrypoint to reach a
# tombstoned routine — or blinds the analyzer — and the analyzer MUST report it.
#
# WHAT THE PROOF-HONESTY AUDIT CHANGED HERE
# -----------------------------------------
# The previous version of this file had three defects of its own, and the first
# two are the more embarrassing because they are the same defects it exists to
# catch:
#
#   1. Every mutation was written in the ONE syntactic form the analyzer
#      already recognised. It proved the analyzer was not asleep; it never
#      probed the boundary of what the analyzer could SEE. The audit reached a
#      tombstoned routine seven different ways — import(), require(), .rpc<T>(),
#      .bind, a .js route, a directive at byte 201, a function-level
#      "use server" — and every one of them was reported PASS.
#
#   2. `expect_red` scored ANY nonzero exit as "detected". A dangling symlink
#      made the analyzer throw before it walked anything; the harness scored
#      that as a catch. A crash is not a detection — it is the absence of one.
#      Each case now has to produce ITS OWN offence string.
#
#   3. Mutant 13 was labelled "zero entrypoints is not a pass" but left six
#      entrypoints standing, and failed via the same positive-control error as
#      mutant 14 — so it was a duplicate, the eps-floor guard was exercised by
#      nothing, and the honest count was 13 distinct mutations rather than the
#      "15/15" reported (which also counted the baseline control as a mutant).
#      The count printed at the end is now the number of mutations, and the
#      baseline is scored separately.
#
# Every mutation is applied to a COPY. The real worktree is never modified.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$DASH/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reach-mutants.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

MUTANTS=0; OK=0; BAD=0
note(){ printf '  %-6s %-56s %s\n' "$1" "$2" "${3:-}"; }

# A copy without node_modules/.next — the analyzer reads source only. The
# migration tree comes too: the forbidden list is read from it, so a copy
# without it would make every mutant fail for the wrong reason.
prepare(){
  local d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d/dashboard"
  ( cd "$DASH" && tar --exclude=node_modules --exclude=.next --exclude=.git -cf - . ) \
    | tar -xf - -C "$d/dashboard"
  # node_modules is EXCLUDED from the copy (it is ~1GB) but the analyzer needs
  # it: source-scan.mjs imports the TypeScript compiler, because the two
  # hardest tokenisation questions in JavaScript — regex-vs-division and JSX —
  # cannot be answered by a hand-written scanner, and an auditor defeated the
  # hand-written one in both. A symlink costs nothing and keeps the mutant tree
  # a faithful copy in every way that matters to the analysis.
  ln -s "$DASH/node_modules" "$d/dashboard/node_modules"
  mkdir -p "$d/supabase"
  cp -r "$REPO/supabase/migrations" "$d/supabase/migrations"
  echo "$d/dashboard"
}

run_analyzer(){ node "$1/test/containment/reachability.mjs" >"$1/out.txt" 2>&1; }

# expect_red <label> <mutator-fn> <required-substring>
#
# The substring is what makes this a detection rather than a crash. It must be
# the offence the mutation was written to provoke.
# A digest over the prepared tree, so a mutation that changes nothing can be
# told from one that changes something.
# Over the WHOLE prepared root, not just its dashboard/ subtree. `prepare`
# returns "$d/dashboard" but also copies supabase/migrations beside it, and
# four mutants (22, 24, 29, 31) patch only the migrations — digesting the
# dashboard alone reported those as "changed nothing" the moment this guard was
# added, which would have been a false accusation against four working mutants.
# STRUCTURE AND CONTENT. Content alone is not enough: mutant 22 plants a
# DANGLING SYMLINK, which `find -type f` does not match and which has no
# content to hash, so a content-only digest called that mutation "no change"
# and accused a working mutant of being disarmed. The entry list carries the
# type and the link target, so creations, deletions and symlinks all move it.
tree_digest(){
  local root; root="$(dirname "$1")"
  {
    find "$root" -not -path '*/node_modules/*' -printf '%y %P %l\n' 2>/dev/null | LC_ALL=C sort
    find "$root" -type f -not -path '*/node_modules/*' -print0 2>/dev/null \
      | LC_ALL=C sort -z | xargs -0 sha256sum 2>/dev/null
  } | sha256sum | cut -d' ' -f1
}

expect_red(){
  local label="$1" fn="$2" want="$3"
  MUTANTS=$((MUTANTS+1))
  local d; d="$(prepare "m$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')")"
  local before; before="$(tree_digest "$d")"
  "$fn" "$d"
  # THE MUTATION MUST HAVE MUTATED SOMETHING.
  #
  # Mutant 27 patched a source line by exact string match; a refactor renamed
  # that line, `str.replace` found nothing, the "mutant" was a pristine tree,
  # and the analyzer passed it — reported as a MISSED mutation, which reads as
  # a hole in the analyzer when it was a hole in the mutant. A no-op mutation
  # is a harness failure and has to say so in its own words, because the two
  # look identical from the outside.
  if [[ "$(tree_digest "$d")" == "$before" ]]; then
    BAD=$((BAD+1)); note NOT-OK "$label" "the mutation changed NOTHING — this mutant is disarmed, not passing"
    return
  fi
  if run_analyzer "$d"; then
    BAD=$((BAD+1)); note NOT-OK "$label" "analyzer still PASSED"
  elif grep -F 'FINDING[' "$d/out.txt" | grep -qF -- "$want"; then
    OK=$((OK+1)); note ok "$label"
  else
    BAD=$((BAD+1)); note NOT-OK "$label" "went red, but not for '$want'"
    tail -3 "$d/out.txt" | sed 's/^/           /'
  fi
}

echo "reachability falsification"
echo

# ── baseline must be green, or nothing below means anything ─────────────────
BASE="$(prepare baseline)"
if run_analyzer "$BASE"; then
  note ok "BASELINE is green (control, not a mutant)"
  # AND IT EMITS NO FINDING LINE AT ALL. Expectations are matched only against
  # lines carrying the FINDING[ marker; this is what makes that meaningful. The
  # analyzer prints "mutation surface (derived: …)" unconditionally, green runs
  # included, and fifteen mutants used to require only the words "mutation
  # surface" — so the banner alone satisfied them and their scoring collapsed
  # to "non-zero exit means detected". If a green run ever emits a FINDING line,
  # every expectation below is potentially satisfiable without the mutation.
  if grep -q 'FINDING\[' "$BASE/out.txt"; then
    note NOT-OK "BASELINE emits a FINDING line on a GREEN run" "expectations could be satisfied without the mutation"
    grep 'FINDING\[' "$BASE/out.txt" | head -3 | sed 's/^/           /'
    exit 1
  fi
  note ok "BASELINE emits no FINDING line (so no expectation is satisfiable by informational output)"
else
  note NOT-OK "BASELINE is green" "$(tail -3 "$BASE/out.txt" | tr '\n' ' ')"
  echo; echo "baseline is not green — aborting, every mutant result would be meaningless"; exit 1
fi

REACH="reaches\|names tombstoned\|mutation surface"

# ── I. forms the analyzer already recognised ────────────────────────────────
m1(){ sed -i '1i import { purgeCredentials } from "@/lib/accounts/credentials";' "$1/app/api/accounts/route.ts"; }
expect_red "1 route imports credentials directly" m1 "app/api/accounts/route.ts -> lib/accounts/credentials.ts"

m2(){ cat > "$1/lib/helper-hop.ts" <<'EOF'
import { purgeCredentials } from "@/lib/accounts/credentials";
export const hop = purgeCredentials;
EOF
  sed -i '1i import { hop } from "@/lib/helper-hop";' "$1/app/api/accounts/route.ts"; }
expect_red "2 route imports it through one helper" m2 "app/api/accounts/route.ts -> lib/accounts/credentials.ts"

m3(){ cat > "$1/lib/reexport-a.ts" <<'EOF'
export { purgeCredentials } from "@/lib/accounts/credentials";
EOF
  cat > "$1/lib/reexport-b.ts" <<'EOF'
export { purgeCredentials } from "@/lib/reexport-a";
EOF
  sed -i '1i import { purgeCredentials } from "@/lib/reexport-b";' "$1/app/api/accounts/route.ts"; }
expect_red "3 route imports it through a re-export chain" m3 "app/api/accounts/route.ts -> lib/accounts/credentials.ts"

m4(){ sed -i 's|import { listAccounts } from "@/lib/accounts/read";|import { listAccounts } from "@/lib/accounts/service";|' "$1/app/api/accounts/route.ts"; }
expect_red "4 GET imports the combined service" m4 "mutation surface in a production entrypoint closure"

m5(){ sed -i 's|const accounts = await listAccounts(user.id);|const accounts = await listAccounts(user.id); await (supa as never as {rpc:(n:string)=>Promise<unknown>}).rpc("vault_create_secret");|' "$1/app/api/accounts/route.ts"; }
expect_red "5 tombstoned call inside a GET" m5 "names tombstoned routine vault_create_secret"

m6(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/[id]/route.ts"; s=p.read_text()
s=s.replace('import { frozenResponse } from "@/lib/frozen";',
 'import { frozenResponse } from "@/lib/frozen";\nimport { getSupabaseService } from "@/lib/supabase/service";')
s=s.replace('export async function PATCH(): Promise<Response> {\n  return frozenResponse();',
 'export async function PATCH(): Promise<Response> {\n  await getSupabaseService().rpc("vault_update_secret");\n  return frozenResponse();')
p.write_text(s)
PY
}
expect_red "6 tombstoned call inside a mutating handler" m6 "names tombstoned routine vault_update_secret"

m7(){ python3 - "$1" <<'PY'
import pathlib,sys,glob
d=pathlib.Path(sys.argv[1])
q=pathlib.Path(sorted(glob.glob(str(d/"app/(app)/*/page.tsx")))[0])
q.write_text('import { purgeCredentials } from "@/lib/accounts/credentials";\nvoid purgeCredentials;\n'+q.read_text())
PY
}
expect_red "7 tombstoned reach from a page" m7 "app/(app)/accounts/page.tsx -> lib/accounts/credentials.ts"

m8(){ sed -i '1i import { purgeCredentials } from "@/lib/accounts/credentials";' "$1/proxy.ts"; }
expect_red "8 tombstoned reach from the proxy" m8 "proxy.ts -> lib/accounts/credentials.ts"

m9(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s='import { purgeCredentials } from "@/lib/accounts/credentials";\n'+s
s=s.replace('export async function POST(): Promise<Response> {',
 'export async function POST(): Promise<Response> {\n  if (false as boolean) { await purgeCredentials(null as never, null as never, null as never); }')
p.write_text(s)
PY
}
expect_red "9 hidden behind a constant-false branch" m9 "app/api/accounts/route.ts -> lib/accounts/credentials.ts"

m10(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const n = "vault_" + "create_secret"; await (supa as never as {rpc:(x:string)=>Promise<unknown>}).rpc(n);\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PY
}
expect_red "10 computed RPC name is unclassifiable" m10 "cannot be classified"

m11(){ mkdir -p "$1/app/api/sneaky"; cat > "$1/app/api/sneaky/route.ts" <<'EOF'
import { purgeCredentials } from "@/lib/accounts/credentials";
export async function GET() { void purgeCredentials; return new Response("x"); }
EOF
}
expect_red "11 a newly added .ts route is enumerated" m11 "app/api/sneaky/route.ts -> lib/accounts/credentials.ts"

m12(){ sed -i '1i import { nope } from "@/lib/does-not-exist";' "$1/app/api/accounts/route.ts"; }
expect_red "12 unresolved import fails closed" m12 "unresolved import"

m13(){ rm -rf "$1/app" "$1/proxy.ts" "$1/middleware.ts" "$1/instrumentation.ts" "$1/lib" "$1/components"; }
expect_red "13 zero entrypoints is not a pass" m13 "zero entrypoints discovered"

m14(){ sed -i 's|import { listAccounts } from "@/lib/accounts/read";|const listAccounts = async (_: string) => [];|' "$1/app/api/accounts/route.ts"; }
expect_red "14 positive control fires when its subject vanishes" m14 "positive control"

# ── II. forms the audit used to walk straight past it ───────────────────────
# Every one of these produced PASS with the module count unchanged.

m15(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const { purgeCredentials } = await import("@/lib/accounts/credentials");\n    void purgeCredentials;\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PY
}
expect_red "15 dynamic import() is an edge" m15 "app/api/accounts/route.ts -> lib/accounts/credentials.ts"

m16(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const c = require("@/lib/accounts/credentials");\n    void c;\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PY
}
expect_red "16 require() is an edge" m16 "app/api/accounts/route.ts -> lib/accounts/credentials.ts"

m17(){ cat >> "$1/lib/accounts/read.ts" <<'EOF'

export async function reapKeys(svc: { rpc<T>(n: string, a?: unknown): Promise<T> }, id: string) {
  await svc.rpc<void>("vault_delete_secret", { p_id: id });
}
EOF
}
expect_red "17 .rpc<T>() with a generic argument" m17 "names tombstoned routine vault_delete_secret"

m18(){ cat >> "$1/lib/accounts/read.ts" <<'EOF'

export async function reapAliased(svc: { rpc: (n: string) => Promise<unknown> }) {
  const f = svc.rpc.bind(svc);
  await f("vault_create_secret");
}
EOF
}
expect_red "18 an aliased .rpc cannot be classified" m18 "not a direct call"

m19(){ mkdir -p "$1/app/api/danger"; cat > "$1/app/api/danger/route.js" <<'EOF'
import { purgeCredentials } from "@/lib/accounts/credentials";
export async function POST(req) { const b = await req.json(); await purgeCredentials(null, b.k, b.s); return new Response("{}"); }
EOF
}
expect_red "19 a .js route is discovered, not just resolved" m19 "app/api/danger/route.js -> lib/accounts/credentials.ts"

m20(){ cat > "$1/lib/ledger-actions.ts" <<'EOF'
/* ------------------------------------------------------------------------
 * A banner comment long enough to push the directive prologue past the
 * two-hundredth byte of this file, which is exactly how the previous
 * enumerator was persuaded that this module contains no Server Action at
 * all. The directive below is legal and Next.js honours it.
 * --------------------------------------------------------------------- */
"use server";
import { purgeCredentials } from "@/lib/accounts/credentials";
export async function reap(id: string) { void purgeCredentials; void id; }
EOF
}
expect_red "20 a directive past byte 200 is still a Server Action" m20 "lib/ledger-actions.ts -> lib/accounts/credentials.ts"

# IN A FILE THAT IS NOT OTHERWISE AN ENTRYPOINT. This mutant used to append
# its action to app/(app)/*/page.tsx — a file ROUTE_FILE_RE already makes an
# entrypoint by filename — so its detection proved the dynamic import edge was
# followed, not that a function-level directive CREATES an entrypoint. It
# passed for a reason other than the one on its label, which is the failure
# mode this suite exists to catch and had already caught once in mutant 35.
# lib/reap-actions.ts enters the entrypoint set only if the directive is seen.
m21(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1])
(d/"lib/reap-actions.ts").write_text(
 'const BANNER = 1;\n'
 'export async function reapAccountAction(id: string) {\n'
 '  "use server";\n'
 '  const creds = await import("@/lib/accounts/credentials");\n'
 '  void creds; void id; void BANNER;\n'
 '}\n')
PYX
}
expect_red "21 a function-level \"use server\" is a Server Action" m21 "lib/reap-actions.ts -> lib/accounts/credentials.ts"

m22(){ ln -s /nonexistent/target "$1/app/api/dangling.ts"; }
expect_red "22 a dangling symlink is an error, not a crash" m22 "cannot stat"

m23(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const mod = "@/lib/accounts/" + "credentials"; await import(mod);\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PY
}
expect_red "23 a computed dynamic import cannot be classified" m23 "non-literal specifier"

m24(){ python3 - "$1" <<'PY'
import pathlib,sys,re,glob
# the forbidden list is read from the migration; corrupting it must not
# silently shrink what is checked
d=pathlib.Path(sys.argv[1]).parent/"supabase/migrations"
f=sorted(glob.glob(str(d/"0022_*.sql")))[0]
p=pathlib.Path(f); s=p.read_text()
s=s.replace("'vault_create_secret', 'vault_update_secret', 'vault_delete_secret'","'vault_create_secret'")
p.write_text(s)
PY
}
expect_red "24 a shrunken tombstone list is not accepted" m24 "expected at least 5"

# ── III. the module the hand-pinned list used to miss ───────────────────────
m25(){ sed -i '1i import { backfillEquity } from "@/lib/accounts/equity-backfill";' "$1/app/api/accounts/route.ts"; }
expect_red "25 equity-backfill in a closure (the old list missed it)" m25 "mutation surface in a production entrypoint closure"

m26(){ python3 - "$1" <<'PYX'
import pathlib,sys,shutil
d=pathlib.Path(sys.argv[1])
# a renamed copy of the mutation surface: the hand-pinned list was defeated by
# exactly this, which is why the set is derived rather than listed
shutil.copy(d/"lib/accounts/credentials.ts", d/"lib/accounts/creds2.ts")
p=d/"app/api/accounts/route.ts"
p.write_text('import * as c2 from "@/lib/accounts/creds2";\nvoid c2;\n'+p.read_text())
PYX
}
expect_red "26 a RENAMED copy of the mutation surface" m26 "app/api/accounts/route.ts -> lib/accounts/creds2.ts"

m27(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1])
# break the derivation itself. If it finds nothing the rule is inert, and that
# must be an ERROR rather than a clean tree — the failure mode the two blockers
# of the day both had.
p=d/"test/containment/reachability.mjs"; s=p.read_text()
s=s.replace("if (isMutationSurface(src)) found.push(relative(DASH, f));",
            "if (false) found.push(relative(DASH, f));")
p.write_text(s)
PYX
}
expect_red "27 a broken derivation is an error, not a clean tree" m27 "the rule is not working"

# ── IV. the second tombstoning mechanism ────────────────────────────────────
m28(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1])
# resolve_create_operation is tombstoned by 0022 INLINE, not by the section-5
# loop. A derivation scoped to that loop misses it, which is what an audit
# demonstrated in the sibling catalogue classifier.
p=d/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'await (supa as never as {rpc:(n:string)=>Promise<unknown>}).rpc("resolve_create_operation");\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "28 an INLINE-tombstoned routine is forbidden too" m28 "names tombstoned routine resolve_create_operation"

m29(){ python3 - "$1" <<'PYX'
import pathlib,sys,glob,re
d=pathlib.Path(sys.argv[1]).parent/"supabase/migrations"
f=sorted(glob.glob(str(d/"0022_*.sql")))[0]
p=pathlib.Path(f); s=p.read_text()
# remove the inline tombstone's raise; the mechanism-2 scan must notice it
# found nothing rather than silently contributing zero to the union
s=s.replace("'resolve_create_operation(uuid, uuid) is superseded: pass the expected request fingerprint'",
            "'resolve_create_operation(uuid, uuid) is retired'")
p.write_text(s)
PYX
}
# The mutation removes 0022's inline raise. The inline scan still finds
# 0017's two, so the count floor does not fire — the NAMED-routine check
# does, which is the more specific and more useful reason.
expect_red "29 losing one inline tombstone is an error" m29 "resolve_create_operation is tombstoned inline but is not in the derived set"

# ── V. tombstones outside migration 0022 ────────────────────────────────────
m30(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
# reconcile_cash_flow_mirror is tombstoned by 0017, not 0022. A derivation
# scoped to one migration cannot see it.
s=s.replace('const accounts = await listAccounts(user.id);',
 'await (supa as never as {rpc:(n:string)=>Promise<unknown>}).rpc("reconcile_cash_flow_mirror");\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "30 a routine tombstoned by 0017, not 0022" m30 "names tombstoned routine reconcile_cash_flow_mirror"

m31(){ python3 - "$1" <<'PYX'
import pathlib,sys,glob
d=pathlib.Path(sys.argv[1]).parent/"supabase/migrations"
# blunt the self-naming requirement: if the scan stops recognising the inline
# form, that is a broken scan, not a cleaner tree
f=sorted(glob.glob(str(d/"0017_*.sql")))[0]
p=pathlib.Path(f); s=p.read_text()
s=s.replace("reconcile_cash_flow_mirror is superseded by publish_broker_refresh",
            "this routine has been retired in favour of publish_broker_refresh")
s=s.replace("replace_equity_snapshots is superseded by publish_broker_refresh",
            "this routine has been retired in favour of publish_broker_refresh")
p.write_text(s)
PYX
}
expect_red "31 a silently-shrunken inline scan is an error" m31 "the inline-tombstone scan yielded"


# ── VI. the four parser blind spots an audit measured (round 9) ─────────────
# Each of these was verified against the shipped regexes before the fix: the
# analyzer did not merely miss them, it reported PASS and said nothing.

# The import scanner was anchored `(?:^|\n)\s*`, so only the FIRST import on a
# physical line existed. Measured: the two-specifier line below yielded exactly
# one edge, ["@/lib/status/broker"], and no error — the credentials subgraph
# entered a route closure with modulesWalked unchanged.
m32(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=('import { brokerStatus } from "@/lib/status/broker"; '
   'import { purgeCredentials } from "@/lib/accounts/credentials";\n') + s
p.write_text(s)
PYX
}
# Asserts the EDGE — the offence naming lib/accounts/credentials.ts — rather
# than one particular wording. credentials.ts is now reported with the more
# specific "names tombstoned routine" reason, because the offence loop applies
# the table-write rule to the module it is holding instead of looking the name
# up in a list; either way the point of this mutant is that the second
# specifier on the line produced an import edge at all.
expect_red "32 a second import on the same line is an edge, not a silence" m32 \
  "-> lib/accounts/credentials.ts"

# `.rpc` was matched as /\.rpc\b/, which computed access does not contain, and
# the concatenated name is not a literal — so BOTH RPC controls missed it.
m33(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'await (supa as never as Record<string, (n: string) => Promise<unknown>>)["rpc"]("vault_" + "create_secret");\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "33 computed access to a data-plane method cannot be classified" m33 \
  "computed access to the data-plane method rpc"

# TABLE_WRITE_RE needs a quoted table name, so a variable defeated it and the
# module never became mutation surface.
m34(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"lib/status/broker.ts"; s=p.read_text()
s += ('\n\nexport async function drift(svc: { from: (t: string) => { upsert: (r: unknown) => Promise<unknown> } }) {\n'
      '  const t = "equity_snapshots";\n'
      '  await svc.from(t).upsert({ id: 1 });\n'
      '}\n')
p.write_text(s)
PYX
}
expect_red "34 a non-literal table name feeding a write is not invisible" m34 \
  "the table-write rule needs a literal"

# stripComments was two `replace` calls; the second could not tell a comment
# from a slash inside a regex literal, and deleted the rest of the line.
# Measured against the old helper: `const sep = /\//;` stripped the file to
# `const sep = /\` and the write below it vanished from every check.
m35(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"lib/status/broker.ts"; s=p.read_text()
s += ('\n\nexport function hidden(svc: { from: (t: string) => { update: (r: unknown) => { eq: (a: string, b: string) => Promise<unknown> } } }, id: string) {\n'
      # ON ONE LINE, which is the whole point. The old stripComments deleted
      # from the slash to the end of the LINE, so a regex literal on its own
      # line hid nothing — measured: separated, the UNFIXED analyzer caught
      # this mutant too, i.e. it passed for the wrong reason. Joined, the
      # unfixed analyzer reports PASS and the write is invisible.
      '  const sep = /\\//; return svc.from(\"accounts\").update({ nickname: \"x\" }).eq(\"id\", id); void sep;\n'
      '}\n')
p.write_text(s)
PYX
}
expect_red "35 a regex literal cannot hide the code after it" m35 \
  "mutation surface in a production entrypoint closure"

# ── VII. the position the round-9 fix did not cover (round 10) ─────────────
# Mutant 35 proved a regex literal cannot hide the code after it — but it wrote
# the regex after `=`, which the hand-written scanner's heuristic happened to
# handle. An auditor moved the SAME regex to the far more common statement
# position `if (cond) /re/.test(x)`, where the heuristic read it as division,
# copied the regex body into the code stream, and let the `//` inside a URL
# pattern delete the rest of the line. Measured against the shipped scanner:
# `REACHABILITY: PASS`, rc 0, with a call to a tombstoned routine on that line.
#
# The suite had been probing exactly the one position its own fix covered. This
# mutant differs from 35 ONLY in where the regex sits.
m36(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'if (user.id.length) /^https?:\\/\\//.test(user.id); await (supa as never as {rpc:(n:string)=>Promise<unknown>}).rpc("vault_create_secret");\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "36 a regex in statement position cannot hide the code after it" m36 \
  "names tombstoned routine vault_create_secret"

# The same class, on the write side, which matters more: a table write is not
# refused by the database tombstone, so hiding one is an unrefused mutation.
m37(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"lib/status/broker.ts"; s=p.read_text()
s += ('\n\nexport function hidden2(svc: { from: (t: string) => { update: (r: unknown) => { eq: (a: string, b: string) => Promise<unknown> } } }, id: string) {\n'
      '  if (id.length) /^https?:\\/\\//.test(id); return svc.from("accounts").update({ nickname: "x" }).eq("id", id);\n'
      '}\n')
p.write_text(s)
PYX
}
expect_red "37 a regex in statement position cannot hide a table write" m37 \
  "mutation surface in a production entrypoint closure"

# ── VIII. the two walks that were not the same walk (round 10) ─────────────
# Every one of the 37 mutants above plants its payload inside app/, lib/ or
# components/ and outside SKIP_DIRS, so the suite only ever exercised the
# INTERSECTION of the derivation's roots and the closure walk, and could not
# observe that they differ. These two plant outside it.

# A writer module in a directory the derivation never enumerated. Measured
# against the shipped code: modulesWalked 363 -> 364, so the analyzer walked
# INTO the file, and still reported PASS.
m38(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1])
(d/"server").mkdir(exist_ok=True)
(d/"server/writer.ts").write_text(
 'import { getSupabaseService } from "@/lib/supabase/service";\n'
 'export async function wipe(id: string) {\n'
 '  const svc = getSupabaseService();\n'
 '  await svc.from("accounts").delete().eq("id", id);\n'
 '}\n')
p=d/"app/api/accounts/route.ts"; s=p.read_text()
p.write_text('import { wipe } from "@/server/writer";\nvoid wipe;\n' + s)
PYX
}
expect_red "38 a writer outside the derivation's roots is still in the closure" m38 \
  "mutation surface in a production entrypoint closure"

# The same, inside a SKIP_DIRS directory.
m39(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1])
(d/"lib/e2e").mkdir(parents=True, exist_ok=True)
(d/"lib/e2e/writer.ts").write_text(
 'import { getSupabaseService } from "@/lib/supabase/service";\n'
 'export async function wipe2(id: string) {\n'
 '  const svc = getSupabaseService();\n'
 '  await svc.from("accounts").delete().eq("id", id);\n'
 '}\n')
p=d/"app/api/accounts/route.ts"; s=p.read_text()
p.write_text('import { wipe2 } from "@/lib/e2e/writer";\nvoid wipe2;\n' + s)
PYX
}
expect_red "39 a writer inside a skipped directory is still in the closure" m39 \
  "mutation surface in a production entrypoint closure"

# ── IX. the .from spellings the write rules could not read (round 10) ──────
# Every write mutant above is spelled `.from(`. These are the two ordinary
# spellings that defeated BOTH write rules at once while emitting nothing —
# an unreadable `.from` reported as an absent `.from`.
m40(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const { from } = supa as unknown as { from: (t: string) => { upsert: (r: unknown) => Promise<unknown> } };\n'
 '    await from("equity_snapshots").upsert({ id: 1 });\n'
 '    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "40 a destructured from() is unclassifiable, not absent" m40 \
  "is destructured"

m41(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const w = supa as unknown as { from?: (t: string) => { update?: (r: unknown) => Promise<unknown> } };\n'
 '    await w?.from?.("accounts")?.update?.({ nickname: "x" });\n'
 '    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "41 optional chaining does not hide a table write" m41 \
  "mutation surface in a production entrypoint closure"

# POSITIVE CONTROL on the receiver allowlist. Array.from and Buffer.from are
# ordinary code; if the allowlist ever stopped working the suite would go red
# on the pristine tree, and somebody would widen the rule to make it green.
# This asserts the allowlist is doing its job on a real construct, so the
# refusals above are about the data plane and not about JavaScript.
m42(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"lib/status/broker.ts"; s=p.read_text()
s += ('\n\nexport function ordinary(xs: Iterable<number>, b: string) {\n'
      '  return Array.from(xs).length + Buffer.from(b).length;\n'
      '}\n')
p.write_text(s)
PYX
}
d42="$(prepare m42_allowlist)"; m42 "$d42"
MUTANTS=$((MUTANTS+1))
if run_analyzer "$d42"; then
  OK=$((OK+1)); note ok "42 CONTROL: Array.from/Buffer.from are not refused"
else
  BAD=$((BAD+1)); note NOT-OK "42 CONTROL: the receiver allowlist rejected ordinary code"
  grep -iE 'from\(' "$d42/out.txt" | head -3 | sed 's/^/           /'
fi

# ── X. the four the delta review found in the round-9 repairs ──────────────

# A real Next route inside a directory the walk skipped. Both the entrypoint set
# and the route-file count it is checked against came from the same skipping
# walk, so the floor could not notice its own blind spot.
m43(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1]); (d/"app/api/e2e").mkdir(parents=True, exist_ok=True)
(d/"app/api/e2e/route.ts").write_text(
 'import { purgeCredentials } from "@/lib/accounts/credentials";\n'
 'export async function POST() { void purgeCredentials; return new Response("x"); }\n')
PYX
}
expect_red "43 a route inside a skipped directory is still an entrypoint" m43 \
  "app/api/e2e/route.ts -> lib/accounts/credentials.ts"

# A literal-table write held far from its .from(, so the windowed rule cannot
# pair them. The table name IS a literal, so the non-literal rule is silent too.
m44(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"lib/status/broker.ts"; s=p.read_text()
filler = "".join(f'  const pad{i} = "{i}".repeat(8);\n' for i in range(24))
s += ('\n\nexport async function farApart(svc: { from: (t: string) => { delete: () => Promise<unknown> } }) {\n'
      '  const q = svc.from("accounts");\n' + filler +
      '  return q.delete();\n'
      '}\n')
p.write_text(s)
PYX
}
expect_red "44 a write far from its .from( is still a table write" m44 \
  "mutation surface in a production entrypoint closure"

# The method taken as a reference rather than called. `.rpc` has been refusing
# this shape since mutant 18; `.from` stopped at the form its own mutant used.
m45(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const tbl = (supa as never as { from: (t: string) => { upsert: (r: unknown) => Promise<unknown> } }).from;\n'
 '    await tbl("equity_snapshots").upsert({ id: 1 });\n'
 '    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "45 a .from taken as a reference is unclassifiable, not absent" m45 \
  "reference(s) that are not calls"

# A stripper that DELETES instead of blanking would drop the specifier count and
# the edge count together, silently re-opening the same-line-import fix.
m46(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"test/containment/source-scan.mjs"; s=p.read_text()
s=s.replace('if (blanked[i] !== "\\n" && blanked[i] !== "\\r") blanked[i] = " ";',
            'if (blanked[i] !== "\\n" && blanked[i] !== "\\r") blanked[i] = "";')
p.write_text(s)
PYX
}
expect_red "46 a stripper that deletes rather than blanks is caught" m46 \
  "must blank comments, not delete them"

# ── XI. the two regressions round 2 introduced (round 3) ───────────────────

# A single emoji before a comment shifted every blanking window, because the
# stripper indexed a CODE POINT array with UTF-16 code-UNIT offsets — leaving
# the comment head intact and blanking real code past it. join("") restored the
# UTF-16 length, so the length guard added in the same round was blind. No
# mutant planted a non-BMP character, and the tree contains none.
m47(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"lib/status/broker.ts"; s=p.read_text()
s += ('\n\nexport const DOTS = { a: "\U0001F7E2", b: "\U0001F7E1", c: "\U0001F534" };\n'
      'export function wipeIt(svc: { from: (t: string) => { delete: () => { eq: (a: string, b: string) => Promise<unknown> } } }, id: string) {\n'
      '  return svc.from("accounts")/*p*/.delete().eq("id", id);\n'
      '}\n')
p.write_text(s, encoding="utf-8")
PYX
}
expect_red "47 a non-BMP character does not shift the comment blanking" m47 \
  "mutation surface in a production entrypoint closure"

# The receiver capture added so Array.from could be allowlisted made an
# IDENTIFIER receiver mandatory, so `getSupabaseService().from(TABLE)` — the
# idiomatic spelling here — matched no `.from` rule at all. Every write mutant
# spelled its receiver as a bare identifier, so none of them could notice.
m48(){ python3 - "$1" <<'PYX'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const TABLE = "accounts";\n'
 '    await (getSupabaseService() as never as { from: (t: string) => { delete: () => { eq: (a: string, b: string) => Promise<unknown> } } }).from(TABLE).delete().eq("id", user.id);\n'
 '    const accounts = await listAccounts(user.id);')
p.write_text(s)
PYX
}
expect_red "48 a factory-call receiver is still a .from the rule must read" m48 \
  "the table-write rule needs a literal"

echo
echo "reachability falsification: $MUTANTS mutations, $OK detected, $BAD missed"
[[ $BAD -eq 0 ]] && { echo "FALSIFICATION GREEN — every mutation is detected, each for its own reason"; exit 0; } \
                 || { echo "FALSIFICATION RED — the analyzer missed $BAD mutation(s)"; exit 1; }
