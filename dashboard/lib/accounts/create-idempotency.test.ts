import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens when the response to a committed write is lost.
 *
 * This is the case that has no safe default. `create_account_atomic` may have
 * committed; the error the caller sees is identical whether it did or not.
 * Retrying blindly creates a second account. Compensating blindly deletes the
 * Vault secrets of an account that exists, which is unrecoverable.
 *
 * The operation id makes the question answerable, and these assert all three
 * answers — including the one that is deliberately *not* resolved.
 */

const OWNER = "99999999-9999-9999-9999-999999999999";
const KEY_ID = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "22222222-2222-2222-2222-222222222222";

type RpcResult = { data: unknown; error: { message: string } | null };

let createResult: RpcResult;
let probeResult: RpcResult;
let purgeCalls: number;
let purgeThrows: boolean;
let rpcCalls: { name: string; args: Record<string, unknown> }[];

function accountRow(id = "acc-new") {
  return {
    id,
    owner_id: OWNER,
    nickname: "Created",
    mode: "paper",
    status: "connected",
    color: "#007aff",
    alpaca_key_secret_id: KEY_ID,
    alpaca_secret_secret_id: SECRET_ID,
    alpaca_account_number: "PA-1234",
    is_active: true,
    last_verified_at: null,
    last_synced_at: null,
    created_at: "2026-08-11T00:00:00Z",
    updated_at: "2026-08-11T00:00:00Z",
    deleted_at: null,
    credential_version: 1,
    create_operation_id: "op",
  };
}

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "create_account_atomic") return createResult;
      if (name === "find_account_by_operation") return probeResult;
      if (name === "vault_create_secret") {
        return {
          data: rpcCalls.filter((c) => c.name === "vault_create_secret").length === 1
            ? KEY_ID
            : SECRET_ID,
          error: null,
        };
      }
      if (name === "vault_delete_secret") {
        purgeCalls += 1;
        if (purgeThrows) return { data: null, error: { message: "purge failed" } };
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const { createAccount } = await import("./service");

beforeEach(() => {
  rpcCalls = [];
  purgeCalls = 0;
  purgeThrows = false;
  createResult = { data: accountRow(), error: null };
  probeResult = { data: null, error: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ account_number: "PA-1234", status: "ACTIVE" }), {
        status: 200,
      }),
    ),
  );
});

const input = {
  nickname: "Created",
  mode: "paper" as const,
  apiKey: "k",
  apiSecret: "s",
};

describe("createAccount carries an operation id", () => {
  it("sends a fresh operation id, so a retry is recognisable", async () => {
    await createAccount(OWNER, input);
    const call = rpcCalls.find((c) => c.name === "create_account_atomic");
    expect(call).toBeDefined();
    expect(typeof call!.args.p_operation_id).toBe("string");
    expect(String(call!.args.p_operation_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("uses a different id for a different creation", async () => {
    await createAccount(OWNER, input);
    await createAccount(OWNER, input);
    const ids = rpcCalls
      .filter((c) => c.name === "create_account_atomic")
      .map((c) => c.args.p_operation_id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("a lost response after a committed create", () => {
  it("reports success and purges nothing when the probe finds the account", async () => {
    // The transaction committed; only the answer was lost. Compensating here
    // would delete the credentials of a live account.
    createResult = { data: null, error: { message: "fetch failed" } };
    probeResult = { data: accountRow("acc-committed"), error: null };

    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.id).toBe("acc-committed");
    expect(purgeCalls).toBe(0);
  });

  it("purges only when the probe proves the account does not exist", async () => {
    // A successful probe returning nothing is proof of absence: the row and
    // its operation id commit together.
    createResult = { data: null, error: { message: "constraint violated" } };
    probeResult = { data: null, error: null };

    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(purgeCalls).toBe(2);
  });

  it("purges nothing and says so when the state cannot be established", async () => {
    // The probe itself failed. Deleting might orphan a live account; leaving
    // them might orphan a pair. Leaving them is the recoverable half.
    createResult = { data: null, error: { message: "fetch failed" } };
    probeResult = { data: null, error: { message: "connection reset" } };

    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("indeterminate");
    expect(purgeCalls).toBe(0);
    // The operator needs the ids to finish the job by hand.
    expect(result.message).toContain(KEY_ID);
    expect(result.message).toContain(SECRET_ID);
    expect(result.message).toContain("Retrying with the same operation id is safe");
  });

  it("reports a failed compensation rather than hiding it", async () => {
    createResult = { data: null, error: { message: "constraint violated" } };
    probeResult = { data: null, error: null };
    purgeThrows = true;

    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/could not be rolled back/);
  });
});
