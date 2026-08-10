import "server-only";
import type { Database } from "@/lib/database.types";
import { getSupabaseService } from "@/lib/supabase/service";
import { maskAccountNumber } from "./mask";
import {
  validateAlpacaKeys,
  storeCredentials,
  rotateCredentials,
  purgeCredentials,
  type AccountMode,
} from "./credentials";

type AccountRow = Database["public"]["Tables"]["accounts"]["Row"];

/**
 * The account shape the browser is allowed to see.
 *
 * This is an explicit allowlist, deliberately *not* `Omit<AccountRow, ...>`:
 * a new sensitive column added to the table must not become client-visible by
 * default. The full broker account number, the Vault secret UUIDs, `owner_id`
 * and `deleted_at` are all withheld; only a four-character broker mask is
 * exposed so the operator can tell two accounts apart.
 */
export interface SafeAccount {
  readonly id: string;
  readonly nickname: string;
  readonly mode: Database["public"]["Enums"]["account_mode"];
  readonly status: Database["public"]["Enums"]["account_status"];
  readonly color: string;
  readonly is_active: boolean;
  readonly brokerAccountMask: string | null;
  readonly last_verified_at: string | null;
  readonly created_at: string;
}

export function toSafe(row: AccountRow): SafeAccount {
  return {
    id: row.id,
    nickname: row.nickname,
    mode: row.mode,
    status: row.status,
    color: row.color,
    is_active: row.is_active,
    brokerAccountMask: maskAccountNumber(row.alpaca_account_number),
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
  };
}

export type AccountError = { ok: false; reason: string; message: string };
export type AccountOk = { ok: true; account: SafeAccount };
export type AccountResult = AccountOk | AccountError;

