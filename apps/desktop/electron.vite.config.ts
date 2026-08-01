import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@codra/protocol"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@codra/protocol"] })],
  },
  renderer: {
    plugins: [react()],
  },
});
