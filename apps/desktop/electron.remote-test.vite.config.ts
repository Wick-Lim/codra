import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

const remoteTestOutput = "out-remote-test";

export default defineConfig({
  main: {
    build: { outDir: `${remoteTestOutput}/main` },
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@codra/protocol", "@codra/firebase", "@codra/webrtc"],
      }),
    ],
    resolve: {
      alias: {
        "@codra/remote-safe-storage": resolve(
          __dirname,
          "src/main/remote/safe-storage-test-only.ts",
        ),
        "@codra/remote-account-bootstrap": resolve(
          __dirname,
          "src/main/remote/account-bootstrap-test-only.ts",
        ),
        "@codra/remote-firebase-config": resolve(
          __dirname,
          "src/main/remote/firebase-emulator.ts",
        ),
      },
    },
  },
  preload: {
    build: { outDir: `${remoteTestOutput}/preload` },
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@codra/protocol", "@codra/firebase", "@codra/webrtc"],
      }),
    ],
  },
  renderer: {
    build: { outDir: `${remoteTestOutput}/renderer` },
    define: {
      __CODRA_BUILD_FLAVOR__: JSON.stringify("remote-test"),
      __CODRA_FIREBASE_PROJECT_ID__: JSON.stringify("demo-codra"),
      __CODRA_FIREBASE_AUTH_EMULATOR_ORIGIN__: JSON.stringify(
        "http://127.0.0.1:5000",
      ),
    },
    plugins: [react()],
    resolve: { alias: {} },
  },
});
