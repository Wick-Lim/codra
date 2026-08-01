import type { TerminalDescriptor } from "@codra/protocol";
import type { TerminalRequestAdmission } from "./ipc/admission";

export interface DesktopAppLike {
  quit(): void;
  on?(
    event: "before-quit" | "window-all-closed" | "activate",
    listener: (event?: { preventDefault(): void }) => void,
  ): void;
}

export interface DesktopLifecycleManager {
  list(): Promise<TerminalDescriptor[]>;
  closeAll(): Promise<void>;
}

export interface DesktopLifecycleOptions {
  app: DesktopAppLike;
  manager: DesktopLifecycleManager;
  platform: NodeJS.Platform;
  getWindowCount(): number;
  createWindow(): void | Promise<void>;
  confirmQuit(activeTerminals: readonly TerminalDescriptor[]): Promise<boolean>;
  closeDatabase(): void | Promise<void>;
  unregisterIpc(): void | Promise<void>;
  admission: TerminalRequestAdmission;
  reportError?(error: unknown): void;
}

export class DesktopLifecycle {
  private quitAttemptInProgress = false;
  private quitting = false;

  constructor(private readonly options: DesktopLifecycleOptions) {}

  start(): void {
    this.options.app.on?.("before-quit", (event) => {
      if (event) void this.onBeforeQuit(event);
    });
    this.options.app.on?.("window-all-closed", () => this.onWindowAllClosed());
    this.options.app.on?.("activate", () => this.onActivate());
  }

  onWindowAllClosed(): void {
    if (this.options.platform !== "darwin") this.options.app.quit();
  }

  onActivate(): void {
    if (this.options.getWindowCount() !== 0) return;
    try {
      const windowCreation = this.options.createWindow();
      if (windowCreation instanceof Promise) {
        void windowCreation.catch((error: unknown) => this.report(error));
      }
    } catch (error) {
      this.report(error);
    }
  }

  async onBeforeQuit(event: { preventDefault(): void }): Promise<void> {
    if (this.quitting) return;
    event.preventDefault();
    if (this.quitAttemptInProgress) return;

    this.quitAttemptInProgress = true;
    let closeAllSucceeded = false;
    try {
      const activeTerminals = (await this.options.manager.list()).filter(
        (descriptor) => descriptor.state === "running",
      );
      if (
        activeTerminals.length > 0 &&
        !(await this.options.confirmQuit(activeTerminals))
      ) {
        return;
      }

      this.options.admission.close();
      await this.options.admission.drain();
      await this.options.manager.closeAll();
      closeAllSucceeded = true;
      await this.options.closeDatabase();
      await this.options.unregisterIpc();
      this.quitting = true;
      this.options.app.quit();
    } catch (error) {
      if (!closeAllSucceeded) this.options.admission.reopen();
      this.report(error);
    } finally {
      this.quitAttemptInProgress = false;
    }
  }

  private report(error: unknown): void {
    try {
      this.options.reportError?.(error);
    } catch (reportingError) {
      console.error("Desktop lifecycle error reporter failed", reportingError);
    }
  }
}
