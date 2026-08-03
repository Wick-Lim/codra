import { Suspense, lazy, useEffect, useState, type ReactElement } from "react";
import LandingPage from "./landing/LandingPage";
import { routeFromPathname, type CodraRoute } from "./routing";
import { t } from "./i18n/messages";
import "./styles.css";

const copy = t.app;

/**
 * The two Firebase-bearing surfaces load on demand.
 *
 * Neither is a mere size optimisation. `remote/firebase-bridge.ts` calls
 * `initializeApp(...)` at module scope, and `remote/controller.ts` reaches a
 * second one through `@codra/web-firebase-config`, so a static import here
 * would download `@firebase/auth` and initialise a Firebase app before the
 * public landing page painted — for a visitor who may never sign in. Keep both
 * of these behind `lazy(...)`: the landing page must not transitively import
 * `remote/firebase-bridge.ts`. `src/App.test.tsx` fails if either is pulled
 * back into the eager graph.
 */
const RemoteConsoleApp = lazy(() => import("./console/RemoteConsoleApp"));
const DesktopAuthBridge = lazy(() => import("./remote/DesktopAuthBridge"));

function RouteFallback(): ReactElement {
  return (
    <main className="login-shell">
      <p className="message" role="status">
        {copy.loading}
      </p>
    </main>
  );
}

function App(): ReactElement {
  const [route, setRoute] = useState<CodraRoute>(() =>
    routeFromPathname(window.location.pathname),
  );

  useEffect(() => {
    const onPopState = (): void =>
      setRoute(routeFromPathname(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // In-app navigation: push the path so Back returns to the landing page, and
  // derive the route from that same pathname so `popstate` and `navigate`
  // cannot disagree about what a path means.
  function navigate(pathname: string): void {
    window.history.pushState({}, "", pathname);
    setRoute(routeFromPathname(pathname));
  }

  // The landing page stays outside Suspense: it is part of the entry chunk and
  // has nothing to suspend on.
  if (route === "landing")
    return <LandingPage onOpenConsole={() => navigate("/console")} />;

  return (
    <Suspense fallback={<RouteFallback />}>
      {route === "desktop-auth" ? <DesktopAuthBridge /> : <RemoteConsoleApp />}
    </Suspense>
  );
}

export default App;
