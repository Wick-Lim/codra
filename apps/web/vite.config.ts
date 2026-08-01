import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
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
    },
  },
});
