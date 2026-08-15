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
    include: [
      "lib/**/*.test.ts",
      "app/**/*.test.ts",
      "components/**/*.test.tsx",
      // The proxy lives at the root and gates every request; it needs the
      // same coverage as anything under `app/`.
      "proxy.test.ts",
      // Containment proofs live outside the source tree because they are
      // about the artifact rather than about a module. Without this entry
      // they are collected by nothing and pass by not running — the exact
      // vacuity this suite exists to prevent.
      "test/**/*.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
  },
});
