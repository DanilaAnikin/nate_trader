import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export type AccountMode = Database["public"]["Enums"]["account_mode"];

type Service = SupabaseClient<Database>;

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

/**
 * Write both Alpaca secrets into Supabase Vault. Returns the two secret UUIDs
 * that get stored on the `accounts` row. If the second write fails, the first
 * is rolled back so Vault never holds an orphan.
 */
export async function storeCredentials(
  svc: Service,
  apiKey: string,
  apiSecret: string,
): Promise<{ keyId: string; secretId: string }> {
  const keyRes = await svc.rpc("vault_create_secret", { p_secret: apiKey });
  if (keyRes.error || !keyRes.data) {
    throw new Error(`Vault store (key) failed: ${keyRes.error?.message ?? "no id"}`);
  }
  const secretRes = await svc.rpc("vault_create_secret", { p_secret: apiSecret });
  if (secretRes.error || !secretRes.data) {
    await svc.rpc("vault_delete_secret", { p_id: keyRes.data });
    throw new Error(
      `Vault store (secret) failed: ${secretRes.error?.message ?? "no id"}`,
    );
  }
  return { keyId: keyRes.data, secretId: secretRes.data };
}

/** Overwrite the two Vault secrets in place, keeping the same UUIDs. */
export async function rotateCredentials(
  svc: Service,
  keyId: string,
  secretId: string,
  apiKey: string,
  apiSecret: string,
): Promise<void> {
  const k = await svc.rpc("vault_update_secret", { p_id: keyId, p_secret: apiKey });
  if (k.error) throw new Error(`Vault rotate (key) failed: ${k.error.message}`);
  const s = await svc.rpc("vault_update_secret", {
    p_id: secretId,
    p_secret: apiSecret,
  });
  if (s.error) throw new Error(`Vault rotate (secret) failed: ${s.error.message}`);
}

/** Permanently delete the Vault secrets backing an account. */
export async function purgeCredentials(
  svc: Service,
  keyId: string | null,
  secretId: string | null,
): Promise<void> {
  if (keyId) await svc.rpc("vault_delete_secret", { p_id: keyId });
  if (secretId) await svc.rpc("vault_delete_secret", { p_id: secretId });
}
