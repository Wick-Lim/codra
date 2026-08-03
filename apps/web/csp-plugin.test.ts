import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emulatorDeployment } from "@codra/protocol/emulator";
import {
  CODRA_PROJECT_ID,
  FUNCTION_REGION,
  productionPublicConfig,
} from "@codra/protocol/production";
import {
  CODRA_WEB_CSP_PLACEHOLDER,
  applyCodraWebCsp,
  codraWebContentSecurityPolicy,
  codraWebCspPlugin,
  stripCodraWebCsp,
} from "./csp-plugin";

// scan-client-artifacts bans `\bturns?://` (rule turn-url) and the uppercase
// vendor constant (rule turn-vendor-constant) from every file under
// apps/web/dist, and index.html carries the policy into that tree. The vendor
// token is assembled at runtime so this repository never spells it out.
const TURN_URL = /\bturns?:\/\//u;
const TURN_VENDOR_CONSTANT = ["CLOUD", "FLARE"].join("");

const productionPolicy = codraWebContentSecurityPolicy("production");
const emulatorPolicy = codraWebContentSecurityPolicy("emulator");

function directivesOf(policy: string): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();
  for (const segment of policy.split(";")) {
    const directive = segment.trim();
    if (!directive) continue;
    const boundary = directive.indexOf(" ");
    expect(boundary).toBeGreaterThan(0);
    const name = directive.slice(0, boundary);
    expect(parsed.has(name)).toBe(false);
    parsed.set(name, directive.slice(boundary + 1));
  }
  return parsed;
}

const repositoryRoot = new URL("../../", import.meta.url);
const firebaseConfig = JSON.parse(
  readFileSync(new URL("firebase.json", repositoryRoot), "utf8"),
) as {
  hosting: {
    headers?: ReadonlyArray<{
      source: string;
      headers: ReadonlyArray<{ key: string; value: string }>;
    }>;
  };
};

