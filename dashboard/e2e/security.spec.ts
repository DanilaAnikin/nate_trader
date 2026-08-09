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
  /PRODUCTION_OWNER_USER_ID/,
  // A full Alpaca account number must never appear anywhere client-side; only
  // a four-character mask is ever rendered.
  /alpaca_account_number/i,
  /"owner_id"/,
  /alpaca_key_secret_id/i,
  /alpaca_secret_secret_id/i,
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


test.describe("registration is closed", () => {
  test("the login page offers sign-in only", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in" }),
    ).toBeVisible();

    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/sign up/i);
    expect(text).not.toMatch(/create your account/i);
    expect(text).not.toMatch(/need an account/i);
    expect(text).toMatch(/does not offer public registration/i);
  });
});

test.describe("RSC payload", () => {
  test("no server-managed account column reaches the streamed HTML", async ({
    page,
  }) => {
    // The login page is the only route this fail-closed server renders, and it
    // must still carry no account internals in its Flight payload.
    const response = await page.goto("/login");
    const html = (await response?.text()) ?? "";
    for (const pattern of SECRET_PATTERNS) {
      expect(html, `RSC payload must not contain ${pattern}`).not.toMatch(
        pattern,
      );
    }
  });
});
