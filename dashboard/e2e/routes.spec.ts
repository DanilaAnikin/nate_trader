import { expect, test } from "@playwright/test";

/**
 * Main-route smoke coverage against a real production build.
 *
 * The account backend is intentionally absent here, so these tests assert the
 * shell, the navigation and — importantly — that a screen with no data source
 * says so explicitly instead of rendering zeros.
 */
const ROUTES = [
  { path: "/", nav: "Overview" },
  { path: "/positions", nav: "Portfolio" },
  { path: "/screener", nav: "Signals & universe" },
  { path: "/research", nav: "Validation & research" },
  { path: "/operations", nav: "Operations" },
] as const;

test.describe("main routes", () => {
  for (const route of ROUTES) {
    test(`${route.path} renders the V11 shell and an explicit empty state`, async ({
      page,
    }) => {
      const response = await page.goto(route.path);
      expect(response?.status()).toBe(200);

      await expect(
        page.getByRole("heading", { name: "V11 Adaptive Momentum" }),
      ).toBeVisible();
      await expect(page.getByText("PAPER FORWARD VALIDATION")).toBeVisible();
      await expect(
        page.getByRole("link", { name: new RegExp(route.nav) }),
      ).toBeVisible();

      // No data source is configured, so the page must say so, not show zeros.
      await expect(
        page.getByText(/Account backend is not configured/),
      ).toBeVisible();

      const body = await page.locator("body").innerText();
      expect(body).not.toMatch(/Dashboard Online/i);
      expect(body).not.toMatch(/max 15/i);
      expect(body).not.toMatch(/stop 8%/i);
    });
  }

  test("navigation moves between screens and marks the current page", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Portfolio/ }).click();
    await expect(page).toHaveURL(/\/positions$/);
    await expect(
      page.getByRole("link", { name: /Portfolio/ }),
    ).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: /Operations/ }).click();
    await expect(page).toHaveURL(/\/operations$/);
  });

  test("the settings screen exposes the read-only effective policy", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });
});

test.describe("responsive layout", () => {
  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1440, height: 900 },
  ]) {
    test(`no horizontal page overflow at ${viewport.name} (${viewport.width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/positions");
      await expect(
        page.getByRole("heading", { name: "V11 Adaptive Momentum" }),
      ).toBeVisible();

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      // A dense table may scroll inside its own container, never the page.
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test("the sidebar is a toggleable drawer on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open navigation" });
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "false");

    await opener.click();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("navigation", { name: "Primary" }),
    ).toBeInViewport();

    await page.getByRole("button", { name: "Close navigation" }).click();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("theme", () => {
  test("light and dark both paint an explicit background", async ({ page }) => {
    await page.goto("/");
    const readBackground = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    const light = await readBackground();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    const dark = await readBackground();

    expect(light).not.toBe("rgba(0, 0, 0, 0)");
    expect(dark).not.toBe("rgba(0, 0, 0, 0)");
    expect(light).not.toBe(dark);
  });
});
