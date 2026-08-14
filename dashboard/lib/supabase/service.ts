import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getSupabaseServerUrl } from "@/lib/supabase/config";

/**
 * Service-role Supabase client. Bypasses RLS and can call the credential
 * functions (get_account_credentials, vault_*). NEVER import this into a
 * Client Component — the `server-only` guard makes such an import a build
 * error. The service-role key must never be exposed as NEXT_PUBLIC_*.
 *
 * Goes to Kong over the internal Docker network. Sending a service-role key
 * to the public origin would both depend on the data plane we are closing and
 * put the most privileged credential on the public path.
 */
export function getSupabaseService() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient<Database>(getSupabaseServerUrl(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
