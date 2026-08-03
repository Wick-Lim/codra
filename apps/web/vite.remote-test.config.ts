import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { codraWebCspPlugin } from "./csp-plugin";
import { codraWebRollupOptions } from "./chunk-strategy";

export default defineConfig({
  // Chunked identically to the production config (see ./chunk-strategy.ts), and
  // likewise without a `sourcemap` key.
  build: { outDir: "dist-remote-test", rollupOptions: codraWebRollupOptions },
  plugins: [react(), codraWebCspPlugin("emulator")],
  resolve: {
    alias: {
      "@codra/web-account-bootstrap": resolve(
        __dirname,
        "src/remote/account-bootstrap-test-only.ts",
      ),
      "@codra/web-firebase-config": resolve(
        __dirname,
        "src/remote/firebase-emulator.ts",
      ),
      "@codra/web-desktop-auth-bridge": resolve(
        __dirname,
        "src/remote/DesktopAuthBridgeTestOnly.tsx",
      ),
    },
  },
});
