import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import RefreshButton from "@/components/RefreshButton";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSelectedAccount } from "@/lib/account-context";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import type { SafeAccount } from "@/lib/accounts/service";

/**
 * Authenticated shell for every dashboard screen.
 *
 * Auth + the account switcher activate only once Supabase is configured via
 * env vars. Until then the dashboard keeps working in its legacy mode so
 * deploying this code never locks anyone out.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let accounts: SafeAccount[] = [];
  let selectedId: string | null = null;

  if (SUPABASE_CONFIGURED) {
    let user = null;
    let supabaseReachable = true;
    try {
      const supa = await getSupabaseServer();
      ({
        data: { user },
      } = await supa.auth.getUser());

      if (user) {
        const selection = await getSelectedAccount();
        accounts = selection.accounts;
        selectedId = selection.selected?.id ?? null;
      }
    } catch {
      // Supabase is configured but unreachable (e.g. the free-tier project
      // auto-paused). Degrade to legacy mode — render the dashboard with no
      // account switcher — instead of 504ing the whole shell.
      supabaseReachable = false;
    }

    // Only enforce the login gate when Supabase actually answered. The
    // redirect() lives outside the try/catch: Next implements it by throwing
    // NEXT_REDIRECT, which must not be swallowed by the catch above.
    if (supabaseReachable && !user) redirect("/login");
  }

  return (
    <div className="min-h-screen flex">
      <Sidebar accounts={accounts} selectedAccountId={selectedId} />
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1600px] mx-auto p-4 sm:p-6 lg:p-8 pt-16 lg:pt-8">
          <div className="flex justify-end mb-4">
            <RefreshButton />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
