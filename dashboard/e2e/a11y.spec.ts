import { expect, test } from "@playwright/test";

/**
 * Accessibility and motion behaviour that a financial console must get right:
 * a skip link, reachable keyboard navigation, labelled landmarks, real table
 * semantics, and animation that respects the user's system preference.
 */
test.describe("accessibility", () => {
  test("a skip link is the first tab stop and focuses the main region", async ({
    page,
  }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await skip.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("landmarks are named", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
  });

  test("the system status region is announced politely", async ({ page }) => {
    await page.goto("/");
    const status = page.getByRole("status", { name: "System status" });
    await expect(status).toHaveAttribute("aria-live", "polite");
  });

  test("every navigation link is reachable by keyboard", async ({ page }) => {
    await page.goto("/");
    const links = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(7);
    for (let index = 0; index < count; index++) {
      await links.nth(index).focus();
      await expect(links.nth(index)).toBeFocused();
    }
  });

  test("interactive controls show a visible focus ring", async ({ page }) => {
    await page.goto("/");
    for (const name of [/Re-read/, /Sync broker data/]) {
      const control = page.getByRole("button", { name });
      await control.focus();
      const outline = await control.evaluate(
        (element) => getComputedStyle(element).outlineWidth,
      );
      expect(outline).not.toBe("0px");
    }
  });

  test("the read control and the broker write are not both called Refresh", async ({
    page,
  }) => {
    // They used to be one button labelled "Refresh", and a broker refresh was
    // a side effect of reading. An operator clicking it could reasonably
    // believe the equity curve had just been re-fetched from Alpaca; it had
    // not. The two are now separate controls with separate names, and only one
    // of them writes.
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Re-read$/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Sync broker data/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Refresh$/ })).toHaveCount(0);
  });

  test("reduced motion disables decorative animation", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    const duration = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "skeleton";
      document.body.appendChild(probe);
      const after = getComputedStyle(probe, "::after").animationDuration;
      probe.remove();
      return after;
    });
    // The reduced-motion override collapses animation to an imperceptible tick.
    expect(Number.parseFloat(duration)).toBeLessThan(0.01);
    await context.close();
  });
});
