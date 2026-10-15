import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // solid-refresh's HMR shim can't resolve under Vitest, so hot reload is off
  // for test runs only.
  plugins: [solid({ hot: !process.env.VITEST })],

  test: {
    environment: "happy-dom",
    globals: true,
  },

  resolve: {
    conditions: ["development", "browser"],
    alias: {
      // The module contract. Modules import only this.
      "@suite/module": fileURLToPath(
        new URL("./packages/suite-module/index.ts", import.meta.url),
      ),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
