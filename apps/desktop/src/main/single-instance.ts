export interface SingleInstanceAppLike {
  requestSingleInstanceLock(): boolean;
  exit(code: number): void;
  whenReady(): Promise<void>;
  on(event: "second-instance", listener: () => void): void;
}

export interface FocusableWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface SingleInstanceApplicationOptions {
  app: SingleInstanceAppLike;
  getWindow(): FocusableWindowLike | undefined;
  createWindow(): void | Promise<void>;
  startPrimary(): void | Promise<void>;
  reportStartupError(error: unknown): void;
  reportWindowError(error: unknown): void;
}

function reportSafely(
  reporter: (error: unknown) => void,
  error: unknown,
): void {
  try {
    reporter(error);
  } catch (reportingError) {
    console.error("Single-instance error reporter failed", reportingError);
  }
}

export function startSingleInstanceApplication(
  options: SingleInstanceApplicationOptions,
): boolean {
  if (!options.app.requestSingleInstanceLock()) {
    options.app.exit(0);
    return false;
  }

  let createWindowInFlight: Promise<void> | undefined;
  const primaryStartup = options.app
    .whenReady()
    .then(() => options.startPrimary())
    .then(
      () => true,
      (error: unknown) => {
        reportSafely(options.reportStartupError, error);
        return false;
      },
    );

  const revealPrimaryWindow = (): void => {
    try {
      const window = options.getWindow();
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        if (!window.isVisible()) window.show();
        window.focus();
        return;
      }

      if (createWindowInFlight) return;
      createWindowInFlight = Promise.resolve(options.createWindow())
        .catch((error: unknown) =>
          reportSafely(options.reportWindowError, error),
        )
        .finally(() => {
          createWindowInFlight = undefined;
        });
    } catch (error) {
      reportSafely(options.reportWindowError, error);
    }
  };

  options.app.on("second-instance", () => {
    void primaryStartup.then((started) => {
      if (started) revealPrimaryWindow();
    });
  });

  return true;
}
