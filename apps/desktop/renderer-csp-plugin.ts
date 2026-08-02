import type { ConfigEnv, Plugin } from "vite";

export function codraRendererCspPlugin(command: ConfigEnv["command"]): Plugin {
  return {
    name: "codra-renderer-csp",
    transformIndexHtml(html) {
      const connectSource = command === "serve" ? "'self' ws: wss:" : "'none'";
      return html.replace("__CODRA_CONNECT_SRC__", connectSource);
    },
  };
}
