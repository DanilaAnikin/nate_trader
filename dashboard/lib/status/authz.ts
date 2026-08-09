/**
 * Server-side authorization for the private V11 production runtime.
 *
 * The frozen plan, pending order intents, preflight, executor results and
 * workflow operations describe *one* central production account. They are not
 * per-tenant data, so owning "some" Supabase account must never be enough to
 * read them. Only the explicitly configured production owner, viewing the
 * explicitly configured production account, may reach them — and the private
 * GitHub Actions API is not called at all for anybody else.
 *
 * Every condition is an AND. There is deliberately no OR path: an attacker who
 * can create an account, or set a nickname, or point a paper key at a
 * lookalike broker account, still gets nothing.
 */

import type { AccountMode } from "./types";

export interface ProductionAuthzConfig {
  /** Supabase `auth.users.id` allowed to see the production runtime. */
  readonly productionOwnerUserId: string | null;
  /** Supabase `accounts.id` of the account the executor actually trades. */
  readonly productionAccountId: string | null;
  /**
   * Optional *additional* AND check. When set, the broker account number read
   * fresh from Alpaca `/v2/account` must match. A value stored in Supabase is
   * never accepted as proof, because the client-facing account row is
   * user-influenced.
   */
  readonly productionBrokerAccountNumber: string | null;
}

export function readProductionAuthzConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionAuthzConfig {
  const value = (name: string): string | null => {
    const raw = env[name]?.trim();
    return raw ? raw : null;
  };
  return {
    productionOwnerUserId: value("PRODUCTION_OWNER_USER_ID"),
    productionAccountId: value("PRODUCTION_ACCOUNT_ID"),
    productionBrokerAccountNumber: value("PRODUCTION_ALPACA_ACCOUNT_NUMBER"),
  };
}

export type ProductionDenialReason =
  | "NOT_CONFIGURED"
  | "NOT_PRODUCTION_OWNER"
  | "NOT_PRODUCTION_ACCOUNT"
  | "NOT_PAPER_MODE"
  | "ACCOUNT_NOT_OWNED_BY_PRODUCTION_OWNER"
  | "BROKER_ACCOUNT_UNVERIFIED"
  | "BROKER_ACCOUNT_MISMATCH";

export interface ProductionAuthorization {
  readonly authorized: boolean;
  readonly reason: ProductionDenialReason | null;
  readonly detail: string;
}

const DENIAL_DETAIL: Record<ProductionDenialReason, string> = {
  NOT_CONFIGURED:
    "No server-side production owner and account are configured, so no viewer can be shown the production runtime.",
  NOT_PRODUCTION_OWNER:
    "The signed-in user is not the configured production owner. Central production runtime data is withheld.",
  NOT_PRODUCTION_ACCOUNT:
    "The selected account is not the configured production executor account.",
  NOT_PAPER_MODE:
    "The V11 executor is paper-only, so a live account can never be the production account.",
  ACCOUNT_NOT_OWNED_BY_PRODUCTION_OWNER:
    "The configured production account is not owned by the signed-in production owner.",
  BROKER_ACCOUNT_UNVERIFIED:
    "A production broker account number is configured but the live Alpaca account could not be read, so the binding cannot be verified.",
  BROKER_ACCOUNT_MISMATCH:
    "The broker account number reported by Alpaca does not match the configured production broker account.",
};

function deny(reason: ProductionDenialReason): ProductionAuthorization {
  return { authorized: false, reason, detail: DENIAL_DETAIL[reason] };
}

/**
 * Identity/config/ownership stage. This runs *before* any GitHub Actions call
 * so an unauthorized viewer never causes one.
 *
 * `accountOwnerId` must come from a service-role read of `accounts.owner_id`,
 * not from anything the browser sent.
 */
export function authorizeProductionRuntime(input: {
  viewerUserId: string;
  accountId: string;
  accountOwnerId: string | null;
  mode: AccountMode;
  /** Fresh Alpaca `/v2/account` account number; null when it could not be read. */
  liveBrokerAccountNumber: string | null;
  config: ProductionAuthzConfig;
}): ProductionAuthorization {
  const { config } = input;

  if (!config.productionOwnerUserId || !config.productionAccountId) {
    return deny("NOT_CONFIGURED");
  }
  if (config.productionOwnerUserId !== input.viewerUserId) {
    return deny("NOT_PRODUCTION_OWNER");
  }
  if (config.productionAccountId !== input.accountId) {
    return deny("NOT_PRODUCTION_ACCOUNT");
  }
  if (input.mode !== "paper") {
    return deny("NOT_PAPER_MODE");
  }
  if (input.accountOwnerId !== config.productionOwnerUserId) {
    return deny("ACCOUNT_NOT_OWNED_BY_PRODUCTION_OWNER");
  }

  if (config.productionBrokerAccountNumber !== null) {
    if (input.liveBrokerAccountNumber === null) {
      return deny("BROKER_ACCOUNT_UNVERIFIED");
    }
    if (
      input.liveBrokerAccountNumber.trim() !==
      config.productionBrokerAccountNumber.trim()
    ) {
      return deny("BROKER_ACCOUNT_MISMATCH");
    }
  }

  return {
    authorized: true,
    reason: null,
    detail: config.productionBrokerAccountNumber
      ? "Signed-in production owner, configured production account, paper mode, account ownership and a freshly verified Alpaca account number all match."
      : "Signed-in production owner, configured production account, paper mode and account ownership all match.",
  };
}
