# CODRA Standalone Desktop + Remote Terminal MVP Design

**Date:** 2026-08-01
**Status:** Revised for user review
**Product:** CODRA — Parallel agents, controlled.

## Summary

CODRA's first deliverable is a standalone macOS Electron application. A user can launch CODRA, open a local terminal, and run a shell or agent CLI without creating an account. The Electron main process owns PTYs, scrollback, session state, and later WebRTC connections. The sandboxed renderer accesses only a narrow preload API over Electron IPC.

Remote access is the second layer on top of that working desktop host. After the user signs in and enables remote access, the running Electron application registers as a selectable host. A signed-in browser can then attach to that host. Firebase Authentication establishes identity, Firestore carries short-lived WebRTC signaling records, and encrypted WebRTC DataChannels carry terminal traffic directly or through Cloudflare TURN.

The web application is never a standalone terminal host and cannot create a host shell. It is only a remote client for an installed, running, and approved CODRA desktop host. Closing the Electron window leaves the Electron main process running on macOS, so PTYs and active remote connections remain available. Explicitly quitting CODRA ends PTYs and remote connections after a warning.

## Goals

1. Ship a standalone Electron application that works locally without login or Firebase availability.
2. Keep all privileged terminal and WebRTC operations in the Electron main process behind a versioned preload API.
3. Create, list, attach to, write to, and resize host PTYs in the Electron UI.
4. Keep the Electron main process and its PTYs alive when the window closes, then reattach when it reopens.
5. Add opt-in Firebase Authentication and register the installed desktop as a remote host.
6. Register browser devices, display recently active hosts, and require host-signed approval.
7. Exchange SDP offers, answers, and trickled ICE candidates through Firestore.
8. Prefer direct WebRTC connectivity and fall back to Cloudflare TURN.
9. Attach to the same host PTYs from the web client without moving terminal data into Firebase.
10. Keep local and remote control responsive during large output bursts and restore scrollback after disconnects.
11. Keep all Cloudflare long-lived credentials in Cloud Secret Manager.

## Non-goals

- Full CODRA Task Board, worktree lifecycle, agent adapters, validation, review, Jira, or GitHub integration
- A browser-only CODRA product or a web client that can act as a terminal host
- Team workspaces or cross-user terminal sharing
- Mobile-native applications
- File transfer, browser streaming, desktop screen sharing, or port forwarding
- Running a shell inside the browser
- Synchronizing SQLite or terminal transcripts through Firestore
- Keeping PTYs alive after the user explicitly quits CODRA or after an Electron process or machine restart
- A separately installed daemon, launch agent, background service, or Unix-socket RPC server
- Hardware-backed device attestation; the MVP uses a software P-256 host key stored in the macOS Keychain
- Supporting Windows or Linux packaging in the first release, although protocol and package boundaries remain portable

## Confirmed Technology Choices

| Area | Choice |
| --- | --- |
| Host UI | Electron + React |
| Host runtime | Electron main process |
| Local terminal UI | xterm.js in Electron renderer |
| Local transport | Electron IPC through a context-isolated preload bridge |
| Host WebRTC | `node-datachannel` in Electron main process |
| Host terminal | `node-pty` |
| Web client | React + Vite + xterm.js |
| Identity | Firebase Authentication |
| Signaling | Cloud Firestore realtime listeners |
| Server functions | Firebase Functions 2nd gen |
| TURN | Cloudflare Realtime TURN |
| Local metadata | SQLite WAL |
| Local scrollback | Append-only files owned by Electron main process |
| Validation | Vitest, Firebase Emulator Suite, Playwright |

`node-datachannel` runs in Electron main rather than a hidden renderer so the remote endpoint remains available when the desktop window is closed. A separate daemon is intentionally omitted for the MVP. A central WebSocket terminal relay is rejected because it would put terminal contents on a hosted data path and weaken CODRA's local-first privacy boundary.

## System Architecture

