import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fault injection across every step of the account lifecycle.
 *
 * Each of these once produced a state no retry could repair: a new key beside
 * the old secret with the previous key value already overwritten; a rotated
 * Vault pair beside a row still advertising the old broker account number that
 * the production binding compares; a soft-deleted row whose live credentials
 * were never purged because the purge result was discarded.
 *
 * The fix is a single transaction per flow (`rotate_account_credentials`,
 * `delete_account_atomic`), so the test asserts two things: the server calls
 * the transaction rather than a sequence of writes, and every failure is
 * propagated instead of being reported as success.
 */

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

const ACCOUNT_ID = "acc-1";
const OWNER_ID = "99999999-9999-9999-9999-999999999999";
const BROKER_NUMBER = "PA-ROTATE-CANARY-5150";

const ROW: {
  id: string;
  owner_id: string;
  nickname: string;
  mode: "paper";
  status: "connected";
  color: string;
  alpaca_key_secret_id: string | null;
  alpaca_secret_secret_id: string | null;
  alpaca_account_number: string | null;
  is_active: boolean;
  last_verified_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
} = {
  id: ACCOUNT_ID,
  owner_id: OWNER_ID,
  nickname: "Paper production",
  mode: "paper" as const,
  status: "connected" as const,
  color: "#007aff",
  alpaca_key_secret_id: "11111111-2222-3333-4444-555555555555",
  alpaca_secret_secret_id: "66666666-7777-8888-9999-000000000000",
  alpaca_account_number: BROKER_NUMBER,
  is_active: true,
  last_verified_at: "2026-08-07T16:00:00Z",
  last_synced_at: "2026-08-07T16:00:00Z",
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-08-07T16:00:00Z",
  deleted_at: null,
};

/** Every RPC the service made, in order. */
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
/** Per-RPC canned results; anything unset succeeds. */
let rpcResults: Record<string, RpcResult> = {};
/** Table writes, so a test can prove none happened outside the transaction. */
let tableWrites: { table: string; op: string }[] = [];
let accountRow: typeof ROW | null = ROW;
let accountReadError: { message: string } | null = null;

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResults[name] ?? { data: defaultFor(name), error: null };
    },
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        maybeSingle: async () => ({
          data: accountRow,
          error: accountReadError,
        }),
        single: async () => ({ data: accountRow, error: accountReadError }),
        insert: async () => {
          tableWrites.push({ table, op: "insert" });
          return { error: null };
        },
        update: () => {
          tableWrites.push({ table, op: "update" });
          return { eq: () => builder, select: () => builder };
        },
        delete: () => {
          tableWrites.push({ table, op: "delete" });
          return { eq: async () => ({ error: null }) };
        },
      };
      return builder;
    },
  }),
}));

function defaultFor(name: string): unknown {
  if (name === "rotate_account_credentials") return { ...ROW };
  if (name === "delete_account_atomic") return true;
  return null;
}

const { deleteAccount, rotateKeys } = await import("./service");

beforeEach(() => {
  rpcCalls = [];
  rpcResults = {};
  tableWrites = [];
  accountRow = { ...ROW };
  accountReadError = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ account_number: BROKER_NUMBER }), {
          status: 200,
        }),
    ),
  );
});

describe("rotateKeys is one transaction", () => {
  it("rotates through the atomic RPC, not a sequence of writes", async () => {
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(true);

    const names = rpcCalls.map((call) => call.name);
    expect(names).toContain("rotate_account_credentials");
    // The two Vault writes and the row update no longer happen separately.
    expect(names).not.toContain("vault_update_secret");
    expect(tableWrites.filter((write) => write.op !== "insert")).toEqual([]);

    const call = rpcCalls.find(
      (entry) => entry.name === "rotate_account_credentials",
    )!;
    expect(call.args).toMatchObject({
      p_account: ACCOUNT_ID,
      p_owner: OWNER_ID,
      p_api_key: "key",
      p_api_secret: "secret",
      // The freshly read broker number, not one taken from the stored row.
      p_account_number: BROKER_NUMBER,
    });
  });

  it("validates against Alpaca before writing anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_keys");
    expect(rpcCalls.map((call) => call.name)).not.toContain(
      "rotate_account_credentials",
    );
  });

  it("reports a rolled-back rotation instead of claiming success", async () => {
    // Whatever failed inside — either Vault write, the row update, the audit
    // insert — the transaction rolled all of it back.
    rpcResults.rotate_account_credentials = {
      data: null,
      error: { message: "vault.update_secret: connection reset" },
    };
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.message).toContain("rolled back");
    expect(result.message).toContain("connection reset");
  });

  it("maps a missing account to not_found rather than a database error", async () => {
    rpcResults.rotate_account_credentials = {
      data: null,
      error: { message: "account not found", code: "P0002" },
    };
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("refuses when the transaction returns no row", async () => {
    rpcResults.rotate_account_credentials = { data: null, error: null };
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(false);
  });

  it("propagates a failed account read instead of reporting not_found", async () => {
    accountRow = null;
    accountReadError = { message: "statement timeout" };
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.message).toContain("statement timeout");
  });

  it("refuses an account with no stored credentials", async () => {
    accountRow = {
      ...ROW,
      alpaca_key_secret_id: null,
      alpaca_secret_secret_id: null,
    };
    const result = await rotateKeys(OWNER_ID, ACCOUNT_ID, "key", "secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_credentials");
    expect(rpcCalls.map((call) => call.name)).not.toContain(
      "rotate_account_credentials",
    );
  });
});

describe("deleteAccount is one transaction", () => {
  it.each([
    ["soft delete", false],
    ["hard delete", true],
  ])("performs a %s through the atomic RPC", async (_label, purgeHistory) => {
    const result = await deleteAccount(OWNER_ID, ACCOUNT_ID, { purgeHistory });
    expect(result.ok).toBe(true);

    const names = rpcCalls.map((call) => call.name);
    expect(names).toEqual(["delete_account_atomic"]);
    // The Vault purge, the row change and the audit entry are all inside it.
    expect(names).not.toContain("vault_delete_secret");
    expect(tableWrites).toEqual([]);
    expect(rpcCalls[0].args).toMatchObject({
      p_account: ACCOUNT_ID,
      p_owner: OWNER_ID,
      p_purge_history: purgeHistory,
    });
  });

  it.each([
    ["the Vault purge", "vault.secrets: permission denied"],
    ["the row update", "update accounts: deadlock detected"],
    ["the audit insert", "insert audit_log: check constraint"],
  ])("reports a rollback when %s fails", async (_label, message) => {
    rpcResults.delete_account_atomic = { data: null, error: { message } };
    const result = await deleteAccount(OWNER_ID, ACCOUNT_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.message).toContain("rolled back");
    expect(result.message).toContain(message);
  });

  it("maps a missing account to not_found", async () => {
    rpcResults.delete_account_atomic = {
      data: null,
      error: { message: "account not found", code: "P0002" },
    };
    const result = await deleteAccount(OWNER_ID, ACCOUNT_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    expect(result.message).toBe("Account not found.");
  });
});
