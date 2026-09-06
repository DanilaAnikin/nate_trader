import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creating an account is one transaction, keyed on an id the *client* chose.
 *
 * The case with no safe default is a lost response: the call may have
 * committed, and the error looks identical either way. Retrying blindly
 * creates a second account; compensating blindly destroys the credentials of
 * one that exists. Both are avoided by making the retry *be* the original —
 * the same id blocks on that operation's lock and returns its result — and by
 * writing the Vault secrets inside the same transaction, so there is nothing
 * to compensate in the first place.
 */

const OWNER = "99999999-9999-9999-9999-999999999999";
const OPERATION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

type RpcResult = { data: unknown; error: { message: string } | null };

let createResult: RpcResult;
let resolveResult: RpcResult;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let vaultCalls: number;
let recoveryRow: { data: unknown; error: { message: string } | null };
let alpacaCalls: number;

function accountRow(id = "acc-new") {
  return {
    id,
    owner_id: OWNER,
    nickname: "Created",
    mode: "paper",
    status: "connected",
    color: "#007aff",
    alpaca_key_secret_id: "11111111-1111-1111-1111-111111111111",
    alpaca_secret_secret_id: "22222222-2222-2222-2222-222222222222",
    alpaca_account_number: "PA-1234",
    is_active: true,
    last_verified_at: null,
    last_synced_at: null,
    created_at: "2026-08-11T00:00:00Z",
    updated_at: "2026-08-11T00:00:00Z",
    deleted_at: null,
    credential_version: 1,
    create_operation_id: OPERATION_ID,
  };
}

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "create_account_operation") return createResult;
      if (name === "resolve_create_operation") return resolveResult;
      if (name.startsWith("vault_")) {
        vaultCalls += 1;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
    // The recovery read is bound on every axis that makes the row *this
    // owner's account for this operation*, so the stub has to answer the same
    // chain: id, owner_id, create_operation_id, deleted_at is null.
    from: () => {
      const chain: Record<string, unknown> = {
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => recoveryRow,
      };
      return { select: () => chain };
    },
  }),
}));

const { createAccount, createRequestFingerprint } = await import("./service");

beforeEach(() => {
  rpcCalls = [];
  vaultCalls = 0;
  createResult = { data: accountRow(), error: null };
  resolveResult = { data: { outcome: "absent" }, error: null };
  recoveryRow = { data: accountRow("acc-committed"), error: null };
  alpacaCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      alpacaCalls += 1;
      return new Response(
        JSON.stringify({ account_number: "PA-1234", status: "ACTIVE" }),
        { status: 200 },
      );
    }),
  );
});

const input = {
  nickname: "Created",
  mode: "paper" as const,
  apiKey: "k",
  apiSecret: "s",
  operationId: OPERATION_ID,
};