```text
┌─────────────────────────┐
│ CODRA Desktop           │
│                         │
│ Renderer                │
│ React + xterm.js        │
│       │ preload IPC     │
│ Main process            │      WebRTC DataChannels      ┌──────────────────────────┐
│ terminal/session owner  │◀─────────────────────────────▶│ Optional web client      │
│ node-pty                │   direct or Cloudflare TURN  │ React + xterm.js         │
│ node-datachannel        │                               │ Browser RTCPeerConnection│
└────────────┬────────────┘                               └──────────────────────────┘
             │
       shell / agent CLI

Firebase control plane
├─ Authentication: user identity
├─ Firestore: device presence and WebRTC signaling
└─ Functions: authenticated TURN credential issue/revoke
```

Firestore is a signaling plane, not a data plane. A successful WebRTC connection makes continued terminal traffic independent of Firestore. Firestore remains available only for connection-state updates and a later reconnect attempt.

## Desktop-first Delivery Contract

The standalone desktop path is a complete product increment and is implemented before any Firebase or web work:

```text
Launch CODRA Desktop
→ initialize Electron main process
→ create a PTY in Electron main
→ render it in Electron xterm.js
→ type, resize, detach, and reattach
→ close Electron window while the main process and PTY remain alive
→ reopen Electron and restore the terminal list and scrollback
```

Local mode never waits for Firebase initialization and never requires login. “Enable Remote Access” is an explicit desktop setting. Enabling it starts Firebase authentication, host key registration, heartbeat, signaling listeners, and WebRTC support. Disabling it stops those listeners and peer connections without stopping local terminals.

Only after the desktop contract passes its acceptance tests does the project build the web client flow:

```text
Sign in on web
→ select an online CODRA Desktop host
→ request host approval
→ negotiate WebRTC through Firestore
→ attach to a PTY already owned by the Electron main process
```

## Component Boundaries

### `apps/desktop`

The Electron application is CODRA's primary product surface. Its main process owns PTYs, WebRTC peer connections, session authorization, scrollback, and protocol routing. Its context-isolated preload exposes a versioned allowlist of terminal operations to the sandboxed React renderer. Local terminals and scrollback work without login.

Closing the last window on macOS hides the application while leaving the main process, PTYs, and remote connections alive. The dock or menu-bar action reopens a renderer and reattaches it. Choosing Quit warns about active terminals and connections, then closes them and exits; there is no separately installed service.

When remote access is enabled, the desktop also signs the user in, shows device presence, and presents host approval prompts. On first host registration, Electron main generates a P-256 signing key and stores its private material in the macOS Keychain; the public JWK is registered with Firebase. Refresh tokens and the private device key remain in the main process and are never exposed through preload or WebRTC.

### `apps/web`

The web application signs the user in, lists their online Electron hosts, requests a session, performs browser-side WebRTC negotiation, renders xterm.js, and reconnects with a terminal cursor. It does not receive Cloudflare API tokens, Firebase Admin credentials, host filesystem paths beyond explicitly returned display values, or Electron main-process credentials.

### `packages/protocol`

This package contains shared Zod schemas, protocol version negotiation, control messages, terminal binary frame codecs, and error codes. Both the browser and Electron main process validate all untrusted messages at the boundary.

### `packages/firebase`

This package wraps Firebase client initialization, typed Firestore references, device heartbeats, session state transitions, and signaling subscriptions. It does not contain Admin SDK code or long-lived secrets.

### `packages/webrtc`

This package normalizes Cloudflare ICE server responses for browser and `node-datachannel` clients, deduplicates ICE candidates, implements negotiation timeouts, and exposes transport-neutral channel adapters.

### `functions`

Firebase Functions register host public keys, verify host-signed session approvals, and issue or revoke Cloudflare TURN credentials. They validate Firebase Auth, App Check or host signatures as appropriate, session ownership, participant device IDs, session status, lease expiry, and issuance rate before contacting Cloudflare.

## Firebase Client Configuration

