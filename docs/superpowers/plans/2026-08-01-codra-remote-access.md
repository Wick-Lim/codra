# CODRA Firebase/WebRTC Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in remote terminal access to the already verified CODRA Electron host so an authenticated browser can select, locally approve, and control that host over a direct or Cloudflare TURN-relayed WebRTC connection without putting terminal traffic in Firebase.

**Architecture:** Electron main remains the only PTY and host WebRTC owner. Firebase Authentication identifies one account, Firestore carries short-lived device/session/SDP/ICE control-plane records, Firebase Functions verify the Keychain-backed host signature and issue/revoke TURN credentials, and two ordered reliable DataChannels carry control JSON and binary terminal output. The standalone terminal bootstrap does not initialize or wait for Firebase; all remote services are created lazily after the user enables remote access.

**Tech Stack:** Existing Node.js 22.22+, pnpm 11.5.2, Electron 43.2.0 (including main-process async `safeStorage`), React 19.2.8, TypeScript 5.9.3, Vitest 4.1.10, Playwright 1.62.1, Zod 4.4.3, node-pty 1.1.0, xterm.js 6.0.0; add Firebase JS SDK 12.17.0, Firebase Admin 14.2.0, Firebase Functions 7.3.2, Firebase CLI 15.25.1, `@firebase/rules-unit-testing` 5.0.1, and `node-datachannel` 0.32.3.

## Global Constraints

- This plan starts only after the standalone completion gate in `docs/superpowers/plans/2026-08-01-codra-standalone-electron.md` passes from fresh macOS output.
- Remote access is disabled by default. Enabling, disabling, authentication failure, Firestore failure, or TURN failure must never prevent local terminal creation, input, output, resize, replay, window reopen, or Quit.
- Electron main owns `node-datachannel`, Firebase host auth state, the P-256 private key, session authorization, all PTYs, and every remote connection. No daemon, launch agent, background service, hidden renderer, or browser-hosted shell is added.
- The renderer remains `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`; only versioned Zod-validated methods and events are added to `window.codra`.
- The web application is a remote client only. It cannot create a local shell except by sending an approved protocol request to the selected running Electron host.
- Firestore is signaling and metadata only. Terminal input, output, commands, prompts, environment values, repository content, file content, and scrollback must never be written to Firebase or Functions logs.
- User records remain below `users/{uid}`. `serverTurnIssuances` and `serverTurnRateLimits` are Admin-only collections denied to every client.
- Host identity uses ECDSA P-256/SHA-256. Electron main encrypts the private JWK with async `safeStorage`, whose macOS encryption key is held in Keychain Access, and writes only ciphertext to a mode `0600` local file. The private JWK never enters preload, renderer state, Firestore, WebRTC, test snapshots, or logs.
- Before Firestore App Check enforcement, Electron main installs a Firebase custom App Check provider. Its one-hour token is minted only after a callable verifies Auth plus a fresh registered-host signature; this is software key possession, not binary or hardware attestation.
- A remote session lease is exactly eight hours; signaling records expire after one hour; a host heartbeat is sent every 30 seconds; a host is considered stale after 90 seconds; the UI must show it offline no later than 120 seconds after heartbeat loss.
- WebRTC negotiation has a 20-second deadline. Connected peers ping every five seconds; three missed pongs mark the transport disconnected. One ICE restart is attempted before building a fresh peer connection.
- Cloudflare credentials use `ttl: 86400`. A reconnect requests new credentials; credentials are not mutated in-place in this slice.
- The Cloudflare long-lived configuration exists only as the `CLOUDFLARE_TURN_CONFIG` structured Firebase secret bound to the two TURN functions. The previously exposed bearer value must be rotated and must never be copied into source, committed env files, fixtures, logs, build artifacts, commands, or this plan.
- Cloudflare calls time out after five seconds and retry exactly once only for a network error or HTTP 5xx. HTTP 4xx is never retried. Authorization headers and returned usernames/passwords are always redacted.
- Browser ICE configuration removes every port 53 URL. Electron maps TURN UDP, TCP, and TLS URLs to `node-datachannel` `TurnUdp`, `TurnTcp`, and `TurnTls` entries.
- The two channel labels are exactly `codra.control.v1` and `codra.terminal.v1`; both are reliable and ordered. Control messages are bounded UTF-8 JSON; output frames are binary and payloads are at most 16 KiB.
- Per attachment, live output pauses above 1 MiB `bufferedAmount` and catch-up resumes below 256 KiB from the last acknowledged durable cursor. Control traffic remains on the separate control channel.
- Terminal sizes remain 20–400 columns and 5–200 rows; one input message remains at most 64 KiB.
- Firebase Functions 2nd gen deploy to `asia-northeast3`. Web production App Check uses reCAPTCHA Enterprise; development against real Firebase uses only a registered debug token, while emulator CI uses the Task 10 triple-guarded inert port.
- Production source files should remain focused; split a file before it exceeds roughly 250 lines of implementation.
- Every behavior change follows red-green-refactor, every task ends in a focused commit, and Critical/Important review findings are fixed before a dependent lane proceeds.

## External Contract References

- Cloudflare credential generation and revocation contract: `https://developers.cloudflare.com/realtime/turn/generate-credentials/`
- Cloudflare TURN endpoints and ports: `https://developers.cloudflare.com/realtime/turn/`
- Firebase callable/App Check behavior: `https://firebase.google.com/docs/app-check/cloud-functions`
- Firebase custom App Check provider/token minting: `https://firebase.google.com/docs/app-check/custom-provider`
- Firestore Rules emulator testing: `https://firebase.google.com/docs/firestore/security/test-rules-emulator`
- `node-datachannel` peer/channel API: `https://github.com/murat-dogan/node-datachannel/blob/v0.32.3/API.md`
- Electron async safe storage and macOS Keychain semantics: `https://www.electronjs.org/docs/latest/api/safe-storage`

## Dependency and Parallelization Map

```text
Standalone Electron completion gate
                 │
       ┌─────────┴─────────┐
       ↓                   ↓
Task 1 protocol       Task 2 Firebase/rules
and durable cursor          │
       │                    ↓
       │              Task 3 typed control plane
       │                    │
       ├──────────────┬─────┴──────────────┐
       ↓              ↓                    ↓
Task 6 shared    Task 4 identity/      Task 9 web shell can
WebRTC core      approval Functions     begin after 3 + 6
       │              │
       │              ├─────────────┐
       │              ↓             ↓
       │         Task 5 TURN     Task 7 desktop
       │         Functions       identity/approval
       │                            │
       └────────────────────────────┤
                                    ↓
                              Task 8 host peer
                                    │
                         Task 9 web peer/UI
                                    │
             ┌──────────────────────┴──────────────────────┐
             ↓                                             ↓
      Task 10 direct ICE                           Task 11 recovery/
      emulator convergence                         backpressure hardening
             └──────────────────────┬──────────────────────┘
                                    ↓
                    Task 12 forced TURN + release gate
```

After Tasks 1 and 2 are reviewed, Task 6 may run alongside the Firebase lane (Tasks 3–5). After Tasks 3, 4, and 6 freeze their public interfaces, the desktop lane (Tasks 7–8) and web lane (Task 9) run concurrently because they edit disjoint applications. Task 10 is the first convergence point and must prove a real browser-to-`node-datachannel` direct connection through the Firebase Emulator Suite. Tasks 11 and 12 are the recovery and trusted relay convergence gates; neither lane is declared complete before both pass.

## Planned File Structure

```text
codra/
├─ firebase.json                         emulator, Firestore, Functions, Hosting configuration
├─ .firebaserc                           project aliases (`default` and `demo` only; no credentials)
├─ firestore.rules                       account ownership, immutable fields, bounded signal rules
├─ firestore.indexes.json                bounded host/session/signaling queries
├─ package.json                          Firebase, remote E2E, and trusted smoke scripts
├─ pnpm-workspace.yaml                   add `functions`
├─ packages/
│  ├─ protocol/
│  │  ├─ src/remote.ts                   device/session/signal/control schemas and error codes
│  │  ├─ src/terminal-frame.ts           37-byte binary output-frame codec
│  │  └─ test/remote.test.ts             schema, canonical payload, and frame boundary tests
│  ├─ firebase/
│  │  ├─ src/config.ts                   explicit client config and emulator wiring
│  │  ├─ src/refs.ts                     validated typed document references/converters
│  │  ├─ src/functions.ts                typed callable client facade
│  │  ├─ src/devices.ts                  web device and host-presence subscriptions
│  │  ├─ src/sessions.ts                 session creation/state transition facade
│  │  ├─ src/signals.ts                  append/listen/deduplicate/cleanup signaling
│  │  └─ test/                            unit and Firestore Rules emulator tests
│  └─ webrtc/
│     ├─ src/ice.ts                       browser and node-datachannel ICE normalization
│     ├─ src/deduplicator.ts              sender/sequence and request-ID replay protection
│     ├─ src/deadline.ts                  negotiation, ping, and retry clocks
│     ├─ src/channel.ts                   transport-neutral ordered-channel interfaces
│     ├─ src/attachment-pump.ts           1 MiB/256 KiB cursor-based output pump
│     └─ test/                             normalization, timeout, and backpressure tests
├─ functions/
│  ├─ src/index.ts                        exported 2nd-gen callable functions
│  ├─ src/auth.ts                         callable auth/App Check guards and safe errors
│  ├─ src/host-signatures.ts              canonical payloads and P-256 verification
│  ├─ src/app-check.ts                    signed desktop custom App Check token minting
│  ├─ src/devices.ts                      register and heartbeat host functions
│  ├─ src/sessions.ts                     signed approve/reject transaction
│  ├─ src/cloudflare-turn.ts              timeout/retry/validation HTTP adapter
│  ├─ src/turn.ts                         authorize, rate-limit, issue, hash, and revoke
│  └─ test/                               dependency-injected function unit tests
├─ apps/
│  ├─ desktop/src/
│  │  ├─ main/remote/                     opt-in controller, safeStorage identity, Firebase, peer, gateway
│  │  ├─ main/bootstrap.ts                compose remote controller without blocking local startup
│  │  ├─ main/lifecycle.ts                warn/close remote peers on explicit Quit
│  │  ├─ main/ipc/remote-ipc.ts           validated renderer settings and approval bridge
│  │  ├─ preload/desktop-api.ts            expose only declared remote methods/events
│  │  └─ renderer/src/remote/              sign-in, enablement, presence, approval UI
│  └─ web/
│     ├─ src/auth/                         Firebase Auth and App Check UI
│     ├─ src/remote/                       hosts, sessions, browser peer, cursor store
│     ├─ src/terminal/                     xterm remote terminal surface
│     └─ test/                             jsdom/browser-facing unit tests
├─ tests/e2e/
│  ├─ remote-direct.spec.ts               emulator-backed direct ICE browser/Electron proof
│  ├─ remote-reconnect.spec.ts            cursor catch-up and burst responsiveness
│  └─ remote-turn.spec.ts                 trusted hosted relay-only proof
└─ scripts/
   ├─ run-remote-e2e.mjs                  isolated emulator/build/Playwright orchestration
   ├─ run-turn-smoke.mjs                  required-env guard for trusted smoke
   └─ scan-client-artifacts.mjs            deny long-lived secrets and terminal data patterns
```

---

### Task 1: Freeze Remote Protocol and Add Durable Output Cursors

**Files:**

- Create: `packages/protocol/src/remote.ts`
- Create: `packages/protocol/src/terminal-frame.ts`
- Create: `packages/protocol/test/remote.test.ts`
- Modify: `packages/protocol/src/terminal.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/desktop/src/main/terminal/contracts.ts`
- Modify: `apps/desktop/src/main/terminal/scrollback.ts`
- Modify: `apps/desktop/src/main/terminal/scrollback.test.ts`
- Modify: `apps/desktop/src/main/terminal/manager.ts`
- Modify: `apps/desktop/src/main/terminal/manager.test.ts`

**Interfaces:**

- Consumes: existing `TerminalDescriptor`, create/write/resize schemas, monotonically increasing local output `sequence`, and 10 MiB bounded JSONL scrollback.
- Produces: `RemoteDeviceSchema`, `RemoteSessionSchema`, `SignalSchema`, `RemoteControlMessageSchema`, canonical signing payload helpers, `encodeTerminalFrame(frame): Uint8Array`, `decodeTerminalFrame(bytes): TerminalFrame`, and `TerminalManager.readFromCursor(terminalId, afterCursor, maxBytes): Promise<TerminalCursorPage>`.

