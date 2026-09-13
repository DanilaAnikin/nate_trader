import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVER_URL", "http://nate-supabase-kong:8000");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
});

describe("dashboard configuration health", () => {
  it("reports a fully configured backend without probing the network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", dataMode: "account-scoped" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "http://kong:8000", "https://internal/rest/v1", "invalid"])(
    "refuses readiness when the required internal origin is %s", async (url) => {
      vi.stubEnv("SUPABASE_SERVER_URL", url);
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "misconfigured", dataMode: "unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("refuses readiness without the service credential", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await GET()).status).toBe(503);
  });
});
