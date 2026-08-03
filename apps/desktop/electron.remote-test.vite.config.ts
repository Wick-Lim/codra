import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { codraRendererCspPlugin } from "./renderer-csp-plugin";

const remoteTestOutput = "out-remote-test";

export default defineConfig(({ command }) => ({
  main: {
    build: {
      outDir: `${remoteTestOutput}/main`,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "agent-setup-runner": resolve(
            __dirname,
            "src/main/terminal/agent-setup-runner.ts",
          ),
        },
      },
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@codra/protocol",
          "@codra/firebase",
          "@codra/remote-client",
          "@codra/webrtc",
        ],
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
        "@codra/remote-session-auto-approve": resolve(
          __dirname,
          "src/main/remote/session-auto-approve-test-only.ts",
        ),
      },
    },
  },
  preload: {
    build: { outDir: `${remoteTestOutput}/preload` },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@codra/protocol",
          "@codra/firebase",
          "@codra/remote-client",
          "@codra/webrtc",
        ],
      }),
    ],
  },
  renderer: {
    build: { outDir: `${remoteTestOutput}/renderer` },
    plugins: [react(), codraRendererCspPlugin(command)],
    resolve: { alias: {} },
  },
}));
