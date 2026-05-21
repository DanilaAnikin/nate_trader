import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Service-role Supabase client. Bypasses RLS and can call the credential
 * functions (get_account_credentials, vault_*). NEVER import this into a
 * Client Component — the `server-only` guard makes such an import a build
 * error. The service-role key must never be exposed as NEXT_PUBLIC_*.
 */
export function getSupabaseService() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
