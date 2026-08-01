import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

test("remote package contains verified native modules for both macOS architectures", () => {
  const root = resolve(process.cwd(), "apps/desktop/dist-remote-test");
  expect(existsSync(root)).toBe(true);
  for (const [directory, architecture] of [
    ["mac-arm64", "arm64"],
    ["mac", "x64"],
  ]) {
    const appRoot = resolve(root, directory, "CODRA Remote Test.app");
    const resources = resolve(appRoot, "Contents/Resources");
    const provenancePath = resolve(resources, "remote-test-provenance.json");
    const binary = resolve(
      resources,
      "app.asar.unpacked/node_modules/node-datachannel/build/Release/node_datachannel.node",
    );
    expect(existsSync(appRoot)).toBe(true);
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(provenancePath)).toBe(true);
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    expect(provenance.testOnly).toBe(true);
    expect(provenance.configMode).toBe("emulator");
    expect(provenance.architecture).toBe(architecture);
    expect(provenance.packagedSha256).toMatch(/^[a-f0-9]{64}$/u);
  }
});
