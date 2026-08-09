/**
 * Production-account binding, derived from the authorization decision.
 *
 * A binding is never inferred from tickers, equity size, nickname or paper
 * mode alone, and a value stored in Supabase is never accepted as proof. The
 * role shown in the UI is exactly the outcome of `authorizeProductionRuntime`.
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

  if (input.mode === "live") {
    return {
      selectedAccountId: input.accountId,
      selectedAccountNickname: input.nickname,
      mode: "live",
      role: "READ_ONLY_LIVE",
      productionBound: false,
      bindingProof: null,
      bindingDetail:
        "Read-only monitoring. The V11 executor is hard-wired to Alpaca paper and never trades a live account.",
      brokerAccountMask,
    };
  }

  if (input.authorization.authorized) {
    return {
      selectedAccountId: input.accountId,
      selectedAccountNickname: input.nickname,
      mode: "paper",
      role: "PRODUCTION_CONTROLLED_PAPER",
      productionBound: true,
      bindingProof: "server-authorized-production-owner-and-account",
      bindingDetail: input.authorization.detail,
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
