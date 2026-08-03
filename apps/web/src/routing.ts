export type CodraRoute = "landing" | "console" | "desktop-auth";

/**
 * Maps a browser pathname onto a CODRA surface.
 *
 * Pure by design: no DOM access, so it is testable without jsdom. Unknown paths
 * fall back to the public landing page because Firebase Hosting rewrites every
 * unmatched path to `index.html`. `/login` stays on the console so existing
 * bookmarks and the `/login` Hosting rewrite keep working.
 */
export function routeFromPathname(pathname: string): CodraRoute {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized === "/desktop-auth") return "desktop-auth";
  if (normalized === "/console" || normalized === "/login") return "console";
  return "landing";
}
