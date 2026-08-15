import { frozenResponse } from "@/lib/frozen";

/**
 * Broker credential verification is disabled in this artifact.
 *
 * Verification is a write in every sense that matters here: it reads the stored
 * Vault secrets through `get_account_credentials`, contacts Alpaca, and then
 * persists a status and a `last_verified_at` timestamp. The frozen containment
 * bridge does none of those. The previous imports of `@/lib/supabase/service`
 * and the account verification helpers are removed rather than left unused, so
 * this route's transitive closure contains no credential or lifecycle code at
 * all.
 *
 * No body is read, no caller is authenticated, no client is constructed, and no
 * broker call is made.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(): Promise<Response> {
  return frozenResponse();
}
