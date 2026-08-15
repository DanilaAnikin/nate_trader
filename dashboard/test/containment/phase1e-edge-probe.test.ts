import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * One observation of the edge, asserted against whichever tree it is run in.
 *
 * Driven by phase1e-freeze-revert.sh, which runs this file twice: once against
 * the artifact as it stands, and once against a copy with commit 86654b552's
 * proxy change reverse-applied — the flag-gated freeze restored and nothing
 * else touched. `PHASE1E_EXPECT` says which tree it is in, and both directions
 * are real assertions:
 *
 *   frozen  the current artifact refuses at the edge, 503, no client built
 *   defect  the reverted copy reproduces the ORIGINAL defect, 401, client built
 *
 * The `defect` direction is the load-bearing one. It is not enough that the
 * fix passes; the mutation that removes it has to fail, and fail in the
 * specific way the canary measured — otherwise the unconditional freeze might
 * be redundant with some other control and the evidence would prove nothing
 * about the line actually changed.
 *
 * The count of constructed Supabase clients is what makes this precise. A 401
 * only says the request was refused. The construction says it REACHED
 * authentication, which is what a frozen artifact must never do on a mutating
 * method — the handler's constant 503 never ran at all.
 *
 * DASHBOARD_MAINTENANCE_MODE is deliberately left unset: that is the
 * production configuration, and the exact one under which the old gated
 * condition evaluated false and fell through.
 */

const EXPECT = process.env.PHASE1E_EXPECT ?? "frozen";

let clients = 0;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    clients += 1;
    // No session — the unauthenticated case the defect produced.
    return {
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    };
  },
}));

beforeEach(() => {
  clients = 0;
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  // production leaves this unset; the old condition read it and fell through
  vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function probe(method: string, path = "/api/accounts") {
  const { proxy } = await import("@/proxy");
  const res = await proxy(
    new NextRequest(new URL(path, "https://dashboard.example.com"), { method }),
  );
  const body = await res.clone().json().catch(() => ({}));
  return { status: res.status, code: body.code ?? null, reason: body.reason ?? null, clients };
}

describe(`the edge, observed in the "${EXPECT}" tree`, () => {
  it("declares which tree it is running against", () => {
    // non-vacuity: a typo'd or absent value must not silently select a
    // direction nobody meant to assert
    expect(["frozen", "defect"]).toContain(EXPECT);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    it(`${method} /api/accounts`, async () => {
      const got = await probe(method);
      if (EXPECT === "frozen") {
        expect(got.status).toBe(503);
        expect(got.reason).toBe("FROZEN_CONTAINMENT_BRIDGE");
        expect(
          got.clients,
          "a frozen edge must not reach authentication on a mutating method",
        ).toBe(0);
      } else {
        expect(
          got.status,
          "reverting the unconditional freeze must reproduce the 401",
        ).toBe(401);
        expect(got.code).toBe("UNAUTHENTICATED");
        expect(
          got.clients,
          "reverting it must also reproduce the client construction",
        ).toBe(1);
      }
    });
  }

  it("GET is unaffected in either tree", async () => {
    // The freeze is by method. If reverting it changed the read path too, the
    // mutation would be broader than 'the unconditional proxy freeze' and the
    // comparison above would be measuring more than one thing.
    const got = await probe("GET");
    expect(got.status).toBe(401);
    expect(got.code).toBe("UNAUTHENTICATED");
    expect(got.clients).toBe(1);
  });
});
