import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@codra/protocol"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@codra/protocol"] })],
  },
  renderer: {
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
