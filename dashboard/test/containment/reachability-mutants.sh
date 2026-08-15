#!/usr/bin/env bash
# ============================================================================
# Falsification for the reachability analyzer.
#
# A static proof that never goes red is indistinguishable from no proof. Each
# mutation below reintroduces a way for a production entrypoint to reach the
# tombstoned Vault wrappers — or blinds the analyzer — and the analyzer MUST
# report it. The baseline must be green first, otherwise every "went red" below
# would be meaningless.
#
# Every mutation is applied to a COPY. The real worktree is never modified.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reach-mutants.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

OK=0; BAD=0
note(){ printf '  %-6s %-58s %s\n' "$1" "$2" "${3:-}"; }

# A copy without node_modules/.next — the analyzer reads source only.
prepare(){
  local d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"
  ( cd "$DASH" && tar --exclude=node_modules --exclude=.next --exclude=.git -cf - . ) | tar -xf - -C "$d"
  echo "$d"
}

run_analyzer(){ node "$1/test/containment/reachability.mjs" >"$1/out.txt" 2>&1; }

# expect_red <label> <mutator-fn>
expect_red(){
  local label="$1" fn="$2"
  local d; d="$(prepare "m$(echo "$label" | tr -c 'a-zA-Z0-9' '_')")"
  "$fn" "$d"
  if run_analyzer "$d"; then
    BAD=$((BAD+1)); note NOT-OK "$label" "analyzer still PASSED"
  else
    OK=$((OK+1)); note ok "$label" "$(grep -m1 -E 'REACHABILITY: FAIL' "$d/out.txt" || echo red)"
  fi
}

echo "reachability falsification"
echo

# ── baseline must be green, or nothing below means anything ─────────────────
BASE="$(prepare baseline)"
if run_analyzer "$BASE"; then
  OK=$((OK+1)); note ok "BASELINE is green (required before any mutant)"
else
  BAD=$((BAD+1)); note NOT-OK "BASELINE is green" "$(tail -3 "$BASE/out.txt" | tr '\n' ' ')"
  echo; echo "baseline is not green — aborting, every mutant result would be meaningless"; exit 1
fi

# 1 direct import of credentials mutation code from a route
m1(){ sed -i '1i import { purgeCredentials } from "@/lib/accounts/credentials";' "$1/app/api/accounts/route.ts"; }
expect_red "1 route imports credentials directly" m1

# 2 through one helper
m2(){ cat > "$1/lib/helper-hop.ts" <<'EOF'
import { purgeCredentials } from "@/lib/accounts/credentials";
export const hop = purgeCredentials;
EOF
  sed -i '1i import { hop } from "@/lib/helper-hop";' "$1/app/api/accounts/route.ts"; }
expect_red "2 route imports it through one helper" m2

# 3 through a re-export chain
m3(){ cat > "$1/lib/reexport-a.ts" <<'EOF'
export { purgeCredentials } from "@/lib/accounts/credentials";
EOF
  cat > "$1/lib/reexport-b.ts" <<'EOF'
export { purgeCredentials } from "@/lib/reexport-a";
EOF
  sed -i '1i import { purgeCredentials } from "@/lib/reexport-b";' "$1/app/api/accounts/route.ts"; }
expect_red "3 route imports it through a re-export chain" m3

# 4 a GET imports the combined read/write service
m4(){ sed -i 's|import { listAccounts } from "@/lib/accounts/read";|import { listAccounts } from "@/lib/accounts/service";|' "$1/app/api/accounts/route.ts"; }
expect_red "4 GET imports the combined service" m4

# 5 a tombstoned call added to a GET
m5(){ sed -i 's|const accounts = await listAccounts(user.id);|const accounts = await listAccounts(user.id); await (supa as never as {rpc:(n:string)=>Promise<unknown>}).rpc("vault_create_secret");|' "$1/app/api/accounts/route.ts"; }
expect_red "5 tombstoned call inside a GET" m5

# 6 a tombstoned call added to a mutating handler
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
expect_red "6 tombstoned call inside a mutating handler" m6

# 7 in a page (a server entrypoint that is not a route)
m7(){ python3 - "$1" <<'PY'
import pathlib,sys,glob
d=pathlib.Path(sys.argv[1])
p=sorted(glob.glob(str(d/"app/(app)/*/page.tsx")))[0]
q=pathlib.Path(p); s=q.read_text()
q.write_text('import { purgeCredentials } from "@/lib/accounts/credentials";\nvoid purgeCredentials;\n'+s)
PY
}
expect_red "7 tombstoned reach from a page" m7

# 8 in the proxy
m8(){ sed -i '1i import { purgeCredentials } from "@/lib/accounts/credentials";' "$1/proxy.ts"; }
expect_red "8 tombstoned reach from the proxy" m8

# 9 hidden behind a constant-false branch — a graph proof must not care
m9(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s='import { purgeCredentials } from "@/lib/accounts/credentials";\n'+s
s=s.replace('export async function POST(): Promise<Response> {',
 'export async function POST(): Promise<Response> {\n  if (false as boolean) { await purgeCredentials(null as never, null as never, null as never); }')
p.write_text(s)
PY
}
expect_red "9 hidden behind a constant-false branch" m9

# 10 a computed RPC name — unclassifiable, must fail closed
m10(){ python3 - "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/"app/api/accounts/route.ts"; s=p.read_text()
s=s.replace('const accounts = await listAccounts(user.id);',
 'const n = "vault_" + "create_secret"; await (supa as never as {rpc:(x:string)=>Promise<unknown>}).rpc(n);\n    const accounts = await listAccounts(user.id);')
p.write_text(s)
PY
}
expect_red "10 computed RPC name is unclassifiable" m10

# 11 a new route added after enumeration would be picked up — prove enumeration is live
m11(){ mkdir -p "$1/app/api/sneaky"; cat > "$1/app/api/sneaky/route.ts" <<'EOF'
import { purgeCredentials } from "@/lib/accounts/credentials";
export async function GET() { void purgeCredentials; return new Response("x"); }
EOF
}
expect_red "11 a newly added route is still enumerated" m11

# 12 an unresolved import must fail closed, not be skipped
m12(){ sed -i '1i import { nope } from "@/lib/does-not-exist";' "$1/app/api/accounts/route.ts"; }
expect_red "12 unresolved import fails closed" m12

# 13 blind the walker: remove every entrypoint
m13(){ rm -rf "$1/app/api" "$1/app/(app)" "$1/proxy.ts"; }
expect_red "13 zero entrypoints is not a pass" m13

# 14 remove the positive control's subject
m14(){ sed -i 's|import { listAccounts } from "@/lib/accounts/read";|const listAccounts = async (_: string) => [];|' "$1/app/api/accounts/route.ts"; }
expect_red "14 positive control fires when its subject vanishes" m14

echo
echo "reachability falsification: $OK ok, $BAD not-ok"
[[ $BAD -eq 0 ]] && { echo "FALSIFICATION GREEN — every mutation is detected"; exit 0; } \
                 || { echo "FALSIFICATION RED — the analyzer missed $BAD mutation(s)"; exit 1; }
