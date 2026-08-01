import { describe, expect, it } from "vitest";
import { buildBrowserWindowOptions } from "./window-options";

describe("buildBrowserWindowOptions", () => {
  it("isolates and sandboxes the renderer", () => {
    const options = buildBrowserWindowOptions("/tmp/preload.js");
    expect(options.webPreferences).toMatchObject({
      preload: "/tmp/preload.js",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });
});
