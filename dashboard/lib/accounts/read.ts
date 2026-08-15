import "server-only";
import type { Database } from "@/lib/database.types";
import { getSupabaseService } from "@/lib/supabase/service";
import { maskAccountNumber } from "./mask";

/**
 * The READ-ONLY half of the account service.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `service.ts` exports `listAccounts` alongside `createAccount`, `updateAccount`,
 * `rotateKeys` and `deleteAccount`. Those four reach `./credentials`, which calls
 * `vault_create_secret`, `vault_update_secret` and `vault_delete_secret` — the
 * three routines migration 0022 deliberately tombstones on the latest schema.
 *
 * So while GET /api/accounts imported `listAccounts` from `service.ts`, the
 * tombstoned wrappers sat inside a GET handler's transitive import closure.
 * Nothing called them — the mutation handlers are constant 503 — but "nothing
 * calls it" is a claim about control flow, and the containment gate is required
 * to prove a property of the MODULE GRAPH, which is decidable.
 *
 * Splitting the read path out makes that proof trivial and permanent: this file
 * imports the service-role client and the masker, and nothing else. A future
 * edit that reintroduces a mutation import here turns the reachability gate red.
 *
 * `service.ts` re-exports these so the many type-only importers are unaffected.
 */

type AccountRow = Database["public"]["Tables"]["accounts"]["Row"];

/**
 * The account shape the browser is allowed to see.
 *
 * An explicit allowlist, deliberately *not* `Omit<AccountRow, ...>`: a new
 * sensitive column added to the table must not become client-visible by
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
