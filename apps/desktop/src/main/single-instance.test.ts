import { describe, expect, it, vi } from "vitest";
import { startSingleInstanceApplication } from "./single-instance";

type SecondInstanceListener = () => void;

function createApp(hasLock: boolean) {
  let secondInstanceListener: SecondInstanceListener | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const app = {
    requestSingleInstanceLock: vi.fn(() => hasLock),
    exit: vi.fn(),
    whenReady: vi.fn(() => ready),
    on: vi.fn((event: "second-instance", listener: SecondInstanceListener) => {
      if (event === "second-instance") secondInstanceListener = listener;
    }),
  };

  return {
    app,
    resolveReady,
    emitSecondInstance() {
      if (!secondInstanceListener) {
        throw new Error("second-instance listener not registered");
      }
      secondInstanceListener();
    },
  };
}

describe("startSingleInstanceApplication", () => {
  it("exits a secondary process before bootstrap can mark persisted sessions exited", () => {
    const harness = createApp(false);
    const markRunningExited = vi.fn();

    const isPrimary = startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => undefined,
      createWindow: vi.fn(),
      startPrimary: markRunningExited,
      reportStartupError: vi.fn(),
      reportWindowError: vi.fn(),
    });

    expect(isPrimary).toBe(false);
    expect(harness.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(harness.app.exit).toHaveBeenCalledWith(0);
    expect(harness.app.on).not.toHaveBeenCalled();
    expect(harness.app.whenReady).not.toHaveBeenCalled();
    expect(markRunningExited).not.toHaveBeenCalled();
  });

  it("starts bootstrap only after the primary app is ready", async () => {
    const harness = createApp(true);
    const startPrimary = vi.fn(async () => undefined);
    startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => undefined,
      createWindow: vi.fn(),
      startPrimary,
      reportStartupError: vi.fn(),
      reportWindowError: vi.fn(),
    });

    expect(startPrimary).not.toHaveBeenCalled();
    expect(harness.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(
      harness.app.requestSingleInstanceLock.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.app.whenReady.mock.invocationCallOrder[0]!);
    harness.resolveReady();
    await vi.waitFor(() => expect(startPrimary).toHaveBeenCalledOnce());
  });

  it("restores, shows, and focuses the existing primary window", async () => {
    const harness = createApp(true);
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      isVisible: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const createWindow = vi.fn();
    startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => window,
      createWindow,
      startPrimary: vi.fn(),
      reportStartupError: vi.fn(),
      reportWindowError: vi.fn(),
    });

    harness.emitSecondInstance();
    expect(window.focus).not.toHaveBeenCalled();
    harness.resolveReady();
    await vi.waitFor(() => expect(window.focus).toHaveBeenCalledOnce());

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("creates a window when the primary instance has none", async () => {
    const harness = createApp(true);
    const createWindow = vi.fn(async () => undefined);
    startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => undefined,
      createWindow,
      startPrimary: vi.fn(),
      reportStartupError: vi.fn(),
      reportWindowError: vi.fn(),
    });

    harness.emitSecondInstance();
    harness.resolveReady();

    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledOnce());
  });

  it("reports second-instance window creation failures", async () => {
    const harness = createApp(true);
    const failure = new Error("window could not be created");
    const reportStartupError = vi.fn();
    const reportWindowError = vi.fn();
    startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => undefined,
      createWindow: vi.fn(async () => {
        throw failure;
      }),
      startPrimary: vi.fn(),
      reportStartupError,
      reportWindowError,
    });

    harness.emitSecondInstance();
    harness.resolveReady();

    await vi.waitFor(() =>
      expect(reportWindowError).toHaveBeenCalledWith(failure),
    );
    expect(reportStartupError).not.toHaveBeenCalled();
  });

  it("reports existing-window reveal failures without using the fatal startup channel", async () => {
    const harness = createApp(true);
    const failure = new Error("window focus failed");
    const reportStartupError = vi.fn();
    const reportWindowError = vi.fn();
    startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        restore: vi.fn(),
        show: vi.fn(),
        focus: () => {
          throw failure;
        },
      }),
      createWindow: vi.fn(),
      startPrimary: vi.fn(),
      reportStartupError,
      reportWindowError,
    });

    harness.emitSecondInstance();
    harness.resolveReady();

    await vi.waitFor(() =>
      expect(reportWindowError).toHaveBeenCalledWith(failure),
    );
    expect(reportStartupError).not.toHaveBeenCalled();
  });

  it("reports primary startup failures through the fatal startup channel", async () => {
    const harness = createApp(true);
    const failure = new Error("database bootstrap failed");
    const reportStartupError = vi.fn();
    const reportWindowError = vi.fn();
    startSingleInstanceApplication({
      app: harness.app,
      getWindow: () => undefined,
      createWindow: vi.fn(),
      startPrimary: vi.fn(async () => {
        throw failure;
      }),
      reportStartupError,
      reportWindowError,
    });

    harness.resolveReady();

    await vi.waitFor(() =>
      expect(reportStartupError).toHaveBeenCalledWith(failure),
    );
    expect(reportWindowError).not.toHaveBeenCalled();
  });
});
