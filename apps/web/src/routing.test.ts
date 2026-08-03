import { describe, expect, it } from "vitest";
import { routeFromPathname } from "./routing";

describe("routeFromPathname", () => {
  it("serves the public landing page at the site root", () => {
    expect(routeFromPathname("/")).toBe("landing");
  });

  it("serves the landing page for unknown paths so the SPA never dead-ends", () => {
    expect(routeFromPathname("/pricing")).toBe("landing");
    expect(routeFromPathname("/console/extra")).toBe("landing");
    expect(routeFromPathname("")).toBe("landing");
  });

  it("routes /console to the console", () => {
    expect(routeFromPathname("/console")).toBe("console");
  });

  it("keeps /login on the console so bookmarks and the Hosting rewrite still work", () => {
    expect(routeFromPathname("/login")).toBe("console");
  });

  it("routes /desktop-auth to the desktop login bridge", () => {
    expect(routeFromPathname("/desktop-auth")).toBe("desktop-auth");
  });

  it("ignores a trailing slash on a known path", () => {
    expect(routeFromPathname("/console/")).toBe("console");
    expect(routeFromPathname("/login/")).toBe("console");
    expect(routeFromPathname("/desktop-auth/")).toBe("desktop-auth");
  });
});
