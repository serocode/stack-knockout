import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enforces the four-module architecture:
 *   engine       -> nothing (pure game rules)
 *   net          -> nothing from the game (transport, auth, liveness)
 *   coordinator  -> engine + net (authority, elections, recovery)
 *   web          -> everything (presentation only)
 * and keeps DOM/rendering out of the lower layers.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const RULES: Record<string, { forbiddenImports: RegExp[]; forbiddenGlobals: RegExp[] }> = {
  "packages/engine/src": {
    forbiddenImports: [/@tk\/net/, /@tk\/coordinator/, /react/, /trystero/],
    forbiddenGlobals: [/\bdocument\./, /\bwindow\./, /CanvasRenderingContext2D/, /localStorage/],
  },
  "packages/net/src": {
    forbiddenImports: [/@tk\/engine/, /@tk\/coordinator/, /react/],
    forbiddenGlobals: [/\bdocument\./, /CanvasRenderingContext2D/],
  },
  "packages/coordinator/src": {
    forbiddenImports: [/react/, /trystero/, /apps\/web/],
    forbiddenGlobals: [/\bdocument\./, /\bwindow\./, /CanvasRenderingContext2D/, /localStorage/],
  },
};

describe("module boundaries", () => {
  for (const [dir, rule] of Object.entries(RULES)) {
    it(`${dir} respects its dependency rules`, () => {
      const problems: string[] = [];
      for (const f of files(join(root, dir))) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
          if (rule.forbiddenImports.some((r) => r.test(m[1]!))) problems.push(`${f}: imports ${m[1]}`);
        }
        const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        for (const g of rule.forbiddenGlobals) if (g.test(code)) problems.push(`${f}: uses ${g}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
