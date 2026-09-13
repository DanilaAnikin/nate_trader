import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";
import { getAuthCookieName } from "@/lib/supabase/config";

/**
 * Browser-side Auth only. Application data goes through same-origin handlers;
 * the public Supabase origin may deny every route outside /auth/v1.
 */
export function getSupabaseBrowser() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: { name: getAuthCookieName() } },
  );
}
