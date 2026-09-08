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
   * Required broker-side proof. A Supabase account row only says which
   * credentials the *dashboard* uses; it cannot show that those credentials
   * point at the account the executor trades. The number read fresh from
   * Alpaca `/v2/account` must therefore match this server-only value. A value
   * stored in Supabase is never accepted, because that row is user-influenced.
   */
  readonly productionBrokerAccountNumber: string | null;
  /**
   * Which broker mode the configured production account is expected to be.
   *
   * Defaults to `paper`. A live production account requires this to say `live`
   * *in as many words*, so the mode is never inferred from the account row —
   * otherwise editing a row's mode in the database would silently promote a
   * real-money account into the production view.
   */
  readonly productionAccountMode: AccountMode;
}

export function readProductionAuthzConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionAuthzConfig {
  const value = (name: string): string | null => {
    const raw = env[name]?.trim();
    return raw ? raw : null;
  };
  const declaredMode = value("PRODUCTION_ACCOUNT_MODE")?.toLowerCase() ?? null;
  return {
    productionOwnerUserId: value("PRODUCTION_OWNER_USER_ID"),
    productionAccountId: value("PRODUCTION_ACCOUNT_ID"),
    productionBrokerAccountNumber: value("PRODUCTION_ALPACA_ACCOUNT_NUMBER"),
    // Anything that is not exactly "live" means paper. A typo must fall back to
    // the safe mode, never to the one that moves real money.
    productionAccountMode: declaredMode === "live" ? "live" : "paper",
  };
}

export type ProductionDenialReason =
  | "NOT_CONFIGURED"
  | "BROKER_BINDING_NOT_CONFIGURED"
  | "NOT_PRODUCTION_OWNER"
  | "NOT_PRODUCTION_ACCOUNT"
  | "ACCOUNT_MODE_MISMATCH"
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
  BROKER_BINDING_NOT_CONFIGURED:
    "No server-side production broker account number is configured, so the Supabase account cannot be proven to use the executor's broker account.",
  NOT_PRODUCTION_OWNER:
    "The signed-in user is not the configured production owner. Central production runtime data is withheld.",
  NOT_PRODUCTION_ACCOUNT:
    "The selected account is not the configured production executor account.",
  ACCOUNT_MODE_MISMATCH:
    "The selected account's broker mode is not the mode configured for the production executor, so it cannot be the production account.",
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
  // Owner + account + paper mode prove *who is asking about which row*. They
  // cannot prove that the row's Vault credentials point at the broker account
  // the executor actually trades, so a broker-side identifier is mandatory.
  if (!config.productionBrokerAccountNumber) {
    return deny("BROKER_BINDING_NOT_CONFIGURED");
  }
  if (config.productionOwnerUserId !== input.viewerUserId) {
    return deny("NOT_PRODUCTION_OWNER");
  }
  if (config.productionAccountId !== input.accountId) {
    return deny("NOT_PRODUCTION_ACCOUNT");
  }
  // The account's own mode must equal the mode the server declares. Matching
  // in both directions matters: a live row must not be shown as a paper
  // executor either, or the reader would be told real money is paper.
  if (input.mode !== config.productionAccountMode) {
    return deny("ACCOUNT_MODE_MISMATCH");
  }
  if (input.accountOwnerId !== config.productionOwnerUserId) {
    return deny("ACCOUNT_NOT_OWNED_BY_PRODUCTION_OWNER");
  }

  if (input.liveBrokerAccountNumber === null) {
    return deny("BROKER_ACCOUNT_UNVERIFIED");
  }
  if (
    input.liveBrokerAccountNumber.trim() !==
    config.productionBrokerAccountNumber.trim()
  ) {
    return deny("BROKER_ACCOUNT_MISMATCH");
  }

  return {
    authorized: true,
    reason: null,
    detail:
      `Signed-in production owner, configured production account, ${config.productionAccountMode} mode, ` +
      "account ownership and a freshly verified Alpaca account number all match.",
  };
}
