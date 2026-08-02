import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

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
        exclude: ["@codra/protocol", "@codra/firebase", "@codra/webrtc"],
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
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@codra/protocol", "@codra/firebase", "@codra/webrtc"],
      }),
    ],
  },
  renderer: {
    resolve: { alias: {} },
    plugins: [
      react(),
      {
        name: "codra-renderer-csp",
        transformIndexHtml(html) {
          const connectSource =
            command === "serve" ? "'self' ws: wss:" : "'none'";
          return html.replace("__CODRA_CONNECT_SRC__", connectSource);
        },
      },
    ],
  },
}));