The user-supplied Firebase web configuration is public client configuration and may be included in the web build:

```ts
export const firebaseConfig = {
  apiKey: "AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o",
  authDomain: "codra-1b3bb.firebaseapp.com",
  projectId: "codra-1b3bb",
  storageBucket: "codra-1b3bb.firebasestorage.app",
  messagingSenderId: "92715578857",
  appId: "1:92715578857:web:6c07f26a4866a1d4d3c778",
  measurementId: "G-YVR71LBSVB",
} as const;
```

This object is not an authorization boundary. Firebase Authentication, Firestore Security Rules, App Check, and host approval enforce access.

## Secret Handling

The Cloudflare Bearer token shared during design is treated as exposed and must be revoked and replaced before deployment. It must never enter Git history, `.env` files committed to Git, application logs, test fixtures, or client bundles.

Firebase Functions use one structured secret:

```json
{
  "keyId": "cloudflare-turn-key-id",
  "apiToken": "rotated-cloudflare-api-token"
}
```

The secret name is `CLOUDFLARE_TURN_CONFIG` and is read with `defineJsonSecret()`. Only the two TURN functions bind this secret. Local tests inject a fake Cloudflare HTTP adapter and never require the production secret.

## Firestore Data Model

All user-owned records are nested below the authenticated UID so rules and queries share the same ownership boundary.

### `users/{uid}/devices/{deviceId}`

```ts
interface DeviceDocument {
  id: string;
  kind: "host" | "web";
  name: string;
  platform: "macos" | "web";
  appVersion: string;
  protocolVersions: number[];
  publicKeyJwk?: JsonWebKey;
  keyFingerprint?: string;
  status: "online" | "offline";
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt: Timestamp;
}
```

Host device creation is performed by a callable function that accepts its P-256 public JWK and permanently binds that key to the random `deviceId`. The private key never leaves the macOS Keychain. Hosts call `heartbeatHostDevice` every 30 seconds with a signed timestamp; the function verifies the registered key and writes `lastSeenAt` with a server timestamp. A web client considers a host online only when `status == "online"` and `lastSeenAt` is no more than 90 seconds old. Firestore has no authoritative disconnect event for this design, so stale presence is inferred rather than trusted.

### `users/{uid}/remoteSessions/{sessionId}`

```ts
type RemoteSessionStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "signaling"
  | "connected"
  | "disconnected"
  | "closed"
  | "expired"
  | "failed";

interface RemoteSessionDocument {
  id: string;
  ownerUid: string;
  hostDeviceId: string;
  clientDeviceId: string;
  status: RemoteSessionStatus;
  protocolVersion: 1;
  requestedScopes: ["terminal:read", "terminal:write"];
  approvedScopes: Array<"terminal:read" | "terminal:write">;
  requestNonce: string;
  approvalSignature?: string;
  createdAt: Timestamp;
  approvedAt?: Timestamp;
  connectedAt?: Timestamp;
  closedAt?: Timestamp;
  expiresAt: Timestamp;
  failureCode?: string;
}
```

A session lease lasts eight hours. The client creates a `requested` session. After local user approval, the selected host signs a canonical payload containing the session ID, request nonce, decision, approved scopes, and expiry. The `approveRemoteSession` callable function verifies that signature against the selected host's registered public key before transitioning the document to `approved` or `rejected`. Both participants may request closure; terminal authority remains with the host.

### `serverTurnIssuances/{issuanceHash}`

This server-only collection records a hash of each issued TURN username, the owning UID, session ID, participant device ID, issue time, and expiry. Client rules deny all reads and writes. It exists only to validate revocation requests and enforce issuance limits; no Cloudflare password or API token is stored.

### `users/{uid}/remoteSessions/{sessionId}/signals/{signalId}`

```ts
interface SignalDocument {
  id: string;
  kind: "offer" | "answer" | "candidate" | "end-of-candidates";
  senderDeviceId: string;
  recipientDeviceId: string;
  sequence: number;
  payload: Record<string, unknown>;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}
```

