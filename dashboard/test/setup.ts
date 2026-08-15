import { afterEach, vi } from "vitest";

/**
 * Module-level configuration flags (for example SUPABASE_CONFIGURED) are read
 * when a module is first imported, so they must exist before any test file
 * loads. These are placeholders only — no real credential ever appears here.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-key";
// Server-side Supabase origin. Deliberately a DIFFERENT host from the public
// one above, so any test that accidentally sends server traffic to the public
// origin — or derives the auth cookie name from the internal host — fails.
process.env.SUPABASE_SERVER_URL ??= "http://test-internal-kong:8000";
process.env.GITHUB_REPO ??= "DanilaAnikin/nate_trader";
process.env.GITHUB_STATE_REF ??= "main";

/**
 * Shared test setup.
 *
 * `matchMedia` is absent in jsdom but is read by theme-aware components, and
 * ResizeObserver is required by Recharts' responsive container.
 */
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}

// DOM-only matchers and unmounting, loaded lazily so the Node-environment
// data/contract tests do not pay for jsdom tooling.
if (typeof window !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup, configure } = await import("@testing-library/react");
  afterEach(cleanup);

  /**
   * `waitFor` defaults to a one-second bound, which under a full parallel run
   * partly measures how busy the machine is rather than whether the component
   * rendered. Five seconds weakens no assertion — each is still "this
   * eventually appears", and a component that never renders still fails, five
   * seconds later — so this is a small robustness improvement worth having.
   *
   * IT IS NOT A FIX FOR THE KNOWN FLAKE, and should not be read as one.
   *
   * A proof-honesty audit reported PortfolioClient.test.tsx failing roughly
   * twice in ten FULL-SUITE runs while passing every time in isolation. A
   * timeout competing with fifteen other workers was the obvious explanation,
   * so this bound was raised — and the failure then reproduced anyway, once in
   * eighteen full-suite runs with the change already in place. The hypothesis
   * is falsified; the cause is still unknown, and the failure message has not
   * been captured (twelve consecutive runs after the reproduction were clean).
   *
   * It fails rather than false-greens, so it is not dangerous. It is still
   * worth chasing, because an intermittently red gate teaches people to re-run
   * a gate, and a gate people re-run is not a gate.
   */
  configure({ asyncUtilTimeout: 5000 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
