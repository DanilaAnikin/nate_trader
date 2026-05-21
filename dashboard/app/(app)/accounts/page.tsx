import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSelectedAccount } from "@/lib/account-context";
import AccountsClient from "@/components/accounts/AccountsClient";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  if (!SUPABASE_CONFIGURED) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-foreground mb-1">Accounts</h1>
        <p className="text-sm text-muted">
          Account management requires Supabase to be configured.
        </p>
      </div>
    );
  }

  const { accounts, selected } = await getSelectedAccount();
  return (
    <AccountsClient
      initialAccounts={accounts}
      selectedAccountId={selected?.id ?? null}
    />
  );
}