- [ ] **Step 1: Write failing protocol and cursor tests**

Add exact tests for an eight-hour requested session, all four signal kinds, unknown-field rejection, a 16 KiB frame, an oversized frame, and UTF-8 cursor stability:

```ts
it("round-trips a terminal frame without changing UTF-8 byte cursors", () => {
  const payload = new TextEncoder().encode("한글\r\n");
  const encoded = encodeTerminalFrame({
    protocolVersion: 1,
    terminalId: "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5",
    sequence: 7n,
    cursor: BigInt(payload.byteLength),
    payload,
  });

  expect(encoded.byteLength).toBe(37 + payload.byteLength);
  expect(decodeTerminalFrame(encoded)).toEqual({
    protocolVersion: 1,
    terminalId: "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5",
    sequence: 7n,
    cursor: BigInt(payload.byteLength),
    payload,
  });
});

it("keeps an absolute cursor when compaction removes older records", async () => {
  const store = new FileTerminalOutputStore(await rootDirectory(), 96);
  const first = await store.append(terminalId, "가".repeat(12));
  const second = await store.append(terminalId, "나".repeat(12));
  const third = await store.append(terminalId, "다".repeat(12));

  expect(first.endCursor).toBe(Buffer.byteLength(first.data));
  expect(second.startCursor).toBe(first.endCursor);
  expect(third.startCursor).toBe(second.endCursor);
  const page = await store.readFromCursor(terminalId, second.endCursor, 16_384);
  expect(page.chunks.map((chunk) => chunk.data)).toEqual([third.data]);
  expect(page.latestCursor).toBe(third.endCursor);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @codra/protocol test -- test/remote.test.ts && pnpm --filter @codra/desktop test -- src/main/terminal/scrollback.test.ts`

Expected: FAIL because the remote schemas, frame codec, cursor fields, and `readFromCursor` do not exist.

- [ ] **Step 3: Define exact remote documents, control messages, and errors**

In `remote.ts`, use strict Zod objects and export these stable shapes:

```ts
export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_SESSION_LEASE_MS = 8 * 60 * 60 * 1_000;
export const SIGNAL_LEASE_MS = 60 * 60 * 1_000;
export const RemoteScopeSchema = z.enum(["terminal:read", "terminal:write"]);
export const RemoteSessionStatusSchema = z.enum([
  "requested",
  "approved",
  "rejected",
  "signaling",
  "connected",
  "disconnected",
  "closed",
  "expired",
  "failed",
]);
export const RemoteErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "APP_CHECK_REQUIRED",
  "HOST_OFFLINE",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_APPROVED",
  "SESSION_EXPIRED",
  "PROTOCOL_MISMATCH",
  "SIGNAL_INVALID",
  "TURN_UNAVAILABLE",
  "ICE_TIMEOUT",
  "ICE_FAILED",
  "CHANNEL_CLOSED",
  "TERMINAL_NOT_FOUND",
  "SCOPE_DENIED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export type RemoteScope = z.infer<typeof RemoteScopeSchema>;
export type RemoteSessionStatus = z.infer<typeof RemoteSessionStatusSchema>;

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  use?: "sig";
  alg?: "ES256";
}

export interface RemoteDevice {
  id: string;
  kind: "host" | "web";
  name: string;
  platform: "macos" | "web";
  appVersion: string;
  protocolVersions: number[];
  publicKeyJwk?: P256PublicJwk;
  keyFingerprint?: string;
  status: "online" | "offline";
  createdAtMillis: number;
  lastSeenAtMillis: number;
  expiresAtMillis: number;
}

export interface RemoteSession {
  id: string;
  ownerUid: string;
  hostDeviceId: string;
  clientDeviceId: string;
  status: RemoteSessionStatus;
  protocolVersion: 1;
  requestedScopes: RemoteScope[];
  approvedScopes: RemoteScope[];
  requestNonce: string;
  approvalSignature?: string;
  createdAtMillis: number;
  approvedAtMillis?: number;
  connectedAtMillis?: number;
  closedAtMillis?: number;
  expiresAtMillis: number;
  failureCode?: z.infer<typeof RemoteErrorCodeSchema>;
}

export interface IceServerDto {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface SignalBase {
  id: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  sequence: number;
  createdAtMillis: number;
  expiresAtMillis: number;
}
export type RemoteSignal =
  | (SignalBase & {
      kind: "offer";
      payload: { type: "offer"; sdp: string };
    })
  | (SignalBase & {
      kind: "answer";
      payload: { type: "answer"; sdp: string };
    })
  | (SignalBase & {
      kind: "candidate";
      payload: {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
        usernameFragment?: string;
      };
    })
  | (SignalBase & { kind: "end-of-candidates"; payload: Record<never, never> });

export interface ApprovalPayload {
  sessionId: string;
  requestNonce: string;
  decision: "approved" | "rejected";
  approvedScopes: RemoteScope[];
  expiresAtMillis: number;
}

export interface TurnProofPayload {
  sessionId: string;
  deviceId: string;
  requestNonce: string;
  issuedAtMinute: number;
}

export interface RegisterHostDeviceRequest {
  name: string;
  appVersion: string;
  protocolVersions: [1];
  publicKeyJwk: P256PublicJwk;
}
export interface RegisterHostDeviceResult {
  device: RemoteDevice;
}
export interface HeartbeatHostDeviceRequest {
  deviceId: string;
  issuedAtMinute: number;
  signature: string;
}
export type IssueHostAppCheckTokenRequest = HeartbeatHostDeviceRequest;
export interface ApproveRemoteSessionRequest extends ApprovalPayload {
  hostDeviceId: string;
  signature: string;
}
export interface IssueTurnCredentialsRequest {
  sessionId: string;
  deviceId: string;
  hostProof?: { issuedAtMinute: number; signature: string };
}
export interface IssueTurnCredentialsResult {
  iceServers: IceServerDto[];
  expiresAtMillis: number;
}
export interface RevokeTurnCredentialsRequest extends IssueTurnCredentialsRequest {
  username: string;
}
export interface RemoteApprovalRequest {
  sessionId: string;
  requestNonce: string;
  clientDeviceId: string;
  clientDeviceName: string;
  requestedScopes: RemoteScope[];
  expiresAtMillis: number;
}

export type RemoteControlMessage =
  | {
      type: "hello";
      sessionId: string;
      requestNonce: string;
      protocolVersion: 1;
    }
  | { type: "hello_ack"; sessionId: string; protocolVersion: 1 }
  | { type: "terminal.list"; phase: "request"; requestId: string }
  | {
      type: "terminal.list";
      phase: "result";
      requestId: string;
      terminals: TerminalDescriptor[];
    }
  | {
      type: "terminal.create";
      phase: "request";
      requestId: string;
      cols: number;
      rows: number;
      cwd?: string;
    }
  | {
      type: "terminal.create";
      phase: "result";
      requestId: string;
      terminal: TerminalDescriptor;
    }
  | {
      type: "terminal.attach";
      phase: "request";
      requestId: string;
      terminalId: string;
      afterCursor: number;
    }
  | {
      type: "terminal.attach";
      phase: "result";
      requestId: string;
      terminalId: string;
      availableFromCursor: number;
      latestCursor: number;
      resetRequired: boolean;
    }
  | {
      type: "terminal.detach";
      phase: "request";
      requestId: string;
      terminalId: string;
    }
  | {
      type: "terminal.input";
      phase: "request";
      requestId: string;
      terminalId: string;
      data: string;
    }
  | {
      type: "terminal.resize";
      phase: "request";
      requestId: string;
      terminalId: string;
      cols: number;
      rows: number;
    }
  | {
      type: "terminal.ack";
      phase: "request";
      requestId: string;
      terminalId: string;
      cursor: number;
    }
  | {
      type: "terminal.ack";
      phase: "result";
      requestId: string;
      operation: "detach" | "input" | "resize";
    }
  | { type: "session.ping"; pingId: string }
  | { type: "session.pong"; pingId: string }
  | {
      type: "error";
      requestId?: string;
      code: z.infer<typeof RemoteErrorCodeSchema>;
      message: string;
      retryable: boolean;
    };
```

Model signals as a strict discriminated union, with SDP strings capped at 65,536 characters and ICE candidate strings capped at 4,096 characters. Model control requests/results with the documented message names and `phase: "request" | "result"`; every request/result carries the same UUID `requestId`. `hello` and `hello_ack` bind `sessionId`, `requestNonce`, and protocol version. `terminal.attach` results carry `availableFromCursor`, `latestCursor`, and `resetRequired`; `terminal.ack` carries the last durably rendered cursor.

Export exact newline canonicalizers:

```ts
export const canonicalApproval = (value: ApprovalPayload): string =>
  [
    "codra.remote-approval.v1",
    value.sessionId,
    value.requestNonce,
    value.decision,
    [...value.approvedScopes].sort().join(","),
    String(value.expiresAtMillis),
  ].join("\n");

export const canonicalHeartbeat = (
  deviceId: string,
  issuedAtMinute: number,
): string =>
  ["codra.host-heartbeat.v1", deviceId, String(issuedAtMinute)].join("\n");

export const canonicalTurnProof = (value: TurnProofPayload): string =>
  [
    "codra.turn-issuance.v1",
    value.sessionId,
    value.deviceId,
    value.requestNonce,
    String(value.issuedAtMinute),
  ].join("\n");

export const canonicalHostAppCheckProof = (
  deviceId: string,
  issuedAtMinute: number,
): string =>
  ["codra.host-app-check.v1", deviceId, String(issuedAtMinute)].join("\n");
```

- [ ] **Step 4: Implement the 37-byte binary frame codec**

Use a one-byte protocol version, 16 raw UUID bytes, unsigned big-endian 64-bit sequence, unsigned big-endian 64-bit end cursor, and unsigned big-endian 32-bit payload length. Reject wrong version, zero sequence, negative/unsafe application conversions, length mismatch, and payloads over 16,384 bytes. Never decode terminal payload bytes as JSON.

```ts
export interface TerminalFrame {
  protocolVersion: 1;
  terminalId: string;
  sequence: bigint;
  cursor: bigint;
  payload: Uint8Array;
}

export const TERMINAL_FRAME_HEADER_BYTES = 37;
export const TERMINAL_FRAME_MAX_PAYLOAD_BYTES = 16 * 1024;
```

- [ ] **Step 5: Extend scrollback records with absolute UTF-8 byte cursors**

Persist `startCursor` and `endCursor` on each JSONL record. Compute the next cursor from the last complete record, not the current compacted file offset. Keep local `readAfter` behavior unchanged and add:

```ts
export interface TerminalCursorPage {
  chunks: TerminalOutputChunk[];
  availableFromCursor: number;
  latestCursor: number;
  resetRequired: boolean;
}

export interface TerminalOutputChunk {
  terminalId: string;
  sequence: number;
  startCursor: number;
  endCursor: number;
  data: string;
}

export interface TerminalOutputStore {
  append(terminalId: string, data: string): Promise<TerminalOutputChunk>;
  readAfter(
    terminalId: string,
    afterSequence: number,
    limit: number,
  ): Promise<TerminalOutputChunk[]>;
  readFromCursor(
    terminalId: string,
    afterCursor: number,
    maxBytes: number,
  ): Promise<TerminalCursorPage>;
  remove(terminalId: string): Promise<void>;
}
```

On first read of a pre-remote JSONL file, migrate legacy `{ sequence, data }` records once by assigning contiguous cursors from zero and atomically replacing the file; no remote acknowledgement can exist before this migration. Split PTY strings into UTF-8-safe chunks of at most 16 KiB before append so each stored sequence maps to exactly one binary frame and no code point is split.

`readFromCursor` returns complete records without exceeding `maxBytes`, except that one record may be returned when it alone fits the 16 KiB protocol payload cap. If compaction removed the requested cursor, set `resetRequired: true`, start at the oldest retained record, and expose its `startCursor` as `availableFromCursor`.

- [ ] **Step 6: Expose cursor replay through `TerminalManager` and preserve existing callers**

Add a public `readFromCursor` delegating to the output store after verifying the terminal exists. Update every `TerminalOutputChunk` fixture with cursor fields and keep `replay()` sequence semantics used by the local renderer unchanged.

- [ ] **Step 7: Run protocol, desktop, type, and format checks**

Run: `pnpm --filter @codra/protocol test && pnpm --filter @codra/desktop test && pnpm typecheck && pnpm format:check`

Expected: all existing standalone tests plus the new remote/cursor tests pass with no type or formatting errors.

