// Copies the web build to <repo>/dist, so Vercel finds it whether the project
// uses vercel.json, the Vite preset's default "dist", or other dashboard settings.
import { cpSync, existsSync, rmSync } from "node:fs";

const src = "apps/web/dist";
if (!existsSync(`${src}/index.html`)) {
  console.error(`copy-dist: ${src}/index.html not found; did the web build run?`);
  process.exit(1);
}
rmSync("dist", { recursive: true, force: true });
cpSync(src, "dist", { recursive: true });
console.log("copy-dist: apps/web/dist -> dist");