Signals are append-only and expire one hour after creation. `signalId` is a random identifier; `(senderDeviceId, sequence)` is the logical deduplication key. Clients ignore expired records immediately even though Firestore TTL deletion may occur later. Session closure performs best-effort signal deletion, while Firestore TTL is the final cleanup mechanism.

No terminal bytes, commands, prompts, repository content, file content, environment variables, or scrollback are written to these collections.

## Firestore Security Rules

Rules enforce all of the following:

1. `request.auth` must exist and its UID must equal the `{uid}` path segment.
2. Creates and updates use explicit field allowlists and type checks.
3. Document IDs must match the `id` field.
4. `ownerUid`, participant IDs, creation timestamps, and nonces are immutable.
5. Clients cannot create or mutate host records or write `approved` or `rejected`; host registration, host heartbeat, and approval callable functions perform those writes after checking the host key.
6. Signal writes are permitted only while the parent session is `approved`, `signaling`, or `connected` and has not expired.
7. Signal payload sizes, candidate string lengths, and SDP lengths are bounded.
8. Deletes are allowed to participants for cleanup but never grant access across UIDs.
9. Queries must include the authenticated user's path and bounded limits.

Firebase Auth identifies the account, while the registered P-256 key distinguishes the selected host from another client signed into that account. This is software key possession, not hardware-backed attestation. Cross-user sharing and hardware attestation are deferred until the team design.

## App Check

The web application uses Firebase App Check with reCAPTCHA Enterprise in production and the debug provider only in local development and CI. Firestore and web-facing callable Functions begin in metrics mode, then enforcement is enabled after legitimate production traffic is verified. Host-only functions accept Firebase Auth plus a signature from the registered host key because Electron main has no built-in desktop App Check provider. This signature proves possession of the registered software key; it does not claim that the host binary is untampered.

## TURN Credential Functions

### `registerHostDevice`, `heartbeatHostDevice`, and `approveRemoteSession`

`registerHostDevice` requires Firebase Auth, validates a P-256 public JWK, creates a random host device ID, and stores the immutable public key and fingerprint. `heartbeatHostDevice` verifies a signature over `codra.host-heartbeat.v1`, the device ID, and the current epoch minute before updating presence with a server timestamp. `approveRemoteSession` requires Firebase Auth and a signature over this canonical UTF-8 payload:

```text
codra.remote-approval.v1
<sessionId>
<requestNonce>
<approved-or-rejected>
<comma-separated-sorted-scopes>
<expiresAtMillis>
```

The function loads the registered host key, verifies ECDSA P-256/SHA-256, confirms the signed values match the current requested session, and performs the status update in a transaction. A web client signed into the same Firebase account cannot approve a session targeting an existing host without that host's private key.

### `issueTurnCredentials`

The callable function accepts:

```ts
interface IssueTurnCredentialsRequest {
  sessionId: string;
  deviceId: string;
  hostProof?: {
    issuedAtMinute: number;
    signature: string;
  };
}
```

It performs these checks in order:

1. Require a valid Firebase Auth context.
2. Require a valid App Check context for a web participant. For the host participant, verify `hostProof.signature` over `codra.turn-issuance.v1`, session ID, device ID, request nonce, and `issuedAtMinute`, which must be within two minutes of server time.
3. Load the session under the authenticated UID.
4. Confirm `deviceId` is one of the session participants.
5. Confirm the session is approved, unexpired, and not closed.
6. Enforce a per-user and per-session issuance window.
7. Call Cloudflare's `generate-ice-servers` endpoint with `ttl: 86400`.
8. Validate the Cloudflare response before returning `iceServers` to the caller.

The Cloudflare request has a five-second timeout, is retried once only for a network failure or HTTP 5xx response, and never logs request headers or returned credentials. HTTP 4xx responses are not retried.

### `revokeTurnCredentials`

