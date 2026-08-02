import { describe, expect, it } from "vitest";
import { resolveDeviceDisplayName } from "./device-name";

describe("resolveDeviceDisplayName", () => {
  it("uses the bare hostname without the mDNS suffix", () => {
    expect(resolveDeviceDisplayName("Juns-MacBook-Pro.local")).toBe(
      "Juns-MacBook-Pro",
    );
    expect(resolveDeviceDisplayName("  studio-mac  ")).toBe("studio-mac");
  });

  it("falls back to a constant when the hostname is empty", () => {
    expect(resolveDeviceDisplayName("")).toBe("CODRA host");
    expect(resolveDeviceDisplayName(".local")).toBe("CODRA host");
  });

  it("falls back to a constant when the hostname is only whitespace", () => {
    expect(resolveDeviceDisplayName("   ")).toBe("CODRA host");
    expect(resolveDeviceDisplayName("\t\n")).toBe("CODRA host");
  });

  it("stays inside the RemoteDevice displayName bounds of 1 to 200", () => {
    for (const hostname of ["", ".local", "a", "x".repeat(500)]) {
      const resolved = resolveDeviceDisplayName(hostname);
      expect(resolved.length).toBeGreaterThanOrEqual(1);
      expect(resolved.length).toBeLessThanOrEqual(200);
    }
    expect(resolveDeviceDisplayName("x".repeat(500))).toHaveLength(200);
  });
});