/** Every account owned by the user, newest first, excluding soft-deleted rows. */
export async function listAccounts(userId: string): Promise<SafeAccount[]> {
  const svc = getSupabaseService();
  const { data, error } = await svc
    .from("accounts")
    .select("*")
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listAccounts failed: ${error.message}`);
  return (data ?? []).map(toSafe);
}

export type CreateAccountInput = {
  nickname: string;
  mode: AccountMode;
  apiKey: string;
  apiSecret: string;
  color?: string;
};

/** Validate keys → store in Vault → insert the row → audit. Atomic-ish: if the
 *  insert fails the Vault secrets are purged so no orphan is left behind. */
export async function createAccount(
  userId: string,
  input: CreateAccountInput,
): Promise<AccountResult> {
  const nickname = input.nickname?.trim() ?? "";
  if (!nickname) {
    return { ok: false, reason: "invalid_input", message: "Nickname is required." };
  }
  if (input.mode !== "paper" && input.mode !== "live") {
    return { ok: false, reason: "invalid_input", message: "Mode must be paper or live." };
  }
  if (!input.apiKey?.trim() || !input.apiSecret?.trim()) {
    return { ok: false, reason: "invalid_input", message: "API key and secret are required." };
  }

  const validation = await validateAlpacaKeys(input.mode, input.apiKey, input.apiSecret);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, message: validation.message };
  }

  const svc = getSupabaseService();
  const { keyId, secretId } = await storeCredentials(svc, input.apiKey, input.apiSecret);

  const { data, error } = await svc
    .from("accounts")
    .insert({
      owner_id: userId,
      nickname,
      mode: input.mode,
      status: "connected",
      color: input.color ?? "#007aff",
      alpaca_key_secret_id: keyId,
      alpaca_secret_secret_id: secretId,
      alpaca_account_number: validation.accountNumber,
      last_verified_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    await purgeCredentials(svc, keyId, secretId);
    return {
      ok: false,
      reason: "db_error",
      message: error?.message ?? "Account could not be created.",
    };
  }

  await svc.from("audit_log").insert({
    actor_id: userId,
    account_id: data.id,
    action: "account.created",
    detail: { mode: input.mode, nickname },
  });

  return { ok: true, account: toSafe(data) };
}

export type UpdateAccountPatch = {
  nickname?: string;
  color?: string;
  is_active?: boolean;
};

/** Update mutable metadata. Does not touch credentials. */
export async function updateAccount(
  userId: string,
  accountId: string,
  patch: UpdateAccountPatch,
): Promise<AccountResult> {
  const update: Database["public"]["Tables"]["accounts"]["Update"] = {};
  if (typeof patch.nickname === "string") {
    const n = patch.nickname.trim();
    if (!n) return { ok: false, reason: "invalid_input", message: "Nickname cannot be empty." };
    update.nickname = n;
  }
  if (typeof patch.color === "string") update.color = patch.color;
  if (typeof patch.is_active === "boolean") update.is_active = patch.is_active;

  if (Object.keys(update).length === 0) {
    return { ok: false, reason: "invalid_input", message: "Nothing to update." };
  }

  const svc = getSupabaseService();
  const { data, error } = await svc
    .from("accounts")
    .update(update)
    .eq("id", accountId)
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .select("*")
    .single();

  if (error || !data) {
    return { ok: false, reason: "not_found", message: "Account not found." };
  }
  await svc.from("audit_log").insert({
    actor_id: userId,
    account_id: accountId,
    action: "account.updated",
    detail: update as unknown as Database["public"]["Tables"]["audit_log"]["Insert"]["detail"],
  });
  return { ok: true, account: toSafe(data) };
}

/** Re-validate a fresh key pair and overwrite the Vault secrets in place. */
export async function rotateKeys(
  userId: string,
  accountId: string,
  apiKey: string,
  apiSecret: string,
): Promise<AccountResult> {
  if (!apiKey?.trim() || !apiSecret?.trim()) {
    return { ok: false, reason: "invalid_input", message: "API key and secret are required." };
  }
  const svc = getSupabaseService();
  const { data: row } = await svc
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .single();
  if (!row) {
    return { ok: false, reason: "not_found", message: "Account not found." };
  }
  if (!row.alpaca_key_secret_id || !row.alpaca_secret_secret_id) {
    return { ok: false, reason: "no_credentials", message: "Account has no stored credentials." };
  }

  const validation = await validateAlpacaKeys(row.mode, apiKey, apiSecret);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, message: validation.message };
  }

  await rotateCredentials(
    svc,
    row.alpaca_key_secret_id,
    row.alpaca_secret_secret_id,
    apiKey,
    apiSecret,
  );

  const { data, error } = await svc
    .from("accounts")
    .update({
      status: "connected",
      alpaca_account_number: validation.accountNumber,
      last_verified_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (error || !data) {
    return { ok: false, reason: "db_error", message: error?.message ?? "Update failed." };
  }
  await svc.from("audit_log").insert({
    actor_id: userId,
    account_id: accountId,
    action: "account.keys_rotated",
  });
  return { ok: true, account: toSafe(data) };
}

/**
 * Delete an account. Credentials are always purged from Vault. By default the
 * row is soft-deleted (history preserved); `purgeHistory` hard-deletes it,
 * cascading away its snapshots/trades.
 */
export async function deleteAccount(
  userId: string,
  accountId: string,
  opts: { purgeHistory?: boolean } = {},
): Promise<{ ok: true } | AccountError> {
  const svc = getSupabaseService();
  const { data: row } = await svc
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .single();
  if (!row) {
    return { ok: false, reason: "not_found", message: "Account not found." };
  }

  await purgeCredentials(svc, row.alpaca_key_secret_id, row.alpaca_secret_secret_id);

  if (opts.purgeHistory) {
    const { error } = await svc.from("accounts").delete().eq("id", accountId);
    if (error) {
      return { ok: false, reason: "db_error", message: error.message };
    }
  } else {
    const { error } = await svc
      .from("accounts")
      .update({
        deleted_at: new Date().toISOString(),
        is_active: false,
        status: "paused",
        alpaca_key_secret_id: null,
        alpaca_secret_secret_id: null,
        // A soft-deleted row keeps its history but must stop carrying the
        // broker identifier the production binding compares against.
        alpaca_account_number: null,
      })
      .eq("id", accountId);
    if (error) {
      return { ok: false, reason: "db_error", message: error.message };
    }
  }

  await svc.from("audit_log").insert({
    actor_id: userId,
    account_id: opts.purgeHistory ? null : accountId,
    action: opts.purgeHistory ? "account.deleted_purged" : "account.deleted",
    detail: { nickname: row.nickname },
  });
  return { ok: true };
}