The issue function records only a hash of the returned TURN username and its expiry in `serverTurnIssuances`. The client retains the actual username in memory. On normal session closure, the authenticated client sends the username to the revoke function, which hashes it, validates that it belongs to the caller and active session, and then calls Cloudflare's revoke endpoint. Expiration remains the fallback if a client disappears.

The 24-hour credential TTL is longer than the eight-hour remote session lease. A reconnect creates a new WebRTC peer connection and requests fresh credentials. Live sessions do not attempt in-place credential mutation in the first slice.

## ICE Server Normalization

Cloudflare returns standard `RTCIceServer[]`. The browser passes compatible entries to `RTCPeerConnection`, excluding port 53 URLs because browsers commonly block that port and it can delay gathering. Electron main converts each TURN URL to a structured `node-datachannel` `IceServer` with the correct `TurnUdp`, `TurnTcp`, or `TurnTls` relay type and preserves the returned username and credential.

The default policy is `all`, which tries host, server-reflexive, and relay candidates. Tests also support `relay` to prove traffic can traverse Cloudflare TURN. Trickle ICE remains enabled so candidate gathering does not block offer creation.

## Signaling Flow

1. Host and web client sign in to the same Firebase account.
2. Electron main publishes a host device heartbeat through the authenticated desktop session.
3. The web client creates a `requested` remote session for a selected host.
4. Electron shows the requesting device and scopes; the host approves or rejects locally, signs the decision with its Keychain-backed key, and calls `approveRemoteSession`.
5. Both peers obtain short-lived TURN configuration from the callable function.
6. The web client creates an offer and appends it to `signals`.
7. Electron main validates the offer, sets it as remote description, creates an answer, and appends the answer.
8. Both peers append trickled ICE candidates and deduplicate received candidates.
9. The WebRTC connection opens `codra.control.v1` and `codra.terminal.v1` DataChannels.
10. The protocol handshake binds the channel to `sessionId`, `requestNonce`, and protocol version 1.
11. The session becomes `connected`; signaling listeners remain only for ICE restart or closure state.
12. Closing either endpoint closes channels, marks the session closed, requests TURN revocation, and deletes current signals best-effort.

## Remote Protocol

### Control channel: `codra.control.v1`

The control channel is reliable and ordered. It uses UTF-8 JSON messages validated with Zod. Every request includes `requestId`; every response includes the same ID. Supported message types are:

```text
hello
hello_ack
terminal.list
terminal.create
terminal.attach
terminal.detach
terminal.input
terminal.resize
terminal.ack
session.ping
session.pong
error
```

Electron main rejects unknown message types, unsupported protocol versions, duplicate request IDs with conflicting bodies, oversized messages, terminal IDs outside the session, and operations outside approved scopes.

### Terminal channel: `codra.terminal.v1`

The terminal channel is reliable and ordered. It carries binary output frames so ANSI data does not require JSON escaping. A frame contains:

```text
protocol version
terminal ID
monotonic output sequence
scrollback byte cursor
payload length
payload bytes
```

Output is chunked at 16 KiB. Input remains on the control channel so output congestion cannot delay keystrokes, resize operations, ping/pong, or detach requests.

## PTY and Scrollback Behavior

Electron main owns every PTY. A terminal record contains its ID, display title, shell command, working directory display value, dimensions, process state, and current scrollback cursor. Raw credentials and environment values are never returned.

Terminal output is appended to a local bounded scrollback file before it is offered to remote clients. Each attachment tracks its last acknowledged cursor. When a browser reconnects, it requests `terminal.attach` with the last durable cursor and receives missing chunks before live output resumes.

When `bufferedAmount` exceeds 1 MiB, Electron main stops enqueueing live terminal frames for that attachment while continuing to persist output locally. Sending resumes below 256 KiB from the last acknowledged cursor. A slow browser therefore catches up without blocking the PTY or the control channel.

Electron main validates resize values within 20–400 columns and 5–200 rows. A single input message is limited to 64 KiB and per-session input is rate-limited to protect the application from accidental floods.

