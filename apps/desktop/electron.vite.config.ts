import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { codraRendererCspPlugin } from "./renderer-csp-plugin";

export default defineConfig(({ command }) => ({
  main: {
    build: {
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
          "src/main/remote/safe-storage-electron.ts",
        ),
        "@codra/remote-account-bootstrap": resolve(
          __dirname,
          "src/main/remote/account-bootstrap-google.ts",
        ),
        "@codra/remote-firebase-config": resolve(
          __dirname,
          "src/main/remote/firebase-production.ts",
        ),
        "@codra/remote-session-auto-approve": resolve(
          __dirname,
          "src/main/remote/session-auto-approve-production.ts",
        ),
      },
    },
  },
  preload: {
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
    resolve: { alias: {} },
    plugins: [react(), codraRendererCspPlugin(command)],
  },
}));