- [ ] **Step 8: Commit the frozen protocol**

```bash
git add packages/protocol apps/desktop/src/main/terminal
git commit -m "feat: define remote terminal protocol"
```

---

### Task 2: Add Firebase Workspace, Emulator, Rules, Indexes, and TTL Contract

**Files:**

- Create: `firebase.json`
- Create: `.firebaserc`
- Create: `firestore.rules`
- Create: `firestore.indexes.json`
- Create: `packages/firebase/package.json`
- Create: `packages/firebase/tsconfig.json`
- Create: `packages/firebase/src/config.ts`
- Create: `packages/firebase/src/refs.ts`
- Create: `packages/firebase/src/index.ts`
- Create: `packages/firebase/test/rules.test.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Task 1 document schemas and the approved public Firebase client configuration in the design document.
- Produces: two-phase `createFirebaseBootstrap(options): FirebaseBootstrap` then `createProtectedFirebaseClient(bootstrap, appCheck): FirebaseClient`, strict Firestore converters/references, emulator commands, deny-by-default Rules, required indexes, and TTL deployment commands for `expiresAt`.

- [ ] **Step 1: Add pinned Firebase packages and deterministic emulator scripts**

Create private workspace package `@codra/firebase` with `firebase: 12.17.0`, `@codra/protocol: workspace:*`, and test dependencies `@firebase/rules-unit-testing: 5.0.1` and Vitest 4.1.10. Add root dev dependency `firebase-tools: 15.25.1`. Add `functions` to workspace membership now so Task 4 does not alter workspace topology.

Use these root scripts:

```json
{
  "firebase:emulators": "firebase emulators:start --project demo-codra",
  "test:rules": "firebase emulators:exec --project demo-codra --only firestore \"pnpm --filter @codra/firebase test:rules\"",
  "deploy:firebase:control": "firebase deploy --only firestore:rules,firestore:indexes,functions,hosting"
}
```

Set `.firebaserc` to `{"projects":{"default":"codra-1b3bb","demo":"demo-codra"}}`; project aliases are public routing metadata and contain no credential.

Copy the approved public Firebase Web client object once from the design's `Firebase Client Configuration` section into `config.ts`; do not copy any Cloudflare value. `createFirebaseBootstrap` accepts `{ useEmulators: boolean }`, initializes only App/Auth/Functions, and connects Auth/Functions emulators only when true. After web reCAPTCHA Enterprise or desktop custom App Check is installed, `createProtectedFirebaseClient` creates Firestore and connects its emulator when requested. Reference converters map Firestore `Timestamp` fields (`createdAt`, `lastSeenAt`, `expiresAt`, and session/signal variants) to the protocol's `*Millis` domain fields and convert writes back to server timestamps. No Firestore read/listener may occur between those phases, and this package exports no Admin SDK.

- [ ] **Step 2: Write failing Firestore Rules tests**

Use `initializeTestEnvironment({ projectId: "demo-codra", firestore: { rules } })`. Seed parent documents only through `testEnv.withSecurityRulesDisabled`. Test at least this exact matrix:

```ts
it("denies cross-user sessions and expired signal writes", async () => {
  const alice = testEnv.authenticatedContext("alice").firestore();
  const bob = testEnv.authenticatedContext("bob").firestore();

  await assertFails(getDoc(doc(bob, "users/alice/remoteSessions/session-a")));
  await assertFails(
    setDoc(
      doc(alice, "users/alice/remoteSessions/session-a/signals/signal-a"),
      validCandidate({ expiresAt: Timestamp.fromMillis(Date.now() - 1) }),
    ),
  );
});

it("rejects host mutation, ownership changes, unknown fields, and oversized SDP", async () => {
  const alice = testEnv.authenticatedContext("alice").firestore();
  await assertFails(
    setDoc(doc(alice, "users/alice/devices/host-a"), validHost()),
  );
  await assertFails(
    updateDoc(doc(alice, "users/alice/remoteSessions/session-a"), {
      ownerUid: "bob",
    }),
  );
  await assertFails(
    updateDoc(doc(alice, "users/alice/remoteSessions/session-a"), {
      unexpected: true,
    }),
  );
  await assertFails(
    setDoc(
      doc(alice, "users/alice/remoteSessions/session-a/signals/large"),
      validOffer({ sdp: "x".repeat(65_537) }),
    ),
  );
});
```

Also prove: unauthenticated access denied; same-owner bounded host query allowed; web-device create/update allowed with immutable ID/kind/createdAt; client host create/update denied; only `requested` session creation allowed; client approval/rejection denied; valid client status transitions allowed; invalid transitions denied; append-only signal update denied; candidate over 4,096 characters denied; participant cleanup delete allowed; `serverTurnIssuances` and `serverTurnRateLimits` denied for all clients.

- [ ] **Step 3: Run Rules tests and verify RED**

Run: `pnpm install && pnpm test:rules`

Expected: FAIL because `firestore.rules` and the strict reference package do not exist.

- [ ] **Step 4: Implement deny-by-default Rules with exact ownership and shape checks**

Rules use reusable ownership, transition, and payload predicates plus inline exact field/type checks. The final catch-all remains `allow read, write: if false`.

Use client-writable boundaries:

```text
users/{uid}/devices/{deviceId}
  read: same uid with bounded owner-path query
  create/update: same uid, kind == "web", immutable id/kind/createdAt, exact fields
  delete: same uid and existing kind == "web"

users/{uid}/remoteSessions/{sessionId}
  read: same uid
  create: same uid, status == "requested", ownerUid == uid, exact participants/scopes/lease
  update: same uid, immutable ownership/participants/nonce/timestamps; never enter approved/rejected
  delete: same uid only after closed/rejected/expired/failed

users/{uid}/remoteSessions/{sessionId}/signals/{signalId}
  read/create/delete: same uid, participant IDs, unexpired parent and signal
  update: never

serverTurnIssuances/{id}, serverTurnRateLimits/{id}
  read/write: never
```

Use `request.time < resource/data.expiresAt`, exact field allowlists, `duration.value(8, "h")` maximum session lease, `duration.value(1, "h")` maximum signal lease, and payload-kind-specific SDP/candidate bounds.

The central matches must retain this deny shape while helper predicates expand the field checks:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedInAs(uid) {
      return request.auth != null && request.auth.uid == uid;
    }
    function session(uid, sessionId) {
      return get(/databases/$(database)/documents/users/$(uid)/remoteSessions/$(sessionId)).data;
    }
    function clientTransition(from, to) {
      return (from == "approved" && (to == "signaling" || to == "closed"))
        || (from == "signaling" && (to == "connected" || to == "failed" || to == "closed"))
        || (from == "connected" && (to == "disconnected" || to == "closed" || to == "failed"))
        || (from == "disconnected" && (to == "signaling" || to == "connected" || to == "closed" || to == "failed"))
        || (from == "requested" && to == "closed");
    }
    function signalPayloadValid(data) {
      return ((data.kind == "offer" || data.kind == "answer")
          && data.payload.keys().hasOnly(["type", "sdp"])
          && data.payload.type == data.kind
          && data.payload.sdp is string
          && data.payload.sdp.size() <= 65536)
        || (data.kind == "candidate"
          && data.payload.keys().hasOnly(["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
          && data.payload.candidate is string
          && data.payload.candidate.size() <= 4096)
        || (data.kind == "end-of-candidates" && data.payload.keys().size() == 0);
    }

    match /users/{uid}/devices/{deviceId} {
      allow get: if signedInAs(uid);
      allow list: if signedInAs(uid) && request.query.limit != null && request.query.limit <= 50;
      allow create: if signedInAs(uid)
        && request.resource.data.keys().hasOnly(["id", "kind", "name", "platform", "appVersion", "protocolVersions", "status", "createdAt", "lastSeenAt", "expiresAt"])
        && request.resource.data.id == deviceId
        && request.resource.data.kind == "web"
        && request.resource.data.platform == "web"
        && request.resource.data.name is string
        && request.resource.data.name.size() > 0
        && request.resource.data.name.size() <= 100
        && request.resource.data.appVersion is string
        && request.resource.data.protocolVersions is list
        && request.resource.data.status in ["online", "offline"]
        && request.resource.data.createdAt == request.time
        && request.resource.data.lastSeenAt == request.time
        && request.resource.data.expiresAt == request.time + duration.value(120, "s");
      allow update: if signedInAs(uid)
        && resource.data.kind == "web"
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(["name", "appVersion", "status", "lastSeenAt", "expiresAt"])
        && request.resource.data.lastSeenAt == request.time
        && request.resource.data.expiresAt == request.time + duration.value(120, "s");
      allow delete: if signedInAs(uid) && resource.data.kind == "web";
    }

    match /users/{uid}/remoteSessions/{sessionId} {
      allow get: if signedInAs(uid);
      allow list: if signedInAs(uid) && request.query.limit != null && request.query.limit <= 50;
      allow create: if signedInAs(uid)
        && request.resource.data.keys().hasOnly(["id", "ownerUid", "hostDeviceId", "clientDeviceId", "status", "protocolVersion", "requestedScopes", "approvedScopes", "requestNonce", "createdAt", "expiresAt"])
        && request.resource.data.id == sessionId
        && request.resource.data.ownerUid == uid
        && request.resource.data.hostDeviceId is string
        && request.resource.data.clientDeviceId is string
        && request.resource.data.status == "requested"
        && request.resource.data.protocolVersion == 1
        && request.resource.data.requestedScopes == ["terminal:read", "terminal:write"]
        && request.resource.data.approvedScopes.size() == 0
        && request.resource.data.requestNonce is string
        && request.resource.data.requestNonce.size() == 22
        && request.resource.data.createdAt == request.time
        && request.time < request.resource.data.expiresAt
        && request.resource.data.expiresAt <= request.time + duration.value(8, "h");
      allow update: if signedInAs(uid)
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(["status", "connectedAt", "closedAt", "failureCode"])
        && clientTransition(resource.data.status, request.resource.data.status)
        && request.time < resource.data.expiresAt;
      allow delete: if signedInAs(uid) && resource.data.status in ["closed", "rejected", "expired", "failed"];
    }

    match /users/{uid}/remoteSessions/{sessionId}/signals/{signalId} {
      allow get: if signedInAs(uid);
      allow list: if signedInAs(uid) && request.query.limit != null && request.query.limit <= 500;
      allow create: if signedInAs(uid)
        && request.resource.data.keys().hasOnly(["id", "kind", "senderDeviceId", "recipientDeviceId", "sequence", "payload", "createdAt", "expiresAt"])
        && request.resource.data.id == signalId
        && request.resource.data.senderDeviceId is string
        && request.resource.data.recipientDeviceId is string
        && request.resource.data.sequence is int
        && request.resource.data.sequence > 0
        && request.resource.data.senderDeviceId != request.resource.data.recipientDeviceId
        && [session(uid, sessionId).hostDeviceId, session(uid, sessionId).clientDeviceId].hasAll([request.resource.data.senderDeviceId, request.resource.data.recipientDeviceId])
        && session(uid, sessionId).status in ["approved", "signaling", "connected"]
        && request.time < session(uid, sessionId).expiresAt
        && request.resource.data.createdAt == request.time
        && request.time < request.resource.data.expiresAt
        && request.resource.data.expiresAt <= request.time + duration.value(1, "h")
        && signalPayloadValid(request.resource.data);
      allow update: if false;
      allow delete: if signedInAs(uid);
    }

    match /serverTurnIssuances/{id} { allow read, write: if false; }
    match /serverTurnRateLimits/{id} { allow read, write: if false; }
    match /{document=**} { allow read, write: if false; }
  }
}
```

- [ ] **Step 5: Add indexes and TTL deployment contract**

Add composite indexes for `(kind ASC, status ASC, lastSeenAt DESC)` on `devices`, `(hostDeviceId ASC, status ASC, createdAt DESC)` on `remoteSessions`, and `(recipientDeviceId ASC, sequence ASC)` on `signals`. Configure `firebase.json` with Auth 9099, Firestore 8080, Functions 5001, Hosting 5000, Emulator UI 4000, Functions source `functions`, and Hosting public directory `apps/web/dist`.

Firestore TTL is an environment operation, not a client rule. Document and later run these exact collection-group policies after authenticated project selection:

```bash
gcloud firestore fields ttls update expiresAt --collection-group=devices --enable-ttl
gcloud firestore fields ttls update expiresAt --collection-group=remoteSessions --enable-ttl
gcloud firestore fields ttls update expiresAt --collection-group=signals --enable-ttl
gcloud firestore fields ttls update expiresAt --collection-group=serverTurnIssuances --enable-ttl
```

