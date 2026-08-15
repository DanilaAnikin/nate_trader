import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
// READ-ONLY import, deliberately from ./read and not ./service. `service.ts`
// also exports createAccount/updateAccount/rotateKeys/deleteAccount, which reach
// ./credentials and therefore the vault_* wrappers that migration 0022
// tombstones. Importing from ./read keeps those out of this GET handler's
// transitive closure entirely — a property test/containment/reachability.mjs
// proves over the real module graph.
import { listAccounts } from "@/lib/accounts/read";
import { frozenResponse } from "@/lib/frozen";

export const dynamic = "force-dynamic";

/** GET /api/accounts → the signed-in user's accounts (no key material). */
export async function GET() {
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const accounts = await listAccounts(user.id);
    return NextResponse.json({ accounts });
  } catch {
    return NextResponse.json({ error: "could not list accounts" }, { status: 500 });
  }
}

/**
 * Account creation is disabled in this artifact.
 *
 * Previously this validated Alpaca keys, stored them in Vault and created the
 * account — a path that reaches `vault_create_secret`, which migration 0022
 * tombstones on the latest schema. It is now a constant refusal, and
 * `createAccount` is no longer imported at all: the containment proof is about
 * the module graph, and an import that is present but "never taken" is exactly
 * the claim a static proof cannot make and a refactor quietly falsifies.
 *
 * The request body is never read and the caller is never authenticated, so
 * there is nothing to decide and nothing to parse.
 */
export async function POST(): Promise<Response> {
  return frozenResponse();
}
