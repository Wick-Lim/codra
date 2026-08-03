import type { ReactElement } from "react";
import { t } from "../i18n/messages";

const copy = t.desktopAuth;

export default function DesktopAuthBridgeTestOnly(): ReactElement {
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="desktop-auth-title">
        <div className="brand-mark">{copy.brandMark}</div>
        <p className="eyebrow">{copy.testOnly.eyebrow}</p>
        <h1 id="desktop-auth-title">{copy.testOnly.title}</h1>
        <p className="muted">{copy.testOnly.body}</p>
      </section>
    </main>
  );
}
