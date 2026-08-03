/**
 * Vendor chunking, shared by `vite.config.ts` and `vite.remote-test.config.ts`.
 *
 * Both configs import this one function rather than each spelling out its own
 * `manualChunks`, because a split that exists in only one of them is worse than
 * no split at all: the emulator bundle is what the remote-test Playwright suites
 * load, so the two flavours have to chunk identically for those suites to say
 * anything about the shipped bundle.
 *
 * Two properties this function must keep:
 *
 * 1. **It never throws.** `apps/web` has no vitest config, so Vitest inherits
 *    `vite.config.ts`; a config that fails to evaluate takes the whole test
 *    suite down with it, not just `vite build`. Hence: no filesystem access, no
 *    resolution, pure string work, and `chunk-strategy.test.ts` next door.
 * 2. **It is the function form, never the object form.** Rollup's object form
 *    (`{ "vendor-xterm": ["@xterm/xterm"] }`) *adds* the named modules to the
 *    graph. `@xterm/*` is a dependency of `apps/web` that nothing imports yet
 *    (the console UI arrives later), so the object form would pull a terminal
 *    emulator into a bundle that has no terminal in it. The function form only
 *    ever places modules that are already there.
 *
 * Firebase carries the point of the exercise: `@firebase/firestore` and
 * `@firebase/auth` are roughly two thirds of the bundle, and both are reachable
 * only through the lazily loaded console and desktop-auth chunks (`src/App.tsx`).
 * Giving them their own chunks keeps them out of the landing page's eager graph
 * instead of letting Rollup fold them into whatever chunk first mentions them.
 */

/**
 * Chunk name -> the package specifiers that belong in it.
 *
 * `firebase/auth` and `@firebase/auth` are listed as a pair on purpose: the
 * `firebase` package's subpath entry points are thin re-exports of the
 * `@firebase/*` packages, and separating a re-export from what it re-exports
 * would only produce a second chunk that is never loaded on its own.
 */
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["vendor-firebase-firestore", ["@firebase/firestore", "firebase/firestore"]],
  ["vendor-firebase-auth", ["@firebase/auth", "firebase/auth"]],
  // `scheduler` is react-dom's own dependency and is dead weight without it.
  ["vendor-react", ["react", "react-dom", "scheduler"]],
  ["vendor-xterm", ["@xterm/xterm", "@xterm/addon-fit"]],
];

const NODE_MODULES = "/node_modules/";

/**
 * Maps a Rollup module id onto a vendor chunk name, or `undefined` to leave the
 * module to Rollup's own placement.
 *
 * The package specifier is read from the *last* `/node_modules/` segment, which
 * is what makes this work under pnpm: a real path looks like
 * `…/node_modules/.pnpm/@firebase+auth@1.13.4_…/node_modules/@firebase/auth/dist/…`,
 * and only the last segment names the package. Ids that are not files —
 * Rollup's `\0`-prefixed virtual modules, Vite's preload helper — carry no such
 * segment and fall through to `undefined`. CommonJS proxies keep the path of
 * the module they wrap, so they land in the same chunk as their target.
 */
export function codraWebVendorChunk(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/");
  const boundary = normalized.lastIndexOf(NODE_MODULES);
  if (boundary < 0) return undefined;
  const specifier = normalized.slice(boundary + NODE_MODULES.length);
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    for (const name of packages) {
      // The trailing slash is the package-name boundary: without it
      // `@firebase/auth` would swallow `@firebase/auth-interop-types`, and
      // `react` would swallow `react-dom`.
      if (specifier === name || specifier.startsWith(`${name}/`)) return chunk;
    }
  }
  return undefined;
}

/** The `build.rollupOptions` both configs share. */
export const codraWebRollupOptions = {
  output: { manualChunks: codraWebVendorChunk },
} as const;