## Connection Recovery

- WebRTC negotiation has a 20-second deadline.
- One ICE restart is attempted for `disconnected`; persistent `failed` creates a fresh peer connection and fresh signaling sequence.
- Signal documents are deduplicated by sender and sequence.
- A five-second ping runs while connected; three missed pongs mark the transport disconnected.
- The browser retains its acknowledged terminal cursor in IndexedDB.
- A reconnect within the eight-hour lease reuses the remote session only if the host is still online and approved; otherwise the user requests a new session.
- Authentication expiry triggers Firebase token refresh before a new signaling write or TURN request.
- A failed Firestore listener resumes from current session state and ignores already processed signals.

## Error Handling

Errors use stable codes rather than raw dependency messages:

```text
AUTH_REQUIRED
APP_CHECK_REQUIRED
HOST_OFFLINE
SESSION_NOT_FOUND
SESSION_NOT_APPROVED
SESSION_EXPIRED
PROTOCOL_MISMATCH
SIGNAL_INVALID
TURN_UNAVAILABLE
ICE_TIMEOUT
ICE_FAILED
CHANNEL_CLOSED
TERMINAL_NOT_FOUND
SCOPE_DENIED
RATE_LIMITED
INTERNAL_ERROR
```

Client-facing errors contain a safe message and retryability flag. Firebase, Cloudflare, SDP, native library, filesystem, and PTY errors are logged locally with secrets, SDP bodies, ICE credentials, terminal content, and authorization headers redacted.

## Privacy and Retention

- Firestore stores account-scoped device metadata, session metadata, SDP, and ICE candidates.
- SDP and ICE candidates may contain network addresses, so signals expire after one hour and are deleted on session close where possible.
- Terminal input/output and scrollback remain on the host only.
- Local scrollback defaults to a bounded 10 MiB file per terminal and is deleted when the terminal is explicitly removed.
- Cloud analytics receive only aggregate connection outcome, duration, selected candidate type, and error code when analytics are enabled.
- No telemetry event includes UID, device name, repository path, terminal title, commands, output, SDP, candidates, or TURN username.

## Testing Strategy

### Unit tests

- Cloudflare response validation and browser/Electron ICE normalization
- TURN URL mapping for UDP, TCP, and TLS
- Protocol schema acceptance and rejection
- Terminal binary frame encode/decode
- Signal and request deduplication
- Session state transitions
- Backpressure thresholds and cursor replay

### Firebase Emulator tests

- Authenticated user access to their devices, sessions, and signals
- Cross-user reads and writes denied
- Immutable ownership and participant fields
- Invalid status transitions denied
- Expired session signal writes denied
- Unknown fields, oversized SDP, and oversized candidates denied
- Callable function auth, App Check, ownership, expiry, and rate-limit behavior
- Cloudflare HTTP calls mocked without production credentials

### Integration tests

- Electron main exposes only the approved preload operations to the sandboxed renderer
- Electron creates, renders, writes to, resizes, detaches from, and reattaches to a main-process PTY without Firebase
- Closing and reopening the Electron window preserves the main process, PTY, terminal list, and scrollback
- Local terminal startup still succeeds when Firebase endpoints are unavailable
- Browser `RTCPeerConnection` interoperates with `node-datachannel`
- Offer, answer, and trickled candidates traverse Firestore Emulator
- Terminal creation, output, input, resize, detach, and reattach
- Ten MiB output burst does not delay control responses beyond one second
- Browser disconnect followed by cursor-based catch-up has no duplicated bytes
- Closing the Electron window while leaving the app running keeps the terminal remotely available

### Hosted smoke tests

- Auth and App Check against the deployed Firebase project
- Direct connection on an unrestricted network
- Forced `relay` connection through Cloudflare TURN
- TURN UDP, TCP, and TLS candidate paths
- Normal session closure invokes revocation
- No production secret appears in built JavaScript, packaged Electron resources, logs, or Git history

