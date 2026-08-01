import { randomUUID } from "node:crypto";
import type { TerminalDescriptor } from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopLifecycle } from "./lifecycle";

const runningDescriptor: TerminalDescriptor = {
  id: randomUUID(),
  title: "Terminal",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};

function createBeforeQuitEvent() {
  return { preventDefault: vi.fn() };
}

function createLifecycleHarness({
  platform = "darwin",
  activeTerminals = 0,
  confirmQuit = true,
}: {
  platform?: NodeJS.Platform;
  activeTerminals?: number;
  confirmQuit?: boolean;
} = {}) {
  const app = { quit: vi.fn() };
  const manager = {
    list: vi.fn(async () =>
      Array.from({ length: activeTerminals }, (_, index) => ({
        ...runningDescriptor,
        id: `${runningDescriptor.id.slice(0, -1)}${index}`,
      })),
    ),
    closeAll: vi.fn(async () => undefined),
  };
  const closeDatabase = vi.fn();
  const unregisterIpc = vi.fn();
  const createWindow = vi.fn();
  const reportError = vi.fn();
  const confirm = vi.fn(async () => confirmQuit);
  const lifecycle = new DesktopLifecycle({
    app,
    manager,
    platform,
    getWindowCount: () => 0,
    createWindow,
    confirmQuit: confirm,
    closeDatabase,
    unregisterIpc,
    reportError,
  });

  return {
    lifecycle,
    app,
    manager,
    closeDatabase,
    unregisterIpc,
    createWindow,
    confirm,
    reportError,
  };
}

describe("DesktopLifecycle", () => {
  it("keeps the app alive when the last macOS window closes", () => {
    const harness = createLifecycleHarness({
      platform: "darwin",
      activeTerminals: 1,
    });

    harness.lifecycle.onWindowAllClosed();

    expect(harness.app.quit).not.toHaveBeenCalled();
  });

  it("recreates a window on macOS activation when none remain", () => {
    const harness = createLifecycleHarness();

    harness.lifecycle.onActivate();

    expect(harness.createWindow).toHaveBeenCalledOnce();
  });

  it("synchronously prevents an explicit quit before warning about active terminals", async () => {
    const harness = createLifecycleHarness({
      activeTerminals: 2,
      confirmQuit: false,
    });
    const event = createBeforeQuitEvent();

    const attempt = harness.lifecycle.onBeforeQuit(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await attempt;
    expect(harness.confirm).toHaveBeenCalledWith(expect.any(Array));
    expect(harness.manager.closeAll).not.toHaveBeenCalled();
  });

  it("closes all terminals and resources before the one guarded final quit", async () => {
    const harness = createLifecycleHarness({ activeTerminals: 0 });
    const event = createBeforeQuitEvent();

    await harness.lifecycle.onBeforeQuit(event);

    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.manager.closeAll).toHaveBeenCalledOnce();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    expect(harness.unregisterIpc).toHaveBeenCalledOnce();
    expect(harness.app.quit).toHaveBeenCalledOnce();

    const finalEvent = createBeforeQuitEvent();
    await harness.lifecycle.onBeforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(harness.manager.closeAll).toHaveBeenCalledOnce();
  });

  it("leaves runtime resources untouched when the user cancels the warning", async () => {
    const harness = createLifecycleHarness({
      activeTerminals: 1,
      confirmQuit: false,
    });

    await harness.lifecycle.onBeforeQuit(createBeforeQuitEvent());

    expect(harness.manager.closeAll).not.toHaveBeenCalled();
    expect(harness.closeDatabase).not.toHaveBeenCalled();
    expect(harness.unregisterIpc).not.toHaveBeenCalled();
    expect(harness.app.quit).not.toHaveBeenCalled();
  });

  it("reports close-all failure without closing resources and allows a later retry", async () => {
    const harness = createLifecycleHarness({ activeTerminals: 0 });
    const failure = new Error("terminal did not exit");
    harness.manager.closeAll.mockRejectedValueOnce(failure);

    await harness.lifecycle.onBeforeQuit(createBeforeQuitEvent());

    expect(harness.reportError).toHaveBeenCalledWith(failure);
    expect(harness.closeDatabase).not.toHaveBeenCalled();
    expect(harness.unregisterIpc).not.toHaveBeenCalled();
    expect(harness.app.quit).not.toHaveBeenCalled();

    await harness.lifecycle.onBeforeQuit(createBeforeQuitEvent());
    expect(harness.manager.closeAll).toHaveBeenCalledTimes(2);
    expect(harness.app.quit).toHaveBeenCalledOnce();
  });
});
