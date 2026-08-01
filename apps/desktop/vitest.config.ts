import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    projects: [
      {
        test: {
          environment: "node",
          include: ["src/{main,preload}/**/*.test.ts"],
          name: "node",
          setupFiles: ["./test/setup.ts"],
        },
      },
      {
        test: {
          environment: "jsdom",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          name: "renderer",
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
