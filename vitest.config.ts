import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tk/engine": r("./packages/engine/src/index.ts"),
      "@tk/net": r("./packages/net/src/index.ts"),
      "@tk/coordinator": r("./packages/coordinator/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
