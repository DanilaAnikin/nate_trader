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
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
