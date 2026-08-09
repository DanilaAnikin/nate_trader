import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { getSelectedAccount } from "@/lib/account-context";
import AccountsClient from "@/components/accounts/AccountsClient";
import {
  authorizeProductionRuntime,
  readProductionAuthzConfig,
} from "@/lib/status/authz";
import { resolveAccountBinding } from "@/lib/status/binding";
import { fetchBrokerSnapshot, loadCredentials } from "@/lib/status/broker";
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

  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  const { accounts, selected } = await getSelectedAccount();

  // Roles are the outcome of the same server-side authorization the status
  // read model uses. The browser is never asked to work out which account V11
  // trades, and no account number leaves the server unmasked.
  const config = readProductionAuthzConfig();
  const bindings: Record<string, AccountBindingInfo> = {};

  if (user) {
    // Only the configured production account can possibly need a fresh broker
    // read; every other account is denied before that check is reached.
    const candidateId = config.productionAccountId;
    let candidateBrokerAccountNumber: string | null = null;
    const candidate = accounts.find((account) => account.id === candidateId);
    if (
      candidate &&
      candidate.mode === "paper" &&
      config.productionBrokerAccountNumber !== null &&
      config.productionOwnerUserId === user.id
    ) {
      const credentials = await loadCredentials(getSupabaseService(), candidate.id);
      if (credentials) {
        const snapshot = await fetchBrokerSnapshot(credentials, candidate.mode);
        candidateBrokerAccountNumber = snapshot.ok ? snapshot.accountNumber : null;
      }
    }

    for (const account of accounts) {
      const liveBrokerAccountNumber =
        account.id === candidateId ? candidateBrokerAccountNumber : null;
      const authorization = authorizeProductionRuntime({
        viewerUserId: user.id,
        accountId: account.id,
        // RLS already scopes `accounts` to the signed-in user, so an account
        // reaching this loop is owned by them.
        accountOwnerId: user.id,
        mode: account.mode,
        liveBrokerAccountNumber,
        config,
      });
      const binding = resolveAccountBinding({
        accountId: account.id,
        nickname: account.nickname,
        mode: account.mode,
        liveBrokerAccountNumber,
        authorization,
      });
      // Keep the stored mask when no fresh broker read happened for this row.
      bindings[account.id] = {
        ...binding,
        brokerAccountMask:
          binding.brokerAccountMask ?? account.brokerAccountMask,
      };
    }
  }

  return (
    <AccountsClient
      initialAccounts={accounts}
      selectedAccountId={selected?.id ?? null}
      bindings={bindings}
    />
  );
}
