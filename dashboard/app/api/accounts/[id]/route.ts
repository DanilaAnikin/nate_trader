import { frozenResponse } from "@/lib/frozen";

/**
 * Account metadata update, credential rotation and deletion are all disabled in
 * this artifact.
 *
 * This file used to import `updateAccount`, `rotateKeys` and `deleteAccount`
 * from `@/lib/accounts/service`, each of which reaches `./credentials` and from
 * there `vault_create_secret`, `vault_update_secret` and `vault_delete_secret` —
 * the three routines migration 0022 deliberately tombstones on the latest
 * schema, revoking EXECUTE from PUBLIC, anon, authenticated AND service_role.
 *
 * Those imports are gone, not merely unused. The distinction matters: the
 * containment gate proves a property of the module graph, and an import that is
 * present but "never taken" is exactly the kind of claim a static proof cannot
 * make and a future refactor quietly falsifies.
 *
 * Neither handler reads its request body, authenticates, constructs a Supabase
 * client, or touches the database. The proxy independently refuses these verbs
 * before authentication; that redundancy is intentional.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PATCH(): Promise<Response> {
  return frozenResponse();
}

export async function DELETE(): Promise<Response> {
  return frozenResponse();
}
