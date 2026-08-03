import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { codraWebCspPlugin } from "./csp-plugin";
import { codraWebRollupOptions } from "./chunk-strategy";

export default defineConfig({
  // No `sourcemap` key here, deliberately: it would reintroduce
  // `sourceMappingURL` and write `.map` files whose `sources` arrays carry
  // developer home paths, both of which scan-client-artifacts denies.
  build: { rollupOptions: codraWebRollupOptions },
  plugins: [react(), codraWebCspPlugin("production")],
  resolve: {
    alias: {
      "@codra/web-account-bootstrap": resolve(
        __dirname,
        "src/remote/account-bootstrap-google.ts",
      ),
      "@codra/web-firebase-config": resolve(
        __dirname,
        "src/remote/firebase-production.ts",
      ),
      "@codra/web-desktop-auth-bridge": resolve(
        __dirname,
        "src/remote/DesktopAuthBridgeGoogle.tsx",
      ),
    },
  },
});
