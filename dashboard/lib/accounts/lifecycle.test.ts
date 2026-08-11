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
  if (name === "create_account_atomic") return { ...ROW };
  if (name === "create_account_operation") return { ...ROW };
  if (name === "resolve_create_operation") return { outcome: "absent" };
  if (name === "update_account_metadata") return { ...ROW };
  if (name === "delete_account_atomic") return true;
  if (name === "vault_create_secret") return "vault-uuid";
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

/* ---------------------------------------------------------------------------
 * Creation and metadata updates are transactions too.
 *
 * Both could previously succeed while their audit entry failed, because the
 * audit insert was a separate round trip whose result was discarded. An audit
 * log that is sometimes missing entries is worse than none: its silence gets
 * read as evidence that nothing happened.
 * ------------------------------------------------------------------------- */

const { createAccount, updateAccount } = await import("./service");

describe("createAccount is one transaction", () => {
  it("creates everything through a single RPC, with no Vault write first", async () => {
    const result = await createAccount(OWNER_ID, {
      nickname: "New paper",
      mode: "paper",
      apiKey: "k",
      apiSecret: "s",
      operationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(result.ok).toBe(true);

    const names = rpcCalls.map((call) => call.name);
    // The Vault secrets are created *inside* the transaction now. Two separate
    // `vault_create_secret` round trips before it meant a dropped response
    // orphaned a secret with nothing able to prove later whether it belonged.
    // The ledger is consulted first — before Alpaca — so a retry of an
    // already committed request stays answerable during a broker outage.
    expect(names).toEqual(["resolve_create_operation", "create_account_operation"]);
    expect(tableWrites).toEqual([]);
    const call = rpcCalls.find((entry) => entry.name === "create_account_operation")!;
    expect(call.args).toMatchObject({
      p_owner: OWNER_ID,
      p_nickname: "New paper",
      p_mode: "paper",
      p_account_number: BROKER_NUMBER,
      p_operation_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(String(call.args.p_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compensates nothing when the transaction rolls back", async () => {
    // There is nothing to compensate: the secrets were written inside the
    // transaction that failed, so they rolled back with it. The old code
    // deleted two secrets here, which is what made a lost response dangerous.
    rpcResults.create_account_operation = {
      data: null,
      error: { message: "insert audit_log: check constraint" },
    };
    rpcResults.resolve_create_operation = {
      data: { outcome: "absent" },
      error: null,
    };
    const result = await createAccount(OWNER_ID, {
      nickname: "New paper",
      mode: "paper",
      apiKey: "k",
      apiSecret: "s",
      operationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(result.ok).toBe(false);
    expect(rpcCalls.filter((call) => call.name === "vault_delete_secret")).toHaveLength(0);
    expect(rpcCalls.filter((call) => call.name === "vault_create_secret")).toHaveLength(0);
  });

  it("reports an indeterminate outcome rather than guessing", async () => {
    rpcResults.create_account_operation = {
      data: null,
      error: { message: "deadlock detected" },
    };
    rpcResults.resolve_create_operation = {
      data: null,
      error: { message: "vault unreachable" },
    };
    const result = await createAccount(OWNER_ID, {
      nickname: "New paper",
      mode: "paper",
      apiKey: "k",
      apiSecret: "s",
      operationId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("indeterminate");
    expect(result.message).toContain("Retrying with the same operation id is safe");
  });
});

describe("updateAccount is one transaction", () => {
  it("updates the row and its audit entry through one RPC", async () => {
    const result = await updateAccount(OWNER_ID, ACCOUNT_ID, {
      nickname: "Renamed",
      is_active: false,
    });
    expect(result.ok).toBe(true);
    expect(rpcCalls.map((call) => call.name)).toEqual(["update_account_metadata"]);
    expect(tableWrites).toEqual([]);
    expect(rpcCalls[0].args).toMatchObject({
      p_account: ACCOUNT_ID,
      p_owner: OWNER_ID,
      p_nickname: "Renamed",
      p_color: null,
      p_is_active: false,
    });
  });

  it("reports a rollback instead of claiming the change landed", async () => {
    rpcResults.update_account_metadata = {
      data: null,
      error: { message: "insert audit_log: permission denied" },
    };
    const result = await updateAccount(OWNER_ID, ACCOUNT_ID, { nickname: "X" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(result.message).toContain("rolled back");
  });

  it("maps a missing account to not_found", async () => {
    rpcResults.update_account_metadata = {
      data: null,
      error: { message: "account not found", code: "P0002" },
    };
    const result = await updateAccount(OWNER_ID, ACCOUNT_ID, { nickname: "X" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("refuses an empty patch without touching the database", async () => {
    const result = await updateAccount(OWNER_ID, ACCOUNT_ID, {});
    expect(result.ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
});
