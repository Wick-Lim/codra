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
    {
      // The only project that drives a browser rather than Electron: it builds
      // apps/web's emulator bundle, serves it from the Hosting emulator, and
      // runs the console against a real desktop host.
      name: "web-console",
      testMatch: "web-console.spec.ts",
      timeout: 600_000,
      // Actions default to no timeout of their own, so a locator that never
      // resolves silently consumes the ten minutes above and reports only
      // "Test timeout exceeded". Bounding them turns that into a named action
      // with a call log, while staying far above anything this suite's
      // loopback round trips legitimately need.
      use: { actionTimeout: 30_000 },
    },
  ],
});
