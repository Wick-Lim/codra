/**
 * Every user-visible string in `apps/web` lives here, keyed by locale.
 *
 * No i18n library is used on purpose. One locale record needs no runtime, and
 * any added dependency would land in `apps/web/dist`, where the client artifact
 * scanner bans a list of substrings that a third-party bundle could easily
 * reintroduce. A typed record gives the one thing a library would: a compile
 * error when a locale drifts out of shape.
 *
 * English is the default locale, which is what `index.html`'s `<html lang="en">`
 * has been claiming all along. Korean is preserved as a second locale — the
 * original copy of this app — even though nothing selects it yet. A selector can
 * be added later without touching a single component.
 *
 * Two rules for anyone editing these strings:
 *
 * 1. Accuracy is not negotiable. These are product claims. In particular, do
 *    not describe remote traffic as "direct" or "peer to peer": production sets
 *    `iceTransportPolicy: "relay"`, so every production session is relayed. What
 *    is true, and what the end-to-end Firestore scan actually enforces, is that
 *    the traffic is encrypted end to end and never passes through the control
 *    plane that arranged it.
 * 2. Grammar belongs inside a message, never spread across JSX children. A
 *    sentence assembled from fragments around an interpolated element only
 *    parses in the language it was written for. Where a value has to appear
 *    mid-sentence, the message is a function of that value.
 */

export type Locale = "en" | "ko";

export const defaultLocale: Locale = "en";

