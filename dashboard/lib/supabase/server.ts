import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";

/**
 * Cookie-bound Supabase client for use in Server Components, Server Actions,
 * and Route Handlers. Carries the signed-in user's session, so every query
 * runs under that user's RLS policies.
 */
export async function getSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (xs) => {
          try {
            xs.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll is called from a Server Component render where cookies
            // are read-only. Safe to ignore — middleware refreshes the session.
          }
        },
      },
    },
  );
}
