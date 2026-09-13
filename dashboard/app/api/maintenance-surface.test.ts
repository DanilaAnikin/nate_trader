import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The inventory is discovered from the route tree so a newly added write
// endpoint cannot silently fall outside the maintenance acceptance check.
function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(path) : entry.name === "route.ts" ? [path] : [];
  });
}

const handlers = routeFiles(__dirname).flatMap((path) => {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/g)]
    .map((match) => ({ path, method: match[1] }));
});

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServer: () => {
  throw new Error("A frozen write reached authentication");
} }));
vi.mock("@/lib/supabase/service", () => ({ getSupabaseService: () => {
  throw new Error("A frozen write reached the database");
} }));
vi.mock("@/lib/accounts/session", () => ({
  getSessionUser: () => { throw new Error("A frozen write reached authentication"); },
  loadOwnedAccount: () => { throw new Error("A frozen write reached account data"); },
}));

describe("complete API maintenance surface", () => {
  it("includes account lifecycle, verification, refresh and profile writes", () => {
    expect(handlers.map(({ path, method }) => `${method} ${path.slice(__dirname.length)}`).sort()).toEqual([
      "DELETE /accounts/[id]/route.ts",
      "PATCH /accounts/[id]/route.ts",
      "PATCH /profile/route.ts",
      "POST /accounts/[id]/refresh/route.ts",
      "POST /accounts/[id]/verify/route.ts",
      "POST /accounts/route.ts",
    ]);
  });

  it.each(handlers)("$method $path refuses before touching auth, data, broker or request body", async ({ path, method }) => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    const externalRequest = vi.fn(() => { throw new Error("A frozen write made a network request"); });
    vi.stubGlobal("fetch", externalRequest);
    const route = await import(path);
    const request = new Request("https://dashboard.example.test/api/acceptance", { method });
    const body = vi.spyOn(request, "json").mockRejectedValue(new Error("Body must not be read"));
    const context = { params: { then() { throw new Error("Parameters must not be awaited"); } } };
    const response = await route[method](request, context);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("600");
    expect(await response.json()).toMatchObject({ code: "MAINTENANCE_MODE" });
    expect(body).not.toHaveBeenCalled();
    expect(externalRequest).not.toHaveBeenCalled();
  });
});
