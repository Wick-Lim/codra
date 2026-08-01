import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  build: { outDir: "dist-remote-test" },
  define: {
    __CODRA_BUILD_FLAVOR__: JSON.stringify("remote-test"),
    __CODRA_FIREBASE_PROJECT_ID__: JSON.stringify("demo-codra"),
  },
  plugins: [react()],
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
