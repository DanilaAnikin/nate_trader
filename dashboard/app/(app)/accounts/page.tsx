import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSelectedAccount } from "@/lib/account-context";
import AccountsClient from "@/components/accounts/AccountsClient";
import { readBindingConfig, resolveAccountBinding } from "@/lib/status/binding";
import type { AccountBindingInfo } from "@/lib/status/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounts · V11 Adaptive Momentum" };

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

  // The production binding is server-side configuration. Roles are resolved
  // here so the browser never has to guess which account V11 actually trades.
  const config = readBindingConfig();
  const bindings: Record<string, AccountBindingInfo> = Object.fromEntries(
    accounts.map((account) => [
      account.id,
      resolveAccountBinding({
        accountId: account.id,
        nickname: account.nickname,
        mode: account.mode,
        brokerAccountNumber: account.alpaca_account_number,
        config,
      }),
    ]),
  );

  return (
    <AccountsClient
      initialAccounts={accounts}
      selectedAccountId={selected?.id ?? null}
      bindings={bindings}
    />
  );
}
