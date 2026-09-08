/**
 * Production-account binding, derived from the authorization decision.
 *
 * A binding is never inferred from tickers, equity size, nickname or broker
 * mode alone, and a value stored in Supabase is never accepted as proof. The
 * role shown in the UI is exactly the outcome of `authorizeProductionRuntime`;
 * the account's mode only chooses which wording and which role name that
 * outcome is reported under.
 */

import { maskAccountNumber } from "@/lib/accounts/mask";
import type { ProductionAuthorization } from "./authz";
import type { AccountBindingInfo, AccountMode } from "./types";

export { maskAccountNumber };

export function resolveAccountBinding(input: {
  accountId: string;
  nickname: string;
  mode: AccountMode;
  /** Fresh Alpaca `/v2/account` number; masked before it leaves the server. */
  liveBrokerAccountNumber: string | null;
  authorization: ProductionAuthorization;
}): AccountBindingInfo {
  const brokerAccountMask = maskAccountNumber(input.liveBrokerAccountNumber);

  // The authorization decision is the only thing that grants a production
  // role, in either mode. The account's own `mode` column decides which of the
  // two production roles it is — never whether it gets one.
  if (input.authorization.authorized) {
    const live = input.mode === "live";
    return {
      selectedAccountId: input.accountId,
      selectedAccountNickname: input.nickname,
      mode: input.mode,
      role: live ? "PRODUCTION_CONTROLLED_LIVE" : "PRODUCTION_CONTROLLED_PAPER",
      productionBound: true,
      bindingProof: "server-authorized-production-owner-and-account",
      bindingDetail: live
        ? `REAL MONEY. ${input.authorization.detail} Orders submitted for this account settle against a funded brokerage account.`
        : input.authorization.detail,
      brokerAccountMask,
    };
  }

  if (input.mode === "live") {
    return {
      selectedAccountId: input.accountId,
      selectedAccountNickname: input.nickname,
      mode: "live",
      role: "OBSERVER_ONLY_LIVE",
      productionBound: false,
      bindingProof: null,
      bindingDetail: `${input.authorization.detail} This live account is shown for monitoring only; the executor is not configured to trade it.`,
      brokerAccountMask,
    };
  }

  return {
    selectedAccountId: input.accountId,
    selectedAccountNickname: input.nickname,
    mode: "paper",
    role: "OBSERVER_ONLY_PAPER",
    productionBound: false,
    bindingProof: null,
    bindingDetail: `${input.authorization.detail} Strategy compliance for this account is NOT_APPLICABLE.`,
    brokerAccountMask,
  };
}
