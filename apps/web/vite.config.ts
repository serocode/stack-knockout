import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm dev:https` serves a self-signed HTTPS dev server so phones on your
// Wi-Fi get a secure page (WebRTC signaling needs one). Plain `pnpm dev` is
// fine on the computer itself via http://localhost. The SSL plugin is loaded
// only when asked for, so plain `pnpm dev` never depends on it.
const plugins: PluginOption[] = [react()];
if (process.env.TK_HTTPS === "1") {
  const { default: basicSsl } = await import("@vitejs/plugin-basic-ssl");
  plugins.push(basicSsl());
}

export default defineConfig({
  plugins,
  build: { target: "es2022", sourcemap: true },
});
