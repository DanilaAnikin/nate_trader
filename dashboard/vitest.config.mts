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
  },
});
