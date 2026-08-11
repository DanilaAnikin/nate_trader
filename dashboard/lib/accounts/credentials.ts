import "server-only";
import type { Database } from "@/lib/database.types";

export type AccountMode = Database["public"]["Enums"]["account_mode"];


const ALPACA_BASE: Record<AccountMode, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

export type AlpacaValidation =
  | { ok: true; accountNumber: string }
  | {
      ok: false;
      reason: "invalid_keys" | "network" | "alpaca_error";
      message: string;
    };

/**
 * Verify a key pair against Alpaca by calling GET /v2/account on the base URL
 * that matches `mode`. Returns the brokerage account number on success.
 */
export async function validateAlpacaKeys(
  mode: AccountMode,
  apiKey: string,
  apiSecret: string,
): Promise<AlpacaValidation> {
  let res: Response;
  try {
    res = await fetch(`${ALPACA_BASE[mode]}/account`, {
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
      },
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network", message: "Could not reach Alpaca." };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: "invalid_keys",
      message: "Alpaca rejected these API keys.",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: "alpaca_error",
      message: `Alpaca returned HTTP ${res.status}.`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    account_number?: string;
  } | null;
  if (!body?.account_number) {
    return {
      ok: false,
      reason: "alpaca_error",
      message: "Alpaca response was missing an account number.",
    };
  }
  return { ok: true, accountNumber: body.account_number };
}

/*
 * `storeCredentials` and `purgeCredentials` used to live here.
 *
 * Both wrote Vault directly, through `vault_create_secret` and
 * `vault_delete_secret`, and both existed to compensate a creation whose
 * secrets were written *before* the account row. 0021 moved that inside one
 * transaction, so there has been nothing to compensate since — and 0022
 * retired the underlying RPCs, because a general-purpose Vault mutation with
 * no remaining caller is a door that only an attacker has a use for.
 *
 * Deleted rather than deprecated: a helper kept "just in case" is how the
 * two-phase creation comes back.
 */
