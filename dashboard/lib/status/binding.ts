/**
 * Explicit production-account binding.
 *
 * The guarded executor runs in GitHub Actions against repository Alpaca paper
 * secrets. The dashboard's Supabase accounts are a *separate* credential
 * store, so the two can only be connected by an explicit server-side
 * configuration. Nothing here infers a binding from tickers, equity size,
 * paper mode, or "it looks like the same portfolio" — an unproven account is
 * observer-only and its strategy-compliance data is NOT_APPLICABLE.
 */

import type { AccountBindingInfo, AccountMode, AccountRole } from "./types";

export interface BindingConfig {
  /** Supabase account UUID of the account the executor actually trades. */
  readonly productionAccountId: string | null;
  /** Alpaca account number of the executor's paper account. */
  readonly productionBrokerAccountNumber: string | null;
}

export function readBindingConfig(
  env: Record<string, string | undefined> = process.env,
): BindingConfig {
  const id = env.PRODUCTION_ACCOUNT_ID?.trim();
  const broker = env.PRODUCTION_ALPACA_ACCOUNT_NUMBER?.trim();
  return {
    productionAccountId: id ? id : null,
    productionBrokerAccountNumber: broker ? broker : null,
  };
}

/** Last four characters only. The full broker account number stays server-side. */
export function maskAccountNumber(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}

export function resolveAccountBinding(input: {
  accountId: string;
  nickname: string;
  mode: AccountMode;
  brokerAccountNumber: string | null;
  config: BindingConfig;
}): AccountBindingInfo {
  const mask = maskAccountNumber(input.brokerAccountNumber);

  if (input.mode === "live") {
    return {
      selectedAccountId: input.accountId,
      selectedAccountNickname: input.nickname,
      mode: "live",
      role: "READ_ONLY_LIVE" satisfies AccountRole,
      productionBound: false,
      bindingProof: null,
      bindingDetail:
        "Read-only monitoring. The V11 executor is hard-wired to Alpaca paper and never trades a live account.",
      brokerAccountMask: mask,
    };
  }

  const idMatches =
    input.config.productionAccountId !== null &&
    input.config.productionAccountId === input.accountId;
  const brokerMatches =
    input.config.productionBrokerAccountNumber !== null &&
    input.brokerAccountNumber !== null &&
    input.config.productionBrokerAccountNumber.trim() ===
      input.brokerAccountNumber.trim();

  if (idMatches || brokerMatches) {
    return {
      selectedAccountId: input.accountId,
      selectedAccountNickname: input.nickname,
      mode: "paper",
      role: "PRODUCTION_CONTROLLED_PAPER",
      productionBound: true,
      bindingProof: idMatches
        ? "server-configured-account-id"
        : "server-configured-broker-account-number",
      bindingDetail: idMatches
        ? "Bound by the server-side PRODUCTION_ACCOUNT_ID configuration."
        : "Bound by the server-side PRODUCTION_ALPACA_ACCOUNT_NUMBER configuration matching this account's verified broker account number.",
      brokerAccountMask: mask,
    };
  }

  const configured =
    input.config.productionAccountId !== null ||
    input.config.productionBrokerAccountNumber !== null;
  return {
    selectedAccountId: input.accountId,
    selectedAccountNickname: input.nickname,
    mode: "paper",
    role: "OBSERVER_ONLY_PAPER",
    productionBound: false,
    bindingProof: null,
    bindingDetail: configured
      ? "This paper account does not match the server-configured production executor account. Strategy compliance for this account is NOT_APPLICABLE."
      : "No server-side production-account binding is configured, so no account can be proven to be the one V11 trades.",
    brokerAccountMask: mask,
  };
}
