import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // `app/api/*/route.ts` import their modules through the `@/` path alias from
  // tsconfig.json, so a route-handler test cannot resolve them without it.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "components/**/*.test.ts", "app/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".next/**", ".qwen/**", "target/**", "tests/**"],
    environment: "node",
  },
});
