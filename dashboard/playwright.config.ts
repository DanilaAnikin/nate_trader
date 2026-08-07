import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * Two servers run the *same* production build with different runtime
 * configuration, so both halves of the fail-closed contract are exercised
 * without ever adding a test-only authentication bypass to the application:
 *
 *  - port 3100 — explicit legacy mode: the shell renders and every
 *    account-scoped screen must report NOT_APPLICABLE / UNAVAILABLE rather
 *    than inventing data.
 *  - port 3101 — no auth configuration and no legacy opt-in: protected routes
 *    and APIs must fail closed.
 *
 * Authenticated flows (account switching against real broker data) require a
 * Supabase test project and are covered by the component and contract suites
 * in CI. See README "Dashboard testing".
 */
const LEGACY_PORT = 3100;
const GATED_PORT = 3101;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "line" : [["list"]],
  expect: { timeout: 10_000 },
  use: {
    trace: "on-first-retry",
    baseURL: `http://127.0.0.1:${LEGACY_PORT}`,
  },
  projects: [
    {
      name: "legacy-shell",
      testMatch: /(routes|a11y)\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${LEGACY_PORT}`,
      },
    },
    {
      name: "fail-closed",
      testMatch: /(auth-gate|security)\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${GATED_PORT}`,
      },
    },
  ],
  webServer: [
    {
      command: `npx next start -p ${LEGACY_PORT}`,
      port: LEGACY_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ALLOW_LEGACY_DASHBOARD: "true",
        BUILD_SHA: process.env.BUILD_SHA ?? "e2e-build",
      },
    },
    {
      command: `npx next start -p ${GATED_PORT}`,
      port: GATED_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        BUILD_SHA: process.env.BUILD_SHA ?? "e2e-build",
      },
    },
  ],
});
