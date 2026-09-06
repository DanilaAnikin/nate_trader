import { describe, expect, it, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The bridge's writes are off in the CODE, under every configuration.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The previous suite asserted "every mutating handler calls maintenanceBlock()".
 * That was the right test for a flag-gated freeze and it is the wrong test now,
 * because it is satisfied by a handler that consults a flag and then writes.
 * The property here is strictly stronger and does not mention the flag at all:
 *
 *   a mutating handler returns a constant 503 and does nothing else,
 *   whatever the environment says.
 *
 * Deleting the old assertions without replacing them would have been a silent
 * weakening, so each one is superseded by something that would also have caught
 * the original bug.
 */

const DASH = join(__dirname, "..", "..");
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Every route file on disk. Enumerated, never hand-listed. */
function routeFiles(dir = join(DASH, "app", "api"), out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    // EVERY route-file form Next accepts, not just the one this tree happens
    // to use today. Matching the literal "route.ts" meant app/api/x/route.js
    // exporting a writing GET was seen by neither this enumerator nor
    // app/api/route-surface.test.ts — and a GET is not refused by the edge
    // freeze, which is deliberately method-scoped.
    else if (/^route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

const ROUTES = routeFiles();

/** The environment permutations the directive requires to be indistinguishable. */
const ENVS: Array<Record<string, string | undefined>> = [
  { DASHBOARD_MAINTENANCE_MODE: "on" },
  { DASHBOARD_MAINTENANCE_MODE: "off" },
  { DASHBOARD_MAINTENANCE_MODE: "" },
  { DASHBOARD_MAINTENANCE_MODE: undefined },
  { DASHBOARD_MAINTENANCE_MODE: "off", DASHBOARD_SIDECAR_ONLY: "on" },
  { DASHBOARD_MAINTENANCE_MODE: "off", DASHBOARD_SIDECAR_ONLY: "off" },
  {
    DASHBOARD_MAINTENANCE_MODE: "off",
    DASHBOARD_SIDECAR_ONLY: "on",
    DASHBOARD_FREEZE_BYPASS_USERS: "00000000-0000-0000-0000-000000000001",
  },
];

describe("the mutating surface is frozen in the image", () => {
  it("found the route surface", () => {
    // non-vacuity: an empty enumeration would make every loop below trivial
    expect(ROUTES.length).toBeGreaterThanOrEqual(8);
  });

  it("no mutating handler takes a request parameter", () => {
    // A handler that accepts `req` can read the body. One that takes no
    // parameter provably cannot — the strongest form of "the body is never
    // parsed" that is checkable without executing every path.
    const offences: string[] = [];
    for (const f of ROUTES) {
      const src = readFileSync(f, "utf8");
      for (const verb of MUTATING) {
        const m = src.match(new RegExp(`export async function ${verb}\\s*\\(([^)]*)\\)`));
        if (m && m[1].trim() !== "") {
          offences.push(`${relative(DASH, f)}: ${verb} accepts (${m[1].trim()})`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("every mutating handler body is exactly the constant refusal", () => {
    const offences: string[] = [];
    for (const f of ROUTES) {
      const src = readFileSync(f, "utf8");
      for (const verb of MUTATING) {
        const m = src.match(
          new RegExp(`export async function ${verb}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`),
        );
        if (!m) continue;
        const body = m[1].trim();
        if (body !== "return frozenResponse();") {
          offences.push(`${relative(DASH, f)}: ${verb} body is not the constant refusal: ${body.slice(0, 80)}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("no route file imports a mutation service or credentials helper", () => {
    const forbidden = [
      "@/lib/accounts/service",
      "@/lib/accounts/credentials",
      "./credentials",
    ];
    const offences: string[] = [];
    for (const f of ROUTES) {
      const code = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
        .join("\n");
      for (const spec of forbidden) {
        if (new RegExp(`from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(code)) {
          offences.push(`${relative(DASH, f)}: imports ${spec}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("no environment combination can enable writes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  for (const [i, env] of ENVS.entries()) {
    it(`refuses under env permutation ${i + 1}: ${JSON.stringify(env)}`, async () => {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) vi.stubEnv(k, "");
        else vi.stubEnv(k, v);
      }
      const mod = await import("@/app/api/accounts/route");
      const res = await mod.POST();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.reason).toBe("FROZEN_CONTAINMENT_BRIDGE");
      expect(body.writes_enabled).toBe(false);
    });
  }
});

describe("the refusal never touches Auth, Supabase or the request body", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("constructs no Supabase client and calls no Auth", async () => {
    const serverSpy = vi.fn();
    const serviceSpy = vi.fn();
    vi.doMock("@/lib/supabase/server", () => ({
      getSupabaseServer: (...a: unknown[]) => {
        serverSpy(...a);
        throw new Error("a frozen mutation must not construct a server client");
      },
    }));
    vi.doMock("@/lib/supabase/service", () => ({
      getSupabaseService: (...a: unknown[]) => {
        serviceSpy(...a);
        throw new Error("a frozen mutation must not construct a service client");
      },
    }));

    for (const [path, verbs] of [
      ["@/app/api/accounts/route", ["POST"]],
      ["@/app/api/accounts/[id]/route", ["PATCH", "DELETE"]],
      ["@/app/api/accounts/[id]/verify/route", ["POST"]],
      ["@/app/api/accounts/[id]/refresh/route", ["POST"]],
      ["@/app/api/profile/route", ["PATCH"]],
    ] as const) {
      const mod = (await import(path)) as Record<string, () => Promise<Response>>;
      for (const verb of verbs) {
        const res = await mod[verb]();
        expect(res.status, `${path} ${verb}`).toBe(503);
      }
    }
    expect(serverSpy).not.toHaveBeenCalled();
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  it("returns a fresh response each call, so the body is never a consumed stream", async () => {
    // A single shared frozen Response would serve an empty body to the second
    // caller. Cheap to get wrong, invisible until production.
    const mod = await import("@/app/api/accounts/route");
    const a = await (await mod.POST()).json();
    const b = await (await mod.POST()).json();
    expect(a).toEqual(b);
    expect(a.reason).toBe("FROZEN_CONTAINMENT_BRIDGE");
  });
});

describe("the artifact declares what it is", () => {
  it("health reports the frozen containment identity", async () => {
    vi.resetModules();
    const mod = await import("@/app/api/health/route");
    const res = await mod.GET();
    const body = await res.json();
    expect(body.artifact_role).toBe("frozen-containment-bridge");
    expect(body.writes_enabled).toBe(false);
    expect(body.unfrozen_compatible).toBe(false);
    expect(body.credential_mutation_compatible).toBe(false);
  });
});
