import { expect, test } from "@playwright/test";

/** Secrets must stay on the server and the transport must stay hardened. */
const SECRET_PATTERNS = [
  /APCA-API-KEY-ID/i,
  /APCA-API-SECRET-KEY/i,
  /SUPABASE_SERVICE_ROLE_KEY/i,
  /service_role/i,
  /GITHUB_TOKEN/i,
  /ghp_[A-Za-z0-9]{20,}/,
  /PRODUCTION_ALPACA_ACCOUNT_NUMBER/,
];

test.describe("security headers", () => {
  test("responses carry the hardening headers", async ({ request }) => {
    const response = await request.get("/login");
    const headers = response.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("health is public, no-store and reports the build", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.json();
    expect(body.service).toBe("nate-trader-dashboard");
    expect(body.strategyVersion).toBe("v11-adaptive-momentum");
    expect(body).toHaveProperty("buildSha");
    expect(body).toHaveProperty("dataMode");
    expect(JSON.stringify(body)).not.toMatch(/key|secret|token/i);
  });
});

test.describe("no secrets reach the browser", () => {
  test("neither the HTML nor any script chunk contains a credential", async ({
    page,
  }) => {
    const scriptUrls = new Set<string>();
    page.on("response", (response) => {
      const url = response.url();
      if (url.endsWith(".js") || url.includes("/_next/static/")) {
        scriptUrls.add(url);
      }
    });

    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const html = await page.content();
    for (const pattern of SECRET_PATTERNS) {
      expect(html, `HTML must not contain ${pattern}`).not.toMatch(pattern);
    }

    for (const url of scriptUrls) {
      const response = await page.request.get(url);
      if (!response.ok()) continue;
      const body = await response.text();
      for (const pattern of SECRET_PATTERNS) {
        expect(body, `${url} must not contain ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