const en = {
  app: {
    // The console and the desktop-auth bridge are separate chunks, so a route
    // change can wait on a network round trip. This is the Suspense fallback
    // that covers it.
    loading: "Loading…",
  },

  landing: {
    brandMark: "C",
    brand: "CODRA",
    source: "View the source",
    eyebrow: "MACOS TERMINAL",
    headline: "A macOS terminal for running agents in parallel.",
    lead: "CODRA runs on your Mac. Terminal sessions, their metadata, and a bounded scrollback stay on the machine — and one CODRA Mac can browse another Mac's workspaces and launch agents there.",
    openConsole: "Open the remote console",
    openConsoleNote:
      "Remote access is optional. It stays off until you sign in and enable it.",
    claimsTitle: "Local first, remote by choice.",
    claims: [
      {
        testId: "landing-local-claim",
        title: "No account for local work",
        body: "Open a terminal, launch an agent, keep working. Local terminals and local agents need no account, and running CODRA locally needs no Firebase configuration at all.",
      },
      {
        testId: "landing-privacy-claim",
        title: "Terminal data never reaches the server",
        body: "Terminal bytes, agent prompts, and workspace paths travel over the encrypted WebRTC data channel between your Macs, and are never stored by CODRA. Sign-in, device registration, session approval, and signalling are all the control plane ever carries — an end-to-end test scans every stored document to keep that true.",
      },
      {
        testId: "landing-lifecycle-claim",
        title: "Closing the window is not quitting",
        body: "Close the CODRA window and your terminal processes keep running. Reopening CODRA restores the session list and its scrollback; quitting asks first when terminals are still active.",
      },
    ],
    stepsTitle: "How remote access works.",
    steps: [
      {
        title: "Sign in, then turn it on",
        body: "Remote access is off by default. Sign in with a Google account and enable the host from Settings on the Mac that will accept connections.",
      },
      {
        title: "Approve the session on the host",
        body: "Every connection request waits for an explicit approval on the host Mac. Nothing is negotiated until you allow it there.",
      },
      {
        title: "Connect over an encrypted channel",
        body: "Once approved, the two ends negotiate an encrypted WebRTC data channel. Terminal traffic flows over that channel end to end, never through the control plane that arranged it.",
      },
    ],
    buildNote:
      "CODRA is built from source. Release signing and notarization credentials are intentionally not configured in the repository, so there is no signed download — clone it and run it with Node.js 22 and pnpm.",
  },

  console: {
    brandMark: "C",
    eyebrow: "CODRA / REMOTE CONSOLE",
    signIn: {
      title: "Reach your terminals securely.",
      lead: "Sign in to see the CODRA desktop hosts registered to the same account. Only a connection you approve on the host starts a WebRTC session.",
      busy: "Signing in…",
      testOnly: "Sign in with the test account",
      google: "Sign in with Google",
      hintTestOnly: "This build talks only to a local Firebase Emulator.",
      hintGoogle:
        "Sign-in goes through your Google account; CODRA never stores your password.",
    },
    status: {
      initial: "Sign in and CODRA lists the hosts registered to your account.",
      hostsLoaded: "Loaded the host list.",
      signInFailed: "Sign-in failed.",
      // The host name lands mid-sentence, so the message takes it as an
      // argument rather than being glued together at the call site.
      requestSent: (hostName: string) =>
        `Sent a connection request to ${hostName}. Approve it on the desktop.`,
      requestFailed: "The connection request failed.",
      signedOut: "Signed out.",
      signOutFailed: "Sign-out failed.",
    },
    session: {
      requested: "Waiting for approval",
      ready: "Ready to connect",
      connected: "Connected",
      failed: (failureCode: string) => `Failed: ${failureCode}`,
    },
    header: {
      title: "Reach the terminal you were working in.",
      accountConnected: "Account connected",
      accountFallback: "CODRA account",
      signOut: "Sign out",
    },
    hero: {
      kicker: "FIREBASE CONTROL PLANE",
      title: "Pick a host, then approve the connection on the desktop.",
      body: "Terminal data is never stored in Firebase. Once a connection is approved it travels over the encrypted WebRTC data channel end to end, never through the control plane that arranged it.",
      refreshBusy: "Working…",
      refresh: "Refresh hosts",
    },
    hosts: {
      kicker: "AVAILABLE HOSTS",
      title: "Your hosts",
      emptyTitle: "No host is online.",
      emptyBody: "Open CODRA on the desktop and turn remote access on.",
      request: "Request connection",
    },
    sessions: {
      kicker: "SESSION ACTIVITY",
      title: "Connection status",
      empty: "You have not requested a session yet.",
    },
    flow: {
      disconnect: "End session",
      connecting: "Negotiating the encrypted channel…",
      connected: "Connected. Choose a folder to work in.",
      workspaceChosen: "Choose a runtime and describe the first task.",
      launching: "Launching the agent on the host…",
      // The terminal title lands mid-sentence, so the message takes it.
      launched: (terminalTitle: string) =>
        `${terminalTitle} is running on the host.`,
      connectFailed: "The connection could not be completed.",
      runtimesFailed: "The host's runtime list is unavailable.",
      launchFailed: "The agent could not be launched.",
      disconnected: "The session ended.",
      back: "Choose a different folder",
    },
    workspace: {
      kicker: "WORKSPACE",
      title: "Choose a folder on the host",
      lead: "Only the folder you pick is shared with this session.",
      breadcrumbLabel: "Folder path",
      locations: "Locations",
      loading: "Loading folders…",
      noRoots: "The host offered no folders.",
      noEntries: "No subfolders here.",
      open: (name: string) => `Open ${name}`,
      rootsFailed: "The host's folder list is unavailable.",
      listFailed: "That folder could not be opened.",
      validateFailed: "That folder cannot be used as a workspace.",
      selectedLabel: "Selected",
      selectedNone: "Choose a location",
      use: (label: string) => `Use ${label}`,
      checking: "Checking…",
    },
    runtime: {
      kicker: "AGENT RUNTIME",
      title: "Choose a runtime and describe the first task",
      lead: "A runtime the host cannot start is listed but cannot be chosen.",
      empty: "The host reported no agent runtimes.",
      runtimeLabel: "Runtime",
      unavailable: "Not available on the host",
      modelLabel: "Model",
      modelPlaceholder: "Choose a model",
      modelMissing: "This runtime needs a model before it can start.",
      effortLabel: "Effort",
      runtimeDefault: "Runtime default",
      yoloLabel: "Skip the agent's approval prompts",
      yoloUnsupported: "This runtime has no approval mode to skip.",
      promptLabel: "First prompt",
      promptPlaceholder: "Describe the first task for this agent…",
      promptCounter: (used: number, limit: number) =>
        `${used.toLocaleString()} / ${limit.toLocaleString()}`,
      launch: "Launch agent",
      launching: "Launching…",
      // Shown when the assembled request fails `AgentLaunchRequestSchema`,
      // which is the same check the host applies before it answers.
      rejected: "The host would refuse this combination.",
    },
    terminal: {
      regionLabel: (terminalTitle: string) => `Terminal ${terminalTitle}`,
      empty: "Launch an agent and its terminal opens here.",
    },
  },

  desktopAuth: {
    brandMark: "C",
    eyebrow: "CODRA / DESKTOP AUTHORIZATION",
    title: "Connect a desktop host",
    queryInvalid:
      "This sign-in request is not valid. Start again from CODRA on the desktop.",
    // Each of these is a whole sentence about the host identified on the line
    // above it. The Korean original built one sentence out of a noun phrase, a
    // case particle, and a verb ending spread across three JSX children, which
    // no other language can be slotted into.
    action: {
      register: "Allowing this will register the host above on your account.",
      resume: "Allowing this will reconnect the host above.",
      reenable: "Allowing this will re-enable the host above.",
    },
    allowBusy: "Approving…",
    allow: "Allow this host",
    redirecting: "Taking you to Google sign-in…",
    signInFailed: "Google sign-in failed. Please try again.",
    retry: "Retry Google sign-in",
    apiKeyInvalid:
      "The Firebase Web API key is not valid. Check the Web app key in the Firebase console.",
    testOnly: {
      eyebrow: "CODRA / REMOTE TEST",
      title: "Desktop Google sign-in is not supported in this build.",
      body: "This build only accepts the Firebase Emulator's test account.",
    },
  },
};

