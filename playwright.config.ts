import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: "dev-electron",
      testMatch: "standalone-terminal.spec.ts",
    },
    {
      name: "packaged-electron",
      testMatch: "packaged-terminal.spec.ts",
    },
  ],
});
