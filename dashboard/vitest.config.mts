import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      "server-only": path.resolve(import.meta.dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    // Data/contract modules run in Node. Component tests opt into jsdom with
    // an `@vitest-environment jsdom` docblock at the top of the file.
    environment: "node",
    // ONE pattern, every root, every extension.
    //
    // This used to be a list of root/extension pairs — lib/**/*.test.ts,
    // app/**/*.test.ts, components/**/*.test.tsx, test/**/*.test.ts — and the
    // pairs did not cover the grid. A proof-honesty audit added four files
    // each containing `expect(1).toBe(2)` and watched all four be silently
    // ignored: test/**/*.test.tsx, lib/**/*.test.tsx, app/**/*.test.tsx and
    // components/**/*.test.ts. The file count did not move and the suite
    // stayed green.
    //
    // A per-directory allowlist for test COLLECTION is the same mistake as an
    // exclusion list for a security boundary: it silently converts "I did not
    // think of this" into "this passed". Collect everything that names itself
    // a test, and let the exclusions below be the only narrowing — they are
    // about where tests cannot live, not about which ones count.
    //
    // test/containment/collection-completeness.test.ts asserts that every
    // *.test.* file on disk is covered by this pattern, so the grid cannot
    // reopen.
    include: ["**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    exclude: ["node_modules/**", ".next/**", "dist/**", "e2e/**"],
    setupFiles: ["test/setup.ts"],
    // Vitest's default per-test bound is 5000ms, and two tests now sit either
    // side of it under a full parallel run:
    //
    //   lib/supabase/browser-data-plane.test.ts strips EVERY file in the tree
    //   in a single `it`. That became a real TypeScript parse when the
    //   hand-written comment scanner was replaced (it had been defeated twice),
    //   so the work is genuinely larger — 3.4s alone, over 5s under sixteen
    //   workers. The result is unchanged; only the cost is.
    //
    //   components/PortfolioClient.test.tsx takes 4.94s ALONE. It has been
    //   intermittently red since long before this change (see the note in
    //   test/setup.ts: reproduced once in eighteen runs with the earlier
    //   asyncUtilTimeout increase already in place, cause still unknown). A
    //   heavier suite makes an already-marginal test tip over more often.
    //
    // THIS IS NOT A FIX FOR THAT FLAKE, and must not be read as one. It stops a
    // timeout bound from being what reports it — a test that never renders
    // still fails, thirty seconds later — so a red result means something is
    // actually wrong rather than that the machine was busy. The flake itself is
    // still open and still worth chasing: an intermittently red gate teaches
    // people to re-run a gate, and a gate people re-run is not a gate.
    testTimeout: 30000,
  },
});
