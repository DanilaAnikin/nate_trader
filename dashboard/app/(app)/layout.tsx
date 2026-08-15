import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import AppHeader from "@/components/AppHeader";
import StatusProvider from "@/components/status/StatusProvider";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSelectedAccount } from "@/lib/account-context";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import type { SafeAccount } from "@/lib/accounts/read";

/**
 * Authenticated shell for every dashboard screen.
 *
 * Auth and the account switcher activate only once Supabase is configured.
 * Repository-only legacy mode is available solely behind the explicit
 * ALLOW_LEGACY_DASHBOARD opt-in; the proxy otherwise blocks this shell when
 * auth configuration is absent.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let accounts: SafeAccount[] = [];
  let selectedId: string | null = null;
  let selectedAccount: SafeAccount | null = null;

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
        selectedAccount = selection.selected;
        selectedId = selectedAccount?.id ?? null;
      }
    } catch {
      // Supabase is configured but unreachable (for example an auto-paused
      // project). Render the shell without a selection; the status provider
      // then fails closed instead of substituting legacy repository data.
      supabaseReachable = false;
    }

    // redirect() throws NEXT_REDIRECT, so it must live outside the try/catch.
    if (supabaseReachable && !user) redirect("/login");
  }

  return (
    <StatusProvider
      enabled={SUPABASE_CONFIGURED}
      selectedAccount={
        selectedAccount
          ? {
              id: selectedAccount.id,
              nickname: selectedAccount.nickname,
              mode: selectedAccount.mode,
            }
          : null
      }
    >
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="min-h-screen flex">
        <Sidebar accounts={accounts} selectedAccountId={selectedId} />
        <div className="flex-1 min-w-0 flex flex-col">
          <AppHeader />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-x-hidden"
          >
            <div className="max-w-[1600px] mx-auto p-4 sm:p-6 lg:p-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </StatusProvider>
  );
}