- [ ] **Step 6: Run Rules coverage and package checks**

Run: `pnpm test:rules && pnpm --filter @codra/firebase test && pnpm --filter @codra/firebase typecheck && pnpm lint && pnpm format:check`

Expected: all allow and deny cases pass; Rules coverage shows no unintentionally open match; source checks exit 0.

- [ ] **Step 7: Commit the Firebase boundary**

```bash
git add firebase.json .firebaserc firestore.rules firestore.indexes.json package.json pnpm-workspace.yaml pnpm-lock.yaml packages/firebase
git commit -m "feat: define Firebase remote access boundary"
```

---

### Task 3: Implement Typed Firebase Devices, Sessions, Signals, and Callable Clients

**Files:**

- Create: `packages/firebase/src/functions.ts`
- Create: `packages/firebase/src/devices.ts`
- Create: `packages/firebase/src/sessions.ts`
- Create: `packages/firebase/src/signals.ts`
- Create: `packages/firebase/test/devices.test.ts`
- Create: `packages/firebase/test/sessions.test.ts`
- Create: `packages/firebase/test/signals.test.ts`
- Modify: `packages/firebase/src/index.ts`

**Interfaces:**

- Consumes: Tasks 1–2 schemas, Firebase `Auth`, `Firestore`, and `Functions` clients.
- Produces: typed callable names and request/results, `registerWebDevice`, `subscribeOnlineHosts`, `createRemoteSession`, `subscribeSession`, `transitionSession`, `FirestoreSignaler`, and idempotent cleanup.

- [ ] **Step 1: Write failing tests with injected Firebase ports and a fake clock**

Test stale presence filtering, exact eight-hour expiry, monotonic signal sequence, sender/sequence deduplication, listener resume, best-effort cleanup, and stable safe errors:

```ts
it("shows only hosts seen within ninety seconds", async () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const hosts = filterOnlineHosts(
    [
      host({ id: "fresh", lastSeenAt: now - 89_000, status: "online" }),
      host({ id: "stale", lastSeenAt: now - 91_000, status: "online" }),
      host({ id: "offline", lastSeenAt: now, status: "offline" }),
    ],
    now,
  );
  expect(hosts.map(({ id }) => id)).toEqual(["fresh"]);
});

it("deduplicates replayed signals by sender and sequence", () => {
  const seen = new SignalDeduplicator();
  expect(seen.accept({ senderDeviceId: "web-a", sequence: 9 })).toBe(true);
  expect(seen.accept({ senderDeviceId: "web-a", sequence: 9 })).toBe(false);
  expect(seen.accept({ senderDeviceId: "host-a", sequence: 9 })).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @codra/firebase test`

Expected: FAIL because device/session/signaling facades do not exist.

- [ ] **Step 3: Implement the callable facade with stable names and safe errors**

Export:

```ts
export interface RemoteFunctionsClient {
  registerHostDevice(
    request: RegisterHostDeviceRequest,
  ): Promise<RegisterHostDeviceResult>;
  heartbeatHostDevice(request: HeartbeatHostDeviceRequest): Promise<void>;
  issueHostAppCheckToken(
    request: IssueHostAppCheckTokenRequest,
  ): Promise<{ token: string; expireTimeMillis: number }>;
  approveRemoteSession(request: ApproveRemoteSessionRequest): Promise<void>;
  issueTurnCredentials(
    request: IssueTurnCredentialsRequest,
  ): Promise<IssueTurnCredentialsResult>;
  revokeTurnCredentials(request: RevokeTurnCredentialsRequest): Promise<void>;
}

export const REMOTE_CALLABLES = {
  registerHostDevice: "registerHostDevice",
  heartbeatHostDevice: "heartbeatHostDevice",
  issueHostAppCheckToken: "issueHostAppCheckToken",
  approveRemoteSession: "approveRemoteSession",
  issueTurnCredentials: "issueTurnCredentials",
  revokeTurnCredentials: "revokeTurnCredentials",
} as const;
```

Validate requests before `httpsCallable` and validate every returned value before exposing it. Convert dependency messages to `{ code, message, retryable }` without SDP, candidates, credentials, UID, or raw Firebase error text.

- [ ] **Step 4: Implement devices and sessions**

`registerWebDevice` creates a random UUID web document with server timestamps and a 120-second presence lease. `subscribeOnlineHosts` uses the required owner-path query with limit 50 and filters stale hosts locally at 90 seconds. `createRemoteSession` uses a random UUID session ID and 128-bit base64url nonce, requests both terminal scopes, uses protocol version 1, and sets expiry to exactly eight hours from server-aligned time.

`transitionSession` exposes only these client transitions:

```ts
const CLIENT_TRANSITIONS = new Set([
  "approved:signaling",
  "signaling:connected",
  "signaling:failed",
  "connected:disconnected",
  "connected:closed",
  "connected:failed",
  "disconnected:signaling",
  "disconnected:connected",
  "disconnected:closed",
  "disconnected:failed",
  "requested:closed",
  "approved:closed",
]);
```

Expiry is never extended by a client. Approval/rejection remains callable-only.

- [ ] **Step 5: Implement append-only trickle signaling**

`FirestoreSignaler` initializes its sender sequence from the highest existing sequence for `(sessionId, senderDeviceId)` plus one (or 1 for a new sender), writes a random signal document ID, subscribes with `(recipientDeviceId == localDeviceId, sequence ASC)`, validates and ignores expired documents before delivery, and deduplicates `(senderDeviceId, sequence)`. On listener failure it re-reads the current session, rebuilds the query, and retains dedupe state. `close()` unsubscribes first, then best-effort deletes only current-session signals addressed to or from this device.

- [ ] **Step 6: Run package tests and review the network-data boundary**

Run: `pnpm --filter @codra/firebase test && pnpm --filter @codra/firebase typecheck && pnpm lint && pnpm format:check`

Expected: all tests pass. A source review of `packages/firebase` finds no field capable of carrying terminal data and no Admin or Cloudflare dependency.

- [ ] **Step 7: Commit typed control-plane clients**

```bash
git add packages/firebase
git commit -m "feat: add typed Firebase signaling clients"
```

---

### Task 4: Implement Host Registration, Custom App Check, Heartbeat, and Signed Session Approval Functions

**Files:**

- Create: `functions/package.json`
- Create: `functions/tsconfig.json`
- Create: `functions/vitest.config.ts`
- Create: `functions/src/auth.ts`
- Create: `functions/src/host-signatures.ts`
- Create: `functions/src/app-check.ts`
- Create: `functions/src/devices.ts`
- Create: `functions/src/sessions.ts`
- Create: `functions/src/index.ts`
- Create: `functions/test/host-signatures.test.ts`
- Create: `functions/test/app-check.test.ts`
- Create: `functions/test/devices.test.ts`
- Create: `functions/test/sessions.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Task 1 canonical payloads/document schemas and Task 3 callable request/result contracts.
- Produces: 2nd-gen `registerHostDevice`, `issueHostAppCheckToken`, `heartbeatHostDevice`, and `approveRemoteSession` in `asia-northeast3`, plus dependency-injected handlers testable without deployed credentials.

- [ ] **Step 1: Create the Functions package and write failing signature/transaction tests**

Pin `firebase-admin: 14.2.0`, `firebase-functions: 7.3.2`, `@codra/protocol: workspace:*`, TypeScript 5.9.3, and Vitest 4.1.10. Test valid P-256 DER signatures, altered nonce/decision/scope/expiry rejection, heartbeat minute skew, host App Check proof skew/replay input, wrong configured Firebase app ID, auth absence, wrong owner, wrong host, expired session, and concurrent approval transaction behavior.

```ts
it("cannot approve after changing a signed request nonce", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const approved = approval({ requestNonce: "nonce-a" });
  const signature = signCanonical(keys.privateKey, canonicalApproval(approved));

  expect(
    verifyHostSignature(
      keys.publicKey.export({ format: "jwk" }),
      canonicalApproval(approved),
      signature,
    ),
  ).toBe(true);
  expect(
    verifyHostSignature(
      keys.publicKey.export({ format: "jwk" }),
      canonicalApproval({ ...approved, requestNonce: "nonce-b" }),
      signature,
    ),
  ).toBe(false);
});
```

- [ ] **Step 2: Run Functions tests and verify RED**

Run: `pnpm --filter @codra/functions test`

Expected: FAIL because the Functions package and handlers do not exist.

- [ ] **Step 3: Implement auth guards, signature validation, and redaction**

`requireAuthUid` throws `HttpsError("unauthenticated", "AUTH_REQUIRED")`. Import only P-256 public JWKs with `kty == "EC"`, `crv == "P-256"`, `use` absent or `sig`, and no private `d`. Signatures are base64url DER ECDSA/SHA-256 and capped at 256 bytes. Safe logs contain function name, stable code, and retryability only.

Use injectable ports:

```ts
export interface FunctionContext {
  uid: string;
  appId?: string;
  now: Date;
}

export interface VerifiedSessionDecision extends ApprovalPayload {
  uid: string;
  hostDeviceId: string;
  signature: string;
}

