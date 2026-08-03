import type { ReactElement } from "react";
import { t } from "../i18n/messages";
import "./LandingPage.css";

const repositoryUrl = "https://github.com/Wick-Lim/codra";

/**
 * Every sentence on this page is checked against `README.md` and the product
 * thesis in `docs/superpowers/specs/2026-08-02-operator-console-ux-design.md`.
 * This page is the only CODRA surface a visitor sees before installing
 * anything, so a claim the product cannot keep is a defect, not marketing. In
 * particular the page does not promise a signed or notarized download:
 * `README.md` records that those credentials are intentionally absent.
 *
 * The copy itself lives in `src/i18n/messages.ts`, one record per locale.
 */
const copy = t.landing;

export default function LandingPage(props: {
  onOpenConsole: () => void;
}): ReactElement {
  return (
    <main className="landing">
      <header className="landing-bar">
        <p className="landing-brand">
          <span className="landing-mark" aria-hidden="true">
            {copy.brandMark}
          </span>
          {copy.brand}
        </p>
        <a
          className="landing-source"
          href={repositoryUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {copy.source}
        </a>
      </header>

      <section className="landing-hero">
        <p className="landing-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.headline}</h1>
        <p className="landing-lead">{copy.lead}</p>
        <div className="landing-actions">
          <button
            type="button"
            className="landing-cta"
            data-testid="landing-open-console"
            onClick={props.onOpenConsole}
          >
            {copy.openConsole}
          </button>
          <p className="landing-note">{copy.openConsoleNote}</p>
        </div>
      </section>

      <section aria-labelledby="landing-claims-title">
        <h2 id="landing-claims-title">{copy.claimsTitle}</h2>
        <ul className="landing-cards">
          {copy.claims.map((claim) => (
            <li
              className="landing-card"
              key={claim.testId}
              data-testid={claim.testId}
            >
              <h3>{claim.title}</h3>
              <p>{claim.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="landing-steps-title">
        <h2 id="landing-steps-title">{copy.stepsTitle}</h2>
        <ol className="landing-steps">
          {copy.steps.map((step, index) => (
            <li className="landing-step" key={step.title}>
              <span className="landing-step-index" aria-hidden="true">
                {index + 1}
              </span>
              <div className="landing-step-body">
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="landing-footer">
        <p>{copy.buildNote}</p>
      </footer>
    </main>
  );
}
