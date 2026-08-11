/**
 * The incident contract applies to every mutating account route, not only to
 * creation.
 *
 * `POST /api/accounts` was sanitized in an earlier round. `PATCH`, `DELETE` and
 * `POST /refresh` were not: they returned `result.message` and `result.detail`
 * straight through, and those strings are written for an operator reading a
 * server log — the constraint that fired, the relation, and, because these
 * RPCs take them as arguments, Vault UUIDs, the operation id and the full
 * broker account number. Every one of them is reachable by any signed-in
 * tenant who can provoke a conflict on their own account.
 *
 * These search the *serialized* response rather than named fields, so a leak
 * through a field nobody thought to check still fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isSanitized } from "@/lib/incident";

const OWNER = "99999999-9999-9999-9999-999999999999";
const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const CANARY_VAULT_KEY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CANARY_BROKER_NUMBER = "PA-LEAK-CANARY-90210";

/** The shape a real PostgREST failure has, with every canary embedded. */
const LEAKY_MESSAGE =
  `duplicate key value violates unique constraint "accounts_pkey": ` +
  `Key (secret_id)=(${CANARY_VAULT_KEY}) already exists; ` +
  `account ${CANARY_BROKER_NUMBER}; SQLSTATE 23505 in plpgsql function ` +
  `rotate_account_credentials near vault.secrets`;

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async () => ({ data: null, error: { message: LEAKY_MESSAGE } }),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: ACCOUNT, owner_id: OWNER, mode: "paper" },
              error: null,
            }),
          }),
          maybeSingle: async () => ({
            data: { id: ACCOUNT, owner_id: OWNER, mode: "paper" },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/accounts/session", () => ({
  getSessionUser: async () => ({ id: OWNER }),
  loadOwnedAccount: async () => ({
    id: ACCOUNT,
    owner_id: OWNER,
    mode: "paper" as const,
  }),
}));

vi.mock("@/lib/accounts/service", () => ({
  updateAccount: async () => ({
    ok: false,
    reason: "db_error",
    message: LEAKY_MESSAGE,
  }),
  rotateKeys: async () => ({
    ok: false,
    reason: "db_error",
    message: LEAKY_MESSAGE,
  }),
  deleteAccount: async () => ({
    ok: false,
    reason: "db_error",
    message: LEAKY_MESSAGE,
  }),
}));

vi.mock("@/lib/accounts/broker-refresh", () => ({
  refreshBrokerDatasets: async () => ({
    ok: false,
    reason: "RECONCILIATION_CONFLICT",
    detail: LEAKY_MESSAGE,
    mirrorMutated: false,
    reservationTaken: false,
  }),
}));

const { PATCH, DELETE } = await import("./route");
const { POST: REFRESH } = await import("./refresh/route");

const ctx = { params: Promise.resolve({ id: ACCOUNT }) };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function read(response: Response) {
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  // The incident id is itself a UUID and is *supposed* to be there.
  const scrubbed =
    typeof body.incidentId === "string"
      ? text.replaceAll(body.incidentId, "<incident>")
      : text;
  return { response, text, scrubbed, body };
}

const CASES: readonly [string, () => Promise<Response>][] = [
  [
    "PATCH (metadata)",
    () =>
      PATCH(
        new Request(`http://localhost/api/accounts/${ACCOUNT}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nickname: "renamed" }),
        }),
        ctx,
      ),
  ],
  [
    "PATCH (key rotation)",
    () =>
      PATCH(
        new Request(`http://localhost/api/accounts/${ACCOUNT}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: "k", apiSecret: "s" }),
        }),
        ctx,
      ),
  ],
  [
    "DELETE",
    () =>
      DELETE(
        new Request(`http://localhost/api/accounts/${ACCOUNT}`, {
          method: "DELETE",
        }),
        ctx,
      ),
  ],
  [
    "POST /refresh",
    () =>
      REFRESH(
        new Request(`http://localhost/api/accounts/${ACCOUNT}/refresh`, {
          method: "POST",
        }),
        ctx,
      ),
  ],
];

describe.each(CASES)("%s leaks nothing on failure", (_label, call) => {
  it("returns a stable code and an incident id, not the database message", async () => {
    const { response, body } = await read(await call());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(typeof body.code).toBe("string");
    expect(typeof body.incidentId).toBe("string");
    expect(String(body.error)).not.toContain("constraint");
  });

  it("carries neither the Vault id nor the broker account number", async () => {
    const { text } = await read(await call());
    expect(text).not.toContain(CANARY_VAULT_KEY);
    expect(text).not.toContain(CANARY_BROKER_NUMBER);
  });

  it("carries no raw SQL, SQLSTATE, relation name or Vault reference", async () => {
    const { scrubbed } = await read(await call());
    const verdict = isSanitized(scrubbed);
    expect(
      verdict.found,
      `response contains ${verdict.found.join(", ")}`,
    ).toEqual([]);
  });

  it("logs the detail server-side, where it belongs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { body } = await read(await call());
    const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(CANARY_VAULT_KEY);
    expect(logged).toContain(String(body.incidentId));
  });

  it("never echoes the internal reason string to the browser", async () => {
    // `reason: "db_error"` names an internal branch. The UI branches on
    // `code`, which is a published contract; the internal name is not.
    const { body } = await read(await call());
    expect(body.reason).toBeUndefined();
  });
});

describe("the refresh route keeps its honest mutation report", () => {
  it("still states that the mirrors were not touched", async () => {
    // Sanitizing the detail must not remove the one fact a caller needs to
    // decide whether a retry is safe.
    const { body } = await read(await CASES[3][1]());
    expect(body.mirrorMutated).toBe(false);
    expect(body.reservationTaken).toBe(false);
  });
});
