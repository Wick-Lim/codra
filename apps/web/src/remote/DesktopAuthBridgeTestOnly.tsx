import type { ReactElement } from "react";

export default function DesktopAuthBridgeTestOnly(): ReactElement {
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="desktop-auth-title">
        <div className="brand-mark">C</div>
        <p className="eyebrow">CODRA / REMOTE TEST</p>
        <h1 id="desktop-auth-title">데스크톱 Google 로그인은 지원되지 않습니다.</h1>
        <p className="muted">
          이 remote-test 빌드는 Firebase Emulator의 테스트 계정 전용입니다.
        </p>
      </section>
    </main>
  );
}
