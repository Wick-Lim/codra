// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import App from "./App";

// Vitest globals are off for this workspace, so Testing Library's automatic
// cleanup never registers itself.
afterEach(cleanup);

/**
 * Counts module *evaluations*, not renders.
 *
 * A `vi.mock` factory runs the first time the mocked module is imported, so
 * these counters answer the only question that matters for bundle size: was the
 * module pulled into the landing page's import graph? A statically imported
 * module is evaluated when `App.tsx` is, at the top of this file; a `React.lazy`
 * one only when its route first renders.
 *
 * Both mocked modules reach `initializeApp(...)` at module scope — the console
 * through `remote/controller` -> `@codra/web-firebase-config`, the bridge
 * through `remote/firebase-bridge` — which is what a landing visitor must not
 * pay for.
 */
const loaded = vi.hoisted(() => ({ console: 0, desktopAuth: 0 }));

vi.mock("./console/RemoteConsoleApp", async () => {
  loaded.console += 1;
  const { createElement } = await import("react");
  return {
    default: () =>
      createElement("p", { "data-testid": "console-surface" }, "console"),
  };
});

vi.mock("./remote/DesktopAuthBridge", async () => {
  loaded.desktopAuth += 1;
  const { createElement } = await import("react");
  return {
    default: () =>
      createElement("p", { "data-testid": "desktop-auth-surface" }, "bridge"),
  };
});

describe("App", () => {
  it("renders the landing page without loading Firebase-bearing surfaces", () => {
    window.history.replaceState({}, "", "/");

    render(<App />);

    expect(screen.getByTestId("landing-open-console")).toBeDefined();
    expect(loaded.console).toBe(0);
    expect(loaded.desktopAuth).toBe(0);
  });

  it("loads the console only once the console route is opened", async () => {
    window.history.replaceState({}, "", "/");

    render(<App />);
    await userEvent.click(screen.getByTestId("landing-open-console"));

    expect(await screen.findByTestId("console-surface")).toBeDefined();
    expect(window.location.pathname).toBe("/console");
    expect(loaded.desktopAuth).toBe(0);
  });

  it("loads the desktop-auth bridge only on /desktop-auth", async () => {
    window.history.replaceState({}, "", "/desktop-auth");

    render(<App />);

    expect(await screen.findByTestId("desktop-auth-surface")).toBeDefined();
  });
});
