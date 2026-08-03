import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { codraWebRollupOptions, codraWebVendorChunk } from "./chunk-strategy";

// Resolved through Node rather than hand-written, so these cases stay honest
// about pnpm's real layout: the store path repeats `node_modules` and only the
// last segment names the package.
const require = createRequire(import.meta.url);
const resolved = {
  react: require.resolve("react"),
  reactDom: require.resolve("react-dom"),
  firestore: require.resolve("firebase/firestore"),
  auth: require.resolve("firebase/auth"),
  xterm: require.resolve("@xterm/xterm"),
  addonFit: require.resolve("@xterm/addon-fit"),
};

describe("codraWebVendorChunk", () => {
  it("resolves the packages these cases are written against", () => {
    for (const [name, path] of Object.entries(resolved))
      expect(path, name).toContain("/node_modules/");
  });

  it("splits Firestore and Auth into separate chunks", () => {
    expect(codraWebVendorChunk(resolved.firestore)).toBe(
      "vendor-firebase-firestore",
    );
    expect(codraWebVendorChunk(resolved.auth)).toBe("vendor-firebase-auth");
    expect(
      codraWebVendorChunk("/repo/node_modules/@firebase/firestore/dist/x.js"),
    ).toBe("vendor-firebase-firestore");
    expect(
      codraWebVendorChunk("/repo/node_modules/@firebase/auth/dist/x.js"),
    ).toBe("vendor-firebase-auth");
  });

  it("keeps react, react-dom and scheduler together", () => {
    expect(codraWebVendorChunk(resolved.react)).toBe("vendor-react");
    expect(codraWebVendorChunk(resolved.reactDom)).toBe("vendor-react");
    expect(codraWebVendorChunk("/repo/node_modules/react/jsx-runtime.js")).toBe(
      "vendor-react",
    );
    expect(codraWebVendorChunk("/repo/node_modules/scheduler/index.js")).toBe(
      "vendor-react",
    );
  });

  it("collects the xterm packages", () => {
    expect(codraWebVendorChunk(resolved.xterm)).toBe("vendor-xterm");
    expect(codraWebVendorChunk(resolved.addonFit)).toBe("vendor-xterm");
  });

  it("reads the package name from the last node_modules segment", () => {
    expect(
      codraWebVendorChunk(
        "/repo/node_modules/.pnpm/@firebase+auth@1.13.4_@firebase+app@0.16.0/node_modules/@firebase/auth/dist/esm/index.js",
      ),
    ).toBe("vendor-firebase-auth");
    // A package vendored *under* another one belongs to the inner package.
    expect(
      codraWebVendorChunk(
        "/repo/node_modules/whatever/node_modules/react/x.js",
      ),
    ).toBe("vendor-react");
  });

  it("stops at the package-name boundary", () => {
    expect(
      codraWebVendorChunk(
        "/repo/node_modules/@firebase/auth-interop-types/x.js",
      ),
    ).toBeUndefined();
    expect(
      codraWebVendorChunk("/repo/node_modules/react-error-boundary/x.js"),
    ).toBeUndefined();
    expect(codraWebVendorChunk("/repo/node_modules/firebase/app/x.js")).toBe(
      undefined,
    );
  });

  it("leaves application code and virtual modules to Rollup", () => {
    expect(codraWebVendorChunk("/repo/apps/web/src/App.tsx")).toBeUndefined();
    expect(codraWebVendorChunk("\0vite/preload-helper")).toBeUndefined();
    expect(codraWebVendorChunk("\0commonjsHelpers.js")).toBeUndefined();
  });

  it("never throws, whatever id Rollup hands it", () => {
    for (const id of ["", "/", "node_modules", "\0", "C:\\repo\\src\\App.tsx"])
      expect(() => codraWebVendorChunk(id)).not.toThrow();
  });

  it("hands Vite the function form, not the object form", () => {
    // The object form would *add* @xterm/* to a graph that does not import it
    // yet. See chunk-strategy.ts.
    expect(typeof codraWebRollupOptions.output.manualChunks).toBe("function");
  });
});