/** The shape every locale must have. English defines it. */
export type WebMessages = typeof en;

const ko: WebMessages = {
  app: {
    loading: "불러오는 중…",
  },

  landing: {
    brandMark: "C",
    brand: "CODRA",
    source: "소스 코드 보기",
    eyebrow: "MACOS TERMINAL",
    headline: "에이전트를 병렬로 실행하는 macOS 터미널.",
    lead: "CODRA는 여러분의 Mac에서 실행됩니다. 터미널 세션과 그 메타데이터, 길이가 제한된 스크롤백은 모두 기기에 남으며, 한 대의 CODRA Mac에서 다른 Mac의 작업 공간을 둘러보고 그곳에서 에이전트를 실행할 수 있습니다.",
    openConsole: "원격 콘솔 열기",
    openConsoleNote:
      "원격 접속은 선택 사항입니다. 로그인해서 직접 켜기 전까지는 꺼져 있습니다.",
    claimsTitle: "로컬이 먼저, 원격은 선택.",
    claims: [
      {
        testId: "landing-local-claim",
        title: "로컬 작업에는 계정이 필요 없습니다",
        body: "터미널을 열고, 에이전트를 실행하고, 그대로 작업하세요. 로컬 터미널과 로컬 에이전트에는 계정이 필요 없고, CODRA를 로컬에서 실행하는 데에는 Firebase 설정도 전혀 필요하지 않습니다.",
      },
      {
        testId: "landing-privacy-claim",
        title: "터미널 데이터는 서버에 닿지 않습니다",
        body: "터미널 바이트와 에이전트 프롬프트, 작업 공간 경로는 두 Mac 사이의 암호화된 WebRTC 데이터 채널로 오가며 CODRA가 저장하지 않습니다. 컨트롤 플레인이 다루는 것은 로그인과 기기 등록, 세션 승인, 시그널링뿐이며, 종단 간 테스트가 저장된 모든 문서를 검사해 이를 지킵니다.",
      },
      {
        testId: "landing-lifecycle-claim",
        title: "창을 닫는 것은 종료가 아닙니다",
        body: "CODRA 창을 닫아도 터미널 프로세스는 계속 실행됩니다. 다시 열면 세션 목록과 스크롤백이 복원되고, 실행 중인 터미널이 남아 있으면 종료하기 전에 먼저 확인합니다.",
      },
    ],
    stepsTitle: "원격 접속은 이렇게 동작합니다.",
    steps: [
      {
        title: "로그인한 뒤에 켜세요",
        body: "원격 접속은 기본적으로 꺼져 있습니다. Google 계정으로 로그인하고, 연결을 받을 Mac의 설정에서 호스트를 활성화하세요.",
      },
      {
        title: "호스트에서 세션을 승인하세요",
        body: "모든 연결 요청은 호스트 Mac에서의 명시적인 승인을 기다립니다. 그곳에서 허용하기 전까지는 아무것도 협상되지 않습니다.",
      },
      {
        title: "암호화된 채널로 연결하세요",
        body: "승인되면 양쪽 끝이 암호화된 WebRTC 데이터 채널을 협상합니다. 터미널 트래픽은 그 채널을 통해 종단 간으로 흐르며, 연결을 중개한 컨트롤 플레인을 거치지 않습니다.",
      },
    ],
    buildNote:
      "CODRA는 소스에서 빌드합니다. 릴리스 서명과 공증 자격 증명은 저장소에 의도적으로 설정되어 있지 않아 서명된 다운로드는 제공되지 않습니다. 저장소를 클론해 Node.js 22와 pnpm으로 실행하세요.",
  },

  console: {
    brandMark: "C",
    eyebrow: "CODRA / REMOTE CONSOLE",
    signIn: {
      title: "내 터미널에 안전하게 접속하세요.",
      lead: "로그인하면 같은 계정으로 등록된 CODRA 데스크톱 호스트를 확인할 수 있습니다. 호스트에서 승인한 연결만 WebRTC 세션으로 이어집니다.",
      busy: "로그인 중…",
      testOnly: "테스트 계정으로 로그인",
      google: "Google로 로그인",
      hintTestOnly: "이 빌드는 로컬 Firebase Emulator 전용입니다.",
      hintGoogle:
        "Google 계정으로 로그인하며 비밀번호는 CODRA가 보관하지 않습니다.",
    },
    status: {
      initial: "로그인하면 같은 계정의 CODRA 호스트를 찾습니다.",
      hostsLoaded: "호스트 목록을 불러왔습니다.",
      signInFailed: "로그인에 실패했습니다.",
      requestSent: (hostName: string) =>
        `${hostName}에 연결 요청을 보냈습니다. 데스크톱에서 승인해 주세요.`,
      requestFailed: "연결 요청에 실패했습니다.",
      signedOut: "로그아웃했습니다.",
      signOutFailed: "로그아웃에 실패했습니다.",
    },
    session: {
      requested: "승인 대기 중",
      ready: "연결 준비됨",
      connected: "연결됨",
      failed: (failureCode: string) => `실패: ${failureCode}`,
    },
    header: {
      title: "작업 중인 터미널에 안전하게 접속하세요.",
      accountConnected: "계정 연결됨",
      accountFallback: "CODRA 계정",
      signOut: "로그아웃",
    },
    hero: {
      kicker: "FIREBASE CONTROL PLANE",
      title: "내 호스트를 선택하고, 데스크톱에서 승인합니다.",
      // The original said the data channel delivers terminal traffic
      // "직접" (directly). It does not: production forces a relay. Corrected
      // here to the claim that actually holds.
      body: "터미널 데이터는 Firebase에 저장하지 않습니다. 연결이 승인되면 암호화된 WebRTC 데이터 채널로 종단 간 전달되며, 연결을 중개한 컨트롤 플레인을 거치지 않습니다.",
      refreshBusy: "처리 중…",
      refresh: "호스트 새로고침",
    },
    hosts: {
      kicker: "AVAILABLE HOSTS",
      title: "내 호스트",
      emptyTitle: "온라인 상태인 호스트가 없습니다.",
      emptyBody: "CODRA 데스크톱을 켜고 원격 모드를 활성화해 주세요.",
      request: "연결 요청",
    },
    sessions: {
      kicker: "SESSION ACTIVITY",
      title: "연결 상태",
      empty: "아직 요청한 세션이 없습니다.",
    },
    flow: {
      disconnect: "세션 종료",
      connecting: "암호화된 채널을 협상하는 중…",
      connected: "연결되었습니다. 작업할 폴더를 선택하세요.",
      workspaceChosen: "런타임을 고르고 첫 작업을 설명해 주세요.",
      launching: "호스트에서 에이전트를 시작하는 중…",
      launched: (terminalTitle: string) =>
        `${terminalTitle}이(가) 호스트에서 실행 중입니다.`,
      connectFailed: "연결을 완료하지 못했습니다.",
      runtimesFailed: "호스트의 런타임 목록을 가져올 수 없습니다.",
      launchFailed: "에이전트를 시작하지 못했습니다.",
      disconnected: "세션이 종료되었습니다.",
      back: "다른 폴더 선택",
    },
    workspace: {
      kicker: "WORKSPACE",
      title: "호스트의 폴더를 선택하세요",
      lead: "선택한 폴더만 이 세션에 공유됩니다.",
      breadcrumbLabel: "폴더 경로",
      locations: "위치",
      loading: "폴더를 불러오는 중…",
      noRoots: "호스트가 제공한 폴더가 없습니다.",
      noEntries: "하위 폴더가 없습니다.",
      open: (name: string) => `${name} 열기`,
      rootsFailed: "호스트의 폴더 목록을 가져올 수 없습니다.",
      listFailed: "그 폴더를 열 수 없습니다.",
      validateFailed: "그 폴더는 작업 공간으로 사용할 수 없습니다.",
      selectedLabel: "선택됨",
      selectedNone: "위치를 선택하세요",
      use: (label: string) => `${label} 사용`,
      checking: "확인 중…",
    },
    runtime: {
      kicker: "AGENT RUNTIME",
      title: "런타임을 고르고 첫 작업을 설명하세요",
      lead: "호스트가 실행할 수 없는 런타임도 목록에는 보이지만 선택할 수 없습니다.",
      empty: "호스트가 사용할 수 있는 에이전트 런타임이 없습니다.",
      runtimeLabel: "런타임",
      unavailable: "호스트에서 사용할 수 없음",
      modelLabel: "모델",
      modelPlaceholder: "모델을 선택하세요",
      modelMissing: "이 런타임은 모델을 지정해야 시작할 수 있습니다.",
      effortLabel: "추론 강도",
      runtimeDefault: "런타임 기본값",
      yoloLabel: "에이전트의 승인 질문 건너뛰기",
      yoloUnsupported: "이 런타임에는 건너뛸 승인 단계가 없습니다.",
      promptLabel: "첫 프롬프트",
      promptPlaceholder: "이 에이전트가 처음 할 작업을 설명하세요…",
      promptCounter: (used: number, limit: number) =>
        `${used.toLocaleString()} / ${limit.toLocaleString()}`,
      launch: "에이전트 실행",
      launching: "실행 중…",
      rejected: "이 조합은 호스트가 거부합니다.",
    },
    terminal: {
      regionLabel: (terminalTitle: string) => `터미널 ${terminalTitle}`,
      empty: "에이전트를 실행하면 여기에 터미널이 열립니다.",
    },
  },

  desktopAuth: {
    brandMark: "C",
    eyebrow: "CODRA / DESKTOP AUTHORIZATION",
    title: "데스크톱 호스트 연결",
    queryInvalid:
      "이 로그인 요청은 유효하지 않습니다. CODRA 데스크톱에서 다시 시작해 주세요.",
    action: {
      register: "허용하면 위 호스트를 새로 등록합니다.",
      resume: "허용하면 위 호스트에 다시 연결합니다.",
      reenable: "허용하면 위 호스트를 다시 활성화합니다.",
    },
    allowBusy: "승인 중…",
    allow: "이 호스트 허용",
    redirecting: "Google 로그인으로 이동 중…",
    signInFailed: "Google 로그인에 실패했습니다. 다시 시도해 주세요.",
    retry: "Google 로그인 다시 시도",
    apiKeyInvalid:
      "Firebase Web API 키가 유효하지 않습니다. Firebase 콘솔에서 Web 앱 키를 확인해 주세요.",
    testOnly: {
      eyebrow: "CODRA / REMOTE TEST",
      title: "데스크톱 Google 로그인은 지원되지 않습니다.",
      body: "이 빌드는 Firebase Emulator의 테스트 계정 전용입니다.",
    },
  },
};

export const messages: Record<Locale, WebMessages> = { en, ko };

/**
 * The active message set. Nothing selects a locale yet, so every component
 * reads this constant; adding a selector later means changing this line only.
 */
export const t: WebMessages = messages[defaultLocale];
