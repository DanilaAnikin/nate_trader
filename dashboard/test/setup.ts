import { afterEach, vi } from "vitest";

/**
 * Module-level configuration flags (for example SUPABASE_CONFIGURED) are read
 * when a module is first imported, so they must exist before any test file
 * loads. These are placeholders only — no real credential ever appears here.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-key";
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
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