export interface RemoteAdminStore {
  createHost(uid: string, device: RemoteDevice): Promise<void>;
  getHost(uid: string, deviceId: string): Promise<RemoteDevice | undefined>;
  updateHeartbeat(
    uid: string,
    deviceId: string,
    at: Date,
    expiresAt: Date,
  ): Promise<void>;
  decideSession(uid: string, input: VerifiedSessionDecision): Promise<void>;
}
```

- [ ] **Step 4: Implement host registration and heartbeat**

`registerHostDevice` validates Auth and the public JWK, creates a server UUID, computes the SHA-256 fingerprint of a canonical public JWK, and writes a host document with server timestamps, `status: "online"`, protocol `[1]`, and `expiresAt = now + 120 seconds`. Host fields are never client-writable.

`heartbeatHostDevice` accepts `{ deviceId, issuedAtMinute, signature }`, requires the signed minute within one minute of server time, verifies `canonicalHeartbeat`, and transactionally updates only `status`, `lastSeenAt`, and `expiresAt`.

- [ ] **Step 5: Mint one-hour custom App Check tokens for the registered host**

Define the public desktop Firebase app ID as deployment parameter `CODRA_DESKTOP_FIREBASE_APP_ID`. `issueHostAppCheckToken` requires Auth, `{ deviceId, issuedAtMinute, signature }`, a minute within one minute of server time, the registered host under that UID, and a valid `canonicalHostAppCheckProof` signature. Call Admin `getAppCheck().createToken(configuredAppId, { ttlMillis: 60 * 60 * 1_000 })` and return only `{ token, expireTimeMillis }`. Do not persist or log the token/signature. Unit tests inject an `AppCheckIssuer` and prove altered device/minute/signature cannot mint.

- [ ] **Step 6: Implement approval/rejection as one transaction**

`approveRemoteSession` loads the session and targeted host under the authenticated UID, requires `status == "requested"`, exact nonce/host/expiry/scopes, verifies `canonicalApproval`, and transactionally changes only decision fields. Approval records the sorted scope subset, signature, `approvedAt`, and `status: "approved"`; rejection records empty scopes, signature, `approvedAt`, and `status: "rejected"`. A transaction retry that observes a completed identical decision is idempotent; any conflicting decision fails `SESSION_NOT_APPROVED`.

- [ ] **Step 7: Export 2nd-gen callable wrappers**

These four host bootstrap/identity wrappers use `onCall({ region: "asia-northeast3", enforceAppCheck: false })`: registration requires Auth, while App Check minting, heartbeat, and approval require Auth plus the registered key signature. Once minted, the Electron custom provider supplies App Check to Firestore. Task 5 still manually requires web App Check or host proof because one TURN callable serves both device kinds.

- [ ] **Step 8: Run unit, build, and emulator-compatible checks**

Run: `pnpm --filter @codra/functions test && pnpm --filter @codra/functions typecheck && pnpm --filter @codra/functions build && pnpm lint && pnpm format:check`

Expected: all checks pass without network calls or production credentials.

- [ ] **Step 9: Commit host identity Functions**

```bash
git add functions pnpm-lock.yaml
git commit -m "feat: verify signed remote host decisions"
```

---

### Task 5: Implement the Server-Only Cloudflare TURN Issue/Revoke Boundary

**Files:**

- Create: `functions/src/cloudflare-turn.ts`
- Create: `functions/src/turn.ts`
- Create: `functions/test/cloudflare-turn.test.ts`
- Create: `functions/test/turn.test.ts`
- Modify: `functions/src/index.ts`
- Modify: `packages/protocol/src/remote.ts`
- Modify: `packages/protocol/test/remote.test.ts`

**Interfaces:**

- Consumes: authenticated sessions and device records from Task 4, Task 1 host-proof canonicalization, and Cloudflare's standard `RTCIceServer[]` response.
- Produces: `issueTurnCredentials`, `revokeTurnCredentials`, a validated `CloudflareTurnPort`, issuance hashes/limits, and no client-visible long-lived credential.

- [ ] **Step 1: Write failing Cloudflare adapter tests**

Use injected `fetch`, clock, sleeper, and logger ports. Prove: `ttl` is 86,400; success requires HTTP 201 and a validated `iceServers` body; a network error retries once; HTTP 503 retries once; HTTP 400 does not retry; five seconds aborts; revocation URL-encodes the username and accepts HTTP 204; logs never contain headers, usernames, credentials, or response bodies.

```ts
it("retries one 503 and returns a validated ICE list", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers: fakeIceServers }), {
        status: 201,
      }),
    );
  const adapter = new CloudflareTurnHttp({
    fetch,
    sleep: async () => undefined,
  });

  await expect(adapter.generate(fakeServerConfig(), 86_400)).resolves.toEqual({
    iceServers: fakeIceServers,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Write failing authorization and rate-limit tests**

Test unauthenticated caller, web device without App Check, host without proof, proof older than two minutes, nonparticipant, unapproved/expired/closed session, 7th session issuance within ten minutes, 31st UID issuance within ten minutes, normal issuance hashing, revoke ownership mismatch, and idempotent successful revoke.

- [ ] **Step 3: Run focused Functions tests and verify RED**

Run: `pnpm --filter @codra/functions test -- test/cloudflare-turn.test.ts test/turn.test.ts`

Expected: FAIL because the adapter and TURN handlers do not exist.

- [ ] **Step 4: Implement the structured secret and HTTP adapter**

Define only the secret name in source:

```ts
import { defineJsonSecret } from "firebase-functions/params";

export const cloudflareTurnConfig = defineJsonSecret<{
  keyId: string;
  apiToken: string;
}>("CLOUDFLARE_TURN_CONFIG");
```

Validate `keyId` and `apiToken` as nonempty bounded strings at invocation time. Build generation and revocation URLs from the validated key ID; set the bearer header only inside the adapter; use `AbortSignal.timeout(5_000)` combined with the invocation abort signal. Return only parsed data or stable `TURN_UNAVAILABLE`. Never include the URL username segment in logs.

The adapter contract is:

```ts
export interface TurnServerConfig {
  keyId: string;
  apiToken: string;
}

export interface CloudflareTurnPort {
  generate(
    config: TurnServerConfig,
    ttlSeconds: 86_400,
  ): Promise<{ iceServers: IceServerDto[] }>;
  revoke(config: TurnServerConfig, username: string): Promise<void>;
}
```

- [ ] **Step 5: Implement participant authorization and exact rate limits**

`issueTurnCredentials` validates Auth, loads the owner session and participant device, and requires approved/signaling/connected/disconnected status before expiry. If the participant device is `web`, require `request.app`; if it is `host`, verify `hostProof` with `canonicalTurnProof` and a minute no more than two minutes from server time.

Reserve a ten-minute rate bucket transactionally before the external call: at most 30 issuances per UID and 6 per session per bucket. Store rate bucket documents under `serverTurnRateLimits` using SHA-256 IDs. After Cloudflare succeeds, hash the returned TURN username with SHA-256 and store only `{ ownerUid, sessionId, deviceId, issuedAt, expiresAt }` under `serverTurnIssuances/{issuanceHash}`. Return validated `iceServers` and server-computed `expiresAt`; never persist the TURN password.

- [ ] **Step 6: Implement validated revocation**

`revokeTurnCredentials` accepts `{ sessionId, deviceId, username, hostProof? }`, derives the issuance hash, checks Auth/participant/issuance ownership, applies the same web App Check or host signature split, calls the documented Cloudflare revoke endpoint, and deletes the issuance record after HTTP 204. A missing issuance after a prior successful revoke returns success; a mismatched existing issuance returns `SESSION_NOT_APPROVED`.

- [ ] **Step 7: Export only the two secret-bound callable wrappers**

Bind `{ region: "asia-northeast3", enforceAppCheck: false, secrets: [cloudflareTurnConfig] }` only to `issueTurnCredentials` and `revokeTurnCredentials`. No other function imports or binds the secret. App Check remains a manual participant-kind check because a single callable serves both web and Electron host clients.

- [ ] **Step 8: Run tests and an explicit credential-leak scan**

Run:

```bash
pnpm --filter @codra/functions test
pnpm --filter @codra/functions typecheck
pnpm --filter @codra/functions build
rg -n --hidden --glob '!docs/superpowers/specs/**' --glob '!pnpm-lock.yaml' '(Authorization:\s*Bearer\s+[A-Za-z0-9_-]{20,}|apiToken\s*[:=]\s*["'\''`][^"'\''`]+)' functions packages apps
```

Expected: tests/build pass and `rg` prints no long-lived credential assignment. Clearly fake unit-test values remain generated inside test helpers and never match the production token pattern.

- [ ] **Step 9: Commit the TURN boundary**

```bash
git add functions packages/protocol
git commit -m "feat: broker Cloudflare TURN credentials server-side"
```

---

### Task 6: Implement Transport-Neutral WebRTC and Backpressure Primitives

**Files:**

- Create: `packages/webrtc/package.json`
- Create: `packages/webrtc/tsconfig.json`
- Create: `packages/webrtc/src/ice.ts`
- Create: `packages/webrtc/src/deduplicator.ts`
- Create: `packages/webrtc/src/deadline.ts`
- Create: `packages/webrtc/src/channel.ts`
- Create: `packages/webrtc/src/attachment-pump.ts`
- Create: `packages/webrtc/src/index.ts`
- Create: `packages/webrtc/test/ice.test.ts`
- Create: `packages/webrtc/test/deduplicator.test.ts`
- Create: `packages/webrtc/test/deadline.test.ts`
- Create: `packages/webrtc/test/attachment-pump.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Cloudflare `RTCIceServer[]`, Task 1 binary frames/cursor pages, and no Electron/browser globals.
- Produces: `normalizeBrowserIceServers`, `normalizeNodeIceServers`, `SignalDeduplicator`, `RequestReplayGuard`, `NegotiationDeadline`, `OrderedChannelPort`, and `AttachmentPump` shared by both app lanes.

- [ ] **Step 1: Write failing ICE normalization tests**

Prove removal of all port 53 URLs, retention of 3478/80/5349/443, credential preservation, URL deduplication, and exact node-datachannel mapping:

```ts
expect(normalizeNodeIceServers(cloudflareIce)).toContainEqual({
  hostname: "turn.cloudflare.com",
  port: 3478,
  username: "test-user",
  password: "test-password",
  relayType: "TurnUdp",
});
expect(normalizeNodeIceServers(cloudflareIce)).toContainEqual({
  hostname: "turn.cloudflare.com",
  port: 443,
  username: "test-user",
  password: "test-password",
  relayType: "TurnTls",
});
expect(
  normalizeBrowserIceServers(cloudflareIce).flatMap((server) => server.urls),
).not.toContain("turn:turn.cloudflare.com:53?transport=udp");
```

- [ ] **Step 2: Write failing dedupe, timeout, ping, and output-pump tests**

Use fake timers and fake channels. Prove duplicate request IDs with the same canonical body replay the cached response, conflicting bodies return `SIGNAL_INVALID`, negotiation expires exactly at 20 seconds, three missing five-second pongs disconnect, output pauses above 1,048,576 bytes, resumes at/below 262,144 bytes, resumes from acknowledged cursor, and never blocks control sends.

- [ ] **Step 3: Run package tests and verify RED**

Run: `pnpm --filter @codra/webrtc test`

Expected: FAIL because `@codra/webrtc` does not exist.

- [ ] **Step 4: Implement ICE normalization as pure functions**

Export browser `RTCIceServer[]` and a library-neutral node shape so `packages/webrtc` does not import the native module:

```ts
export type NodeRelayType = "TurnUdp" | "TurnTcp" | "TurnTls";
export interface NodeIceServer {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: NodeRelayType;
}
```

Parse URLs with a dedicated STUN/TURN parser, reject non-STUN/TURN schemes, require username and credential together for TURN, map `turn:?transport=udp`, `turn:?transport=tcp`, and `turns:` exactly, and preserve STUN entries without relay type.

- [ ] **Step 5: Implement deterministic dedupe/deadline primitives**

`SignalDeduplicator` uses `${senderDeviceId}:${sequence}` with a 2,048-entry bounded LRU. `RequestReplayGuard` stores the SHA-256 digest and serialized response for the last 1,024 request IDs; same digest replays, a different digest for the same ID rejects. `NegotiationDeadline` owns one 20-second abort and one allowed ICE-restart token. `HeartbeatMonitor` sends pings every five seconds and reports disconnected after the third unanswered ping.

- [ ] **Step 6: Define channel ports and implement `AttachmentPump`**

```ts
export interface OrderedChannelPort {
  readonly label: "codra.control.v1" | "codra.terminal.v1";
  readonly bufferedAmount: number;
  sendText(data: string): boolean;
  sendBinary(data: Uint8Array): boolean;
  setBufferedAmountLowThreshold(bytes: number): void;
  onBufferedAmountLow(listener: () => void): () => void;
  close(): void;
}

export interface CursorSource {
  readFromCursor(
    terminalId: string,
    afterCursor: number,
    maxBytes: number,
  ): Promise<TerminalCursorPage>;
}
```

The pump serializes one drain at a time, chunks encoded payloads at 16 KiB, tracks sent and acknowledged cursors separately, stops reading while over the high watermark, and schedules catch-up from the acknowledged cursor when low. Attach uses subscribe-buffer-first, cursor replay second, then deduplicated buffered live chunks so output created during replay is not lost.

- [ ] **Step 7: Run package and workspace checks**

Run: `pnpm --filter @codra/webrtc test && pnpm --filter @codra/webrtc typecheck && pnpm test && pnpm typecheck && pnpm format:check`

Expected: pure package tests and all standalone tests pass without loading `node-datachannel` or browser globals.

- [ ] **Step 8: Commit shared WebRTC primitives**

```bash
git add packages/webrtc pnpm-lock.yaml
git commit -m "feat: add shared WebRTC transport primitives"
```

---

### Task 7: Add Opt-In Desktop Identity, Host Approval, IPC, and Lifecycle

**Files:**

- Create: `apps/desktop/src/main/remote/secure-key-store.ts`
- Create: `apps/desktop/src/main/remote/firebase-auth.ts`
- Create: `apps/desktop/src/main/remote/firebase-app-check.ts`
- Create: `apps/desktop/src/main/remote/settings.ts`
- Create: `apps/desktop/src/main/remote/controller.ts`
- Create: `apps/desktop/src/main/ipc/remote-ipc.ts`
- Create: `apps/desktop/src/main/remote/secure-key-store.test.ts`
- Create: `apps/desktop/src/main/remote/firebase-app-check.test.ts`
- Create: `apps/desktop/src/main/remote/controller.test.ts`
- Create: `apps/desktop/src/main/ipc/remote-ipc.test.ts`
- Create: `apps/desktop/src/renderer/src/remote/RemoteAccessPanel.tsx`
- Create: `apps/desktop/src/renderer/src/remote/RemoteAccessPanel.test.tsx`
- Modify: `packages/protocol/src/desktop-api.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/global.d.ts`
- Modify: `apps/desktop/src/main/bootstrap.ts`
- Modify: `apps/desktop/src/main/lifecycle.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Task 3 Firebase clients, Task 4 host callables, existing secure preload/lifecycle/admission patterns, and no peer connection yet.
- Produces: `RemoteAccessController`, async-safeStorage-backed `HostIdentity`, host presence/approval listeners, renderer settings/approval API, and Quit coordination used by Task 8.

- [ ] **Step 1: Write failing controller and IPC tests**

Test disabled-by-default state, local bootstrap independence when Firebase initialization rejects, email/password sign-in staying in main, one host key per Firebase UID, signed custom App Check acquisition/refresh, no Firestore access before App Check activation, signed heartbeat every 30 seconds, pending-request event delivery while no window exists, local approve/reject signature, disable cleanup, no private key/token in renderer payloads, and exact preload allowlisting.

```ts
it("does not initialize Firebase until the user enables remote access", async () => {
  const createFirebase = vi.fn();
  const controller = new RemoteAccessController({
    createFirebase,
    settings: disabledSettings(),
  });

  await controller.restore();

  expect(createFirebase).not.toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({
    enabled: false,
    auth: "signed-out",
    connections: 0,
  });
});
```

- [ ] **Step 2: Run focused desktop tests and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/main/remote src/main/ipc/remote-ipc.test.ts src/renderer/src/remote`

Expected: FAIL because the controller, IPC bridge, and settings UI do not exist.

- [ ] **Step 3: Implement async-safeStorage host identity after app readiness**

Generate an EC `prime256v1` pair in Electron main and export public/private JWK. Do not touch `safeStorage` before `app.whenReady()` resolves. Then await `safeStorage.isAsyncEncryptionAvailable()`; if it is false or temporarily unavailable, set remote state to a retryable secure-storage error and leave local terminals fully operational.

Encrypt the private JWK with `safeStorage.encryptStringAsync`, atomically write only ciphertext beneath `userData/remote-identity/${sha256Hex(uid)}.bin`, create the directory as mode `0700`, and enforce file mode `0600` after rename. Decrypt with `decryptStringAsync`; when it reports `shouldReEncrypt`, encrypt the returned result with the current provider and atomically replace the ciphertext. Sign with `crypto.sign("sha256", Buffer.from(canonical, "utf8"), { key: privateKey, dsaEncoding: "der" })`; expose only `{ publicKeyJwk, keyFingerprint, sign(canonical): string }` from the identity object.

```ts
export interface SafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }>;
}
```

Unit tests use an in-memory `SafeStoragePort` and temporary directory. Prove no method is called before readiness, plaintext JWK bytes are absent from the file, file mode is exactly `0600`, rotation rewrites ciphertext, and secure-storage failure disables only remote access.

Firebase Auth runs in Electron main with `inMemoryPersistence` and supports the MVP email/password provider. The password crosses the validated IPC request once, is passed directly to `signInWithEmailAndPassword`, and is never stored or logged. Firebase refresh tokens therefore remain in Electron main memory and the user signs in again after a full app process restart; adding durable Firebase Auth persistence is outside this slice, while the encrypted host identity remains durable on disk under a Keychain-backed encryption key.

- [ ] **Step 4: Install the desktop custom App Check provider before Firestore**

After Auth, secure identity, and host registration succeed, initialize Firebase App Check with `CustomProvider`. Each `getToken()` signs `canonicalHostAppCheckProof(deviceId, currentEpochMinute)`, calls `issueHostAppCheckToken`, validates the returned JWT-shaped string and future `expireTimeMillis`, and returns it to the SDK with auto refresh enabled. Tokens remain only in main memory and are never logged or sent through preload.

Test that the bootstrap order is exactly Auth → host registration → custom App Check → protected Firestore, that token refresh signs a new current minute, and that mint/network failure sets remote to retryable error without touching local terminal ownership. The Emulator direct test injects a fake custom token provider because the App Check product has no emulator; production/staging hosted smoke uses the real signed mint function.

- [ ] **Step 5: Implement the opt-in controller**

Use this state boundary:

```ts
export interface RemoteAccessSnapshot {
  enabled: boolean;
  auth: "signed-out" | "signing-in" | "signed-in" | "error";
  email?: string;
  hostDeviceId?: string;
  presence: "offline" | "starting" | "online" | "error";
  pendingRequests: RemoteApprovalRequest[];
  connections: number;
  error?: { code: string; retryable: boolean };
}
```

`restore()` reads only the nonsecret enabled preference and does not initialize Firebase while disabled. `signInAndEnable` creates the Firebase bootstrap, signs in, loads/generates the host key, registers or reuses the locally stored device ID, installs custom App Check, creates the protected Firestore client, starts the 30-second signed heartbeat, and subscribes to `requested` sessions targeting this host. `disable()` unsubscribes, marks local state offline, signs out, and calls the Task 8 connection closer without stopping terminals.

When a request arrives with no renderer window, send a native Electron notification and request the existing `createWindow` callback; approval never occurs from the notification itself. `approve(sessionId, scopes)` and `reject(sessionId)` sign the exact Task 1 canonical payload before calling the Function.

- [ ] **Step 6: Extend the versioned preload API**

Add only:

```ts
remote: {
  state(): Promise<RemoteAccessSnapshot>;
  signInAndEnable(request: { email: string; password: string }): Promise<RemoteAccessSnapshot>;
  disable(): Promise<void>;
  approve(request: { sessionId: string; approvedScopes: RemoteScope[] }): Promise<void>;
  reject(sessionId: string): Promise<void>;
  onState(listener: (snapshot: RemoteAccessSnapshot) => void): () => void;
  onApprovalRequest(listener: (request: RemoteApprovalRequest) => void): () => void;
}
```

Validate both IPC directions, register/unregister all listeners with the existing admission gate, and assert that arbitrary Firebase calls, keys, tokens, SDP, ICE credentials, and peer objects are absent from `window.codra`.

- [ ] **Step 7: Add the desktop settings and approval UI**

Render a compact “Remote access” panel outside the terminal pane. Signed-out state shows email/password and an “Enable remote access” action; enabled state shows the current account, host presence, and “Disable” action. Each pending request shows the web device name, requested read/write scopes, expiry, and explicit Approve/Reject buttons. Closing the window leaves controller listeners/heartbeats in main alive.

- [ ] **Step 8: Integrate explicit Quit semantics**

Extend lifecycle dependencies with `remote.activeConnectionCount()` and `remote.closeAll()`. The confirmation text includes both active terminal and remote connection counts. On confirmed Quit: close the remote admission gate, drain in-flight remote creates, close peers/listeners, close PTYs, close SQLite, then quit. A failure reports locally but cleanup continues in reverse ownership order.

- [ ] **Step 9: Verify packaged safe-storage isolation**

Keep identity storage on Electron's built-in main-process `safeStorage`; add no third-party keychain native module. Extend bootstrap/package tests to prove remote-disabled startup never calls `isAsyncEncryptionAvailable`, and use an injected fake port for packaged smoke so CI never opens the developer or runner Keychain. A macOS manual test enables remote once, verifies only a mode `0600` ciphertext file is created under `userData/remote-identity`, then removes that test profile.

- [ ] **Step 10: Run desktop regression and package checks**

Run: `pnpm --filter @codra/desktop test && pnpm typecheck && pnpm lint && pnpm build && pnpm --filter @codra/desktop package:dir && pnpm test:packaged`

Expected: all standalone behavior stays green, remote-disabled launch performs no Firebase or safe-storage call, and the packaged app loads without a new keychain native dependency.

- [ ] **Step 11: Commit desktop identity and approval**

```bash
git add apps/desktop packages/protocol pnpm-lock.yaml
git commit -m "feat: add opt-in desktop remote identity"
```

---

### Task 8: Add the Electron Main `node-datachannel` Peer and Terminal Gateway

**Files:**

- Create: `apps/desktop/src/main/remote/node-datachannel.ts`
- Create: `apps/desktop/src/main/remote/peer.ts`
- Create: `apps/desktop/src/main/remote/gateway.ts`
- Create: `apps/desktop/src/main/remote/node-datachannel.test.ts`
- Create: `apps/desktop/src/main/remote/peer.test.ts`
- Create: `apps/desktop/src/main/remote/gateway.test.ts`
- Modify: `apps/desktop/src/main/remote/controller.ts`
- Modify: `apps/desktop/src/main/bootstrap.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: approved sessions from Task 7, Task 3 signaling/callables, Task 6 ICE/channel/pump primitives, and the existing `TerminalManager` methods plus Task 1 cursor replay.
- Produces: `HostPeerSession`, `NodeDataChannelAdapter`, `RemoteTerminalGateway`, connection counts/close semantics, and the host half of offer/answer/trickle negotiation.

- [ ] **Step 1: Write failing host peer tests with fake native bindings**

Prove: only an approved unexpired targeted session starts; both participants receive fresh ICE configuration; an offer is validated before `setRemoteDescription`; answer/candidates are appended with monotonic sequence; unknown channel labels close the peer; both exact channels are required; hello nonce/session/version mismatch closes; 20-second timeout returns `ICE_TIMEOUT`; one disconnected state attempts ICE restart; persistent failed creates a fresh peer; disable/Quit closes every peer and signal listener.

- [ ] **Step 2: Write failing terminal gateway authorization tests**

Test hello before any terminal method, read scope for list/attach, write scope for create/input/resize, terminal ID membership, duplicate request replay/conflict, 64 KiB input bound, 20–400/5–200 resize bounds, detach without PTY close, output cursor ack, and safe error payloads.

```ts
it("never lets a read-only session write to the PTY", async () => {
  const gateway = createGateway({ approvedScopes: ["terminal:read"] });
  await gateway.receive(hello());
  await gateway.receive(terminalInput({ terminalId, data: "pwd\r" }));

  expect(terminal.write).not.toHaveBeenCalled();
  expect(control.sent.at(-1)).toMatchObject({
    type: "error",
    code: "SCOPE_DENIED",
  });
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm --filter @codra/desktop test -- src/main/remote/peer.test.ts src/main/remote/gateway.test.ts`

Expected: FAIL because the host peer and gateway do not exist.

- [ ] **Step 4: Implement a narrow native adapter**

Add `node-datachannel: 0.32.3` only to desktop. Wrap `PeerConnection`, `DataChannel`, `onLocalDescription`, `onLocalCandidate`, `setRemoteDescription`, `addRemoteCandidate`, `onDataChannel`, `onStateChange`, and close/delete operations behind testable ports. Convert Task 6 node ICE entries to the library's `RelayType` values and set `iceTransportPolicy` to `"all"` normally or `"relay"` only when the trusted smoke injects relay policy.

Map `sendMessage`/`sendMessageBinary`, `bufferedAmount()`, `setBufferedAmountLowThreshold`, and `onBufferedAmountLow` to `OrderedChannelPort`. Call the native library cleanup API after every peer has closed during app shutdown.

- [ ] **Step 5: Implement host signaling and negotiation**

After approval, obtain host TURN configuration with a signed host proof, create the peer, and subscribe to signals addressed to the host. The browser is always the initial offerer. Validate and apply one offer, append one answer, trickle candidates both directions, and ignore duplicate signals. On `disconnected`, request one ICE restart through the existing session; on `failed` or a missed deadline, close the old native object and create a fresh peer/signaling sequence only while the eight-hour approval remains valid.

- [ ] **Step 6: Bind both channels and run the hello gate**

Accept only `codra.control.v1` and `codra.terminal.v1`, one each. Do not construct `RemoteTerminalGateway` until both are open. Require the first control message to be `hello` matching the Firestore session ID, request nonce, and version 1; answer `hello_ack` and only then process terminal messages.

- [ ] **Step 7: Route terminal operations and cursor output**

List/create/write/resize call the same `TerminalManager` used by local IPC. `terminal.attach` adds that ID to the session's authorized set, subscribes before replay, runs `AttachmentPump` from the requested cursor, then emits live frames. `terminal.detach` removes only the attachment/pump. `terminal.ack` advances the acknowledged cursor monotonically. Remote close never closes a PTY unless an explicit approved terminal-close operation is added in a future protocol version.

- [ ] **Step 8: Integrate connection ownership and packaging**

`RemoteAccessController` owns a `Map<sessionId, HostPeerSession>`, reports its size to lifecycle, and removes entries on closure. Add `node-datachannel` to ASAR unpack and packaged native-architecture inspection. Remote-disabled packaged startup must not initialize the native library.

- [ ] **Step 9: Run desktop and packaged regression gates**

Run: `pnpm --filter @codra/desktop test && pnpm typecheck && pnpm lint && pnpm build && pnpm --filter @codra/desktop package:dir && pnpm test:packaged`

Expected: host peer/gateway tests and every standalone unit/E2E/package smoke pass; the packaged app contains the matching-architecture `node-datachannel` native binding outside ASAR.

- [ ] **Step 10: Commit the Electron host transport**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat: host remote terminals over WebRTC"
```

---

### Task 9: Build the Browser Remote Client, Peer, Cursor Store, and xterm UI

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/auth/firebase.ts`
- Create: `apps/web/src/auth/SignIn.tsx`
- Create: `apps/web/src/remote/useHosts.ts`
- Create: `apps/web/src/remote/useRemoteSession.ts`
- Create: `apps/web/src/remote/browser-peer.ts`
- Create: `apps/web/src/remote/cursor-store.ts`
- Create: `apps/web/src/terminal/RemoteTerminal.tsx`
- Create: `apps/web/src/terminal/useRemoteTerminal.ts`
- Create: `apps/web/test/SignIn.test.tsx`
- Create: `apps/web/test/hosts.test.tsx`
- Create: `apps/web/test/browser-peer.test.ts`
- Create: `apps/web/test/cursor-store.test.ts`
- Create: `apps/web/test/remote-terminal.test.tsx`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Tasks 1, 3, and 6 shared contracts and approved-session behavior from Task 4; interoperates with the Task 8 host but cannot import desktop code.
- Produces: authenticated web device/host picker, approval wait state, browser `RTCPeerConnection`, durable IndexedDB cursor, remote xterm list/create/attach/input/resize/detach, and buildable Firebase Hosting output.

- [ ] **Step 1: Scaffold the web package and write failing UI/peer tests**

Pin React/xterm/Firebase to workspace-compatible versions. Test signed-out form, Auth errors without raw provider messages, online/stale host display, explicit connection request, approval/rejection/expiry states, exact two DataChannels, offer/candidate signaling, hello gate, binary frame decode, cursor persistence before ack, and terminal input/resize routing.

```ts
it("persists the rendered cursor before acknowledging it", async () => {
  const store = memoryCursorStore();
  const channel = fakeControlChannel();
  const terminal = fakeTerminalThatCompletesWrites();
  const client = createRemoteTerminalClient({ store, channel, terminal });

  await client.onFrame(
    frame({ cursor: 42n, payload: new TextEncoder().encode("ready") }),
  );

  expect(store.operations).toEqual(["put:session-a:terminal-a:42"]);
  expect(channel.sent.at(-1)).toMatchObject({
    type: "terminal.ack",
    cursor: 42,
  });
});
```

- [ ] **Step 2: Run web tests and verify RED**

Run: `pnpm --filter @codra/web test`

Expected: FAIL because `apps/web` does not exist.

- [ ] **Step 3: Implement web Auth, App Check, and device registration**

Initialize Firebase Auth with IndexedDB/browser-local persistence and email/password sign-in. Before creating Firestore, initialize reCAPTCHA Enterprise App Check from `VITE_FIREBASE_APPCHECK_SITE_KEY` in production; enable the debug provider only for an explicitly registered debug token when `VITE_CODRA_APP_CHECK_DEBUG === "true"`. Task 10 uses a separately guarded inert port only against the loopback `demo-codra` emulator. The site key is public; no Admin or Cloudflare long-lived value enters the bundle.

After sign-in, register one UUID web device in Firestore, refresh its client-writable presence lease every 30 seconds while the page is visible, and delete/mark it offline best-effort on sign-out. Never label the web device as a host.

- [ ] **Step 4: Implement host selection and approval flow**

`useHosts` renders only Task 3 fresh hosts, ordered by `lastSeenAt`, with name/platform/version. Selecting one creates a `requested` session and renders the literal prefix `Waiting for approval on ` followed by `host.name`. Do not create a peer before status `approved`. Rejection, expiry, host staleness, and closure produce stable retry actions; a retry creates a new session unless an approved eight-hour lease remains reusable.

- [ ] **Step 5: Implement the browser peer and Firestore signaling**

Request web TURN credentials through the callable, normalize browser ICE servers, create `RTCPeerConnection({ iceServers, iceTransportPolicy: "all" })`, and synchronously create reliable ordered channels named `codra.control.v1` and `codra.terminal.v1` before `createOffer`. Append offer/candidates through `FirestoreSignaler`, apply the host answer/candidates, enforce the 20-second deadline, and send hello only after both channels open.

The trusted smoke may inject `iceTransportPolicy: "relay"`; production UI cannot toggle it. One disconnected state calls `restartIce()` and sends a new offer; persistent failure closes the peer and lets the session controller construct a fresh one with new credentials.

- [ ] **Step 6: Implement durable IndexedDB cursors**

Use native IndexedDB database `codra-remote-v1`, store `terminal-cursors`, and key `${sessionId}:${terminalId}`. Values are nonnegative safe integers. Store a cursor only from a successfully decoded frame and only after xterm's write callback completes; then send `terminal.ack`. Never move the cursor backward. On attach, send the stored cursor. If the host returns `resetRequired`, clear the old cursor, write a visible local “older output expired” marker, and continue from `availableFromCursor`.

- [ ] **Step 7: Implement the remote xterm surface**

After `hello_ack`, request terminal list. Provide List, Create, Attach, and Detach; attach creates xterm and fit-addon, sends input on the control channel, and debounces size updates within 50 ms. Decode only terminal-channel binary frames matching the attached terminal ID and monotonic cursor. The UI does not expose filesystem paths beyond the descriptor display value already authorized by the host.

- [ ] **Step 8: Build and inspect the browser bundle**

Run: `pnpm --filter @codra/web test && pnpm --filter @codra/web typecheck && pnpm --filter @codra/web build && pnpm lint && pnpm format:check`

Expected: tests/build pass. `apps/web/dist` contains no Node/Electron native module, Firebase Admin reference, Cloudflare API header, host key, TURN password literal, terminal fixture output, or source-map secret.

- [ ] **Step 9: Commit the browser remote client**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: add browser remote terminal client"
```

---

### Task 10: Converge the Three Lanes in a Direct-ICE Emulator E2E

**Files:**

- Create: `scripts/run-remote-e2e.mjs`
- Create: `tests/e2e/remote-fixture.ts`
- Create: `tests/e2e/remote-direct.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/web/src/auth/firebase.ts`
- Modify: `apps/web/src/remote/browser-peer.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: Firebase/Auth/Functions/Rules lane Tasks 2–5, shared transport Task 6, Electron host Tasks 7–8, and web Task 9.
- Produces: `pnpm test:remote:direct`, the first real browser `RTCPeerConnection` ↔ Electron-main `node-datachannel` terminal connection, and proof that Firestore never receives terminal content.

- [ ] **Step 1: Write the failing direct connection E2E**

The test creates one Auth Emulator user through its REST endpoint, launches the built Electron main with an isolated user-data directory, opens the Hosting Emulator web app, signs both into the same account through visible UI, enables the host, selects it in the browser, approves the request in Electron, and waits for both channels.

Then it must:

```ts
await web.getByRole("button", { name: "New terminal" }).click();
await web
  .getByTestId("remote-terminal")
  .pressSequentially("printf '__CODRA_REMOTE_DIRECT__\\n'", { delay: 5 });
await web.getByTestId("remote-terminal").press("Enter");
await expect(web.getByTestId("remote-terminal")).toContainText(
  "__CODRA_REMOTE_DIRECT__",
);

const selectedPair = await readSelectedCandidatePair(web);
expect(selectedPair.localCandidateType).not.toBe("relay");
expect(selectedPair.remoteCandidateType).not.toBe("relay");

await electronPage.close();
await web
  .getByTestId("remote-terminal")
  .pressSequentially("printf '__WINDOW_CLOSED__\\n'");
await web.getByTestId("remote-terminal").press("Enter");
await expect(web.getByTestId("remote-terminal")).toContainText(
  "__WINDOW_CLOSED__",
);
```

Finally, read Firestore Emulator session/signal documents through the test admin fixture and assert their serialized form contains neither marker, shell command, terminal bytes, nor scrollback. Reopen the Electron window, close the session, close the terminal locally, confirm Quit, and verify both Electron and shell PIDs exit.

- [ ] **Step 2: Run the E2E and verify RED**

Run: `pnpm test:remote:direct`

Expected: FAIL because emulator orchestration and cross-app launch fixtures do not exist.

- [ ] **Step 3: Implement isolated emulator orchestration**

`run-remote-e2e.mjs` allocates temporary data/export directories, builds protocol/firebase/webrtc/desktop/web, and runs:

```bash
firebase emulators:exec --project demo-codra --only auth,firestore,functions,hosting "playwright test --project=remote-direct"
```

Use fixed loopback ports from `firebase.json`, fail if any are occupied, and remove the temporary profile/export in `finally`. The child-process tree cleanup must match the existing packaged E2E discipline and kill only descendants launched by this script.

- [ ] **Step 4: Add tightly guarded emulator App Check and direct-ICE test providers**

The Firebase Emulator Suite has no App Check emulator. Inject an inert App Check port and an empty ICE list only when all three conditions hold: project ID is exactly `demo-codra`, every Firebase endpoint is loopback, and `CODRA_E2E_DIRECT_ICE === "1"` (desktop) or `VITE_CODRA_E2E_DIRECT_ICE === "true"` (web). Any partial or production-project combination throws during test bootstrap. Production/staging builds always install real App Check and use the Task 5 TURN callable.

- [ ] **Step 5: Make reconnection-safe signaling sequences observable**

The E2E fixture records Firestore signals and asserts one offer, one answer, trickled candidates from both device IDs, monotonic per-sender sequences, and expiry at or before one hour. It waits for `connected` state before typing and asserts session ownership, host/client IDs, nonce, signed approval, scopes, and eight-hour maximum lease.

- [ ] **Step 6: Run direct convergence twice from clean state**

Run: `pnpm test:remote:direct && pnpm test:remote:direct`

Expected: both runs pass from separate temporary profiles with no reused Firebase data, no leaked Electron/shell process, no Keychain prompt, and no Cloudflare request.

- [ ] **Step 7: Add the direct gate to macOS CI**

After unit/Rules/build checks and before packaging, run `pnpm test:remote:direct` on `macos-14`. Upload Playwright traces only on failure; traces are sanitized and use emulator-only accounts/SDP. Never upload the temporary Electron profile or Firestore export.

- [ ] **Step 8: Commit direct-ICE convergence**

```bash
git add scripts/run-remote-e2e.mjs tests/e2e/remote-fixture.ts tests/e2e/remote-direct.spec.ts playwright.config.ts apps/desktop/src/main/index.ts apps/web package.json .github/workflows/ci.yml
git commit -m "test: prove direct remote terminal connection"
```

---

### Task 11: Harden Reconnect, Cursor Catch-Up, Backpressure, and Closure

**Files:**

- Create: `tests/e2e/remote-reconnect.spec.ts`
- Create: `packages/webrtc/test/recovery.test.ts`
- Modify: `packages/firebase/src/signals.ts`
- Modify: `packages/firebase/test/signals.test.ts`
- Modify: `packages/webrtc/src/deadline.ts`
- Modify: `packages/webrtc/src/attachment-pump.ts`
- Modify: `apps/desktop/src/main/remote/peer.ts`
- Modify: `apps/desktop/src/main/remote/gateway.ts`
- Modify: `apps/web/src/remote/useRemoteSession.ts`
- Modify: `apps/web/src/remote/browser-peer.ts`
- Modify: `apps/web/src/remote/cursor-store.ts`
- Modify: `apps/web/src/terminal/useRemoteTerminal.ts`

**Interfaces:**

- Consumes: the passing direct connection from Task 10.
- Produces: one ICE restart, fresh-peer fallback, persisted monotonic sender sequence, three-pong disconnect detection, cursor-resumed terminal replay, bounded output buffering, and deterministic close/revoke/cleanup behavior.

- [ ] **Step 1: Write failing recovery state-machine tests**

With fake clocks/transports, test these exact paths:

```text
connected -> disconnected -> ICE restart -> connected
connected -> disconnected -> ICE restart -> failed -> fresh peer -> connected
connected -> three missed pongs -> disconnected
approved but expires during retry -> expired (no new peer, signal, or TURN request)
closed -> no reconnect
```

Also prove that a reconstructed `FirestoreSignaler` queries the highest existing sequence sent by its device and starts at `highest + 1`; a new sender starts at 1. No reconnect may reuse `(senderDeviceId, sequence)`.

- [ ] **Step 2: Write failing cursor/backpressure tests**

Feed overlapping replay/live frames and assert xterm receives each byte once. Simulate high/low watermarks and assert PTY output persistence continues, terminal-channel sends pause, control pings/input/resize/detach remain immediate, and resume reads from acknowledged—not merely sent—cursor. Reject backward/future acknowledgements.

- [ ] **Step 3: Write the failing browser reload E2E**

The test connects, creates a terminal, records the current IndexedDB cursor, prints numbered output while closing the browser page mid-stream, opens a new page using the same browser profile, reuses the still-approved/unexpired session, and reattaches with the stored cursor. Assert the recovered output contains every numbered marker exactly once and the final stored cursor equals the host's acknowledged cursor.

Then start a 10 MiB ASCII output burst on the host. During the burst, measure `session.ping`/pong, resize acknowledgement, and detach acknowledgement; each must complete within one second. Reattach and wait for the final marker without freezing Electron local input.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm --filter @codra/firebase test -- test/signals.test.ts && pnpm --filter @codra/webrtc test && pnpm --filter @codra/desktop test -- src/main/remote && pnpm --filter @codra/web test && pnpm test:remote -- --grep reconnect`

Expected: at least sequence resume, fresh-peer fallback, and cursor catch-up fail before implementation.

- [ ] **Step 5: Implement reconnect ownership and fresh credentials**

Allow one `restartIce()` inside the existing peer. If it does not reconnect by the 20-second deadline, close it completely, read current session/host presence, refresh Auth if needed, request fresh participant credentials, initialize signal sequence from Firestore's current maximum for that sender, and create a new peer. Keep at most one live peer per session using a generation token; late events from an old generation are ignored.

- [ ] **Step 6: Implement durable catch-up and overlap rejection**

On browser reload, read IndexedDB before attach. Host attach registers the live listener before reading replay, buffers live chunks, sends cursor replay, discards buffered chunks ending at/before the sent cursor, and then drains remaining live data. Browser rejects frames whose cursor is at/before its durable cursor, treats a forward gap without `resetRequired` as `SIGNAL_INVALID`, writes the payload, durably stores cursor, then acknowledges.

- [ ] **Step 7: Implement heartbeat and closure cleanup**

Start five-second ping only after hello acknowledgement. Three missed pongs close the transport and mark the Firestore session disconnected. Normal browser close or desktop disable closes both channels/peer, transitions the session to closed, requests TURN revocation with the in-memory username, unsubscribes signaling, and best-effort deletes signals. Expiry closes without permitting new signals or credentials.

- [ ] **Step 8: Run burst/reconnect E2E and all local regressions**

Run: `pnpm test:remote:direct && pnpm test:remote -- --grep reconnect && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`

Expected: no duplicated numbered bytes, durable cursor convergence, all control acknowledgements under one second during the 10 MiB burst, no local terminal freeze, and all standalone tests remain green.

- [ ] **Step 9: Commit recovery hardening**

```bash
git add packages/firebase packages/webrtc apps/desktop apps/web tests/e2e/remote-reconnect.spec.ts
git commit -m "feat: recover remote terminals from durable cursors"
```

---

### Task 12: Prove Forced Cloudflare TURN and Add the Remote Release Gate

**Files:**

- Create: `scripts/run-turn-smoke.mjs`
- Create: `scripts/scan-client-artifacts.mjs`
- Create: `tests/e2e/remote-turn.spec.ts`
- Create: `.github/workflows/turn-smoke.yml`
- Create: `docs/remote-access-operations.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `scripts/ensure-packaged-helper-mode.mjs`

**Interfaces:**

- Consumes: complete remote access implementation from Tasks 1–11 and a deployed trusted Firebase environment whose Cloudflare secret was set interactively after credential rotation.
- Produces: opt-in UDP/TCP/TLS relay smoke, revocation proof, App Check/deployment runbook, packaged native validation, artifact/history scan, and the final remote release gate.

- [ ] **Step 1: Write a guarded trusted-smoke runner and failing test**

`run-turn-smoke.mjs` refuses to start unless all of these environment names are present: `CODRA_TURN_SMOKE_BASE_URL`, `CODRA_TURN_SMOKE_EMAIL`, `CODRA_TURN_SMOKE_PASSWORD`, `CODRA_TURN_SMOKE_PROJECT_ID`, and `CODRA_TURN_SMOKE_TRANSPORT`. It never accepts a Cloudflare bearer or key ID. The transport must be exactly `udp`, `tcp`, or `tls`.

The test signs the packaged or release-candidate Electron app and hosted web client into the trusted Firebase account, obtains host approval through visible UI, connects with both peers set to relay-only and the chosen URL family, opens a terminal, sends a marker, and checks browser `getStats()`:

```ts
expect(selectedPair.localCandidateType).toBe("relay");
expect(selectedPair.remoteCandidateType).toBe("relay");
expect(selectedPair.state).toBe("succeeded");
```

Close normally, assert the session is `closed`, and use workload identity plus Admin SDK to verify the corresponding `serverTurnIssuances` document is gone. The test never prints ICE server objects, SDP, candidate addresses, usernames, credentials, Auth tokens, or account passwords.

- [ ] **Step 2: Run without trusted variables and verify a safe RED**

Run: `pnpm test:turn`

Expected: exit nonzero before browser/Electron launch and print only the missing environment variable names, never values.

- [ ] **Step 3: Add relay transport filtering only to trusted smoke builds**

Build the web smoke artifact with `VITE_CODRA_TRUSTED_TURN_SMOKE=true` and inject the selected transport from the runner; launch Electron with `CODRA_TRUSTED_TURN_SMOKE=1`. Both flags are accepted only for the configured trusted project and force `iceTransportPolicy: "relay"`. UDP retains only `turn:` UDP URLs, TCP only `turn:` TCP URLs, and TLS only `turns:` URLs. Normal production builds keep all valid non-port-53 URLs and policy `all`.

- [ ] **Step 4: Rotate and configure the long-lived secret without command-line exposure**

Revoke the credential shared during design and create a replacement with the minimum Cloudflare TURN permission. From an authenticated operator shell, run only:

```bash
firebase functions:secrets:set CLOUDFLARE_TURN_CONFIG
```

Paste the structured JSON at the interactive prompt. Do not put it in shell history, `.env`, CI variables, Firebase client config, logs, docs, test recordings, or source. Deploy only after the secret is present, then delete any local scratch material.

- [ ] **Step 5: Add App Check and deployment operations**

`docs/remote-access-operations.md` records: deploy Functions/Rules/indexes/Hosting to `asia-northeast3`; configure all four TTL policies; configure web reCAPTCHA Enterprise and `CODRA_DESKTOP_FIREBASE_APP_ID`; grant the Functions runtime service account `roles/iam.serviceAccountTokenCreator` on itself for Admin App Check token signing; verify signed desktop custom-provider tokens and legitimate web traffic in metrics mode; enable Cloud Firestore App Check enforcement only after both web and desktop metrics are valid; manually enforce App Check for the web participant in shared TURN callables while the host participant also supplies a signature; leave host bootstrap/App Check-mint/heartbeat/approval callables on Auth+signature validation; verify 30-second heartbeat and 90/120-second stale display behavior; and rollback by disabling remote access without touching local terminals.

- [ ] **Step 6: Add client/build/history secret and data-plane scans**

`scan-client-artifacts.mjs` scans tracked source, web `dist`, Electron `app.asar` listing/unpacked resources, sourcemaps, test artifacts, and commits introduced by this plan. It rejects private-key fields, Firebase Admin/service-account keys, long bearer-like values, Cloudflare Authorization headers, TURN password fixtures outside explicitly generated unit helpers, and known remote E2E terminal markers in Firestore exports. It reports only file/commit and rule name, never the matched value.

- [ ] **Step 7: Extend packaged validation for `node-datachannel`**

Require the selected `node-datachannel` `.node` binary under `app.asar.unpacked`, mode-readable, and Mach-O architecture matching the host package. Launch the exact fresh host artifact, verify remote-disabled local PTY smoke first, then leave real Firebase/TURN access to the trusted workflow. Archive the app in a tar container that preserves executable modes.

- [ ] **Step 8: Run the trusted three-transport matrix**

In the protected manual/deployment workflow, authenticate to Firebase through workload identity, deploy the smoke Hosting build, and run:

```bash
CODRA_TURN_SMOKE_TRANSPORT=udp pnpm test:turn
CODRA_TURN_SMOKE_TRANSPORT=tcp pnpm test:turn
CODRA_TURN_SMOKE_TRANSPORT=tls pnpm test:turn
```

Expected: all three selected candidate pairs are relay/relay and succeeded, terminal control works, normal closure revokes issuance, and logs/artifacts contain no sensitive body. This workflow never runs for pull requests or untrusted forks.

- [ ] **Step 9: Run the full local/CI release gate from fresh output**

Run in this exact order on macOS:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:rules
pnpm build
pnpm test:e2e
pnpm test:remote:direct
pnpm test:remote -- --grep reconnect
pnpm --filter @codra/desktop package:dir
pnpm test:packaged
pnpm package:archive
pnpm scan:client-artifacts
```

Expected: every command exits 0, standalone local mode remains network-independent, remote direct/reconnect tests pass with emulators, the fresh packaged app passes real PTY smoke, and scanners find no long-lived secret or terminal data in the Firebase plane.

- [ ] **Step 10: Commit the remote release gate**

```bash
git add scripts/run-turn-smoke.mjs scripts/scan-client-artifacts.mjs tests/e2e/remote-turn.spec.ts .github/workflows README.md docs/remote-access-operations.md package.json apps/desktop/electron-builder.yml scripts/ensure-packaged-helper-mode.mjs
git commit -m "test: gate Firebase WebRTC remote access"
```

## Remote Access Completion Gate

Do not declare the phase complete until fresh evidence proves every item:

- Standalone Electron launch/local PTY/window-close/reopen/Quit still works with Firebase and Cloudflare blocked.
- Remote is disabled by default, and disabled startup initializes neither Firebase, `safeStorage`, nor `node-datachannel`.
- Host and browser can authenticate to the same account; fresh hosts appear within 60 seconds and stale hosts disappear within 120 seconds.
- A new browser remains blocked until the selected host signs and locally approves the exact nonce/scopes/expiry; altered signatures and another same-account browser cannot forge that host's decision.
- Cross-user device/session/signal access, client host writes, client approval, invalid transitions, expired signals, oversized SDP/candidates, and all server TURN collection access are denied by emulator tests.
- Direct emulator E2E connects browser WebRTC to Electron-main `node-datachannel`, operates a main-owned PTY, and remains connected when the Electron window is closed.
- Trusted smoke proves relay-only UDP, TCP, and TLS candidate pairs through Cloudflare TURN and verifies normal revocation.
- Web can list, create, attach, type, resize, detach, reload, and reattach to a host PTY from its durable cursor without duplicated bytes.
- A 10 MiB output burst keeps ping, input, resize, and detach acknowledgements below one second and never freezes the local Electron terminal.
- Firestore contains only device/session/SDP/ICE metadata; no terminal input, output, prompt, file, environment, or scrollback data.
- Session expiry blocks new signals/TURN issuance; disconnect performs one ICE restart then fresh-peer/fresh-credential fallback only within the approved eight-hour lease.
- Web App Check, host signatures, Rules, TTL policies, issuance limits, log redaction, and safe errors are enabled as documented.
- Source, Git commits introduced by this plan, web build, packaged Electron resources, logs, traces, and uploaded artifacts contain no Cloudflare long-lived credential, Firebase Admin/service-account key, TURN password, P-256 private key, or authorization token.
- Unit, Rules emulator, Functions, direct/reconnect integration, standalone E2E, web production build, desktop package, and artifact scan gates pass in CI; the real TURN matrix passes only in the protected trusted environment.

## Self-Review Checklist Before Execution

- [ ] Map every design acceptance criterion 1–17 to at least one task and one executable gate above.
- [ ] Search this plan for unfinished-marker words, ellipses standing in for code, mismatched paths, and undefined public types; remove every occurrence.
- [ ] Confirm `RemoteSessionStatus`, scopes, callable names, channel labels, canonical signature payloads, timeouts, watermarks, TTLs, frame sizes, cursor fields, and method names are identical in every task.
- [ ] Confirm the only long-lived TURN secret reference is the name `CLOUDFLARE_TURN_CONFIG`; neither a key ID nor token value appears anywhere in implementation guidance.
- [ ] Confirm Tasks 7–9 edit disjoint app lanes after Tasks 1, 3, 4, and 6 freeze interfaces, and that Tasks 10–12 are explicit convergence gates.

## Execution Handoff

Plan complete at `docs/superpowers/plans/2026-08-01-codra-remote-access.md`. Execute only after the standalone completion gate is green.

1. **Subagent-Driven (recommended):** dispatch a fresh implementer and two-stage reviewer per task, using the parallel lanes above.
2. **Inline Execution:** use `superpowers:executing-plans` in batches with review checkpoints after Tasks 2, 6, 9, 10, and 12.
