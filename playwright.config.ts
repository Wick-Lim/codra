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
    {
      name: "packaged-native-modules",
      testMatch: "packaged-native-modules.spec.ts",
    },
    {
      name: "remote-harness",
      testMatch: "remote-harness.spec.ts",
      timeout: 600_000,
    },
    {
      name: "remote-direct",
      testMatch: "remote-direct.spec.ts",
      timeout: 600_000,
    },
    {
      name: "remote-reconnect",
      testMatch: "remote-reconnect.spec.ts",
      timeout: 600_000,
    },
    {
      name: "remote-agent-workspace",
      testMatch: "remote-agent-workspace.spec.ts",
      timeout: 600_000,
    },
  ],
});