The real TURN smoke suite is opt-in and uses Secret Manager. It is not run for untrusted pull requests.

## Deployment Shape

- The first distributable is one signed macOS Electron application with no separately installed daemon or background service.
- Local terminal features have no runtime dependency on Firebase or Cloudflare.
- Firebase Hosting serves `apps/web`.
- Firebase Functions 2nd gen run in `asia-northeast3`.
- Firestore rules, indexes, and TTL policies deploy from the repository.
- `CLOUDFLARE_TURN_CONFIG` is configured interactively through Firebase CLI after the exposed token is rotated.
- Development uses Firebase Emulator Suite and fake TURN responses by default.

## Delivery Milestones

1. **Greenfield foundation:** pnpm monorepo, TypeScript, linting, testing, CI, shared schemas, Electron build pipeline.
2. **Standalone desktop shell:** Electron main/renderer split, context isolation, sandboxing, secure versioned preload bridge.
3. **Local terminal core:** main-process `node-pty`, terminal registry, Electron xterm.js, input, resize, detach, bounded scrollback.
4. **Desktop lifecycle:** window-close persistence in Electron main, reopen/reattach, quit warning, macOS development packaging.
5. **Identity and devices:** opt-in host/web sign-in, host key registration, heartbeat, host list, rules tests.
6. **TURN boundary:** authenticated issue/revoke functions, Secret Manager binding, Cloudflare adapter tests.
7. **Transport proof:** Firestore signaling and browser-to-`node-datachannel` DataChannel with direct and relay smoke tests.
8. **Remote terminal:** restricted protocol routing, web xterm.js attach/input/resize, acknowledgements, backpressure.
9. **Recovery and hardening:** reconnect, cursor replay, cleanup, App Check enforcement, production packaging, privacy checks.

Each milestone must produce a separately testable result. Full CODRA Task and agent-control features begin only after this remote terminal foundation passes its acceptance criteria.

## Acceptance Criteria

1. CODRA launches as a standalone Electron application on macOS without requiring login.
2. With Firebase and Cloudflare unavailable, Electron can still create and operate a local shell in its main process.
3. The Electron terminal supports ANSI rendering, input, resize, detach, and reattach.
4. Closing the Electron window does not terminate the Electron main process or its PTYs; reopening restores the terminal list and scrollback, while explicitly quitting CODRA ends them after a warning.
5. Remote access is disabled by default and can be enabled without changing local terminal behavior.
6. A user can sign in on the host Mac and in a supported desktop browser with the same Firebase account.
7. The browser displays the installed CODRA host as online within 60 seconds and offline within 120 seconds of heartbeat loss.
8. A new browser cannot connect until the selected host signs and approves its session request; another same-account browser cannot forge that approval.
9. The same web client connects over direct ICE when possible and over forced Cloudflare TURN in the relay smoke test.
10. The web client can list, create, attach to, type into, and resize a PTY owned by the selected Electron host.
11. Reconnecting after a temporary disconnect restores output from the last acknowledged cursor without duplicated terminal bytes.
12. A ten MiB output burst does not freeze local or remote input, resize, ping, or detach handling.
13. Cross-user Firestore access, forged host approvals, and unauthorized TURN issuance are denied by automated tests.
14. Firestore contains no terminal input, terminal output, prompt, file content, or scrollback.
15. Client artifacts and Git history contain no Cloudflare API token, Firebase Admin key, TURN password, or service-account key.
16. Normal session closure requests credential revocation and expired sessions reject new signals.
17. Unit, emulator, integration, standalone desktop build, and web production-build checks pass in CI; real TURN smoke checks pass in the trusted deployment environment.

## Follow-on Work

After this design is implemented, the same authenticated WebRTC transport can carry read-only Task snapshots, agent status events, `Needs You` responses, and validation summaries. Those capabilities will use new versioned remote methods rather than exposing Electron main's full local IPC surface. Cross-user teams, hardware-backed device attestation, mobile clients, file transfer, and remote browser views require separate designs.
