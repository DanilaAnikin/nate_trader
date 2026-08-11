import "server-only";
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/database.types";
import { getSupabaseService } from "@/lib/supabase/service";
import { maskAccountNumber } from "./mask";
import {
  validateAlpacaKeys,
  storeCredentials,
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

  // The row and its audit entry commit together. Previously the audit was a
  // separate round trip whose result was discarded, so an account could exist
  // with no record that it was ever created — and an audit log that is
  // sometimes missing entries is worse than none, because its silence is read
  // as evidence that nothing happened.
  // A client-generated id for *this* creation, so the database can recognise a
  // retry. Without it a lost response is undecidable: retrying might create a
  // second account, and compensating might destroy the credentials of one that
  // already exists.
  const operationId = randomUUID();

  // The row and its audit entry commit together. Previously the audit was a
  // separate round trip whose result was discarded, so an account could exist
  // with no record that it was ever created — and an audit log that is
  // sometimes missing entries is worse than none, because its silence is read
  // as evidence that nothing happened.
  const { data, error } = await svc.rpc("create_account_atomic", {
    p_owner: userId,
    p_nickname: nickname,
    p_mode: input.mode,
    p_color: input.color ?? "#007aff",
    p_key_secret: keyId,
    p_secret_secret: secretId,
    p_account_number: validation.accountNumber,
    p_operation_id: operationId,
  });

  if (error || !data) {
    // Read after write, before compensating anything.
    //
    // An error here does not mean the transaction did not commit: a dropped
    // connection, a proxy timeout or a lost response all look identical to a
    // refusal. Purging the Vault pair on that assumption destroys the
    // credentials of an account that exists, which is unrecoverable.
    //
    // The operation id makes the question answerable. Three outcomes, and the
    // third is not an error to be smoothed over:
    const probe = await svc.rpc("find_account_by_operation", {
      p_owner: userId,
      p_operation_id: operationId,
    });

    const committed =
      !probe.error && probe.data && (probe.data as { id?: unknown }).id;
    if (committed) {
      // It did commit; the response was simply lost. This *is* success.
      return { ok: true, account: toSafe(probe.data as AccountRow) };
    }

    const reported = error?.message ?? "Account could not be created.";

    if (probe.error) {
      // The state cannot be established. Deleting the secrets might orphan a
      // live account; leaving them might orphan a pair. Leaving them is the
      // recoverable half, and saying so is the honest answer.
      return {
        ok: false,
        reason: "indeterminate",
        message:
          `${reported} Whether the account was created could not be determined ` +
          `(${probe.error.message}). Nothing was rolled back: operation id ` +
          `${operationId}, Vault ids ${keyId} and ${secretId}. Retrying with ` +
          `the same operation id is safe; purging those ids is not, until the ` +
          `account's absence is confirmed.`,
      };
    }

    // A successful probe that found nothing is proof of absence: the row and
    // its operation id commit together. Only now is compensation safe, and it
    // goes through the purge that refuses an assigned pair.
    try {
      await purgeCredentials(svc, keyId, secretId);
    } catch (caught) {
      return {
        ok: false,
        reason: "db_error",
        message: `${reported} The stored credentials could not be rolled back: ${
          caught instanceof Error ? caught.message : "unknown error"
        }`,
      };
    }
    return { ok: false, reason: "db_error", message: reported };
  }

  return { ok: true, account: toSafe(data as AccountRow) };
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
  if (typeof patch.nickname === "string" && !patch.nickname.trim()) {
    return { ok: false, reason: "invalid_input", message: "Nickname cannot be empty." };
  }
  if (
    typeof patch.nickname !== "string" &&
    typeof patch.color !== "string" &&
    typeof patch.is_active !== "boolean"
  ) {
    return { ok: false, reason: "invalid_input", message: "Nothing to update." };
  }

  const svc = getSupabaseService();
  // Row and audit entry in one transaction, for the same reason as creation:
  // a metadata change with no audit record makes the log's silence misleading.
  const { data, error } = await svc.rpc("update_account_metadata", {
    p_account: accountId,
    p_owner: userId,
    p_nickname: typeof patch.nickname === "string" ? patch.nickname : null,
    p_color: typeof patch.color === "string" ? patch.color : null,
    p_is_active: typeof patch.is_active === "boolean" ? patch.is_active : null,
  });

  if (error) {
    return {
      ok: false,
      reason: error.code === "P0002" ? "not_found" : "db_error",
      message:
        error.code === "P0002"
          ? "Account not found."
          : `The update was rolled back: ${error.message}`,
    };
  }
  if (!data) {
    return { ok: false, reason: "not_found", message: "Account not found." };
  }
  return { ok: true, account: toSafe(data as AccountRow) };
}

/**
 * Re-validate a fresh key pair and swap it in.
 *
 * The Vault writes, the account row and the audit entry all happen inside one
 * `rotate_account_credentials` transaction. Doing them as separate round trips
 * could leave a new key beside the old secret — with the previous key value
 * already overwritten and therefore unrecoverable — or leave the row still
 * advertising the old broker account number that the production binding
 * compares against.
 */
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
  const { data: row, error: readError } = await svc
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) {
    return { ok: false, reason: "db_error", message: readError.message };
  }
  if (!row) {
    return { ok: false, reason: "not_found", message: "Account not found." };
  }
  if (!row.alpaca_key_secret_id || !row.alpaca_secret_secret_id) {
    return { ok: false, reason: "no_credentials", message: "Account has no stored credentials." };
  }

  // Alpaca is checked before anything is written, so a bad pair never reaches
  // the transaction at all.
  const validation = await validateAlpacaKeys(row.mode, apiKey, apiSecret);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, message: validation.message };
  }

  const { data, error } = await svc.rpc("rotate_account_credentials", {
    p_account: accountId,
    p_owner: userId,
    p_api_key: apiKey,
    p_api_secret: apiSecret,
    p_account_number: validation.accountNumber,
  });
  if (error) {
    // Nothing was written: the whole function rolled back.
    return {
      ok: false,
      reason: error.code === "P0002" ? "not_found" : "db_error",
      message: `Key rotation was rolled back: ${error.message}`,
    };
  }
  if (!data) {
    return {
      ok: false,
      reason: "db_error",
      message: "Key rotation returned no account row.",
    };
  }
  return { ok: true, account: toSafe(data as AccountRow) };
}

/**
 * Delete an account.
 *
 * The Vault purge, the row change and the audit entry happen inside one
 * `delete_account_atomic` transaction. Separately, a failed purge used to be
 * discarded silently, which left live credentials behind a row marked deleted;
 * a failed row update left a row pointing at secrets that no longer existed.
 * Now either everything happens or nothing does, and the error is returned.
 *
 * By default the row is soft-deleted (history preserved, credential references
 * and broker account number cleared); `purgeHistory` hard-deletes it, cascading
 * away its snapshots and trades.
 */
export async function deleteAccount(
  userId: string,
  accountId: string,
  opts: { purgeHistory?: boolean } = {},
): Promise<{ ok: true } | AccountError> {
  const svc = getSupabaseService();
  const { error } = await svc.rpc("delete_account_atomic", {
    p_account: accountId,
    p_owner: userId,
    p_purge_history: opts.purgeHistory ?? false,
  });
  if (error) {
    return {
      ok: false,
      reason: error.code === "P0002" ? "not_found" : "db_error",
      message:
        error.code === "P0002"
          ? "Account not found."
          : `Deletion was rolled back: ${error.message}`,
    };
  }
  return { ok: true };
}
