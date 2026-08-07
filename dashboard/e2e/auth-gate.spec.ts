import { expect, test } from "@playwright/test";

/**
 * Fail-closed behaviour when the identity provider is not configured.
 *
 * A financial dashboard must never degrade into showing repository snapshots
 * or an empty-but-green shell when it cannot authenticate the caller.
 */
const PROTECTED_PAGES = ["/", "/positions", "/screener", "/research", "/operations", "/accounts", "/settings"];

test.describe("authentication gate", () => {
  for (const path of PROTECTED_PAGES) {
    test(`${path} is not served without authentication configuration`, async ({
      page,
    }) => {
      const response = await page.goto(path);
      expect(response).not.toBeNull();
      // Either the login redirect or an explicit 503 — never a rendered
      // dashboard with substituted data.
      expect([307, 401, 503]).toContain(response!.status());
      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(/A · Broker account/);
      expect(body).not.toMatch(/Frozen V11 plan/);
    });
  }

  for (const path of [
    "/api/accounts",
    "/api/accounts/00000000-0000-0000-0000-000000000000/status",
    "/api/accounts/00000000-0000-0000-0000-000000000000/live",
    "/api/accounts/00000000-0000-0000-0000-000000000000/performance",
    "/api/accounts/00000000-0000-0000-0000-000000000000/equity",
  ]) {
    test(`${path} refuses an unauthenticated caller`, async ({ request }) => {
      const response = await request.get(path);
      expect([401, 503]).toContain(response.status());
      const body = await response.text();
      expect(body).not.toMatch(/equity"\s*:/);
      expect(body).not.toMatch(/APCA/);
    });
  }

  test("the retired global live endpoint stays gone", async ({ request }) => {
    const response = await request.get("/api/live");
    expect([410, 401, 503]).toContain(response.status());
  });

  test("the login page remains reachable", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
    await expect(page.locator("form")).toBeVisible();
  });
});
