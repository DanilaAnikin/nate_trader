import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORBIDDEN_IN_RESPONSES, isSanitized } from "@/lib/incident";

/**
 * Canaries: distinctive values planted in the failure path, then hunted for in
 * everything the browser receives.
 *
 * A database error message is written for an operator, and it says operator
 * things — the constraint that fired, the relation, and, because these RPCs
 * take them as arguments, Vault UUIDs, the operation id and the full broker
 * account number. Forwarding it is trivially reachable by any signed-in tenant
 * who can provoke a conflict.
 *
 * These search the *serialized* response rather than inspecting fields, so a
 * leak through a field nobody thought to check still fails.
 */

const OWNER = "99999999-9999-9999-9999-999999999999";
const CANARY_VAULT_KEY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CANARY_VAULT_SECRET = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CANARY_OPERATION = "cccccccc-3333-4333-8333-cccccccccccc";
const CANARY_BROKER_NUMBER = "PA-LEAK-CANARY-90210";

/** The shape a real PostgREST failure has, with every canary embedded. */
const LEAKY_DB_ERROR = {
  message:
    `duplicate key value violates unique constraint ` +
    `"account_credential_assignment_pkey": Key (secret_id)=(${CANARY_VAULT_KEY}) ` +
    `already exists; operation ${CANARY_OPERATION}; account ${CANARY_BROKER_NUMBER}; ` +
    `secret ${CANARY_VAULT_SECRET}; SQLSTATE 23505 in plpgsql function ` +
    `create_account_operation near vault.secrets`,
};

let rpcCalls: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async (name: string) => {
      rpcCalls.push(name);
      if (name === "create_account_operation") {
        return { data: null, error: LEAKY_DB_ERROR };
      }
      if (name === "resolve_create_operation") {
        return { data: { outcome: "absent" }, error: null };
      }
      return { data: null, error: null };
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}));

const { POST } = await import("./route");

beforeEach(() => {
  rpcCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({ account_number: CANARY_BROKER_NUMBER, status: "ACTIVE" }),
        { status: 200 },
      ),
    ),
  );
});

async function createRequest() {
  const response = await POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nickname: "Canary",
        mode: "paper",
        apiKey: "k",
        apiSecret: "s",
        operationId: CANARY_OPERATION,
      }),
    }),
  );
  return { response, text: await response.text() };
}

describe("POST /api/accounts leaks nothing on failure", () => {
  it("returns a stable code and an incident id, not the database message", async () => {
    const { response, text } = await createRequest();
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(typeof body.code).toBe("string");
    expect(typeof body.incidentId).toBe("string");
    expect(String(body.error)).not.toContain("constraint");
  });

  it.each([
    ["a Vault key id", CANARY_VAULT_KEY],
    ["a Vault secret id", CANARY_VAULT_SECRET],
    ["the operation id", CANARY_OPERATION],
    ["the full broker account number", CANARY_BROKER_NUMBER],
  ])("does not carry %s", async (_label, canary) => {
    const { text } = await createRequest();
    expect(text).not.toContain(canary);
  });

  it("carries no raw SQL, SQLSTATE, relation name or Vault reference", async () => {
    const { text } = await createRequest();
    // The incident id is itself a UUID and is *supposed* to be there, so it is
    // removed before the UUID pattern is applied.
    const body = JSON.parse(text) as { incidentId?: string };
    const scrubbed = text.replace(String(body.incidentId), "<incident>");
    const verdict = isSanitized(scrubbed);
    expect(verdict.found, `response contains ${verdict.found.join(", ")}`).toEqual([]);
  });

  it("logs the detail server-side, where it belongs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { text } = await createRequest();
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\\n");
    // The operator can still find everything — just not through the browser.
    expect(logged).toContain(CANARY_VAULT_KEY);
    const body = JSON.parse(text) as { incidentId?: string };
    expect(logged).toContain(String(body.incidentId));
  });

  it("keeps the forbidden-pattern list non-empty, so the canary can fail", () => {
    // Guards against the list being emptied and every assertion above passing
    // vacuously.
    expect(FORBIDDEN_IN_RESPONSES.length).toBeGreaterThanOrEqual(4);
    expect(isSanitized(`id ${CANARY_VAULT_KEY}`).ok).toBe(false);
    expect(isSanitized("SQLSTATE 23505").ok).toBe(false);
    expect(isSanitized("nothing to see").ok).toBe(true);
  });
});
