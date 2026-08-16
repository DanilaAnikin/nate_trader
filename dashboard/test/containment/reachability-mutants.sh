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
  mkdir -p "$d/supabase"
  cp -r "$REPO/supabase/migrations" "$d/supabase/migrations"
  echo "$d/dashboard"
}

run_analyzer(){ node "$1/test/containment/reachability.mjs" >"$1/out.txt" 2>&1; }

# expect_red <label> <mutator-fn> <required-substring>
#
# The substring is what makes this a detection rather than a crash. It must be
# the offence the mutation was written to provoke.
expect_red(){
  local label="$1" fn="$2" want="$3"
  MUTANTS=$((MUTANTS+1))
  local d; d="$(prepare "m$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')")"
  "$fn" "$d"
  if run_analyzer "$d"; then
    BAD=$((BAD+1)); note NOT-OK "$label" "analyzer still PASSED"
  elif grep -qF "$want" "$d/out.txt"; then
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
else
  note NOT-OK "BASELINE is green" "$(tail -3 "$BASE/out.txt" | tr '\n' ' ')"
  echo; echo "baseline is not green — aborting, every mutant result would be meaningless"; exit 1
fi

REACH="reaches\|names tombstoned\|mutation surface"

# ── I. forms the analyzer already recognised ────────────────────────────────
m1(){ sed -i '1i import { purgeCredentials } from "@/lib/accounts/credentials";' "$1/app/api/accounts/route.ts"; }
expect_red "1 route imports credentials directly" m1 "mutation surface"

m2(){ cat > "$1/lib/helper-hop.ts" <<'EOF'
import { purgeCredentials } from "@/lib/accounts/credentials";
export const hop = purgeCredentials;
EOF
  sed -i '1i import { hop } from "@/lib/helper-hop";' "$1/app/api/accounts/route.ts"; }
expect_red "2 route imports it through one helper" m2 "mutation surface"

m3(){ cat > "$1/lib/reexport-a.ts" <<'EOF'
export { purgeCredentials } from "@/lib/accounts/credentials";
EOF
  cat > "$1/lib/reexport-b.ts" <<'EOF'
export { purgeCredentials } from "@/lib/reexport-a";
EOF
  sed -i '1i import { purgeCredentials } from "@/lib/reexport-b";' "$1/app/api/accounts/route.ts"; }
expect_red "3 route imports it through a re-export chain" m3 "mutation surface"

m4(){ sed -i 's|import { listAccounts } from "@/lib/accounts/read";|import { listAccounts } from "@/lib/accounts/service";|' "$1/app/api/accounts/route.ts"; }
expect_red "4 GET imports the combined service" m4 "mutation surface"

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
expect_red "7 tombstoned reach from a page" m7 "mutation surface"

m8(){ sed -i '1i import { purgeCredentials } from "@/lib/accounts/credentials";' "$1/proxy.ts"; }
expect_red "8 tombstoned reach from the proxy" m8 "mutation surface"

m9(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s='import { purgeCredentials } from "@/lib/accounts/credentials";\n'+s
s=s.replace('export async function POST(): Promise<Response> {',
 'export async function POST(): Promise<Response> {\n  if (false as boolean) { await purgeCredentials(null as never, null as never, null as never); }')
p.write_text(s)
PY
}
expect_red "9 hidden behind a constant-false branch" m9 "mutation surface"

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
expect_red "11 a newly added .ts route is enumerated" m11 "mutation surface"

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
expect_red "15 dynamic import() is an edge" m15 "mutation surface"

m16(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const c = require("@/lib/accounts/credentials");\n    void c;\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PY
}
expect_red "16 require() is an edge" m16 "mutation surface"

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
expect_red "19 a .js route is discovered, not just resolved" m19 "mutation surface"

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
expect_red "20 a directive past byte 200 is still a Server Action" m20 "mutation surface"

m21(){ python3 - "$1" <<'PY'
import pathlib,sys,glob
d=pathlib.Path(sys.argv[1])
q=pathlib.Path(sorted(glob.glob(str(d/"app/(app)/*/page.tsx")))[0])
q.write_text(q.read_text() + '''
export async function reapAccountAction(id: string) {
  "use server";
  const creds = await import("@/lib/accounts/credentials");
  void creds; void id;
}
''')
PY
}
expect_red "21 a function-level \"use server\" is a Server Action" m21 "mutation surface"

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
expect_red "25 equity-backfill in a closure (the old list missed it)" m25 "mutation surface"

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
expect_red "26 a RENAMED copy of the mutation surface" m26 "mutation surface"

m27(){ python3 - "$1" <<'PYX'
import pathlib,sys
d=pathlib.Path(sys.argv[1])
# break the derivation itself. If it finds nothing the rule is inert, and that
# must be an ERROR rather than a clean tree — the failure mode the two blockers
# of the day both had.
p=d/"test/containment/reachability.mjs"; s=p.read_text()
s=s.replace("if (writesTable || namesTombstone) found.push(relative(DASH, f));",
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


echo
echo "reachability falsification: $MUTANTS mutations, $OK detected, $BAD missed"
[[ $BAD -eq 0 ]] && { echo "FALSIFICATION GREEN — every mutation is detected, each for its own reason"; exit 0; } \
                 || { echo "FALSIFICATION RED — the analyzer missed $BAD mutation(s)"; exit 1; }