describe("one transaction, one operation id", () => {
  it("creates everything in a single RPC and writes no Vault secret first", async () => {
    // The secrets used to be two separate RPCs *before* the account existed.
    // A dropped response to either orphaned one, with nothing able to prove
    // later whether it should exist.
    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(true);
    expect(vaultCalls).toBe(0);
    const names = rpcCalls.map((c) => c.name);
    // The ledger is asked first — before Alpaca — so a retry of an already
    // committed request can be answered during a broker outage.
    expect(names).toEqual(["resolve_create_operation", "create_account_operation"]);
  });

  it("passes the client's id and a fingerprint of the payload", async () => {
    await createAccount(OWNER, input);
    const args = rpcCalls.find((c) => c.name === "create_account_operation")!.args;
    expect(args.p_operation_id).toBe(OPERATION_ID);
    expect(String(args.p_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_fingerprint).toBe(createRequestFingerprint(OWNER, input));
  });

  it("gives a different fingerprint to a different payload", () => {
    const a = createRequestFingerprint(OWNER, input);
    expect(createRequestFingerprint(OWNER, { ...input, nickname: "Other" })).not.toBe(a);
    expect(createRequestFingerprint(OWNER, { ...input, apiKey: "k2" })).not.toBe(a);
    expect(createRequestFingerprint("other-owner", input)).not.toBe(a);
    // The same request, twice, is the same fingerprint — that is the point.
    expect(createRequestFingerprint(OWNER, { ...input })).toBe(a);
  });

  it.each([
    ["absent", ""],
    ["not a uuid", "retry-1"],
    ["a nil uuid", "00000000-0000-0000-0000-000000000000"],
  ])("refuses an operation id that is %s", async (_label, operationId) => {
    // Server-validated, so a client cannot opt out of idempotency.
    const result = await createAccount(OWNER, { ...input, operationId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_input");
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("a lost response", () => {
  it("returns the committed account when the operation resolves as created", async () => {
    createResult = { data: null, error: { message: "fetch failed" } };
    resolveResult = {
      data: { outcome: "created", account_id: "acc-committed" },
      error: null,
    };
    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.id).toBe("acc-committed");
    expect(vaultCalls).toBe(0);
    // Answered from the ledger, before the broker was asked at all.
    expect(alpacaCalls).toBe(0);
    expect(rpcCalls.map((c) => c.name)).toEqual(["resolve_create_operation"]);
  });

  it("answers a committed retry during an Alpaca outage", async () => {
    // The validation used to run *ahead* of the ledger, so a retry that
    // arrived while Alpaca was down failed at validation and never asked the
    // question idempotence exists to answer. The caller was told the creation
    // had failed while the account sat committed.
    resolveResult = {
      data: { outcome: "created", account_id: "acc-committed" },
      error: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        alpacaCalls += 1;
        throw new TypeError("fetch failed");
      }),
    );

    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.id).toBe("acc-committed");
    expect(alpacaCalls).toBe(0);
  });

  it("refuses a spent operation id carrying a different request", async () => {
    // Matching the id alone reported *some* account this owner created
    // earlier as the thing just created.
    resolveResult = { data: { outcome: "conflict" }, error: null };
    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_input");
    expect(result.message).toContain("already used for a different request");
    // Nothing was attempted: no broker call, no create.
    expect(alpacaCalls).toBe(0);
    expect(rpcCalls.map((c) => c.name)).toEqual(["resolve_create_operation"]);
  });

  it("passes the fingerprint to the resolver, not only the id", async () => {
    resolveResult = { data: { outcome: "absent" }, error: null };
    await createAccount(OWNER, input);
    const probe = rpcCalls.find((c) => c.name === "resolve_create_operation")!;
    expect(probe.args.p_fingerprint).toBe(createRequestFingerprint(OWNER, input));
  });

  it.each([
    ["the row belongs to another owner or operation", { data: null, error: null }],
    ["the recovery read itself failed", { data: null, error: { message: "reset" } }],
  ])("does not report success when %s", async (_label, row) => {
    // The read used to match the id alone and ignore its own error, so a
    // ledger row naming a foreign, soft-deleted or re-pointed account came
    // back as a successful creation — and a failed read was indistinguishable
    // from no row.
    createResult = { data: null, error: { message: "fetch failed" } };
    resolveResult = {
      data: { outcome: "created", account_id: "acc-committed" },
      error: null,
    };
    recoveryRow = row as typeof recoveryRow;
    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("indeterminate");
  });

  it("reports a plain failure when the operation provably never ran", async () => {
    // Proven under the operation lock. Nothing to compensate: the secrets are
    // written inside the same transaction that failed.
    createResult = { data: null, error: { message: "nickname is required" } };
    resolveResult = { data: { outcome: "absent" }, error: null };
    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("db_error");
    expect(vaultCalls).toBe(0);
  });

  it("says so, and purges nothing, when the state cannot be established", async () => {
    createResult = { data: null, error: { message: "fetch failed" } };
    resolveResult = { data: null, error: { message: "connection reset" } };
    const result = await createAccount(OWNER, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("indeterminate");
    expect(vaultCalls).toBe(0);
    expect(result.message).toContain("Retrying with the same operation id is safe");
    // And it does not leak the ids it would have needed to purge.
    expect(result.message).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("two retries of one request make exactly one create call each, same id", async () => {
    // The database collapses them; the client's job is only to send the same
    // id both times.
    await createAccount(OWNER, input);
    await createAccount(OWNER, input);
    const creates = rpcCalls.filter((c) => c.name === "create_account_operation");
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((c) => c.args.p_operation_id)).size).toBe(1);
    expect(new Set(creates.map((c) => c.args.p_fingerprint)).size).toBe(1);
  });
});
