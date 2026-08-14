import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";
import { getAuthCookieName } from "@/lib/supabase/config";

/**
 * Browser-side Supabase client for Client Components.
 *
 * This client exists for GoTrue Auth only — sign in, session refresh, password
 * change, sign out. It keeps the PUBLIC Supabase origin, because that is the
 * one path the edge still allows from the internet. It must not be used to
 * read or write application data: the public data plane is denied at the edge,
 * and every data path goes through same-origin Route Handlers instead.
 *
 * The cookie name is pinned rather than derived, so that this client and the
 * server-side clients — which now point at a different hostname — continue to
 * agree on where the session lives. See getAuthCookieName().
 */
export function getSupabaseBrowser() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: { name: getAuthCookieName() } },
  );
}