describe("codraWebContentSecurityPolicy", () => {
  it("allows every Firebase origin the production document talks to", () => {
    expect(directivesOf(productionPolicy).get("connect-src")).toBe(
      [
        "'self'",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://firestore.googleapis.com",
        `https://${FUNCTION_REGION}-${CODRA_PROJECT_ID}.cloudfunctions.net`,
      ].join(" "),
    );
    expect(productionPolicy).toContain(
      "https://asia-northeast3-codra-1b3bb.cloudfunctions.net",
    );
  });

  it("frames the Firebase auth helper and loads its api.js", () => {
    const production = directivesOf(productionPolicy);
    expect(production.get("frame-src")).toBe(
      `https://${productionPublicConfig.authDomain}`,
    );
    expect(production.get("frame-src")).toBe(
      "https://codra-1b3bb.firebaseapp.com",
    );
    expect(production.get("script-src")).toBe("'self' https://apis.google.com");
  });

  it("keeps xterm's inline styles working without inline script", () => {
    const production = directivesOf(productionPolicy);
    expect(production.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(production.get("script-src")).not.toContain("'unsafe-inline'");
    expect(production.get("img-src")).toBe(
      "'self' data: https://*.googleusercontent.com",
    );
    expect(production.get("font-src")).toBe("'self' data:");
  });

  it("denies framing so /desktop-auth cannot be clickjacked", () => {
    for (const policy of [productionPolicy, emulatorPolicy]) {
      const parsed = directivesOf(policy);
      expect(parsed.get("frame-ancestors")).toBe("'none'");
      expect(parsed.get("default-src")).toBe("'self'");
      expect(parsed.get("base-uri")).toBe("'none'");
      expect(parsed.get("object-src")).toBe("'none'");
      expect(parsed.get("form-action")).toBe("'none'");
    }
  });

  it("swaps the production origins for the emulator loopback origins", () => {
    expect(directivesOf(emulatorPolicy).get("connect-src")).toBe(
      [
        "'self'",
        emulatorDeployment.authOrigin,
        emulatorDeployment.firestoreOrigin,
        emulatorDeployment.functionsOrigin,
      ].join(" "),
    );
    expect(emulatorPolicy).toContain("http://127.0.0.1:9099");
    expect(emulatorPolicy).toContain("http://127.0.0.1:8080");
    expect(emulatorPolicy).toContain("http://127.0.0.1:5001");
    expect(directivesOf(emulatorPolicy).get("frame-src")).toBe("'none'");
    expect(directivesOf(emulatorPolicy).get("script-src")).toBe("'self'");
  });

  it("never leaks a loopback origin into the production policy", () => {
    expect(productionPolicy).not.toContain("127.0.0.1");
    expect(productionPolicy).not.toContain("localhost");
    expect(productionPolicy).not.toContain("http://");
  });

  it("carries no relay URL or vendor constant into the scanned tree", () => {
    for (const policy of [productionPolicy, emulatorPolicy]) {
      expect(policy).not.toMatch(TURN_URL);
      expect(policy).not.toContain(TURN_VENDOR_CONSTANT);
    }
  });

  it("never blocks WebRTC, which connect-src does not govern anyway", () => {
    for (const policy of [productionPolicy, emulatorPolicy]) {
      expect(policy).not.toContain("webrtc 'block'");
      if (policy.includes("webrtc")) expect(policy).toContain("webrtc 'allow'");
    }
  });
});

describe("codraWebCspPlugin", () => {
  const indexHtml = readFileSync(
    new URL("index.html", import.meta.url),
    "utf8",
  );

  it("leaves a placeholder in index.html for the build to substitute", () => {
    expect(indexHtml).toContain(CODRA_WEB_CSP_PLACEHOLDER);
    expect(indexHtml).toContain('http-equiv="Content-Security-Policy"');
  });

  it("substitutes the flavour's policy and leaves no placeholder behind", () => {
    const production = applyCodraWebCsp(indexHtml, "production");
    expect(production).toContain(productionPolicy);
    expect(production).not.toContain(CODRA_WEB_CSP_PLACEHOLDER);

    const emulator = applyCodraWebCsp(indexHtml, "emulator");
    expect(emulator).toContain(emulatorPolicy);
    expect(emulator).not.toContain(CODRA_WEB_CSP_PLACEHOLDER);
    expect(emulator).not.toContain("https://identitytoolkit.googleapis.com");
  });

  it("is a named vite plugin that transforms index.html", () => {
    const plugin = codraWebCspPlugin("production");
    expect(plugin.name).toBe("codra-web-csp");
    expect(typeof plugin.transformIndexHtml).toBe("function");
  });

  it("drops the meta outright rather than weakening it for the dev server", () => {
    const served = stripCodraWebCsp(indexHtml);
    expect(served).not.toContain("Content-Security-Policy");
    expect(served).not.toContain(CODRA_WEB_CSP_PLACEHOLDER);
    expect(served).toContain('<div id="root"></div>');
    expect(served).toContain("<title>CODRA</title>");
    expect(stripCodraWebCsp(applyCodraWebCsp(indexHtml, "production"))).toBe(
      served,
    );
  });
});

describe("firebase.json hosting headers", () => {
  const headerBlocks = firebaseConfig.hosting.headers ?? [];
  const applied = new Map<string, string>();
  for (const block of headerBlocks)
    for (const header of block.headers) applied.set(header.key, header.value);

  it("applies the security headers to every hosted path", () => {
    expect(headerBlocks.map((block) => block.source)).toEqual(["**"]);
  });

  it("serves the production policy as a real response header", () => {
    // frame-ancestors is ignored when delivered through <meta http-equiv>, so
    // the header is the only place the clickjacking defence is enforced.
    expect(applied.get("Content-Security-Policy")).toBe(productionPolicy);
  });

  it("mirrors the loopback callback page's header set", () => {
    expect(applied.get("Referrer-Policy")).toBe("no-referrer");
    expect(applied.get("X-Content-Type-Options")).toBe("nosniff");
    expect(applied.get("X-Frame-Options")).toBe("DENY");
  });
});
