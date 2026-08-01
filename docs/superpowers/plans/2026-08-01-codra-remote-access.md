# CODRA Firebase/WebRTC Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Track every checkbox, review each task before releasing a dependent lane, and use superpowers:verification-before-completion before claiming a gate passes.

**Goal:** Add opt-in remote terminal access to the verified standalone CODRA Electron app. An authenticated browser can discover one of the same account's running Electron hosts, request a session, obtain an explicit local approval, and use that host's PTY over direct or Cloudflare TURN-relayed WebRTC. Firebase remains control plane only.

**Architecture:** Production account bootstrap uses Google through the trusted Firebase Hosting origin. The browser uses normal Firebase Google Auth; Electron opens that hosted bridge in the system browser and receives only a one-shot PKCE/state-bound authorization code on a random 127.0.0.1 callback, never a Google credential. Each browser and Electron installation then proves possession of its own P-256 key and receives a device-scoped custom-token Auth session. Electron main is the only PTY and host WebRTC owner. Firestore carries short-lived, participant-bound, signed device/session/SDP/ICE records. Firebase Functions own proof/login transactions, presence, session decisions, desktop App Check bootstrap, and durable TURN issuance/revocation. Reliable ordered DataChannels carry authenticated control messages and terminal bytes without blocking standalone startup.

**Tech stack:** Existing Node.js 22.22+, pnpm 11.5.2, Electron 43.2.0, React 19.2.8, TypeScript 5.9.3, Vitest 4.1.10, Playwright 1.62.1, Zod 4.4.3, node-pty 1.1.0, xterm.js 6.0.0; add Firebase JS SDK 12.17.0, Firebase Admin 14.2.0, Firebase Functions 7.3.2, Firebase CLI 15.25.1, @firebase/rules-unit-testing 5.0.1, and node-datachannel 0.32.3.

## Non-negotiable contracts

- Start only after docs/superpowers/plans/2026-08-01-codra-standalone-electron.md passes from a fresh macOS build.
- Remote access is off by default. Remote enablement, Auth, App Check, Firestore, WebRTC, or TURN failure must not block or degrade local create, input, resize, output, replay, reopen, and Quit.
- Electron main owns Firebase host state, the P-256 private key, node-datachannel peers, authorization, and all PTYs. No daemon, launch agent, hidden renderer, browser-hosted local shell, or independent background process is added.
- Renderer security remains contextIsolation true, sandbox true, and nodeIntegration false. Only versioned, strict, Zod-validated IPC enters window.codra.
- Firestore and Functions logs never contain terminal input/output, commands, prompts, environment values, repository or file content, scrollback, SDP contents, ICE candidate contents, private keys, Auth/App Check tokens, or TURN passwords.
- The browser private key is a non-extractable P-256 CryptoKey stored directly in IndexedDB. Its public key is exportable. Electron stores a P-256 private JWK only as async safeStorage ciphertext in a mode 0600 file.
- The immutable device key identifier is the RFC 7638 SHA-256 thumbprint of canonical JSON containing only crv, kty, x, and y in that lexical order. x and y are strict unpadded base64url and each decode to exactly 32 bytes. Import/on-curve validation is mandatory.
- Production browser registration/resume/re-enable requires a Google account token whose firebase.sign_in_provider is google.com and whose auth_time is at most five minutes old and no more than 30 seconds ahead of server time. Email/password exists only behind compile-time emulator/remote-test bindings and is denied/absent from production release paths.
- Electron production never embeds Google OAuth. It uses the exact Firebase Hosting login bridge, a one-shot server login transaction bound to its device key plus PKCE/state/nonce, and a random ephemeral 127.0.0.1 callback. No Google credential crosses renderer IPC, reaches the loopback callback, or is persisted.
- `codra-1b3bb` is the only real Firebase project. Normal development and CI use only the `demo-codra` emulator. Any real-project canary, Google/App Check bridge, or Cloudflare smoke must have `CODRA_LIVE_TEST=1` plus literal `--project codra-1b3bb --confirm-project codra-1b3bb`; an infrastructure release instead requires `CODRA_RELEASE_DEPLOY=1` plus the same project literals and exact approved account/candidate confirmations. Neither uses an implicit/default alias or runs in normal CI.
- Live tests use one externally durable, pre-provisioned Google test account plus operator-maintained host/browser device-and-key profiles for Chrome, Firefox, and ordinary Safari; approved UID/creation/provider and device/key fingerprints are frozen in the nonsecret authority policy. Scripts never request Auth-user or durable-device creation/deletion. Normal product flows may create server-generated proof/login attempts, nonces, sessions, issuances, deterministic revocation jobs, and shared HMAC rate-limit state whose IDs are not all known in advance. These remain product-owned bounded-retention side effects. The suite uses very short legal leases, terminalizes known sessions, reconciles known issuances, retains a 30-day high-level run tombstone, and relies on synchronous expiry plus the scheduled reconciler/sweeper and overdue alerts for abandoned records; TTL is retention only.
- Every device document has server-authored active and generation fields. Every custom token/session carries codraDeviceGeneration, and every device-scoped Firestore Rules helper and Function guard requires firebase.sign_in_provider custom, loads the authoritative device once, and requires active true plus exact device ID, thumbprint, kind, and generation. Device disable/re-enable increments generation so still-cryptographically-valid stale refresh/ID tokens fail.
- Device registration, resume, heartbeat, desktop login/App Check bootstrap, and TURN operations use server-created, purpose-bound, short-lived, one-shot proof/login transactions. A Firestore transaction consumes each exactly once.
- Firebase Authentication App Check enforcement remains OFF in this MVP so initial Google or emulator-only password bootstrap can succeed. Raw register/resume/re-enable and desktop login/App Check endpoints have no callable App Check option and enforce their documented manual boundary; selected callables retain `enforceAppCheck`. Firestore enforcement and operational callables turn on only after the web or desktop provider is initialized.
- The initial desktop App Check client is raw HTTP. It receives only an Auth ID-token supplier, host signer, clock, and fetch; it imports neither Firebase Functions nor Firebase App Check. A separate module later wraps returned tokens in Firebase CustomProvider.
- Device presence is Admin-written only. A signed heartbeat causes the server to set lastSeenAt to server time and expiresAt to server time plus 120 seconds. Clients cannot write device presence. Hosts heartbeat every 30 seconds, and host discovery has a local deadline timer so a stale host disappears without another snapshot.
- A session lease is caller-selected up to a maximum of eight hours and a signal lease is at most one hour. Stored session status never equals expired. deriveSessionState returns expired when any nonterminal state reaches expiresAt. After expiry every normal/client write, signal, TURN issuance, and PTY operation is denied. Only the narrow Admin cleanup transition may fail the expired session, remove exact registry IDs, and enqueue known-issuance revocation.
- Every signal includes negotiationId, sender and recipient device IDs, signer thumbprint, signer generation, sequence, kind, payload, expiry, and an IEEE-P1363 P-256 signature. Its sequence key is exactly (sessionId, negotiationId, senderDeviceId, recipientDeviceId): each direction starts at 1, increments contiguously, and resets only for a new negotiationId. The receiver verifies before applying SDP or ICE.
- The DataChannel hello includes both device IDs, both thumbprints, clientChallenge, hostChallenge, sessionId, negotiationId, and protocol version. The hello_ack repeats that binding and signs the SHA-256 hash of the canonical hello. Neither side processes terminal operations before both signatures and the transcript are verified.
- Signal reads are cursor based: afterSequence, negotiationId, and limit at most 500. A full page drains again before installing a listener. Listener errors and full snapshots return to drain mode.
- WebRTC negotiation has a 20-second deadline. Connected peers ping every five seconds; three missed pongs disconnect. The browser is the only ICE-restart offerer: it calls browser RTCPeerConnection.restartIce, creates a fresh negotiationId and offer, and the host closes the old PeerConnection and answers the new offer. Old-negotiation candidates are rejected.
- Browser ICE may select Cloudflare UDP, TCP, or TLS. node-datachannel/libjuice host support in this slice is Cloudflare TURN UDP only and is normalized to TurnUdp. No test or release claim may attribute host TCP/TLS relay support.
- Cloudflare long-lived settings exist only in the structured Firebase secret CLOUDFLARE_TURN_CONFIG. Previously exposed credentials must be rotated and never copied into source, env files, fixtures, logs, commands, artifacts, or this plan.
- IP rate-limit hashing uses the separate `CODRA_RATE_LIMIT_PEPPER` Firebase secret, decoded to at least 32 random bytes. It is bound only to Functions that hash an IP and is never logged, returned, or reused as the Cloudflare secret.
- Cloudflare generation uses ttl 86400, expects HTTP 201, and makes exactly one five-second-bounded attempt. It never retries a timeout, network error, HTTP 5xx, malformed/partial response, or any other ambiguous outcome because the endpoint supplies no idempotency key; the caller fails closed, releases only its reservation, retains the rolling attempt, and reports `TURN_GENERATION_AMBIGUOUS`. A possible credential created behind an ambiguous response cannot be named or revoked and expires within the requested 86,400-second TTL. Revocation is a separate durable POST-only workflow, expects HTTP 204, and may retry network/5xx outcomes from persisted jobs; HTTP 4xx is never retried.
- Both DataChannels are reliable and ordered. Labels are codra.control.v1 and codra.terminal.v1. CONTROL_MAX_UTF8_BYTES is exactly 72 KiB. Terminal input is at most 64 KiB by UTF-8 bytes, not JavaScript string length. Output frame payload is at most 16 KiB.
- Remote terminal operations are terminal.list, terminal.create, terminal.attach, terminal.detach, terminal.write, and terminal.resize. Destructive terminal.close is not in this MVP; terminal.detach only removes the remote attachment and never kills the local PTY. terminal.ok is the correlated result and terminal.cursor_ack is fire-and-forget. Per-session terminal input uses a 128 KiB-capacity token bucket refilled at 64 KiB/s.
- Every Firebase Functions v2 export is explicitly configured with the shared region constant asia-northeast3, including HTTP, callable, Firestore trigger, and scheduled TURN worker exports.
- Every at-least-once trigger/reconciler rereads the authoritative current source plus durable run/session/issuance state immediately before a derived write. An absent or terminal source cannot recreate optional product data; only a still-required deterministic revocation job for a known issuance may be created after terminalization.
- Live terminal output pauses at 1 MiB DataChannel bufferedAmount and resumes below 256 KiB from the last acknowledged durable cursor.
- Production files should stay focused; split implementations near 250 lines. Every behavior change follows red-green-refactor and each task ends in a focused commit.

## Primary contract references

- Cloudflare generation/revocation: https://developers.cloudflare.com/realtime/turn/generate-credentials/
- Cloudflare TURN endpoints and ports: https://developers.cloudflare.com/realtime/turn/
- Firebase custom App Check providers: https://firebase.google.com/docs/app-check/custom-provider
- Firebase custom provider for web: https://firebase.google.com/docs/app-check/web/custom-provider
- Firebase callable App Check enforcement: https://firebase.google.com/docs/app-check/cloud-functions
- Firebase custom-token additional claims and sign-in: https://firebase.google.com/docs/auth/admin/create-custom-tokens
- Firebase Auth custom-token exchange ID/refresh pair: https://firebase.google.com/docs/reference/rest/auth#section-verify-custom-token
- Firestore Rules emulator: https://firebase.google.com/docs/firestore/security/test-rules-emulator
- node-datachannel 0.32.3 exported source/types: https://github.com/murat-dogan/node-datachannel/blob/v0.32.3/src/lib/index.ts and https://github.com/murat-dogan/node-datachannel/blob/v0.32.3/src/lib/types.ts
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage

## Exact dependency DAG and file ownership

```text
Standalone completion gate
          |
          v
        Task 1
          |
          v
        Task 2
          |
     +----+----+
     v         v
   Task 3    Task 6
     +----+----+
          v
        Task 4
          |
    +-----+-----+
    v     v     v
 Task 5 Task 7 Task 9
          |
          v
        Task 8
    +-----+-----+
    | Task 5 + |
    | Task 8 + |
    | Task 9   |
    +-----+-----+
          v
       Task 10
          |
          v
       Task 11
          |
          v
       Task 12
```

The exact DAG is Task 1 → Task 2 → (Task 3 || Task 6) → Task 4 → (Task 5 || Task 7 || Task 9), Task 7 → Task 8, and (Task 5 + Task 8 + Task 9) → Task 10 → Task 11 → Task 12.

Inside Task 12 the release lane is strictly `actual outputs → deterministic candidate → approved maintenance-lease release → authoritative receipt`; only that receipt unlocks the separate `bounded-retention live suite → known-session terminalization/issuance reconciliation` lane. A failed release operation or active mutually exclusive lease blocks both lanes.

- Task 1 alone owns and freezes protocol schemas, signed canonical payloads, status derivation, cursor contracts, and TURN response schemas.
- Task 2 alone owns every package.json, pnpm-lock.yaml, pnpm-workspace.yaml, root script, Electron/Vite/builder configuration, native-module allowlist, and remote-test build flavor.
- Tasks 3 and 6 edit disjoint packages and may run in parallel after Tasks 1 and 2 pass review.
- Tasks 5, 7, and 9 edit disjoint Functions, desktop, and web lanes and may run in parallel after Task 4.
- No task after Task 1 may redefine its exported contracts. No task after Task 2 may edit a manifest, lockfile, workspace file, Electron build configuration, or builder configuration.

## Planned ownership tree

```text
packages/protocol        Task 1: frozen documents, signatures, messages, frames
all manifests/build      Task 2: dependencies, scripts, native and test flavors
packages/firebase        Task 3: tagged config, refs, rules-facing client APIs
functions identity       Task 4: proofs, device Auth, presence, App Check, decisions
functions TURN           Task 5: Cloudflare boundary, rolling limits, compensation
packages/webrtc          Task 6: crypto verification, ICE, channels, pressure
apps/desktop remote      Task 7: identity, raw bootstrap, controller, IPC, UI
apps/desktop host peer   Task 8: node-datachannel and authenticated PTY gateway
apps/web                 Task 9: browser key, scoped Auth, peer, cursor, terminal UI
direct E2E               Task 10: emulator convergence and same-UID attacker
recovery E2E             Task 11: pages, restart, cursors, pressure, token bucket
trusted/release          Task 12: deterministic candidate, release control, retention-bound live matrix, scanner
```

---

### Task 1: Freeze the Authenticated Protocol and Durable Cursor Contract

**Files**

- Create packages/protocol/src/remote.ts
- Create packages/protocol/src/remote-signing.ts
- Create packages/protocol/src/remote-server.ts
- Create packages/protocol/src/deployment.ts
- Create packages/protocol/src/terminal-frame.ts
- Create packages/protocol/test/remote.test.ts
- Create packages/protocol/test/deployment.test.ts
- Create docs/security/remote-baseline.json
- Modify packages/protocol/src/terminal.ts
- Modify packages/protocol/src/index.ts
- Modify apps/desktop/src/main/terminal/scrollback.ts
- Modify apps/desktop/src/main/terminal/scrollback.test.ts

**Produces**

- Strict device, session, signal, live-run/server-registry/TURN-outbox, deployment, remote-terminal-descriptor, control-message, canonical-signing, and output-frame schemas.
- deriveSessionState(session, now).
- FileTerminalOutputStore.readFromCursor(terminalId, afterCursor, maxBytes) plus its frozen result type; Task 8 alone adds the TerminalManager adapter.
- No dependency or manifest change.

- [ ] **Step 0: Record and verify the standalone Git baseline**

Before any Task 1 source edit, write docs/security/remote-baseline.json with the exact 40-character output of git rev-parse HEAD, schemaVersion 1, and purpose remote-implementation-secret-scan. Verify that commit passes the standalone completion gate and is an ancestor of every later remote commit. The final scanner uses baselineCommit..HEAD plus index/worktree and all intermediate reachable blobs, so an introduced-then-deleted secret remains detectable.

- [ ] **Step 1: Add failing schema, signature-payload, and cursor tests**

Test at least:

- Unknown fields, padded/non-base64url values, a 31-byte or 33-byte x/y coordinate, a signature not exactly 64 decoded bytes, mismatched thumbprints, or unsafe integers are rejected.
- The RFC 7638 input is byte-for-byte canonical JSON with only crv, kty, x, y in lexical order.
- Session request, approval, rejection, signal, hello, and hello_ack canonical payload snapshots are stable under input object property reordering.
- Session expiry one millisecond after request time and exactly request time plus eight hours pass; expiry at/before request time or beyond eight hours fails the Rules-facing bound helper.
- Expired-session cleanup accepts only a derived-expired nonterminal session plus its exact expected update time, produces `failed`/`LEASE_EXPIRED` with a server `closedAt`, removes only that session ID from both registries, and idempotently enqueues/reconciles revocation for its known persisted issuances. A nonexpired, differently terminal, or raced session refuses, and no client-callable path can invoke the cleanup.
- Signal sequence is keyed by the exact four-tuple, starts at 1 independently in both directions, rejects 0/gaps/duplicates, and resets for a new negotiationId.
- Input containing 64 KiB of ASCII passes; a JavaScript string whose UTF-8 encoding exceeds 64 KiB fails.
- A 72 KiB control JSON byte payload passes and the next byte fails.
- terminal.ok requires requestId and operation; terminal.cursor_ack has no response/request correlation.
- terminal.list has a bounded descriptor result, terminal.detach is non-destructive, and terminal.close is rejected as an unknown MVP operation.
- Production deployment constants contain only the two exact HTTPS Hosting origins, Google provider, canonical `/desktop-auth` bridge, canonical Firebase Auth handler, and distinct bridge/desktop Firebase Web App IDs; emulator constants contain only demo-codra, 127.0.0.1:5000, and the test-only password provider.
- PKCE accepts only a 43-character unpadded base64url verifier generated from exactly 32 random bytes, and the challenge equals unpadded base64url SHA-256 over the verifier's ASCII bytes; padded, non-ASCII, non-unreserved, or 42/44-character fixtures fail.
- RemoteTerminalDescriptor rejects cwd, command, environment, scrollback, output, and every unknown field.
- Turn revocation jobs always require `credentialExpiresAt`; pending/leased/retry_wait reject `ttlDeleteAt`, completed requires completedAt plus seven days, terminal_failure requires its terminal time plus 30 days, and naturally_expired requires naturallyExpiredAt plus 30 days. The old overloaded job expiry field is rejected.
- Live-run variants accept only bounded post-response exact known session/issuance IDs (hash-only in output), safe counters/status, stable account/device-profile fingerprints, candidate receipt hash when required, terminal/revocation summary, and a terminal-state `ttlDeleteAt`; they reject credentials, complete mutation ledgers, proof/login/nonce IDs, product-document deletion lists, and shared rate-state cleanup intents. The singleton server-time live lease is mutually exclusive with the deployment lease.
- 16 KiB output frames round-trip and the next byte fails.
- Absolute output cursors survive scrollback compaction.

Run:

```sh
pnpm --filter @codra/protocol test -- test/remote.test.ts
pnpm --filter @codra/desktop test -- src/main/terminal/scrollback.test.ts
```

Expected: RED because these contracts do not exist.

- [ ] **Step 2: Define exact constants and strict public-key/signature primitives**

Export:

```ts
REMOTE_PROTOCOL_VERSION = 1;
ACCOUNT_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
ACCOUNT_AUTH_FUTURE_SKEW_MS = 30 * 1000;
PKCE_VERIFIER_RANDOM_BYTES = 32;
PKCE_VERIFIER_LENGTH = 43;
REMOTE_SESSION_MAX_LEASE_MS = 8 * 60 * 60 * 1000;
SIGNAL_LEASE_MS = 60 * 60 * 1000;
DEVICE_PRESENCE_LEASE_MS = 120 * 1000;
CONTROL_MAX_UTF8_BYTES = 72 * 1024;
TERMINAL_INPUT_MAX_UTF8_BYTES = 64 * 1024;
TERMINAL_FRAME_MAX_BYTES = 16 * 1024;
SIGNAL_PAGE_LIMIT = 500;
PENDING_SESSION_LIMIT = 50;
MAX_ACTIVE_REMOTE_SESSIONS_PER_DEVICE = 16;
MAX_ACTIVE_TURN_ISSUANCES_PER_SESSION = 12;
FUNCTION_REGION = "asia-northeast3";
```

PublicEcJwkSchema is strict and permits exactly kty EC, crv P-256, x, and y. It validates unpadded base64url and decoded coordinate lengths before any crypto import. ThumbprintSchema is an unpadded, 32-byte SHA-256 base64url digest. P256SignatureSchema is an unpadded, exactly 64-byte IEEE-P1363 value.

PkceVerifierSchema is exactly 43 unpadded base64url characters because generation is `base64url(randomBytes(32))`; this is within RFC 7636's 43–128 unreserved-character bound. PkceChallengeSchema is an unpadded 32-byte base64url digest computed as `BASE64URL(SHA256(ASCII(verifier)))`. No UTF-8 normalization, padding, hexadecimal form, caller-chosen verifier, or alternate method is accepted; `desktopLoginStart` stores only the S256 challenge and redeem verifies the supplied verifier against it.

Canonical RFC 7638 bytes are UTF-8 of one whitespace-free object whose keys are emitted in the exact order crv, kty, x, y and whose x/y values are the validated input strings. Freeze a complete fixed public-key test vector and expected thumbprint in remote.test.ts. Do not include alg, use, key_ops, ext, device ID, or display name in the thumbprint.

deployment.ts freezes a discriminated union:

- ProductionDeploymentConfig: mode production, projectId exactly codra-1b3bb, accountBootstrapProvider google.com, browser origins exactly https://codra-1b3bb.web.app and https://codra-1b3bb.firebaseapp.com, desktopAuthBridgeUrl exactly https://codra-1b3bb.firebaseapp.com/desktop-auth, firebaseAuthHandlerUrl exactly https://codra-1b3bb.firebaseapp.com/__/auth/handler, bridgeFirebaseAppId exactly 1:92715578857:web:6c07f26a4866a1d4d3c778, separately provisioned and operator-approved desktopAppCheckFirebaseAppId, Firebase Authentication App Check enforcement false, Functions region asia-northeast3. Parse fails when either app ID is absent or the two are equal; implementation stops for the real second ID and never invents one.
- EmulatorDeploymentConfig: mode emulator, projectId demo-codra, accountBootstrapProvider password-test-only, browser origin exactly http://127.0.0.1:5000, every service endpoint loopback, build flavor remote-test, Functions region asia-northeast3.

No merge/fallback is permitted. Production exports and client builds must be statically unable to import the emulator origin/provider. AUTH_APP_CHECK_ENFORCEMENT is frozen false for both variants in this MVP; Firestore and operational Function App Check are separate surface settings.

- [ ] **Step 3: Freeze stored device and session shapes**

RemoteDevice contains:

- deviceId, ownerUid, kind host or browser, displayName.
- publicKeyJwk and immutable keyThumbprint.
- server-authored active, positive safe-integer generation, remoteAccessEnabled, and capabilities.
- createdAt, lastSeenAt, and expiresAt as server timestamps.

Only Functions/Admin write device documents.

ServerDeviceSessionRegistrySchema is Admin-only at serverDeviceSessionRegistries/{deviceScopeHash}. It binds ownerUid/deviceId/generation, contains at most 16 activeSessionIds, updatedAt, and optional expiresAt only after it becomes empty/inactive. Client device documents never expose active session IDs. ServerLiveTestRunSchema is an Admin-only purpose-discriminated tombstone at `serverLiveTestRuns/{runId}`. Both variants strictly contain schemaVersion, runId, purpose, knownUidFingerprint, stableDeviceProfileFingerprints, state running/terminalizing/terminal/revocation_pending/abandoned, server-time createdAt/updatedAt/runLeaseExpiresAt, bounded post-response exact knownSessionIds and knownIssuanceIds, bounded safe counters, lastSafeStatus, and optional ambiguousTurnUntil. These opaque IDs never enter normal output; receipts expose only their hashes. `live-release-smoke` additionally requires candidateSha256 and releaseReceiptHash; `claim-isolation-canary` rejects both and has zero session/issuance entries. Terminal, abandoned, and fully reconciled revocation states require `ttlDeleteAt` equal to the terminal transition plus 30 days; active states reject it. The schema rejects credentials, per-mutation intent/outcome ledgers, product-document deletion lists, proof/login/nonce IDs, shared rate-limit document identifiers, wildcards, and unknown fields. Create-only callers cannot overwrite an existing run. ServerLiveTestLeaseSchema is the separate strict Admin-only singleton at `serverLiveTestLeases/codra-1b3bb`; it freezes run ID, candidate/receipt/profile fingerprints, state active/terminalizing, server-time creation/heartbeat/expiry, and is transactionally mutually exclusive with the project deployment lease. ServerRemoteReleaseOperationSchema is Admin-only at `serverRemoteReleaseOperations/{opId}` and freezes candidate/account/release-control-principal fingerprints, selector/pre-state/attestation hashes, monotonically increasing fencing token, server-time lease/heartbeat timestamps, bounded LRO resource hashes, and state deploying/failed_blocking/succeeded/superseded. ServerRemoteReleaseReceiptSchema contains only the candidate hash, authoritative attestation hash, release-control-principal fingerprint, operation ID, fencing token, and server timestamps. None of these schemas contains a credential or secret value. TurnIssuanceSchema, TurnRateLimitSchema, TurnRevocationJobSchema, BootstrapRateLimitSchema, and DesktopLoginTransactionSchema are also strict Admin-only server shapes frozen in remote-server.ts.

RemoteSession stored status is exactly:

```text
requested | approved | rejected | signaling | connected |
disconnected | closed | failed
```

There is no stored expired value. The immutable binding contains sessionId, ownerUid, clientDeviceId, hostDeviceId, clientKeyThumbprint, hostKeyThumbprint, clientDeviceGeneration, hostDeviceGeneration, protocolVersion, requestedScopes, clientChallenge, requestSignature, createdAt, and expiresAt. createdAt is server request time. The browser chooses/signs expiresAt; it must be later than createdAt and no later than createdAt plus REMOTE_SESSION_MAX_LEASE_MS. Approval fields contain approvedScopes, hostChallenge, approvalSignature, and decidedAt. Rejection fields contain approvedScopes empty, rejectionReason, rejectionSignature, and decidedAt.

RemoteFailureCodeSchema is exactly AUTH_FAILED, HOST_OFFLINE, APPROVAL_INVALID, NEGOTIATION_TIMEOUT, ICE_FAILED, CHANNEL_CLOSED, PROTOCOL_ERROR, INTERNAL_ERROR, or LEASE_EXPIRED.

Validate these exact status/timestamp combinations:

- requested: decidedAt, connectedAt, disconnectedAt, closedAt, failureCode, hostChallenge, approvalSignature, rejectionReason, and rejectionSignature absent.
- approved or signaling: decidedAt, hostChallenge, and approvalSignature present; connectedAt, disconnectedAt, closedAt, and failureCode absent.
- rejected: decidedAt, closedAt, rejectionReason, and rejectionSignature present; approvedScopes is empty; hostChallenge, approvalSignature, connectedAt, disconnectedAt, and failureCode absent.
- connected: decidedAt and connectedAt present; disconnectedAt, closedAt, and failureCode absent.
- disconnected: decidedAt, connectedAt, and disconnectedAt present; closedAt absent; failureCode is ICE_FAILED or CHANNEL_CLOSED.
- closed: closedAt present and failureCode absent. The only allowed histories are cancel before decision with no decided/connected/disconnected timestamp, close after approval with decidedAt but no disconnectedAt, or close after connection with decidedAt and connectedAt and optional disconnectedAt.
- failed: closedAt and failureCode present. AUTH_FAILED, HOST_OFFLINE, or APPROVAL_INVALID require no decided/connected/disconnected timestamp. NEGOTIATION_TIMEOUT or ICE_FAILED require decidedAt and no connected/disconnected timestamp. CHANNEL_CLOSED or PROTOCOL_ERROR require decidedAt plus connectedAt and permit disconnectedAt. INTERNAL_ERROR permits any otherwise valid prefix of requested → approved → connected → disconnected. LEASE_EXPIRED permits any otherwise valid nonterminal prefix; the Admin cleanup helper alone may write it after authoritative server time reaches expiresAt. No other timestamp/failureCode pairing parses.

deriveSessionState returns expired when now is at or beyond expiresAt and the stored status is requested, approved, signaling, connected, or disconnected. It otherwise returns the stored status. rejected, closed, and failed are terminal and remain unchanged.

Freeze `cleanupExpiredRemoteSession({ownerUid, sessionId, expectedUpdateTime})` as a non-exported-callable, Admin-only server helper. Its transaction rereads the exact session and requires the supplied snapshot update time before changing any nonterminal record; authoritative server time must derive `expired`. It then writes only status `failed`, failureCode `LEASE_EXPIRED`, and server `closedAt`; removes only the exact session ID from the two registries derived from the immutable participant bindings; and creates or reconciles deterministic revocation jobs for every bounded persisted issuance already known for that session. A retry that finds the exact `LEASE_EXPIRED` result verifies/reconciles those registry and job effects and succeeds idempotently even when its original update-time precondition is stale; every other update-time mismatch, nonexpired state, or terminal state refuses. The helper cannot extend expiresAt, approve, create signals, issue TURN, attach/write PTYs, delete records, or be reached through a client callable.

- [ ] **Step 4: Freeze signed request, approval, signal, and handshake bytes**

Use one deterministic canonical-JSON routine: UTF-8, recursively sorted object keys, array order retained, no undefined or non-finite numbers, and timestamps represented as integer Unix milliseconds.

Session request signed fields are:

```text
domain, protocolVersion, sessionId, ownerUid,
clientDeviceId, hostDeviceId,
clientKeyThumbprint, hostKeyThumbprint,
clientDeviceGeneration, hostDeviceGeneration,
requestedScopes, clientChallenge, expiresAtMillis
```

Approval signed fields are:

```text
domain, protocolVersion, sessionId,
clientDeviceId, hostDeviceId,
clientKeyThumbprint, hostKeyThumbprint,
clientDeviceGeneration, hostDeviceGeneration,
requestedScopes, approvedScopes,
clientChallenge, hostChallenge, expiresAtMillis
```

RejectionReasonSchema is exactly USER_REJECTED, HOST_BUSY, or HOST_DISABLED. The canonical codra.session-rejection.v1 payload signs domain, protocolVersion, sessionId, ownerUid, both device IDs, both key thumbprints, both device generations, requestedScopes, clientChallenge, rejectionReason, and expiresAtMillis. It never contains hostChallenge or approved scopes.

Every Signal is a strict union of offer, answer, candidate, and end-of-candidates and includes:

```text
sessionId, negotiationId, senderDeviceId, recipientDeviceId,
signerThumbprint, signerDeviceGeneration, sequence, kind, payload,
createdAt, expiresAt, signature
```

The canonical signal digest signs domain, protocolVersion, sessionId, negotiationId, senderDeviceId, recipientDeviceId, signerThumbprint, signerDeviceGeneration, sequence, kind, SHA-256 of canonical payload, and expiresAtMillis. createdAt is server/rules metadata and is not signed. A receiver must check session/negotiation/participants/thumbprint/generation/sequence/expiry and verify the signature before setRemoteDescription or addIceCandidate.

SignalSequenceKey is exactly (sessionId, negotiationId, senderDeviceId, recipientDeviceId). sequence is a positive safe integer: the first signal for each key is 1 and every later signal is exactly previous plus 1. Browser→host and host→browser are independent keys. A new negotiationId starts both directions back at 1; no cursor is shared across direction or negotiation.

The signed hello contains domain, protocolVersion, sessionId, negotiationId, both device IDs, both thumbprints, both device generations, clientChallenge, and hostChallenge. helloTranscriptHash is SHA-256 of the entire canonical signed hello object, including its signature. The signed hello_ack repeats every binding field plus helloTranscriptHash. Browser verifies the host ack; host verifies hello; the gateway remains locked until both pass.

- [ ] **Step 5: Freeze control operations and TURN response shape**

RemoteControlMessage is a strict discriminated union:

- hello and hello_ack as above.
- terminal.list, terminal.create, terminal.attach, terminal.detach, terminal.write, and terminal.resize with requestId.
- terminal.ok with requestId, operation, and operation-specific result.
- terminal.error with requestId, code, and safe message.
- terminal.cursor_ack with terminalId and absolute cursor, explicitly fire-and-forget.
- ping and pong with nonce.
- session.close with a safe reason code.

RemoteTerminalDescriptorSchema is strict and contains only `id`, `title`, `cols`, `rows`, `state`, `createdAt`, and optional `exitCode`; state uses the existing running/exited terminal state union. It cannot contain cwd, command, environment, scrollback, output, or arbitrary metadata.

terminal.list terminal.ok result is exactly `{terminals: RemoteTerminalDescriptor[]}` with at most 100 existing descriptors. terminal.create returns `{terminal: RemoteTerminalDescriptor}`; attach/detach/write/resize return `{terminalId}`. terminal.detach removes only that session's remote attachment/output pump. There is no terminal.close message in this MVP and no remote operation kills a local PTY. Write validates TextEncoder byte length, not string.length. Resize remains 20–400 columns and 5–200 rows.

TurnCredentialResponse contains issuanceId, an array of strict RTCIceServer-compatible entries, issuedAtMillis, and expiresAtMillis. It never contains Cloudflare account, key, API token, Authorization header, or server persistence fields.

TurnRevocationJobSchema state is exactly pending, leased, retry_wait, completed, terminal_failure, or naturally_expired and freezes issuanceId, encoded server-only username, reason, attemptCount, nextAttemptAt, leaseOwnerHash, leaseExpiresAt, createdAt, updatedAt, completedAt, naturallyExpiredAt, required `credentialExpiresAt`, optional `ttlDeleteAt`, and safe lastErrorCode combinations. Only a Cloudflare HTTP 204 sets completed. Reconciliation compares server time with `credentialExpiresAt`; it never uses the Firestore TTL field as credential validity. `ttlDeleteAt` is absent for pending, leased, and retry_wait; completed sets it to completedAt plus seven days; terminal_failure sets it to its terminal transition time plus 30 days; naturally_expired sets it to naturallyExpiredAt plus 30 days. Firestore TTL targets only `ttlDeleteAt`. Passwords never enter a job. Turn issuance and rolling-attempt/reservation schemas keep attempts separate so releasing a reservation cannot erase an attempt.

- [ ] **Step 6: Add the durable output cursor without changing local terminal behavior**

Each persisted chunk has absolute startCursor and endCursor measured in UTF-8 bytes. Compaction may delete old chunks but never rebases later cursors. `FileTerminalOutputStore.readFromCursor` returns:

```ts
{
  chunks: Array<{
    sequence: bigint;
    startCursor: bigint;
    endCursor: bigint;
    data: Uint8Array;
  }>;
  earliestCursor: bigint;
  latestCursor: bigint;
  truncated: boolean;
}
```

If afterCursor precedes earliestCursor, truncated is true and catch-up begins at earliestCursor. Keep the existing 10 MiB local scrollback bound and existing local renderer event behavior.

- [ ] **Step 7: Run Task 1 verification and freeze contracts**

Run:

```sh
pnpm --filter @codra/protocol test
pnpm --filter @codra/protocol typecheck
pnpm --filter @codra/desktop test -- src/main/terminal/scrollback.test.ts
pnpm --filter @codra/desktop typecheck
git diff --check
```

Review canonical snapshots and the no-expired-storage invariant before Task 2.

- [ ] **Step 8: Commit**

```sh
git add packages/protocol apps/desktop/src/main/terminal/scrollback.ts apps/desktop/src/main/terminal/scrollback.test.ts docs/security/remote-baseline.json
git commit -m "feat: freeze authenticated remote protocol"
```

---

### Task 2: Own All Dependencies, Native Packaging, and Test Build Flavors

**Files — exclusive Task 2 ownership**

- Modify .gitignore
- Modify package.json
- Modify pnpm-workspace.yaml
- Modify pnpm-lock.yaml
- Modify apps/desktop/package.json
- Modify apps/desktop/electron.vite.config.ts
- Modify apps/desktop/electron-builder.yml
- Create apps/desktop/electron.remote-test.vite.config.ts
- Create apps/desktop/electron-builder.remote-test.yml
- Create apps/web/package.json
- Create apps/web/tsconfig.json
- Create apps/web/vite.config.ts
- Create packages/firebase/package.json
- Create packages/firebase/tsconfig.json
- Create packages/webrtc/package.json
- Create packages/webrtc/tsconfig.json
- Create functions/package.json
- Create functions/tsconfig.json
- Modify playwright.config.ts
- Create scripts/package-remote-test.mjs
- Create scripts/stage-functions-deploy.mjs
- Create scripts/test-functions-deploy-artifact.mjs
- Create scripts/verify-node-datachannel-package.mjs
- Create scripts/verify-remote-build-config.mjs
- Create scripts/run-bounded-firebase-cli.mjs
- Create scripts/google-rest-client.mjs
- Create scripts/live-test-guard.mjs
- Create scripts/test-live-test-guard.mjs
- Create scripts/run-firebase-claim-canary.mjs
- Create scripts/test-firebase-claim-canary.mjs
- Create scripts/resume-firebase-claim-canary.mjs
- Create scripts/test-resume-firebase-claim-canary.mjs
- Create docs/security/codra-live-authority.json
- Create functions-deploy/package.json
- Create functions-deploy/pnpm-lock.yaml
- Create functions-deploy/.npmrc
- Create tests/e2e/packaged-native-modules.spec.ts

No later task may edit any file in this list.

**Produces**

- A single reviewed lockfile and root command surface.
- A release artifact that can only bind the real Electron safeStorage implementation.
- A separately identified, never-released remote-test Electron artifact with compile-time emulator/test ports.
- node-datachannel native install and package verification.
- A deterministic, self-contained Functions deploy directory and canonical component manifest with no workspace protocol or sibling symlink.
- A doubly guarded `codra-1b3bb` live custom-token claim-isolation decision gate that runs before Task 3 and is never part of normal CI.
- One read-only shared live-target/authority guard, a non-echoing bounded Firebase CLI adapter, and stable-account/profile plus release-control authority policy reused by the Task 2 canary and Task 12 workflows.

- [ ] **Step 1: Write failing workspace/build ownership checks**

Add tests/checks that fail until:

- Every workspace resolves one version of protocol, Firebase, and WebRTC packages.
- pnpm-workspace.yaml contains allowBuilds.node-datachannel: true.
- Release Vite config aliases the SafeStoragePort binding only to the real Electron implementation.
- Release web/desktop Auth aliases select Google/system-browser production adapters only; no signInWithEmailAndPassword import or password-test provider is reachable.
- Remote-test Vite config aliases it only to a test-only implementation, uses appId com.codra.desktop.remote-test, productName CODRA Remote Test, and a distinct output directory.
- Remote-test web/desktop Auth aliases select the demo-codra email/password test adapter and exact http://127.0.0.1:5000 origin.
- There is no runtime environment flag that can select fake safeStorage, inert App Check, demo project, or loopback endpoints in a release bundle.
- electron-builder unpacks node-datachannel native assets for both architectures.
- Live scripts refuse unless `CODRA_LIVE_TEST=1`, `--project codra-1b3bb`, and `--confirm-project codra-1b3bb` are all present as exact values; refuse implicit aliases/defaults and normal CI; and never treat demo-codra as a live target.
- Live guard subprocess capture allowlists only bounded `projects:list --json` and `apps:list WEB --json`, never echoes child stdout/stderr, and parses results into booleans/counts/hashes.
- Read-only preflight never creates a lease/run tombstone. Static tests prove the top-level canary alone acquires the server-time live lease, writes one high-level run tombstone, transitions it terminal, sets 30-day `ttlDeleteAt`, releases the lease, and makes no product-document deletion request.
- Every Firebase CLI child runs in its own run-owned `mkdtemp` working directory with an absolute generated `--config` and absolute source paths, rejects `--token`, `FIREBASE_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, policy-enumerated unintended ADC/Cloud SDK precedence, inherited `DEBUG`, or any `FIREBASE_DEBUG*` variable, receives an explicitly filtered environment, captures bounded stdout/stderr without forwarding, and removes only that validated temporary directory—including a failed child's `firebase-debug.log`—in `finally`; release mode also forces the exact policy `--account` and pinned firebase-tools version.
- Fixture Functions artifact tests fail on `workspace:*`, a path outside `functions-deploy`, a sibling symlink, an unpinned dependency, nondeterministic bytes/modes/order, or a missing packed `@codra/protocol` 0.0.1 artifact. The actual Task 4+5 export assertion is deferred until Task 5 stages real output.

Expected RED:

```sh
pnpm install --frozen-lockfile
pnpm run verify:remote-build-config
```

- [ ] **Step 2: Add exact dependencies in one lockfile transaction**

Pin:

```text
firebase 12.17.0
firebase-admin 14.2.0
firebase-functions 7.3.2
firebase-tools 15.25.1
@firebase/rules-unit-testing 5.0.1
node-datachannel 0.32.3
```

Desktop depends on protocol, firebase, webrtc, Firebase JS SDK, and node-datachannel. Web depends on protocol, firebase, webrtc, Firebase JS SDK, React, and xterm. Functions depends on protocol, firebase-admin, and firebase-functions. Root live tooling also declares the same exact firebase-admin version so scripts can use its official ADC implementation without reaching through a transitive pnpm dependency. Keep all current exact versions unchanged.

Add functions to pnpm workspace packages and add:

```yaml
allowBuilds:
  node-datachannel: true
```

Preserve existing allowBuilds and the node-pty patch.

- [ ] **Step 3: Define every root command now**

Task 2 adds the final script names even though later task implementations initially make some commands fail:

```text
firebase:emulators
test:firebase-rules
stage:functions-deploy
test:functions-deploy-artifact
build:release-candidate
verify:release-candidate
test:firebase-claim-canary
resume:firebase-claim-canary
test:resume-firebase-claim-canary
test:remote-direct
test:remote-reconnect
build:remote-test
package:remote-test
verify:native-package
verify:remote-build-config
scan:client-artifacts
test:release-remote-disabled
verify:remote-release
```

Later tasks create the referenced sources/scripts but do not reopen package.json.

- [ ] **Step 4: Make release and remote-test flavors structurally disjoint**

Release:

- appId com.codra.desktop, product CODRA, existing release output.
- Compile-time binding imports only safe-storage-electron and production Firebase config.
- Compile-time Auth binding imports browser Google bootstrap and Electron system-browser bridge adapters only.
- It contains no fake storage implementation, inert App Check provider, loopback endpoint table, demo-codra string, remote-test app ID, or E2E control hook.
- It contains no signInWithEmailAndPassword import, password-test provider, or emulator login UI/copy.

Remote-test:

- appId com.codra.desktop.remote-test, product CODRA Remote Test, separate output and provenance.
- Compile-time binding imports safe-storage-test-only, EmulatorFirebaseConfig, and inert emulator App Check.
- Compile-time Auth binding imports email-password-bootstrap-test-only for emulator automation; it is excluded from every production graph.
- package-remote-test.mjs writes a provenance record with testOnly true, configMode emulator, commit, artifact hash, and creation time.
- It is excluded from release archives, upload globs, signing/notarization release paths, and normal package:mac.

Unit tests inject SafeStoragePort directly into constructors. They never select a fake through process.env or a runtime global.

- [ ] **Step 5: Verify node-datachannel from install through packaged Electron**

Update asarUnpack for node-datachannel and native dependencies. verify-node-datachannel-package.mjs resolves the installed 0.32.3 package entry and declaration output, checks the exact exported signatures against the tagged `src/lib/index.ts` and `src/lib/types.ts` references above, verifies the packaged application has the correct arm64/x64 native binding, and launches an Electron probe that creates and closes a PeerConnection. The probe calls `PeerConnection.close()` and then module-level `cleanup()` after every peer is closed. It does not invent any other teardown or host ICE-restart method.

Run:

```sh
pnpm install
pnpm install --frozen-lockfile
pnpm --filter @codra/protocol test
pnpm --filter @codra/protocol typecheck
pnpm --filter @codra/desktop test
pnpm --filter @codra/desktop typecheck
pnpm --filter @codra/desktop build
pnpm --filter @codra/desktop run package:dir
pnpm run verify:remote-build-config
pnpm run verify:native-package
pnpm exec playwright test tests/e2e/packaged-native-modules.spec.ts
git diff --check
```

The new firebase/webrtc/web/functions workspaces are intentionally manifest/config scaffolds at this gate. Do not run recursive root build/test or package:remote-test before Tasks 3–9 create their sources and compile-time alias targets.

- [ ] **Step 6: Freeze a self-contained Functions deployment artifact**

`functions-deploy/package.json` is private and contains only exact registry dependencies `firebase-admin` 14.2.0, `firebase-functions` 7.3.2, the exact reviewed `@google-cloud/functions-framework` version resolved and named in the dedicated lock/component manifest, and `@codra/protocol` as `file:vendor/codra-protocol-0.0.1.tgz`; its engines/runtime, TypeScript/toolchain, and every build dependency are exact rather than ranged. It contains no `workspace:*`, parent path, lifecycle download, or unpinned range. Its dedicated `pnpm-lock.yaml` and `.npmrc` set `link-workspace-packages=false`, `prefer-workspace-packages=false`, and `shared-workspace-lockfile=false`; nothing in the staged tree is a symlink.

`stage-functions-deploy.mjs` is the only writer of generated `functions-deploy/lib`, `functions-deploy/vendor`, and `functions-deploy/functions-component-manifest.json`. It first builds the reviewed Functions workspace and `@codra/protocol` 0.0.1, creates a normalized protocol tarball with lexically ordered entries, fixed modes, and zeroed mtimes, copies compiled Functions output into a fresh temp tree, rejects any resolved import outside that tree, and atomically installs the tree only after validation. It writes a canonical manifest containing schemaVersion 1, projectId `codra-1b3bb`, source commit, Functions stage SHA-256, protocol tarball SHA-256, exact Task 4+5 export list, region `asia-northeast3`, and dependency-lock SHA-256. No timestamp enters an artifact hash.

Task 2 freezes only the deterministic self-contained Functions component artifact and its canonical hash manifest. It does not build a production release candidate before Task 4/5 exports or Task 9 Hosting output exist. Task 12 owns the complete candidate schema/builder/verifier and combines this staged component with the later reviewed outputs.

`test-functions-deploy-artifact.mjs` stages a fixed fixture twice into separate temp roots and requires identical file lists, modes, and hashes. It then copies only the staged fixture directory into an empty isolated root and runs `pnpm install --offline --frozen-lockfile --ignore-workspace`, the staged build/import probe, and fixture export-manifest assertion without repository siblings. It fails on a symlink, `workspace:*`, parent path, undeclared file, dirty stage, or network request. Task 2 runs only this fixture RED/GREEN coverage because real exports do not exist yet; Task 5 reruns the actual stage after its final export list exists.

Run:

```sh
pnpm run test:functions-deploy-artifact -- --fixture
```

- [ ] **Step 7: Run the guarded single-project claim-isolation decision gate**

`test-live-test-guard.mjs`, `test-firebase-claim-canary.mjs`, and `test-resume-firebase-claim-canary.mjs` first prove refusal of missing/wrong opt-in, either missing/mismatched project flag, demo-codra, CI, implicit aliases, malformed/oversized CLI JSON, raw child stdout/stderr propagation, token-shaped/logging output, absent/equal Firebase Web App IDs, missing/mismatched durable account or stable profile fingerprints, an active live/deployment lease, any product-document deletion request, any attempt by preflight to create a lease/tombstone, and any attempt to read Firebase CLI credential files. They prove terminal tombstone retention, 30-day `ttlDeleteAt`, no Auth/device mutation, and a hard-crash immediately after canary lease/tombstone creation that is recoverable before Task 3 without any Task 5 code. A subprocess fixture deliberately exits nonzero after writing a large stdout/stderr stream and `firebase-debug.log`; the test proves output remains bounded/non-echoing and only the helper's validated `mkdtemp` directory is removed.

`run-bounded-firebase-cli.mjs` is the only Firebase CLI launcher. `live-test-guard.mjs` is the sole read-only target/authority gate. It requires the literal triple `CODRA_LIVE_TEST=1`, `--project codra-1b3bb`, and `--confirm-project codra-1b3bb`. For each child, the launcher creates a run-owned OS temporary directory, writes a minimal absolute generated config, passes it by absolute `--config`, and sets the child `cwd` to the temporary directory; a release config may point only to the sealed self-contained Functions directory and other immutable candidate paths, never workspace/sibling sources. It rejects `--token`, inherited `FIREBASE_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, policy-enumerated ADC/Cloud SDK precedence variables, `DEBUG`, and every `FIREBASE_DEBUG*` key; removes them from the exact child environment allowlist; caps stdout/stderr bytes and runtime; never forwards either stream; and in `finally` validates the path is the exact directory returned by `mkdtemp` before removing it and any `firebase-debug.log` beneath it. Release-mode calls additionally require the exact policy account on `--account`; metadata-mode calls reject deploy selectors. The guard permits only bounded `firebase projects:list --json` and `firebase apps:list WEB --project codra-1b3bb --json`; it parses in memory and emits only target/app booleans, counts, and SHA-256 fingerprints. It requires the exact Task 1 project, canonical firebaseapp.com origin/handler, exact approved bridge App ID, and a separately provisioned approved desktop App Check App ID present in the app list and unequal to the bridge ID. It refuses every other Firebase metadata subcommand, never runs login:list, and never reads/copies CLI credential storage.

`docs/security/codra-live-authority.json` is a reviewed, nonsecret policy containing literal project ID; approved custom-token signer `serviceAccountId`; the constrained live-data WIF/ADC caller principal, impersonated service account, credential mode, and fingerprints; the distinct release-control WIF/ADC principal, impersonated service account, credential mode, and fingerprints; the separately approved nonsecret Firebase CLI deploy account email/fingerprint; required signer binding; the durable Google live-test UID plus account-email/creation-time/ordered-provider-data fingerprints; stable operator-maintained host and Chrome/Firefox/Safari device/key profile fingerprints; policy-enumerated forbidden CLI auth environment keys; and three exact sorted permission arrays. The live-data array permits only signing, exact account/profile reads, live lease/run tombstone writes, product flow, and terminalization/revocation status work. The release-control array permits only release operation/lease/receipt transactions; abandoned live-run/session/issuance/revocation status reads needed for the acquisition gate; and authoritative Hosting, Rules, Firestore index/field/TTL, Functions, Run, Scheduler, IAM, Secret Manager binding-version, project, and app metadata reads—never secret payload access. The CLI account is not either ADC principal.

The implementation never writes a guessed identity: live/release gates remain externally blocked until an operator supplies and reviews real values. `google-rest-client.mjs` acquires short-lived ADC only through the exact caller-specific `applicationDefault()` WIF/impersonation mode, rejects an unexpected credential type/principal/service account/quota project, keeps tokens in memory, sends them only to allowlisted Google REST hosts, redacts failures, and never prints, persists, shells out for, or accepts a downloaded service-account key. Callers must select exactly `liveDataAuthority` or `releaseControlAuthority`; cross-use fails. The guard verifies policy fingerprints, exact caller-to-signer binding, `iam.serviceAccounts.signBlob`, exact Auth-user get, and the canary's bounded live lease/run-tombstone permissions. It requires the known Auth user and stable profile fingerprints to match before and after and never requests Auth-user or durable-device identity creation/deletion. If token exchange reports `isNewUser === true` or identity/profile drift, that is a safe operator incident and the gate aborts.

Firebase CLI login is sufficient only for the two bounded project/app metadata commands used by the canary/live suite; it is not Admin or infrastructure-deploy authority there. Missing local ADC/WIF or missing pre-provisioned Google test account is an explicit external prerequisite that blocks only live gates—emulator development and static CI remain usable—and no script manufactures credentials.

The canary then:

1. As sole top-level owner for purpose `claim-isolation-canary`, refuses an active server live lease or deployment lease, generates an in-memory random >=128-bit run ID, and runs read-only preflight. It transactionally acquires `serverLiveTestLeases/codra-1b3bb` using server time and creates one `serverLiveTestRuns/{runId}` high-level tombstone with zero session/issuance entries. An optional local receipt contains only project/run/account fingerprints and safe status.
2. Initializes the Admin app exactly as follows, with a unique name derived from the random run ID:

   ```ts
   const credential = applicationDefault();
   const exactApp = initializeApp(
     {
       credential,
       projectId: "codra-1b3bb",
       serviceAccountId: policy.serviceAccountId,
     },
     `codra-live-claim-${runId}`,
   );
   ```

   Assert the exact named app's options retain that credential object, literal project ID, and policy serviceAccountId. Mint only through `getAuth(exactApp).createCustomToken(policy.liveTestGoogleUid, claims)`. Decode the returned JWT header/payload in memory without logging or persistence; require `alg` RS256, `iss` and `sub` equal the exact signer service-account email, `aud` equal `https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit`, `uid` equal the approved live-test UID, and bounded integer `iat`/`exp` with the expected one-hour maximum and skew before exchange. The signer ID inside the minted token—not an ambient credential guess—is the final signer enforcement point.

3. The canary makes no Auth-management or durable-device request and creates no device/session/signal/TURN record. The subsequent custom-token exchange must say `isNewUser === false`, with any contrary result treated as the external-account incident described above.
4. Mints two tokens for the same approved UID with different device ID/thumbprint/kind/generation additional claims, exchanges them in independent Firebase JS Auth contexts using `inMemoryPersistence`, and requires both exchanges to report `isNewUser === false`. It verifies each exchanged ID token's signature against the current securetoken keys without logging it; requires project audience, `iss` exactly `https://securetoken.google.com/codra-1b3bb`, approved UID/subject, `firebase.sign_in_provider` exactly custom, and bounded `iat`/`auth_time`/`exp`; then force-refreshes both and proves A retains only A claims and B only B claims after refresh. Exact Auth UID/creation-time/provider fingerprints must still match after the exchanges; drift is an operator incident and blocks PASS.
5. In its single `try/finally`, signs out both clients, transitions the run tombstone to terminal with server time and `ttlDeleteAt` 30 days later, and releases only its matching live lease. It never deletes the tombstone, Auth user, or a product document. On a hard crash, `resume-firebase-claim-canary.mjs` supplies the pre-Task-3 recovery path: with the literal project/live guards and constrained live-data authority, it reads the fixed expired live lease to obtain the exact run ID; requires purpose `claim-isolation-canary`, zero session/issuance entries, and exact account/profile fingerprints; then transactionally marks only that tombstone terminal with server time plus 30-day `ttlDeleteAt` and releases only the matching expired lease. A nonexpired lease refuses. It never depends on Task 5, enumerates, or deletes data/Auth/devices. Canary failure output contains only a safe run hash and this command shape; the optional local receipt is removed after terminal state.
6. Emits a nonsecret result containing schema version, project/app/account/signer/profile fingerprints, SDK/CLI versions, run ID hash, bounded counters, terminal status, timestamp, and PASS/FAIL only.

Run the static refusal tests in normal CI, but run the live decision gate manually before Task 3:

```sh
node scripts/test-live-test-guard.mjs
node scripts/test-firebase-claim-canary.mjs
node scripts/test-resume-firebase-claim-canary.mjs
CODRA_LIVE_TEST=1 pnpm run test:firebase-claim-canary -- --project codra-1b3bb --confirm-project codra-1b3bb
```

PASS freezes the same-owner-UID plus per-device additional-claims architecture used by Tasks 3–12. FAIL stops the DAG before Task 3. The concrete fallback creates a server-random, non-client-selectable principal UID with at least 128 bits of entropy for each device-generation authorization and maps it to the owner/device/generation in Admin-only `serverDevicePrincipals/{principalUid}`; claims carry `codraOwnerUid`, while Rules require both that exact principal mapping and the active generation. A principal is never deterministic, reused, or reassigned. Disable leaves a permanent inactive tombstone, and re-enable creates a new random principal UID rather than reviving the old one. There is no UID-only fallback. Selecting it requires updating/re-reviewing Task 1 Auth bindings and this plan before any Task 3 work.

- [ ] **Step 8: Commit the only manifest/build/canary change**

```sh
git add .gitignore package.json pnpm-workspace.yaml pnpm-lock.yaml apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/electron-builder.yml apps/desktop/electron.remote-test.vite.config.ts apps/desktop/electron-builder.remote-test.yml apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts packages/firebase/package.json packages/firebase/tsconfig.json packages/webrtc/package.json packages/webrtc/tsconfig.json functions/package.json functions/tsconfig.json functions-deploy/package.json functions-deploy/pnpm-lock.yaml functions-deploy/.npmrc playwright.config.ts scripts/package-remote-test.mjs scripts/stage-functions-deploy.mjs scripts/test-functions-deploy-artifact.mjs scripts/verify-node-datachannel-package.mjs scripts/verify-remote-build-config.mjs scripts/run-bounded-firebase-cli.mjs scripts/google-rest-client.mjs scripts/live-test-guard.mjs scripts/test-live-test-guard.mjs scripts/run-firebase-claim-canary.mjs scripts/test-firebase-claim-canary.mjs scripts/resume-firebase-claim-canary.mjs scripts/test-resume-firebase-claim-canary.mjs docs/security/codra-live-authority.json tests/e2e/packaged-native-modules.spec.ts
git commit -m "build: add remote workspaces and native test flavor"
```

---

### Task 3: Implement Tagged Firebase Config, Rules, Indexes, and Cursor APIs

**Depends on:** Tasks 1 and 2. May run in parallel with Task 6.

**Files**

- Create firebase.json
- Create .firebaserc
- Create firestore.rules
- Create firestore.indexes.json
- Create packages/firebase/src/config.ts
- Create packages/firebase/src/refs.ts
- Create packages/firebase/src/devices.ts
- Create packages/firebase/src/sessions.ts
- Create packages/firebase/src/signals.ts
- Create packages/firebase/src/index.ts
- Create packages/firebase/test/config.test.ts
- Create packages/firebase/test/devices.test.ts
- Create packages/firebase/test/signals.test.ts
- Create packages/firebase/test/hosting.test.ts
- Create packages/firebase/test/firestore.rules.test.ts
- Create docs/runbooks/firebase-ttl.md
- Create docs/runbooks/firebase-app-check.md

**Produces**

- A tagged config boundary that cannot mix production and emulator endpoints.
- Participant/thumbprint-bound Firestore Rules and exact indexes.
- Exact Firebase Hosting direct-navigation rewrite for `/desktop-auth` without intercepting Firebase's reserved Auth handler.
- Participant-triple-bound subscribePendingSessions and subscribeClientSessions queries.
- Bounded drainSignals and drainAndSubscribeSignals APIs with durable sequence cursors.

- [ ] **Step 1: Write RED tests for config contamination, rules, pagination, and stale timers**

Cover:

- EmulatorFirebaseConfig accepts only projectId demo-codra and loopback Auth, Firestore, Functions, and Hosting endpoints.
- Any emulator config containing a production project identifier, public field, hostname, or non-loopback endpoint fails before Firebase initialization.
- ProductionFirebaseConfig cannot contain emulator endpoint fields.
- Production config imports the two exact HTTPS origins and google.com provider from Task 1; emulator config imports only http://127.0.0.1:5000 and password-test-only. Neither branch can initialize the other's provider/origin.
- Production config requires project codra-1b3bb, the exact approved bridge App ID, and the distinct operator-approved desktop App Check App ID frozen by the Task 2 live gate; absent/equal/unlisted IDs fail before initialization.
- Firebase Authentication App Check enforcement is false. Firestore production enforcement is enabled only after both web and desktop provider bootstrap gates pass; operational callables declare enforceAppCheck true individually.
- Direct-E2E mode requires an explicit compile-time test flavor; it is not selected at runtime.
- Same-UID device B cannot get/list/delete device A's participant-only session or signals.
- A token whose device document is inactive or whose codraDeviceGeneration is stale cannot get/list/create/delete anything protected, even when its signature and ID-token expiry are otherwise valid.
- Any account-bootstrap token and any non-custom sign-in provider fail participant Rules before the authoritative-device get.
- Rules helper document-access calls remain within Firestore limits: session create uses caller-device plus selected-host gets (2), session list uses the caller device (1), and a 500-row signal query uses cached caller-device plus parent-session gets (2).
- A client cannot create/update any device presence document.
- Session creation fails if either caller or selected host authoritative record is missing/inactive/stale; participant ID/thumbprint/generation, host kind/remote-enabled/presence, immutable fields, createdAt=request.time, or maximum-eight-hour bound disagree.
- At and after derived session expiry, every client session/signal create, update, and delete fails; no participant cleanup exception exists. The Admin-only cleanup helper is covered separately by Functions tests.
- Signal create requires exact sender claims/thumbprint and exact opposite participant recipient.
- Signal list limit 501 fails, and pending-session list limit 51 fails.
- Host presence disappears at expiresAt with a fake clock even if the subscription never emits again.
- 501 and 1001 signal fixtures drain in order without loss or duplication.
- Pending-host/client-session queries missing any device ID/thumbprint/generation equality or exceeding limit 50 are denied.
- firebase.json rewrites exact source `/desktop-auth` to `/index.html`; an emulator direct GET returns the SPA shell, while `/__/auth/handler` remains a Firebase-reserved path and is never matched or rewritten to that shell.

- [ ] **Step 2: Implement an explicit tagged Firebase runtime boundary**

Use a discriminated union:

```ts
type ProductionFirebaseConfig = {
  mode: "production";
  projectId: "codra-1b3bb";
  publicConfig: ApprovedPublicFirebaseConfig;
  bridgeFirebaseAppId: "1:92715578857:web:6c07f26a4866a1d4d3c778";
  desktopAppCheckFirebaseAppId: ApprovedDistinctDesktopAppId;
  accountBootstrapProvider: "google.com";
  browserOrigins: readonly [
    "https://codra-1b3bb.web.app",
    "https://codra-1b3bb.firebaseapp.com",
  ];
  authAppCheckEnforcement: false;
};

type EmulatorFirebaseConfig = {
  mode: "emulator";
  projectId: "demo-codra";
  endpoints: {
    auth: "127.0.0.1:9099";
    firestore: "127.0.0.1:8080";
    functions: "127.0.0.1:5001";
    hosting: "127.0.0.1:5000";
  };
  buildFlavor: "remote-test";
  accountBootstrapProvider: "password-test-only";
  browserOrigins: readonly ["http://127.0.0.1:5000"];
  authAppCheckEnforcement: false;
};
```

Production initialization consumes only the approved public Firebase fields supplied for CODRA and checks both Web App IDs against the Task 2 bounded live-app preflight. Emulator initialization uses only demo-codra and explicit loopback endpoints. assertFirebaseRuntimeConfig runs before initializeApp. Do not fall back between variants.

.firebaserc contains named `live` and `demo` mappings but no default project alias or credential; every real command still supplies both required literal project/confirmation gates. firebase.json binds all emulator hosts to 127.0.0.1, uses demo-codra in tests, and sets every production Functions codebase source to exact Task 2 directory `functions-deploy`; release deployment refuses that directory until its sealed candidate hashes pass. Its Hosting rewrites contain the exact entry `{ "source": "/desktop-auth", "destination": "/index.html" }` and no wildcard that can match `/__/auth/handler`; preserve Firebase's reserved `/__/` behavior. Emulator exports/traces are written under a test-only ignored directory.

- [ ] **Step 3: Implement typed refs and immutable converters**

Use:

```text
users/{uid}/devices/{deviceId}
users/{uid}/remoteSessions/{sessionId}
users/{uid}/remoteSessions/{sessionId}/signals/{signalId}
serverProofChallenges/{challengeId}
serverBootstrapRateLimits/{scopeKey}
serverDesktopLoginTransactions/{transactionId}
serverLiveTestRuns/{runId}
serverDeviceSessionRegistries/{deviceScopeHash}
serverTurnRateLimits/{scopeKey}
serverTurnIssuances/{issuanceId}
serverTurnRevocationJobs/{jobId}
```

Converters parse every read through Task 1 schemas. Client code has no reference constructor for any server-prefixed collection. Never log raw parse failures containing document data; return code plus path only.

- [ ] **Step 4: Implement host discovery and pending-session APIs with timers**

Host discovery subscribes to same-account host devices, filters active plus remoteAccessEnabled, and computes online from expiresAt. For every visible device, arm/reschedule a clock-injected deadline. At deadline, filter and emit again even without a Firestore snapshot.

Freeze these exact APIs:

```ts
subscribePendingSessions({
hostDeviceId,
hostKeyThumbprint,
hostDeviceGeneration,
limit: 50,
onChange,
onError,
}): Unsubscribe

subscribeClientSessions({
clientDeviceId,
clientKeyThumbprint,
clientDeviceGeneration,
limit: 50,
onChange,
onError,
}): Unsubscribe

```

The host query uses equality on hostDeviceId, hostKeyThumbprint, hostDeviceGeneration, and status requested; orders by createdAt ascending; and limits to 50. The client query uses equality on clientDeviceId, clientKeyThumbprint, and clientDeviceGeneration; orders by createdAt descending; and limits to 50. Arguments must exactly equal the caller's scoped claims. Both derive expired locally and never present an expired request as actionable.

- [ ] **Step 5: Implement bounded signal drain/relisten**

Freeze:

```ts
drainSignals({
  sessionId,
  senderDeviceId,
  recipientDeviceId,
  negotiationId,
  afterSequence,
  limit,
}): Promise<SignalPage>
```

afterSequence starts at 0; limit must be 1–500. The algorithm is scoped to the exact SignalSequenceKey:

1. Query senderDeviceId, recipientDeviceId, and negotiationId equality, sequence greater than afterSequence, order ascending, limit 500.
2. Parse, validate the exact four-tuple, require first accepted sequence after 0 to be 1 and every later value to be previous plus 1, verify via injected verifier, then advance afterSequence.
3. If the page has exactly 500 documents, fetch the next page and repeat.
4. When a page has fewer than 500, install an ordered listener from the last accepted sequence using the same limit.
5. If a listener snapshot reaches 500 or the listener errors/reconnects, unsubscribe, return to drain mode from the durable sequence, then relisten.

Add the reverse-field-order composite query only for bounded Admin cleanup/diagnostics. Persist cursor under all four key components. Old negotiationId or opposite-direction rows never advance the active cursor; a fresh negotiation starts again from afterSequence 0.

- [ ] **Step 6: Write participant-bound Firestore Rules**

Rules require request.auth.uid equal to the path UID plus device-scoped claims:

```text
request.auth.token.codraDeviceId
request.auth.token.codraKeyThumbprint
request.auth.token.codraDeviceKind
request.auth.token.codraDeviceGeneration
request.auth.token.firebase.sign_in_provider == "custom"
```

Enforce:

- Every Rules entry point first requires firebase.sign_in_provider custom and all four scoped claims, then loads users/{uid}/devices/{codraDeviceId} through one shared helper and requires active true plus exact owner UID, device ID, key thumbprint, kind, and safe-integer generation. Short-circuit invalid/missing claims before constructing a get path. There is no claims-only shortcut.
- Device get/list is same-account and requires that authoritative active scoped-device check. Every client device create/update/delete is denied; Functions/Admin own active, generation, identity, and presence.
- Session get/list only succeeds when caller device ID, thumbprint, and generation equal the exact client or host side stored in the session. Host list queries must constrain hostDeviceId+hostKeyThumbprint+hostDeviceGeneration and requested status; client list queries must constrain clientDeviceId+clientKeyThumbprint+clientDeviceGeneration; both limit to 50 with the documented createdAt ordering.
- Session create performs two authoritative gets: the active scoped caller device and the selected host device. The host must share owner UID, be active kind host, match immutable ID/thumbprint/generation, have remoteAccessEnabled true, and have presence expiresAt after request.time. Require requested status/no decision fields, createdAt == request.time, request.time < expiresAt, and expiresAt <= request.time + duration.value(8, "h"). Never require equality to eight hours.
- Every client session update/delete is denied; Functions/Admin own normal transitions and the narrow expired-session cleanup.
- Signal create only before both signal and session expiry; caller is exact sender, signerThumbprint and signerDeviceGeneration equal its session side and authoritative device record, recipient is exact other participant, sequence is a positive safe integer under the four-tuple contract, createdAt is request.time, and expiresAt is no later than request.time plus one hour and session expiresAt.
- Signal get/list is only for an exact participant. Every client signal update/delete is denied, and list limit is at most 500.
- serverProofChallenges, serverBootstrapRateLimits, serverDesktopLoginTransactions, serverLiveTestRuns, serverDeviceSessionRegistries, serverTurnRateLimits, serverTurnIssuances, and serverTurnRevocationJobs deny every client operation.
- Pending host and client-session query constraints exactly match Step 4; omitting thumbprint or generation equality is denied.

Rules do not pretend to verify ECDSA. Application receivers and Functions perform signature verification.

Keep rule-access cost explicit: session create uses caller-device plus selected-host gets (2); session get/list uses caller device (1); a signal create/get/list uses caller device plus parent session (2). Query all signal rows under one session so those two identical get paths are cacheable across up to 500 results. Emulator tests assert allow/deny behavior and document-access-call counts remain below Firestore limits.

- [ ] **Step 7: Add exact indexes and TTL policy runbook**

firestore.indexes.json includes exactly these collection-scope composites (plus no unrelated remote index):

```text
devices:
  kind ASC, active ASC, remoteAccessEnabled ASC, expiresAt ASC
remoteSessions:
  hostDeviceId ASC, hostKeyThumbprint ASC, hostDeviceGeneration ASC,
  status ASC, createdAt ASC
remoteSessions:
  clientDeviceId ASC, clientKeyThumbprint ASC, clientDeviceGeneration ASC,
  createdAt DESC
signals:
  senderDeviceId ASC, recipientDeviceId ASC, negotiationId ASC, sequence ASC
signals:
  recipientDeviceId ASC, senderDeviceId ASC, negotiationId ASC, sequence ASC
```

Each entry uses its literal collectionGroup name and `queryScope: "COLLECTION"`. `fieldOverrides` is exactly empty because this repository file deploys composite indexes only; it does not configure, enable, disable, or claim ownership of TTL. Index tests parse JSON and assert the exact field order/direction against the Step 4/5 queries, not merely that an index with similar fields exists.

Document the separately provisioned `expiresAt` TTL policies required for collection groups signals, serverProofChallenges, serverBootstrapRateLimits, serverDesktopLoginTransactions, empty/inactive serverDeviceSessionRegistries, serverTurnRateLimits, and serverTurnIssuances. Terminal/abandoned `serverLiveTestRuns` and terminal `serverTurnRevocationJobs` instead use `ttlDeleteAt`; active/pending states intentionally omit it. Do not enable TTL on devices: expiry marks presence stale but immutable public-key binding remains available. serverBootstrapRateLimits and serverTurnRateLimits use server now plus 20 minutes. TTL is retention only; Rules/Functions enforce expiry synchronously and scheduled sweepers plus overdue alerts terminalize abandoned live runs and reconcile stale product state. Task 12 requires every field configuration ACTIVE before acquiring its live lease and never mutates TTL. A separately approved release workflow owns any TTL configuration change.

firebase-app-check.md freezes the deployment matrix: Firebase Authentication enforcement OFF; raw device bootstrap and Electron begin/exchange/App Check bootstrap exports omit the unsupported callable `enforceAppCheck` option and enforce their manual contracts; hosted authorizeDesktopLogin requires valid consumed limited-use web App Check; Firestore production enforcement and operational callables turn ON only after their provider initialization tests pass. Emulator bypass exists only in the compile-time remote-test/demo-codra variant.

- [ ] **Step 8: Verify and commit**

Run:

```sh
pnpm --filter @codra/firebase test
pnpm --filter @codra/firebase typecheck
pnpm exec firebase emulators:exec --project demo-codra --only auth,firestore,functions,hosting "pnpm --filter @codra/firebase test"
git diff --check
```

Then:

```sh
git add firebase.json .firebaserc firestore.rules firestore.indexes.json packages/firebase docs/runbooks/firebase-ttl.md docs/runbooks/firebase-app-check.md
git commit -m "feat: add bound firebase control plane"
```

---

### Task 4: Implement Device-Scoped Auth, Proofs, Presence, App Check, and Decisions

**Depends on:** Tasks 3 and 6.

**Files**

- Create functions/src/http.ts
- Create functions/src/runtime.ts
- Create functions/src/bootstrap-cors.ts
- Create functions/src/rate-limit-config.ts
- Create functions/src/bootstrap-rate-limit.ts
- Create functions/src/auth.ts
- Create functions/src/proof-challenges.ts
- Create functions/src/device-identity.ts
- Create functions/src/desktop-login.ts
- Create functions/src/devices.ts
- Create functions/src/app-check-http.ts
- Create functions/src/sessions.ts
- Create functions/src/index.ts
- Create functions/test/proof-challenges.test.ts
- Create functions/test/bootstrap-cors.test.ts
- Create functions/test/rate-limit-config.test.ts
- Create functions/test/bootstrap-rate-limit.test.ts
- Create functions/test/device-identity.test.ts
- Create functions/test/desktop-login.test.ts
- Create functions/test/device-auth-session.test.ts
- Create functions/test/device-revocation.test.ts
- Create functions/test/devices.test.ts
- Create functions/test/app-check-http.test.ts
- Create functions/test/sessions.test.ts
- Create functions/test/export-metadata.test.ts
- Create docs/runbooks/firebase-rate-limit-pepper.md

**Produces**

- One-shot proof challenge service.
- Exact production/emulator HTTP/CORS/App Check deployment matrix and rolling bootstrap limits.
- A separately bound, strictly parsed `CODRA_RATE_LIMIT_PEPPER` secret for IP HMAC scopes.
- One-shot system-browser Google→desktop PKCE login transaction.
- Device-scoped custom Auth claims for browser and host.
- Admin-written registration and 120-second presence lease.
- A recursion-free raw HTTP desktop App Check challenge/exchange.
- Signed server-verified session decision transitions.
- Every v2 export pinned to asia-northeast3 with testable metadata.

- [ ] **Step 1: Add RED tests for proof replay, claim scoping, presence, and App Check bootstrap**

Cover:

- Challenge bytes are server-random, 32-byte base64url, purpose/UID/subject bound, expire in two minutes, and can be consumed once.
- Concurrent exchange attempts yield exactly one success.
- Rolling bootstrap accounting persists every challenge/mint attempt by UID when known, HMAC-hashed IP, and device/purpose without raw IP: desktop start allows 10/IP/10m and 5/device/10m with at most 3 active attempts; desktop inspect/Allow together allow 10/UID/hour and Allow mutates once/attempt; redeem locks after 5 failures; App Check refresh allows 10/device/minute and 100/device/hour.
- Production browser bootstrap rejects providers other than google.com, auth_time older than five minutes, future auth_time beyond skew, and already device-scoped custom sessions. password is accepted only when mode emulator, project demo-codra, and FUNCTIONS_EMULATOR true all hold.
- A stolen device-scoped ID/refresh session cannot request or complete registration for a new device/key.
- Browser bootstrap POST/OPTIONS CORS, 32 KiB JSON bound, no-store, Vary: Origin, null/unlisted origin rejection, and exact production/emulator origin behavior match the frozen matrix.
- Raw desktopLoginStart/Redeem/Cancel and desktopAppCheckBootstrap exports have `cors: false`, omit the unsupported `enforceAppCheck` option entirely, enforce exact method/body/no-store manually, and reject every present Origin header.
- Desktop login rejects callback hosts other than its prebound 127.0.0.1 port, wrong PKCE/state/nonce/key/origin, direct Google-to-loopback redirects, replay, cancellation, and timeout.
- Desktop start/redeem accepts only Task 1's exact 43-character verifier/S256 challenge derivation; padded, non-ASCII, non-unreserved, caller-selected-length, or mismatched values fail.
- Both authorizeDesktopLogin inspect and Allow require `request.app` before any transaction/rate/business read, require exact bridge App ID, and require `request.app.alreadyConsumed !== true`. Each call uses a fresh limited-use token; reusing either token fails before business logic and does not authorize/mutate.
- authorizeDesktopLogin accepts only the canonical firebaseapp.com origin, google.com within five minutes, and its exact inspect-or-explicit-Allow request contract; only Allow authorizes an attempt.
- Desktop bridge and desktop custom-AppCheck Firebase Web App IDs must be configured and distinct; absent/equal IDs stop deployment.
- Wrong purpose, UID, device, subject, public key, thumbprint, signature, or expired challenge fails with a safe code.
- A malformed coordinate, off-curve point, padded base64url, or non-64-byte signature fails before verification.
- Register/resume returns a custom token whose additional claims bind exact codraDeviceId, codraKeyThumbprint, codraDeviceKind, and codraDeviceGeneration.
- Two concurrent Auth clients for the same UID exchange distinct custom tokens, force-refresh their ID tokens, and retain different device-scoped claims; neither can impersonate the other.
- An email/password account-only ID token and a device token with missing/mismatched claims are denied by participant Rules.
- Disabling a device increments authoritative generation and marks it inactive; every old-generation Firestore operation and Function call then fails despite a still-valid ID token.
- Browser re-enable requires fresh Google proof; Electron re-enable repeats the full system-browser Google bridge plus existing device-key proof. Both increment generation and cannot resurrect old-generation sessions/signals.
- Heartbeat ignores client timestamps and writes server now plus a 120-second expiry.
- The App Check bootstrap client contract can complete without any callable or App Check token.
- Admin createToken result {token, ttlMillis} is returned with serverTimeMillis; no absolute client expiry is invented by the server SDK call.
- Forced token expiry causes a new challenge and exchange, not reuse of a consumed nonce.
- Approval/request signature field mutation is rejected.
- `cleanupExpiredRemoteSession` is callable only as an imported Admin helper: it requires a derived-expired nonterminal session and expected update time, writes only server-authored `failed`/`LEASE_EXPIRED`/`closedAt`, removes the exact two registry memberships, and idempotently creates or reconciles deterministic revocation jobs for the session's bounded known issuances. Nonexpiry, a racing update, another terminal result, or any attempt to extend/approve/signal/issue TURN/access PTY refuses.
- Missing/blank/malformed/under-32-byte `CODRA_RATE_LIMIT_PEPPER` fails cold start; valid config HMACs the normalized IP without logging either input or key. Only `browserDeviceBootstrap` and `desktopLoginStart` bind this secret; no unrelated export and no CLOUDFLARE_TURN_CONFIG consumer does.
- Every exported onRequest/onCall/onDocument/onSchedule endpoint metadata contains region asia-northeast3; raw exports have no `enforceAppCheck` property, while operational callables enforce App Check only where the matrix says so.

- [ ] **Step 2: Implement exact deployment, CORS, one-shot, and rolling-rate boundaries**

runtime.ts exports FUNCTION_REGION = asia-northeast3 and every v2 export passes it explicitly. serverProofChallenges stores only challengeHash, purpose, ownerUid, subject, optional expected device binding, server timestamps, expiry, and consumedAt. serverDesktopLoginTransactions stores only hashes/bindings and state pending, authorized, consumed, or cancelled. Challenge/attempt/state/code/nonce values are at least 32 random bytes; login attempt lasts five minutes and authorization code 90 seconds.

For browserDeviceBootstrap, use `onRequest({region: FUNCTION_REGION, cors: false, secrets: [rateLimitPepper]})` with no `enforceAppCheck` property—firebase-functions 7.3.2 raw `HttpsOptions` does not support it—then implement exact manual CORS from Task 1:

- Only POST with media type application/json and raw body at most 32 KiB is accepted. Successful/error responses include Cache-Control: no-store.
- Production Origin must equal https://codra-1b3bb.web.app or https://codra-1b3bb.firebaseapp.com. Emulator Origin must equal http://127.0.0.1:5000. Origin null, absent, or unlisted is denied for this browser endpoint.
- Allowed OPTIONS returns 204 with the exact echoed Access-Control-Allow-Origin, Vary: Origin, Access-Control-Allow-Methods: POST, OPTIONS, Access-Control-Allow-Headers: Authorization, Content-Type, Access-Control-Max-Age: 600, and no credentials header. Denied preflight returns 403, Vary: Origin, and no allow-origin value.
- Production config cannot contain the emulator origin and emulator config cannot contain either production origin.

desktopLoginStart, desktopLoginRedeem, desktopLoginCancel, and desktopAppCheckBootstrap use `onRequest` with `region` and `cors: false`, omit `enforceAppCheck`, reject OPTIONS and every present Origin header, accept only POST application/json up to 32 KiB, and set no-store. Their security is one-shot proof/PKCE/scoped Auth as applicable, not incoming App Check. Only desktopLoginStart additionally binds the IP-hashing pepper.

`rate-limit-config.ts` declares `defineSecret("CODRA_RATE_LIMIT_PEPPER")` and accepts only an unpadded base64url value decoding to at least 32 bytes. The parsed bytes exist only in function memory and key HMAC-SHA-256 scopes; raw secret/IP never enters a document, error, or log. `serverBootstrapRateLimits` is Admin-only with true rolling timestamps and expiresAt server now plus 20 minutes. Transactional limits are: desktop start 10/hashed-IP/10m, 5/device/10m, max 3 active attempts/device; browser challenge/mint 20/UID/10m, 60/hashed-IP/10m, 6/device+purpose/10m; desktop inspect/Allow together 10/UID/hour with only one Allow mutation per attempt; redeem locks after 5 failed attempts; desktop App Check refresh 10/device/minute and 100/device/hour. Every request appends/retains its rolling attempt even when later proof/provider/mint validation fails.

`firebase-rate-limit-pepper.md` documents creating at least 32 random bytes with an approved secret generator, entering them through Firebase Secret Manager's interactive/stdin flow without a command-line value or shell-history example, binding/deploy verification by secret name only, safe rotation, the expected temporary reset of hashed IP buckets, and post-rotation expiry of old rate documents. It never shows a value, digest, or retrieval command.

- [ ] **Step 3: Implement browser Google bootstrap and the system-browser Electron bridge**

browserDeviceBootstrap actions register, resume, and reenable require a recent account token and key proof. Against server time, require `now - ACCOUNT_AUTH_MAX_AGE_MS <= auth_time * 1000 <= now + ACCOUNT_AUTH_FUTURE_SKEW_MS`. Production accepts only firebase.sign_in_provider google.com; password is accepted only when mode emulator, projectId demo-codra, FUNCTIONS_EMULATOR true, and the remote-test compile-time client is used. A custom-provider token is rejected. Register creates generation 1; resume requires the exact active immutable key/generation; re-enable requires the exact disabled key and increments generation. Each returns createCustomToken(uid, {codraDeviceId, codraKeyThumbprint, codraDeviceKind, codraDeviceGeneration}).

Before Task 4 implementation, provision two distinct Firebase Web Apps in the same project: the existing Hosting/Google bridge app and a separate desktop custom-App-Check app. Do not invent or reuse an app ID. Deployment stops if the approved desktop app ID is absent or equals the bridge app ID.

Electron production uses this exact flow:

1. desktopLoginStart receives no Auth/App Check. It validates a self-signed device public-key proof, action register/resume/reenable, device display name/fingerprint, Task 1's exact RFC 7636 S256 challenge, >=32-byte state hash, and exact prebound 127.0.0.1 callback host/port/path. It rate-limits and creates a pending five-minute transaction plus server nonce.
2. Electron opens only https://codra-1b3bb.firebaseapp.com/desktop-auth with opaque attempt in the query and state in the fragment. Immediately before redirect, the hosted page may persist only Task 9's `{attempt,state,createdAt}` session record. Firebase's Google callback remains https://codra-1b3bb.firebaseapp.com/__/auth/handler; Google never redirects directly to loopback.
3. After explicit user click, the hosted page calls exactly `await signInWithRedirect(bridgeAuth, new GoogleAuthProvider())`. On return it calls `authorizeDesktopLogin({action: "inspect", attempt, state})` with a new limited-use App Check token. Before any business logic, the callable requires `request.app`, exact bridge `request.app.appId`, and `request.app.alreadyConsumed !== true`; it then validates origin/recent-google/state, reads but does not mutate the pending attempt, and returns only the validated device display name, fingerprint suffix, and requested register/resume/reenable action. The page displays those values and an explicit Allow button.
4. Allow calls `authorizeDesktopLogin({action: "allow", attempt, state})` from the exact firebaseapp.com origin with a different limited-use App Check token. The callable repeats the request.app/appId/alreadyConsumed precondition before any rate/transaction read and requires google.com Auth inside Task 1's exact five-minute/30-second server-time window, `enforceAppCheck: true`, `consumeAppCheckToken: true`, exact attempt/state binding, and the 10-per-UID/hour rate. A transaction permits the allow action once per attempt, records owner UID and code hash/90-second expiry, and returns the plaintext one-time code only to that page. Inspect never authorizes, denies, or consumes the one-Allow mutation; replaying either limited-use token returns a safe App Check error first.
5. The page performs one top-level `window.location.replace` to the validated http://127.0.0.1 callback carrying only attempt, code, and state. It never uses fetch, iframe, PNA, or a direct Google loopback redirect. The bridge error page is terminal and exposes no second-navigation control; if navigation/callback does not complete, Electron reaches its deadline, signed-cancels the still-pending attempt when possible, closes the listener, and the desktop UI can start an entirely new login attempt with new attempt/code/state values.
6. desktopLoginRedeem receives attempt, code, the exact 43-character PKCE verifier, server nonce, and a fresh device signature. It recomputes `BASE64URL(SHA256(ASCII(verifier)))`; a transaction validates every hash/binding/state and marks the attempt consumed before minting. It creates/resumes/re-enables the same-UID device, then returns the device custom token plus an initial desktop App Check seed {token, ttlMillis, serverTimeMillis} minted for the distinct desktop app ID.
7. desktopLoginCancel transactionally marks an unconsumed attempt cancelled. Timeout and any redeem/mint failure require a new transaction.

Google credentials never leave the hosted page/server, and no Google/custom/App Check token crosses renderer IPC or persists. Treat returned custom/App Check tokens as bearer secrets. Never call setCustomUserClaims. The guarded Task 2 `codra-1b3bb` live gate has already frozen the claim architecture; Task 4 emulator tests re-prove refresh isolation, active-generation denial, and re-enable without offering a late fallback.

- [ ] **Step 4: Make presence entirely server-authored**

auth.ts exposes one requireActiveDevice guard used by every authenticated proof, heartbeat, enablement, App Check exchange, session decision/transition, TURN issue, and TURN revoke Function. It requires firebase.sign_in_provider equal to custom, decodes the four scoped claims, performs one authoritative users/{uid}/devices/{codraDeviceId} read, and requires active true plus exact UID/device/thumbprint/kind/generation. Function code cannot authorize from token claims alone.

Registration writes lastSeenAt from the server and expiresAt equal to server now plus 120 seconds. heartbeatDevice requires:

- Scoped host claims matching the device document.
- Enforced custom App Check.
- A fresh heartbeat proof challenge and valid signature.

The callable transaction consumes the proof and writes lastSeenAt/expiresAt itself. It never accepts a client timestamp. remoteAccessEnabled changes through an authenticated signed function, not a direct Firestore write.

Approval atomically adds the session ID to both Admin-only serverDeviceSessionRegistries documents and rejects when either would exceed MAX_ACTIVE_REMOTE_SESSIONS_PER_DEVICE. No same-account-readable device document contains active session IDs. Every terminal transition removes the ID from both registries; empty/inactive registries receive a cleanup expiresAt.

disableDevice requires the active-device guard plus a fresh disable proof. One Firestore transaction loads its at-most-16 server registry IDs, sets the device inactive, increments generation, clears its registry, terminalizes every referenced nonterminal session as closed with server closedAt, and removes those IDs from opposite participant registries. Host/session listeners close DataChannels and remote PTY attachments without killing local PTYs. Requested-only sessions cannot reach a PTY and server cleanup moves them to failed HOST_OFFLINE. Per-device disable never calls UID-wide revokeRefreshTokens. Browser re-enable requires fresh Google/key proof; Electron repeats the full system-browser bridge. Both increment again and cannot reopen old-generation records.

- [ ] **Step 5: Implement initial seed and recursion-free desktop App Check refresh**

desktopLoginRedeem supplies the initial seed only after consumed login proof and device custom-token issuance. app-check-http.ts supplies subsequent refresh with two actions and no incoming App Check:

- challenge: call requireActiveDevice on the scoped custom-provider Auth token, apply 10/minute and 100/hour device limits, and return a fresh purpose/generation-bound challenge.
- exchange: call requireActiveDevice again, validate the host signature/current generation, transactionally consume the challenge, and call Admin getAppCheck().createToken for the distinct approved desktop Firebase Web App ID with one-hour ttlMillis.

Return exactly:

```ts
{
  token: string;
  ttlMillis: number;
  serverTimeMillis: number;
}
```

The client derives expireTimeMillis as serverTimeMillis plus ttlMillis. Never parse JWT expiry or treat ttlMillis as absolute. Both redeem seed and refresh use the cors-false POST/32-KiB/no-store/no-Origin contract. No Google, device custom, or App Check bearer is logged/persisted. The desktop CustomProvider initializes from the in-memory seed, then uses this scoped-Auth+key-proof refresh path.

- [ ] **Step 6: Verify signed session request and approval in Functions**

The host first validates the browser request locally. decideRemoteSession then:

- Requires requireActiveDevice, App Check, and exact host participant ID/thumbprint/generation binding.
- Loads both immutable device public keys and verifies both thumbprints.
- Verifies the browser request signature over the stored request bytes.
- For approve, verifies host approval signature including both device IDs/thumbprints/generations, both challenges, requested and approved scopes, session ID, and expiry.
- For reject, verifies the exact Task 1 codra.session-rejection.v1 fields/reason/signature, stores approvedScopes empty, and stores no hostChallenge/approvalSignature.
- Uses a transaction to require requested, nonexpired status and write server decidedAt plus either approved or rejected fields.
- Never accepts requested scope escalation, expiry beyond the browser-signed maximum-eight-hour value, or client-supplied server timestamps.

The same module exposes transitionRemoteSession for approved signaling/connected/disconnected/closed/failed transitions. It requires scoped participant Auth, enforced App Check, a fresh purpose-bound device signature, the exact current-state precondition, and a nonexpired lease for every normal transition. Once derived expiry is reached, every normal/client transition is denied. Functions write all decidedAt, connectedAt, disconnectedAt, closedAt, and failureCode combinations from server time and the Task 1 state table; clients never update those fields directly.

`sessions.ts` also implements Task 1's non-callable `cleanupExpiredRemoteSession({ownerUid, sessionId, expectedUpdateTime})` for trusted Admin workers only. In one transaction it rereads the exact session, requires authoritative derived expiry plus the expected update time, changes only a nonterminal session to `failed` with `LEASE_EXPIRED` and server `closedAt`, removes only that session ID from both participant registries, and creates or reconciles deterministic revocation jobs for its at-most-12 known persisted issuances. Retrying the already exact cleanup result is idempotent and repairs those bounded side effects; a stale precondition on any other state refuses. It cannot extend/approve the session, write signals, issue TURN, perform PTY work, delete records, or be exported as HTTP/callable surface.

- [ ] **Step 7: Verify the Functions lane**

Freeze `TASK4_REMOTE_FUNCTION_EXPORT_NAMES` as exactly `requestDeviceProofChallenge`, `browserDeviceBootstrap`, `desktopLoginStart`, `desktopLoginRedeem`, `desktopLoginCancel`, `authorizeDesktopLogin`, `desktopAppCheckBootstrap`, `heartbeatDevice`, `setRemoteAccessEnabled`, `disableDevice`, `decideRemoteSession`, and `transitionRemoteSession`. index.ts exports no dynamically named alias; metadata tests compare actual enumerable exports to this list so Task 12 can construct a bounded deploy selector.

export-metadata.test.ts enumerates every Task 4 v2 export. Raw bootstrap/login/AppCheck exports must show region asia-northeast3, cors false, and the `enforceAppCheck` option absent—not false. Only browserDeviceBootstrap and desktopLoginStart bind `CODRA_RATE_LIMIT_PEPPER`; no export binds both pepper and CLOUDFLARE_TURN_CONFIG. authorizeDesktopLogin must show region asia-northeast3, exact firebaseapp.com CORS, enforceAppCheck true, and consumeAppCheckToken true. Heartbeat, enable/disable, decision, transition, and authenticated proof callables must show region asia-northeast3 and enforceAppCheck true. No export may rely on a CLI/runbook default.

Run:

```sh
pnpm --filter @codra/functions test
pnpm --filter @codra/functions typecheck
pnpm exec firebase emulators:exec --project demo-codra --only auth,firestore,functions "pnpm --filter @codra/functions test"
git diff --check
```

- [ ] **Step 8: Commit**

```sh
git add functions/src functions/test docs/runbooks/firebase-rate-limit-pepper.md
git commit -m "feat: bind remote auth to device proofs"
```

---

### Task 5: Implement the Server-Only Cloudflare TURN Boundary

**Depends on:** Task 4. May run in parallel with Tasks 7 and 9.

**Files**

- Create functions/src/cloudflare-turn.ts
- Create functions/src/turn-rate-limit.ts
- Create functions/src/turn.ts
- Create functions/src/turn-revocation.ts
- Create functions/src/turn-revocation-worker.ts
- Create functions/src/live-test-sweeper.ts
- Modify functions/src/sessions.ts
- Modify functions/src/devices.ts
- Modify functions/src/index.ts
- Create functions/test/cloudflare-turn.test.ts
- Create functions/test/turn-rate-limit.test.ts
- Create functions/test/turn.test.ts
- Create functions/test/turn-revocation.test.ts
- Create functions/test/turn-revocation-worker.test.ts
- Create functions/test/live-test-sweeper.test.ts
- Modify functions/test/sessions.test.ts
- Modify functions/test/devices.test.ts
- Modify functions/test/export-metadata.test.ts

**Produces**

- Strict parsing of the CLOUDFLARE_TURN_CONFIG Firebase secret.
- True rolling UID/session rate limits with TTL.
- Auth, App Check, participant-proof-bound issuance and durable revocation enqueue.
- Compensating Cloudflare revoke when Firestore persistence fails.
- Leased/retried revocation outbox with trigger, scheduled reconciliation, and crash recovery.

- [ ] **Step 1: Write RED tests around the external HTTP boundary**

Cover:

- Generation sends ttl 86400, treats only HTTP 201 as success, parses only returned iceServers entries, derives issuedAt from the injected server clock, and derives expiresAt as issuedAt plus 86,400,000 ms without expecting response expiry.
- Revocation uses POST and treats only HTTP 204 as completed; a method spy rejects every other method. Every 4xx—including undocumented missing/already-revoked responses—becomes terminal_failure. Server time reaching `credentialExpiresAt` moves an otherwise noncompleted job to naturally_expired without revokedAt.
- At-least-once session/device/issuance triggers and the scheduled reconciler reread authoritative source plus current terminal state immediately before a derived write; missing or terminal sources cannot recreate optional data, while a known persisted issuance still deterministically receives its required revocation job.
- Generation performs exactly one fetch. Timeout, abort, connection reset, network error, HTTP 5xx, truncated body, invalid JSON/201 payload, or an otherwise ambiguous response produces `TURN_GENERATION_AMBIGUOUS` with no second fetch; deterministic HTTP 4xx also fails without another fetch.
- Authorization, key identifiers, usernames, passwords, response bodies, signatures, and tokens never reach logger arguments.
- URLs using port 53 are discarded.
- Host normalization receives UDP candidates only; browser response may retain approved UDP/TCP/TLS URLs.
- UID attempt 31 in ten rolling minutes and session attempt 7 fail even across a wall-clock bucket boundary.
- Events just outside ten minutes no longer count.
- serverTurnRateLimits.expiresAt is server now plus 20 minutes.
- Every handler-reaching request consumes a rolling attempt even on stale generation/proof, Cloudflare timeout/network/5xx/4xx, or generation failure. Reservation cleanup never erases that attempt. Tests prove each ambiguous generation releases only its reservation, keeps the attempt, records no issuance/revocation username, and cannot fabricate a revoke request; a possible unknown credential is reported only by safe request fingerprint/code and is bounded by the requested 86,400-second Cloudflare TTL.
- Generate success followed by issuance persistence failure invokes Cloudflare revoke and never returns credentials.
- A failed compensating revoke still fails closed and emits only a safe orphan fingerprint/code.
- Issuance persistence and rate finalization either commit in one Firestore transaction or neither does.
- Revocation lease races, worker crash before/after Cloudflare 204, retry backoff, 204-before-state-write recovery, duplicate terminal events, and scheduled reconciliation complete idempotently.
- An expired/terminal session, wrong participant/device/thumbprint, replayed proof, absent App Check, or wrong session binding fails before Cloudflare fetch.
- The expired-session cleanup helper and live-run sweeper use the authoritative snapshot update time: a concurrent normal terminal transition wins without being overwritten, while an exact `LEASE_EXPIRED` retry idempotently verifies registry removal and reconciles every deterministic known-issuance revocation job.

- [ ] **Step 2: Parse the structured secret without fallback**

CLOUDFLARE_TURN_CONFIG is JSON with only the Cloudflare key identifier and API token fields required by the official endpoint. Parse at cold start inside each secret-bound generation/worker export; reject absent/extra/blank values. Never accept a renderer-provided endpoint, credential, bearer token, account value, or override. Never place the secret in client config or emulator export.

Bind the secret only to issueTurnCredentials, the immediate compensation path, the revocation-create worker, and the scheduled revocation worker. The client-facing revokeTurnCredentials callable only persists a job and therefore does not receive the secret.

- [ ] **Step 3: Implement a redacted Cloudflare adapter**

The adapter builds the official generate/revoke URL from validated configuration, injects Authorization only inside fetch, and uses an AbortController five-second deadline. Generation POST body is exactly ttl 86400 and expects 201. Parse only the response iceServers array and each actual urls, username, and credential field; do not require or trust response issuedAt, expiresAt, ttl, account, or key metadata. At successful parse set issuedAtMillis = serverClock.now() and expiresAtMillis = issuedAtMillis + 86_400_000. Revocation sends POST to the official revoke URL with the persisted username path-encoded and expects 204; no alternate HTTP method is implemented or tested as valid.

Generation has no idempotency key and therefore calls fetch exactly once. Timeout, abort, network failure, HTTP 5xx, partial/malformed/invalid-201 response, or any state where creation cannot be ruled out maps to safe `TURN_GENERATION_AMBIGUOUS`; do not issue another generation call. Release the matching reservation while retaining its rolling attempt. Because no validated username exists, do not create a revocation job, guess a username, or call the revoke endpoint. The response remains fail-closed; if Cloudflare created an unreachable credential, ttl 86400 bounds it to 86,400 seconds. A deterministic generation 4xx also fails without another generation call and exposes only a safe status class/code. By contrast, durable revocation jobs for known persisted usernames keep their documented network/5xx schedule; only a revocation HTTP 204 completes, every revocation 4xx becomes `terminal_failure`, and at/after `credentialExpiresAt` reconciliation may mark a noncompleted job `naturally_expired` without claiming revoke success.

- [ ] **Step 4: Implement true rolling reservations**

Use Admin-only serverTurnRateLimits docs keyed by one-way UID and session scope hashes. Each doc has separate rolling attempt timestamps and active reservations; no fixed bucket key is used. Attempts and reservations are never the same entry.

At the start of every Auth/App-Check-valid invocation, before requireActiveDevice/proof/session authorization, one transaction:

1. Removes attempts at/before server now minus ten minutes and expired reservations.
2. Appends the current attempt to both scopes even if this request is subsequently denied or Cloudflare fails. Keep the most recent limit-plus-one timestamps to bound document size while remaining blocked under continued attempts.
3. Enforces 30 attempts per UID rolling ten minutes and 6 per session rolling ten minutes, counting the new attempt.
4. Adds a requestId reservation only when under both limits.
5. Sets expiresAt to server now plus 20 minutes.

On stale generation, proof/session denial, rate denial, timeout/network/5xx/4xx, parse error, ambiguous outcome, or any generation failure, remove only the matching reservation when one exists; the attempt remains. On generation success, finalization removes the reservation in the same transaction that persists issuance. Server timestamps only.

- [ ] **Step 5: Authorize, issue, persist, and compensate**

issueTurnCredentials requires:

- requireActiveDevice and enforced App Check.
- Session exact participant device/thumbprint/generation.
- Nonterminal, unexpired, approved session and allowed scope.
- A fresh turn-issue challenge signed by that participant.

Order:

1. Record attempts/reserve, then run requireActiveDevice, proof, participant, scope, and derived-expiry checks. Any failure releases only reservation.
2. Make the sole generation attempt and parse Cloudflare iceServers; derive issuedAt/expiresAt from server clock. Any ambiguous result follows Step 3 and never reaches issuance persistence or username-based revocation.
3. In one Firestore transaction, enforce at most MAX_ACTIVE_TURN_ISSUANCES_PER_SESSION, persist serverTurnIssuances with issuance/session/participant hashes, server-only username, password hash only, URL metadata and derived timestamps; remove the matching rate reservations/finalize them. Never persist plaintext credential/Authorization.
4. Only after that transaction commits return Task 1 TurnCredentialResponse.

If the single transaction fails after generation, synchronously call Cloudflare revoke before returning, then attempt to persist a compensation revocation job if revoke is uncertain. Never return credentials. Reservation cleanup removes only the reservation. A failed compensation remains fail-closed and is surfaced only by issuance/request fingerprint plus durable safe error state where Firestore is available.

- [ ] **Step 6: Enqueue and process revocation durably**

revokeTurnCredentials requires requireActiveDevice, participant generation, App Check, fresh proof, and issuance/session binding. It transactionally creates a deterministic serverTurnRevocationJobs document with the issuance's required `credentialExpiresAt`, no `ttlDeleteAt`, and marks issuance revokeRequestedAt, then returns only after that commit. It never fires an untracked promise or calls Cloudflare inline.

Task 5 extends terminal session transitions, `cleanupExpiredRemoteSession`, and device-disable transactions: query at most 12 active issuances per session, create deterministic jobs in the same transaction as terminalization, and only then return. The expired helper alone maps a derived-expired nonterminal state to `failed`/`LEASE_EXPIRED` with server `closedAt`; it removes only the exact registry memberships and reconciles those deterministic jobs idempotently under its expected-update-time contract. With at most 16 active sessions/device, the disable transaction remains below Firestore's write limit. An onDocumentCreated worker plus a once-per-minute scheduled reconciler cover external/admin terminal writes, missed delivery, expired leases, and terminal sessions whose issuance lacks a job.

Workers transactionally claim a two-minute lease with owner hash, POST to Cloudflare, and transactionally mark issuance revokedAt plus job completed only after HTTP 204. Durable revocation delays are 5 seconds, 30 seconds, 2 minutes, 10 minutes, then 1 hour capped at `credentialExpiresAt`; network/5xx follows that schedule and every 4xx becomes terminal_failure. If a worker crashes after Cloudflare 204 but before state write, lease expiry causes another POST; a repeated 204 completes, while any repeated 4xx remains terminal_failure and is not assumed revoked. At/after `credentialExpiresAt` the reconciler may mark the job naturally_expired without setting revokedAt. Duplicate triggers/jobs are idempotent by deterministic job ID. State transitions set `ttlDeleteAt` exactly as Task 1 specifies: absent for pending/leased/retry_wait, completedAt plus seven days for completed, terminal transition plus 30 days for terminal_failure, and naturallyExpiredAt plus 30 days for naturally_expired. Tests configure Firestore TTL only on `ttlDeleteAt` and prove `credentialExpiresAt` never deletes a job.

The once-per-minute `sweepLiveTestRuns` scheduled export reads bounded expired live leases/runs and rereads every bounded known session/issuance from the run tombstone. For each derived-expired nonterminal session it calls `cleanupExpiredRemoteSession` with that authoritative snapshot's expected update time; concurrent changes refuse and exact `LEASE_EXPIRED` retries remain idempotent. It ensures required deterministic revocation jobs exist for known persisted issuances, then marks the run terminal/revocation_pending/abandoned with 30-day `ttlDeleteAt`. It never deletes product records or touches unknown/shared rate state. Missing/other-terminal sources produce no optional derived write; overdue work emits only safe hashes/counters to the alert sink.

No session/device response reports terminal success before its required revocation jobs are durably enqueued. External Cloudflare completion may occur later and never blocks local PTY cleanup.

- [ ] **Step 7: Verify and commit**

Freeze `TASK5_REMOTE_FUNCTION_EXPORT_NAMES` as exactly `issueTurnCredentials`, `revokeTurnCredentials`, `enqueueTurnRevocationOnSessionWrite`, `processTurnRevocationJob`, `reconcileTurnRevocations`, and `sweepLiveTestRuns`. Extend export-metadata.test.ts so those exact issue/revoke callables, terminal-session trigger, revocation-job-create trigger, and scheduled workers all declare region asia-northeast3; issue/revoke require App Check; Cloudflare secret is bound only to generation/compensation and revocation workers, never the live-run sweeper; and no Task 5 export binds CODRA_RATE_LIMIT_PEPPER. Trigger/schedule metadata must be asserted rather than inferred from runbook deployment flags. After these final exports exist, run Task 2's actual self-contained Functions staging and reject any extra/missing export; Task 12 later consumes its immutable component hash in the complete candidate.

Run:

```sh
pnpm --filter @codra/functions test -- test/cloudflare-turn.test.ts test/turn-rate-limit.test.ts test/turn.test.ts test/turn-revocation.test.ts test/turn-revocation-worker.test.ts test/live-test-sweeper.test.ts test/export-metadata.test.ts
pnpm --filter @codra/functions typecheck
pnpm run stage:functions-deploy
pnpm run test:functions-deploy-artifact -- --actual
pnpm exec firebase emulators:exec --project demo-codra --only auth,firestore,functions "pnpm --filter @codra/functions test"
git diff --check
```

Then:

```sh
git add functions/src/cloudflare-turn.ts functions/src/turn-rate-limit.ts functions/src/turn.ts functions/src/turn-revocation.ts functions/src/turn-revocation-worker.ts functions/src/live-test-sweeper.ts functions/src/sessions.ts functions/src/devices.ts functions/src/index.ts functions/test functions-deploy/lib functions-deploy/vendor functions-deploy/functions-component-manifest.json
git commit -m "feat: add compensated cloudflare turn boundary"
```

---

### Task 6: Implement Shared Crypto, ICE, Channel, and Backpressure Primitives

**Depends on:** Tasks 1 and 2. May run in parallel with Task 3.

**Files**

- Create packages/webrtc/src/canonical-crypto.ts
- Create packages/webrtc/src/identity.ts
- Create packages/webrtc/src/signal-verifier.ts
- Create packages/webrtc/src/handshake.ts
- Create packages/webrtc/src/ice.ts
- Create packages/webrtc/src/channel.ts
- Create packages/webrtc/src/deadline.ts
- Create packages/webrtc/src/token-bucket.ts
- Create packages/webrtc/src/attachment-pump.ts
- Create packages/webrtc/src/index.ts
- Create packages/webrtc/test/identity.test.ts
- Create packages/webrtc/test/signal-verifier.test.ts
- Create packages/webrtc/test/handshake.test.ts
- Create packages/webrtc/test/ice.test.ts
- Create packages/webrtc/test/token-bucket.test.ts
- Create packages/webrtc/test/attachment-pump.test.ts

**Produces**

- Runtime-independent P-256 import/sign/verify and RFC 7638 helpers.
- Verify-before-apply signal and mutual-handshake gates.
- Separate browser and node-datachannel ICE normalization.
- Clock-injected deadlines/token buckets and cursor-based output pressure.

- [ ] **Step 1: Write RED crypto and handshake tests**

Include:

- Strict base64url rejects padding, whitespace, plus, slash, empty values, and noncanonical encodings.
- x/y decode to exactly 32 bytes and public-key import rejects an off-curve point.
- RFC 7638 thumbprint is stable and rejects a claimed mismatch.
- Valid 64-byte IEEE-P1363 signature verifies; DER, truncated, expanded, or wrong-key signatures fail.
- Changing sessionId, negotiationId, participant, thumbprint, generation, sequence, kind, payload hash, or expiry invalidates a signal.
- Both directional four-tuple keys independently require 1,2,3; sequence 0/gap/duplicate fails; changing negotiationId resets each direction to 1 without accepting an old cursor.
- Signal is not delivered to the SDP/ICE callback before verification.
- hello from another same-UID device key or an older generation fails. hello_ack with a modified clientChallenge, hostChallenge, device generation, negotiationId, or transcript hash fails.
- A valid mutual transcript is the only transition to authorized.

- [ ] **Step 2: Implement strict P-256 helpers**

validateAndImportPublicJwk first performs Task 1 structural/base64url/coordinate checks, then imports P-256 and thereby validates the curve point. computeRfc7638Thumbprint hashes exactly the Task 1 canonical bytes. signCanonical and verifyCanonical use ECDSA P-256/SHA-256 and the frozen IEEE-P1363 64-byte representation.

Accept CryptoKey and narrow signer/verifier ports so the browser never exports private material. Electron may import a decrypted private JWK only inside main process memory after safeStorage decrypt.

- [ ] **Step 3: Implement verify-before-apply signal sequencing**

SignalVerifier is constructed with frozen session participants/thumbprints/generations, exact sender+recipient, active negotiationId, expected four-tuple cursor, clock, and public key. It:

1. Parses the strict signal.
2. Rejects expired session/signal and any participant/thumbprint/generation/negotiation mismatch.
3. Requires sequence 1 when the exact four-tuple cursor is 0, otherwise exactly cursor plus 1; rejects any cursor from another direction/negotiation.
4. Recomputes the canonical payload hash and verifies signature.
5. Only then returns a typed offer/answer/candidate/end-of-candidates to the peer adapter.

Verification failure does not advance afterSequence and never calls setRemoteDescription or addIceCandidate.

- [ ] **Step 4: Implement a two-key handshake state machine**

Handshake starts locked. Host accepts only a verified client hello bound to the approved session and active negotiation. Host signs hello_ack with the exact canonical hello transcript hash. Browser verifies the host signature and transcript. Each side exposes isAuthorized only after its required peer proof passes; the terminal gateway additionally requires the host to have emitted the verified ack.

Clear transcript/signature state when negotiationId changes. Replay from the prior negotiation fails.

- [ ] **Step 5: Split browser and host ICE normalization honestly**

Browser normalization:

- Rejects port 53, non-Cloudflare schemes/hosts, malformed credentials, and unbounded lists.
- May select only UDP turn, TCP turn, or TLS turns URLs according to an explicit BrowserTurnTransport enum.

Host normalization:

- Accepts only Cloudflare UDP turn URLs and maps them to node-datachannel TurnUdp.
- Drops every TCP and TLS URL rather than mapping unsupported relay types.
- Fails HOST_TURN_UDP_UNAVAILABLE when relay-only mode has no UDP URL.

There is no TurnTcp or TurnTls host output in this plan.

- [ ] **Step 6: Implement deadlines, token bucket, and output pump**

All clocks/timers are injected.

- Negotiation deadline: 20 seconds.
- Health ping: every five seconds; disconnect after three unanswered pings.
- Terminal input bucket: 128 KiB capacity, 64 KiB/s continuous refill, charged by TextEncoder byte length before write. A rejected write consumes no tokens and emits a safe RATE_LIMITED terminal.error.
- Output pump: frames at most 16 KiB; pause when bufferedAmount is at least 1 MiB; resume only on low-water callback at or below 256 KiB; resume via readFromCursor from last acknowledged absolute cursor.
- terminal.cursor_ack is monotonic and fire-and-forget; regression or cursor beyond latest is a protocol error.

- [ ] **Step 7: Verify and commit**

Run:

```sh
pnpm --filter @codra/webrtc test
pnpm --filter @codra/webrtc typecheck
git diff --check
```

Then:

```sh
git add packages/webrtc
git commit -m "feat: add authenticated webrtc primitives"
```

---

### Task 7: Add Opt-In Desktop Identity, Raw App Check, Approval, IPC, and UI

**Depends on:** Task 4. May run in parallel with Tasks 5 and 9.

**Files**

- Create apps/desktop/src/main/remote/safe-storage-port.ts
- Create apps/desktop/src/main/remote/safe-storage-electron.ts
- Create apps/desktop/src/main/remote/safe-storage-test-only.ts
- Create apps/desktop/src/main/remote/device-identity.ts
- Create apps/desktop/src/main/remote/account-bootstrap-port.ts
- Create apps/desktop/src/main/remote/account-bootstrap-production.ts
- Create apps/desktop/src/main/remote/account-bootstrap-test-only.ts
- Create apps/desktop/src/main/remote/loopback-auth-listener.ts
- Create apps/desktop/src/main/remote/device-auth.ts
- Create apps/desktop/src/main/remote/app-check-bootstrap.ts
- Create apps/desktop/src/main/remote/firebase-app-check.ts
- Create apps/desktop/src/main/remote/firebase-host.ts
- Create apps/desktop/src/main/remote/session-approval.ts
- Create apps/desktop/src/main/remote/controller.ts
- Create apps/desktop/src/main/remote/device-identity.test.ts
- Create apps/desktop/src/main/remote/device-auth.test.ts
- Create apps/desktop/src/main/remote/account-bootstrap-production.test.ts
- Create apps/desktop/src/main/remote/loopback-auth-listener.test.ts
- Create apps/desktop/src/main/remote/app-check-bootstrap.test.ts
- Create apps/desktop/src/main/remote/session-approval.test.ts
- Create apps/desktop/src/main/remote/controller.test.ts
- Create apps/desktop/src/main/ipc/remote-ipc.ts
- Create apps/desktop/src/main/ipc/remote-ipc.test.ts
- Modify apps/desktop/src/main/bootstrap.ts
- Modify apps/desktop/src/main/bootstrap.test.ts
- Modify apps/desktop/src/main/lifecycle.ts
- Modify apps/desktop/src/main/lifecycle.test.ts
- Modify apps/desktop/src/preload/desktop-api.ts
- Modify apps/desktop/src/preload/desktop-api.test.ts
- Modify apps/desktop/src/preload/global.d.ts
- Create apps/desktop/src/renderer/src/remote/RemoteSettings.tsx
- Create apps/desktop/src/renderer/src/remote/PendingSessions.tsx
- Create apps/desktop/src/renderer/src/remote/remote.test.tsx
- Modify apps/desktop/src/renderer/src/App.tsx

**Produces**

- Lazy main-process device identity, system-browser Google bridge, and process-lifetime device-scoped Auth session.
- Recursion-free desktop App Check bootstrap and separate CustomProvider adapter.
- Local enable/disable and explicit signed approval UI.
- No host PeerConnection or PTY gateway yet.

- [ ] **Step 1: Write RED tests that preserve standalone startup**

Cover:

- app.whenReady and local terminal/window complete without constructing Firebase when remote is disabled.
- After every Electron restart, standalone terminal starts immediately while remote state is disabled/auth-required; no Auth ID, refresh, custom, or App Check token is restored from disk.
- Every production restart requires a fresh explicit system-browser Google bridge plus the persisted safeStorage key's resume proof; no silent key-only login exists.
- Offline Auth/App Check/Firestore errors do not change local terminal state or window lifecycle.
- Remote enable waits for app.whenReady before touching safeStorage.
- Release binding constructs only safe-storage-electron; no env/global can choose the fake.
- Unit tests can inject an in-memory SafeStoragePort constructor argument.
- Pending approval defaults reject/deny, shows exact browser device and scopes, and expires on its local deadline.
- Renderer cannot choose device ID, thumbprint, session status, signature, Firebase endpoint, TURN URL, or PTY ID outside validated operations.
- Production never creates BrowserWindow/webview OAuth, imports signInWithEmailAndPassword, sends Google/Firebase credentials through IPC, or directs Google/Firebase's handler to loopback.
- PKCE tests prove exactly 32 random bytes become a 43-character unpadded base64url verifier and challenge `BASE64URL(SHA256(ASCII(verifier)))`; a nonconforming verifier/challenge never reaches desktopLoginStart/Redeem.
- Loopback tests cover 127.0.0.1:0 prebind, exact Host/GET/path/query, constant-time state, wrong/replayed/duplicate request, cancellation, five-minute timeout, 8 KiB request bound, invalid-request flood, simultaneous valid-callback race, first-valid atomic claim, success-response flush, bounded forced socket close, and secure static response headers.

- [ ] **Step 2: Implement async safeStorage identity after app readiness**

SafeStoragePort mirrors Electron 43.2.0 async behavior:

```ts
isAsyncEncryptionAvailable(): Promise<boolean>
encryptStringAsync(plaintext): Promise<Buffer>
decryptStringAsync(ciphertext): Promise<{
  result: string;
  shouldReEncrypt: boolean;
}>
```

After app.whenReady, generate a P-256 key if no ciphertext exists. Encrypt the private JWK asynchronously, atomically write ciphertext to a mode 0600 userData file, and persist only public JWK, thumbprint, and device ID alongside it. On decrypt, validate private/public consistency and re-encrypt when shouldReEncrypt is true. Zero/replace plaintext buffers as practical and never log them.

If async encryption is unavailable or decrypt fails, remote enablement fails closed with a recovery choice to register a new device. Local terminal remains usable. safe-storage-test-only is reachable only through Task 2 remote-test compile-time alias and direct unit injection.

- [ ] **Step 3: Implement the exact process-lifetime device-scoped Auth lifecycle**

Initialize Electron-main Firebase Auth with initializeAuth and inMemoryPersistence; never call setPersistence or use internal/custom persistence. account-bootstrap-production.ts:

1. Prebind an HTTP listener to the literal address 127.0.0.1 with port 0 before desktopLoginStart. Never bind localhost, ::, 0.0.0.0, or enable SO_REUSEADDR.
2. Generate >=32 random bytes for state. Generate exactly 32 separate random bytes for the PKCE verifier, encode them as 43-character unpadded base64url, and compute `BASE64URL(SHA256(ASCII(verifier)))`; validate both Task 1 schemas, sign the start binding, and call desktopLoginStart for register/resume/reenable.
3. Build only the canonical https://codra-1b3bb.firebaseapp.com/desktop-auth URL with opaque attempt query and state fragment; validate it again and call shell.openExternal. Never use BrowserWindow, BrowserView, webview, iframe, or embedded Google OAuth.
4. While state is pending, accept only `GET /auth/callback` whose Host exactly equals `127.0.0.1:<bound-port>` and whose query contains exactly one attempt, code, and state with no extra key. Bound request-line plus headers to 8 KiB, cap concurrent listener-owned sockets at 16 with a two-second header timeout, and compare state in constant time. Invalid method/path/Host/state/duplicate/oversized requests receive a bounded static 4xx, close only that socket, never consume state, and never stop the listener; repeated invalid traffic cannot extend the five-minute overall deadline.
5. The first exact callback wins one atomic pending→claimed compare-and-set; simultaneous or replayed valid callbacks cannot redeem twice. Write the static success HTML and call `response.end()`, immediately initiate `server.close()` so Node stops accepting new connections, then await response `finish`, the winning socket close, and the server-close callback. Cap that drain at two seconds, after which destroy only listener-owned sockets and finish closing. Never close the server before success bytes flush unless that bounded timeout fires. Cancellation/overall timeout atomically move pending→cancelled, return no code, close owned sockets/server, and call desktopLoginCancel when the signed cancel remains possible. The controller discards attempt, code, state, nonce, verifier, and port; a subsequent UI action must restart at step 1 with entirely new values and a newly bound listener.
6. Every static success/error response includes `Connection: close`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. It contains no attempt/code/state/token.
7. Redeem attempt/code with the exact PKCE verifier, server nonce, and fresh device signature. Validate the returned device custom token and initial desktop App Check seed in memory, immediately signInWithCustomToken, and verify all four scoped claims against the authoritative device.

Only account-bootstrap-test-only.ts imports signInWithEmailAndPassword, and only Task 2's remote-test alias can reach it under demo-codra/FUNCTIONS_EMULATOR. Production source graph/UI has Google system-browser copy only.

Never call setCustomUserClaims. While running, Auth refreshes the in-memory scoped token and every refresh is rechecked. Quit/restart persists no account/custom/ID/refresh/App Check token or Auth state; only encrypted device identity survives. Remote returns disabled/auth-required and repeats the full Google bridge. Missing/stale claims lock remote with no account-only fallback.

- [ ] **Step 4: Implement raw HTTP App Check bootstrap with zero SDK recursion**

app-check-bootstrap.ts may import only protocol/crypto utilities and injected ports:

```ts
getAuthIdToken(forceRefresh): Promise<string>
signProof(payload): Promise<string>
fetch(input, init)
clock.now()
```

It must have no import path to firebase/functions or firebase/app-check. It calls the challenge action, signs the response binding, calls exchange, validates {token, ttlMillis, serverTimeMillis}, and derives:

```text
expireTimeMillis = serverTimeMillis + ttlMillis
```

firebase-app-check.ts is separate and constructs CustomProvider around the bootstrap supplier. Cache only until the derived expiry minus skew. A forced-expiry fake-clock test proves the next provider request performs a fresh challenge/exchange.

The first CustomProvider request consumes only the in-memory seed returned by `desktopLoginRedeem`; it does not call a Firebase-protected endpoint. Every later refresh calls the raw desktop App Check challenge/exchange endpoints with the device-scoped Auth token plus fresh key proof. Both paths validate server time/TTL and retain the token only in process memory.

- [ ] **Step 5: Compose Firebase host services lazily**

After remote opt-in and verified active-device generation/App Check sessions:

- Enable presence through the signed function and heartbeat every 30 seconds.
- Subscribe with `subscribePendingSessions({hostDeviceId, hostKeyThumbprint, hostDeviceGeneration, limit: 50})`, with all three participant fields taken from the verified scoped claims.
- Verify every session request signature and derived expiry before showing it.
- Explicit `remote.disable` calls `disableDevice`, increments generation, stops heartbeat/subscriptions/sessions, signs out in-memory Auth, and requires the complete system-browser Google bridge plus existing-key proof to re-enable. Plain sign-out/quit drops process-memory tokens and stops hosting without changing the authoritative generation.
- Reconnect transient services with bounded jitter while keeping local terminal independent.

Do not create a background host outside the Electron process.

- [ ] **Step 6: Sign approval or rejection locally**

The approval UI displays the browser device display name and fingerprint suffix, requested scopes, create/attach target, and eight-hour maximum. User must click Allow or Reject; no timeout auto-approves.

Allow generates a fresh random hostChallenge, chooses a subset of requested scopes, signs the exact Task 1 approval payload with both device IDs/thumbprints/generations/challenges, then calls `decideRemoteSession`. Reject selects exactly `USER_REJECTED`, `HOST_BUSY`, or `HOST_DISABLED` and signs the frozen Task 1 rejection payload; timeout/expiry is derived and does not invent another stored rejection reason. Never send the private JWK or raw decrypted material across IPC.

- [ ] **Step 7: Add narrow IPC/preload/UI and lifecycle hooks**

Expose only:

```text
remote.getState
remote.beginGoogleSignIn
remote.cancelSignIn
remote.signOut
remote.enable
remote.disable
remote.listPending
remote.decide
remote.onStateChanged
remote.onPendingChanged
```

Use strict size bounds, sender authorization, admission tokens, and safe error codes. Never return Auth/App Check tokens, Firebase config, private/public JWK, raw signature payloads, TURN credentials, or PTY handles to the renderer.

Explicit Quit stops approvals/heartbeat and asks the future peer registry to close, but local window-close/reopen behavior remains unchanged.

- [ ] **Step 8: Verify and commit**

Run:

```sh
pnpm --filter @codra/desktop test -- src/main/remote src/main/ipc/remote-ipc.test.ts src/main/bootstrap.test.ts src/main/lifecycle.test.ts src/preload
pnpm --filter @codra/desktop typecheck
pnpm run test:e2e -- --grep "standalone"
git diff --check
```

Then:

```sh
git add apps/desktop/src
git commit -m "feat: add opt-in desktop remote identity"
```

---

### Task 8: Add the node-datachannel Host Peer and Authenticated PTY Gateway

**Depends on:** Task 7.

**Files**

- Create apps/desktop/src/main/remote/host-peer.ts
- Create apps/desktop/src/main/remote/host-peer.test.ts
- Create apps/desktop/src/main/remote/peer-registry.ts
- Create apps/desktop/src/main/remote/peer-registry.test.ts
- Create apps/desktop/src/main/remote/terminal-gateway.ts
- Create apps/desktop/src/main/remote/terminal-gateway.test.ts
- Create apps/desktop/src/main/remote/shutdown.ts
- Create apps/desktop/src/main/remote/shutdown.test.ts
- Modify apps/desktop/src/main/remote/controller.ts
- Modify apps/desktop/src/main/remote/controller.test.ts
- Modify apps/desktop/src/main/lifecycle.ts
- Modify apps/desktop/src/main/lifecycle.test.ts
- Modify apps/desktop/src/main/terminal/contracts.ts
- Modify apps/desktop/src/main/terminal/manager.ts
- Modify apps/desktop/src/main/terminal/manager.test.ts
- Modify apps/desktop/src/main/terminal/sqlite.ts
- Modify apps/desktop/src/main/terminal/sqlite.test.ts

**Produces**

- One main-process node-datachannel peer per approved negotiation.
- Verify-before-apply signaling and mutual signed handshake.
- PTY operations and cursor pump only after authorization.
- A repository-bounded safe terminal projection and TerminalManager cursor adapter, owned only by this task.
- Correct PeerConnection.close and process-final cleanup lifecycle.

- [ ] **Step 1: Write RED host-peer and locked-gateway tests**

Cover:

- Unsigned, wrong-key, wrong-thumbprint, wrong-generation, wrong-participant, expired, old-negotiation, replayed, or gapped signals never call node-datachannel peer methods.
- Host receives an offer and answers; it never calls or exposes restartIce.
- A new browser offer with a new negotiationId closes the prior host peer and builds a new answering peer with new SDP ufrag/password.
- Old candidates arriving after replacement are ignored without advancing the new cursor.
- Host TURN config contains TurnUdp only.
- DataChannel operations before verified hello/ack are rejected and create/attach/write never reach TerminalManager.
- Same-UID attacker hello signed by another device key or a stale generation never reaches PTY.
- Device inactive/generation change or server-terminalized session immediately closes channels/PeerConnection and detaches the remote attachment without killing the local PTY.
- `listRemoteDescriptors(limit)` rejects a noninteger/out-of-range limit, executes an actual SQLite `LIMIT` at 100 or below with stable ordering, and returns only strict RemoteTerminalDescriptor fields; cwd/command/environment/scrollback/output never leave the repository projection.
- `terminal.list` returns at most 100 RemoteTerminalDescriptor values; `terminal.detach` removes only this session's attachment/output pump; `terminal.close` is rejected before TerminalManager dispatch.
- PeerConnection.close is called exactly once per peer. Module cleanup runs only at app shutdown after all peers close.

- [ ] **Step 2: Adapt only documented node-datachannel 0.32.3 APIs**

Create PeerConnection with validated configuration, register local description/candidate/state/data-channel callbacks, apply a verified browser offer, and emit a signed host answer/candidates. The browser creates both ordered reliable DataChannels; the host accepts only the exact two labels and rejects duplicates/unknown labels.

Use PeerConnection.close for session/replacement shutdown. There is no destroy method. Do not call module cleanup for a session or window close; shutdown calls cleanup once after registry closeAll settles during explicit application Quit.

- [ ] **Step 3: Make browser the sole restart offerer**

When the browser publishes a valid fresh negotiationId offer, PeerRegistry:

1. Rejects a reused negotiationId.
2. Stops and closes the old host peer.
3. Resets signal cursors/handshake state for the new negotiation.
4. Creates a fresh host PeerConnection.
5. Applies the verified new offer and returns an answer.

The host never calls restartIce and never fabricates an offer. Reconnect obtains new TURN credentials rather than mutating existing credentials in place.

- [ ] **Step 4: Gate the PTY behind signed mutual proof**

Control channel starts in awaiting-hello. Verify client hello using the session-bound browser key, exact both challenges/thumbprints/generations, current active device records, and active negotiation. Sign and emit hello_ack with the canonical transcript hash. Only then transition gateway to authorized.

After authorization:

- Enforce approved list/create/attach/read/write scopes for each operation.
- Extend TerminalRepository and TerminalManager with `listRemoteDescriptors(limit: number): Promise<RemoteTerminalDescriptor[]>`. SqliteTerminalRepository prepares an explicit projection `id, title, cols, rows, state, created_at, exit_code`—never `SELECT *` or cwd—and executes `ORDER BY created_at DESC, id ASC LIMIT ?`. Validate limit as integer 1–100 before repository access and parse every projected row with Task 1's strict schema.
- `terminal.list` calls `listRemoteDescriptors(100)` and returns exactly `{terminals: RemoteTerminalDescriptor[]}`. It never maps from or serializes the full local TerminalDescriptor.
- `terminal.create` uses the existing TerminalManager default-profile creation path, immediately projects the result through the same strict mapper, and returns exactly `{terminal: RemoteTerminalDescriptor}`; it never accepts an arbitrary process command.
- `terminal.attach` accepts only a current terminal ID returned by the bounded list/create path and permitted by the signed session target, returning `{terminalId}`.
- `terminal.detach` stops only this session's pump/attachment and returns `{terminalId}`; it never kills or closes the local PTY. There is no `terminal.close` dispatch case.
- terminal.write validates 64 KiB UTF-8 bytes and charges the 128/64 KiB token bucket before TerminalManager.write.
- terminal.resize preserves 20–400 by 5–200.
- terminal.ok is returned for successful correlated operations.
- terminal.cursor_ack updates pump state with no reply.
- terminal.error has safe code/message and no local path/command/output.

On auth/protocol failure, close both channels and peer without touching unrelated local terminals.

PeerRegistry also watches the authoritative host device generation and each active session status. Device disable or a server closed/failed/rejected transition calls PeerConnection.close, stops its output pump, and detaches remote access immediately; it never relies on a future Firestore Rules denial to stop an already-open DataChannel.

- [ ] **Step 5: Stream terminal bytes with durable catch-up**

Task 8 alone adds `TerminalOutputStore.readFromCursor` to the desktop contract and `TerminalManager.readFromCursor(terminalId, afterCursor, maxBytes)` as a validated pass-through to Task 1's FileTerminalOutputStore implementation. Use terminal-frame codec and AttachmentPump. Live output frames are at most 16 KiB. At 1 MiB bufferedAmount pause live sends; at the low-water event at or below 256 KiB call readFromCursor from the last ack. If compaction caused truncated true, emit a safe terminal.resync marker and begin at earliestCursor.

Do not write payloads to Firestore, Functions, logs, crash metadata, or IPC.

- [ ] **Step 6: Verify and commit**

Run:

```sh
pnpm --filter @codra/desktop test -- src/main/remote/host-peer.test.ts src/main/remote/peer-registry.test.ts src/main/remote/terminal-gateway.test.ts src/main/remote/shutdown.test.ts src/main/terminal/manager.test.ts src/main/terminal/sqlite.test.ts
pnpm --filter @codra/desktop typecheck
pnpm run verify:native-package
git diff --check
```

Then:

```sh
git add apps/desktop/src/main/remote apps/desktop/src/main/lifecycle.ts apps/desktop/src/main/lifecycle.test.ts apps/desktop/src/main/terminal/contracts.ts apps/desktop/src/main/terminal/manager.ts apps/desktop/src/main/terminal/manager.test.ts apps/desktop/src/main/terminal/sqlite.ts apps/desktop/src/main/terminal/sqlite.test.ts
git commit -m "feat: host approved terminals over webrtc"
```

---

### Task 9: Build the Browser Device, Peer, Cursor Store, and Terminal UI

**Depends on:** Task 4. May run in parallel with Tasks 5 and 7; Task 8 is not required until convergence.

**Files**

- Create apps/web/index.html
- Create apps/web/src/main.tsx
- Create apps/web/src/App.tsx
- Create apps/web/src/styles.css
- Create apps/web/src/auth/firebase.ts
- Create apps/web/src/auth/account-bootstrap-production.ts
- Create apps/web/src/auth/account-bootstrap-test-only.ts
- Create apps/web/src/auth/DesktopAuthBridge.tsx
- Create apps/web/src/auth/device-key-store.ts
- Create apps/web/src/auth/device-auth.ts
- Create apps/web/src/auth/app-check.ts
- Create apps/web/src/remote/hosts.ts
- Create apps/web/src/remote/session-request.ts
- Create apps/web/src/remote/browser-peer.ts
- Create apps/web/src/remote/signal-cursor.ts
- Create apps/web/src/remote/cursor-store.ts
- Create apps/web/src/terminal/RemoteTerminal.tsx
- Create apps/web/src/terminal/useRemoteTerminal.ts
- Create apps/web/test/device-key-store.test.ts
- Create apps/web/test/account-bootstrap-production.test.ts
- Create apps/web/test/desktop-auth-bridge.test.tsx
- Create apps/web/test/device-auth.test.ts
- Create apps/web/test/session-request.test.ts
- Create apps/web/test/browser-peer.test.ts
- Create apps/web/test/cursor-store.test.ts
- Create apps/web/test/remote-terminal.test.tsx

**Produces**

- Non-extractable browser P-256 identity and durable, device-scoped Auth session.
- Trusted-web Google bootstrap plus the exact hosted system-browser desktop bridge.
- Same-account live host picker and signed session request.
- Browser RTCPeerConnection offer/restart flow and signed mutual handshake.
- IndexedDB signal/output cursors and xterm remote-only UI.

- [ ] **Step 1: Write RED browser-key/Auth tests**

Cover:

- Generate P-256 with extractable false and usages sign/verify.
- Store private CryptoKey directly in IndexedDB structured clone; exporting the private key fails while exporting public JWK succeeds.
- Reload restores the same CryptoKey and RFC 7638 thumbprint.
- Corrupt/missing IndexedDB key creates a new device only after user confirmation; it never reuses an old device ID with a new key.
- Production main-browser bootstrap uses only an explicitly clicked Google popup in a separate in-memory Auth context; its account-only token is never written to IndexedDB and cannot access device-bound Firestore data.
- Production registration/resume/re-enable rejects a provider other than google.com, auth_time older than five minutes or implausibly in the future, and any device-scoped custom-provider token.
- Email/password exists only in `account-bootstrap-test-only.ts`; loading it requires all three compile-time/runtime guards: remote-test build, project demo-codra, and FUNCTIONS_EMULATOR true. The production import graph contains neither that module nor `signInWithEmailAndPassword`.
- signInWithCustomToken result has exact codraDeviceId, codraKeyThumbprint, codraDeviceKind, and codraDeviceGeneration claims.
- Forced ID-token refresh retains that browser's claims.
- Two Auth contexts for the same UID retain different device claims concurrently.
- Disable/re-enable advances generation; the prior persisted browser refresh session fails Rules/Functions and cannot read/delete its old sessions.
- `/desktop-auth` accepts only one attempt query plus one state fragment, initializes a dedicated named Firebase app/Auth with the pinned public redirect resolver and in-memory persistence, never embeds OAuth, invokes `signInWithRedirect` only after an explicit click, explicitly calls `getRedirectResult()` on return, uses different limited-use App Check tokens for inspect and Allow, and navigates to loopback only through top-level `window.location.replace`.
- Replaying the inspect token for Allow or either token a second time produces `alreadyConsumed` denial and no business mutation; unit fakes expose distinct token IDs and assert no credential is logged or stored.
- The desktop bridge never sends a Google/Firebase credential to Electron, renderer IPC, query parameters, logs, or persistence. A failed/interrupted callback has no same-code navigation control: Electron times out, signed-cancels if the attempt remains pending, closes its listener/session, and the UI starts a wholly new attempt/code/state.

- [ ] **Step 2: Implement browser key storage and exact Auth exchange**

Call:

```ts
crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
  "sign",
  "verify",
]);
```

Persist the non-extractable private CryptoKey and public CryptoKey/metadata in IndexedDB. Export only the public JWK. Validate and recompute thumbprint on every load.

Auth lifecycle matches Task 7:

1. In production, `account-bootstrap-production.ts` initializes a separate `accountAuth` context with `inMemoryPersistence`, constructs `const provider = new GoogleAuthProvider()`, and after an explicit user click calls exactly `await signInWithPopup(accountAuth, provider)`. Require provider google.com and let the server enforce Task 1's exact five-minute/30-second auth_time window. Sign out this account-only context immediately after exchange. Unit tests spy the modular function and prove the first argument is that exact `accountAuth` instance and the second is `provider`.
2. In the remote-test build only, `account-bootstrap-test-only.ts` uses in-memory email/password under the exact demo-codra plus FUNCTIONS_EMULATOR triple guard. No runtime flag can load it from a production graph.
3. Use request-register/register for a new key, request-resume/resume for an existing active key, or the explicit re-enable path for a disabled key.
4. Receive createCustomToken with four per-device additional claims and treat it as an in-memory bearer only.
5. Call signInWithCustomToken on the scoped Auth context configured with browserLocalPersistence so IndexedDB persists only its post-custom-token ID/refresh session.
6. Validate all claims against local key metadata and the authoritative active device generation before Firestore/App Check use and again on every refresh/restoration.

Never call setCustomUserClaims. Never downgrade to account-wide Rules if claims are absent/stale. Clear the scoped browser persistence immediately when authoritative active/generation validation fails.

- [ ] **Step 3: Implement production App Check and the hosted desktop bridge**

Production web uses reCAPTCHA Enterprise. Development against real Firebase requires an explicitly registered debug token, but Task 12's guarded live browser smoke uses the real registered reCAPTCHA Enterprise integration and refuses a debug provider/token. Emulator builds use only the Task 2 compile-time remote-test config/inert port and demo-codra loopback endpoints. No runtime query parameter, localStorage flag, window global, or env read inside a release bundle switches production to emulator/inert behavior.

Consume Task 3's exact Hosting rewrite for `https://codra-1b3bb.firebaseapp.com/desktop-auth`; Task 9 does not edit firebase.json. Client routing renders `DesktopAuthBridge.tsx` on that direct path, while the Firebase Google handler remains exactly `https://codra-1b3bb.firebaseapp.com/__/auth/handler`. The bridge uses the approved Hosting Firebase Web App ID, while Task 4 mints desktop App Check only for the separately provisioned desktop Web App ID; build/deployment validation rejects missing or equal IDs.

Create the bridge app/Auth through only these pinned public Firebase APIs:

```ts
const bridgeApp = initializeApp(
  bridgePublicConfig,
  "codra-desktop-auth-bridge",
);
const bridgeAuth = initializeAuth(bridgeApp, {
  persistence: inMemoryPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});
```

Do not call setPersistence or use an internal resolver/persistence adapter. On every load call `getRedirectResult(bridgeAuth)` explicitly; a null result is handled as the pre-redirect state, not implicit success.

The bridge performs this bounded state machine:

1. Strictly parse one opaque attempt query and one >=32-byte state fragment into memory and show a Google sign-in button. Invalid/missing/duplicate fields fail closed. Do not write session storage merely by viewing the page.
2. Immediately before the explicit button calls exactly `await signInWithRedirect(bridgeAuth, new GoogleAuthProvider())`, store exactly `{attempt, state, createdAt}` under one namespaced sessionStorage key—no Firebase credential, callback URL, code, config, or device metadata. Unit tests spy the modular function and prove its first argument is the exact named `bridgeAuth` instance. No iframe, webview, popup relay, or direct Google-to-loopback redirect exists.
3. After Firebase returns, explicitly call `getRedirectResult(bridgeAuth)`, load and strictly parse that one record, require age <=5 minutes, compare its attempt/state against the current URL and later server binding, then require google.com and fresh auth_time. Any mismatch/error/expiry signs out bridgeAuth and clears the record.
4. Call `authorizeDesktopLogin` inspect with `httpsCallable(..., {limitedUseAppCheckTokens: true})`; require one new limited-use token and display the server-returned device name, fingerprint suffix, and requested action. A token-ID spy proves the inspect token is not reused.
5. Only an explicit Allow click calls the allow action with another `httpsCallable(..., {limitedUseAppCheckTokens: true})` invocation and a different limited-use token. Validate that the response contains only attempt/code/state and that all three match the stored/server binding, clear the session record, sign out bridgeAuth, then call top-level `window.location.replace` to the exact server-approved `http://127.0.0.1:<port>/auth/callback` with only those three values.
6. Call top-level `window.location.replace` only once. The bridge supplies no same-code recovery control and its error page need not recover. Success, navigation failure, cancel, error, and expiry clear the session key and Auth state; Electron's independent deadline signed-cancels when possible, closes the exact loopback listener, and returns the desktop UI to a state that can create an entirely new login attempt/code/state. Never restash or reuse the code, and never use fetch, iframe, PNA, or renderer IPC for the loopback handoff.

- [ ] **Step 4: Discover hosts and create a signed session**

List only current same-account, unexpired host devices. The local stale timer removes them at expiresAt without waiting for Firestore.

On selection, generate a random 32-byte clientChallenge and sessionId. Let the user choose a positive lease no greater than eight hours, then sign the frozen request containing exact browser/host IDs, thumbprints, current generations, requested scopes, clientChallenge, and that expiresAt. Create the requested session through the Task 3 API. The browser never assumes equality to the maximum and cannot choose a host public key/thumbprint/generation that differs from the loaded active host document.

Show waiting/rejected/derived-expired states. Do not start RTCPeerConnection until a valid host approval signature and hostChallenge are loaded and verified with the immutable host key.

- [ ] **Step 5: Implement browser offerer, signal cursors, and handshake**

The browser:

- Creates both exact reliable ordered DataChannels.
- Creates the initial offer with a fresh negotiationId and signs every offer/candidate/end marker. Each outgoing direction begins at sequence 1 and increments contiguously for the exact `(sessionId, negotiationId, senderDeviceId, recipientDeviceId)` key.
- Drains/listens for the exact host→browser tuple using `afterSequence: 0`, negotiationId, and limit 500; a full page or listener error returns to drain mode before listening again.
- Persists accepted sender sequence under all four tuple components in IndexedDB before applying the next record. The opposite direction and old negotiation never advance it.
- Applies only verifier-approved signals.
- On the one allowed restart, calls browser RTCPeerConnection.restartIce, creates a new negotiationId and signed offer, resets handshake, and ignores all old-negotiation rows.

After channels open, send signed hello. Verify signed hello_ack and transcript before rendering an interactive terminal. Browser close closes channels/peer and requests safe session transition.

- [ ] **Step 6: Implement a remote-only xterm surface and durable output cursor**

RemoteTerminal cannot spawn a local process. After mutual proof it first sends `terminal.list`, parses each strict RemoteTerminalDescriptor, rejects any cwd/command/environment/scrollback/output/unknown field, and lets the user either create through the default host profile or attach to an approved listed target. It sends only the frozen approved control operations over the channel. Leaving a terminal sends `terminal.detach`; there is no close control or UI, and detach never requests local PTY destruction. Decode binary frames, write bytes to xterm, persist the absolute acknowledged cursor to IndexedDB, and send fire-and-forget terminal.cursor_ack after durable write.

Disable paste/input without terminal:write. Bound control and UTF-8 input before send. Resize is debounced and validated. Never put terminal content in React logs, analytics, URL, localStorage, Firestore, or error reporting.

- [ ] **Step 7: Verify and commit**

Run:

```sh
pnpm --filter @codra/web test
pnpm --filter @codra/web typecheck
pnpm --filter @codra/web build
git diff --check
```

Then:

```sh
git add apps/web
git commit -m "feat: add authenticated browser remote terminal"
```

---

### Task 10: Prove Direct-ICE Emulator Convergence and Same-UID Isolation

**Depends on:** Tasks 5, 8, and 9.

**Files**

- Create tests/e2e/fixtures/remote-emulator.ts
- Create tests/e2e/remote-direct.spec.ts
- Create tests/e2e/remote-auth-isolation.spec.ts
- Create scripts/run-remote-e2e.mjs
- Modify apps/desktop/src/main/remote implementation tests only as failures require
- Modify apps/web/src implementation tests only as failures require
- Modify packages/firebase implementation tests only as failures require
- Modify functions implementation tests only as failures require

Do not edit Task 1 contracts or Task 2 ownership files.

**Produces**

- Real browser RTCPeerConnection to packaged remote-test Electron node-datachannel host through Auth/Firestore/Functions emulators.
- Proof that production config never initializes in direct E2E.
- Proof that same-UID key/claim confusion cannot reach a PTY.

- [ ] **Step 1: Make the orchestration test fail before convergence**

run-remote-e2e.mjs:

- Uses a fresh temporary emulator export and fixed project demo-codra.
- Requires the Task 2 remote-test compile-time Auth alias and confirms the Functions process has `FUNCTIONS_EMULATOR=true`; the test-only email/password provider refuses to load unless both hold.
- Verifies every configured endpoint is loopback before launch.
- Builds/launches the separately packaged CODRA Remote Test artifact from Task 2 provenance.
- Serves the compile-time emulator web build.
- Starts Auth, Firestore, Functions, and Hosting emulators.
- Scrubs production Firebase identifiers/endpoints from child environments.
- Captures network destinations and fails on any non-loopback Firebase/Functions/Hosting request.
- Ensures trace, screenshot, video, export, and log directories contain neither production config fingerprints nor terminal test marker content.

- [ ] **Step 2: Prove the device-scoped custom-token session lifecycle**

With the Auth emulator and only the triple-guarded remote-test email/password adapter:

1. Sign in one disposable UID by test-only email/password in host, victim browser, and attacker browser contexts; assert the production Google/system-browser modules are absent from this artifact.
2. Register three distinct P-256 device keys through one-shot proofs.
3. Exchange each for createCustomToken(uid, {codraDeviceId, codraKeyThumbprint, codraDeviceKind, codraDeviceGeneration}) and signInWithCustomToken.
4. Force-refresh each ID token after the original ID token expires/invalidates.
5. Assert each refresh retains its own device ID/thumbprint/kind/generation and the three concurrent sessions remain distinct.
6. Assert the original account-only test credential and attacker-scoped token cannot read/write/delete victim participant sessions/signals through Rules.
7. Attempt to use the attacker device-scoped token to request/register a fourth key; reject it because its custom provider/claims are not the emulator-only recent account bootstrap.
8. Disable the attacker device, assert generation increments/inactive, and prove its old ID/refresh session fails every Rules operation and guarded Function. Re-enable only through a fresh triple-guarded test bootstrap plus the original key proof, increment generation again, and prove old-generation sessions/signals remain inaccessible.

The implementation must never call setCustomUserClaims. If the emulator result diverges from the Task 2 guarded `codra-1b3bb` live canary, stop this DAG as an implementation regression before Tasks 11/12. Task 10 does not select a fallback or rewrite the frozen claim architecture; that decision was owned exclusively by the pre-Task-3 gate. Never weaken Rules to UID-only access.

- [ ] **Step 3: Prove the happy path through a real PTY**

Run:

1. Electron starts and local standalone terminal is usable before remote enablement.
2. Host uses the compile-time remote-test account adapter and in-memory scoped Auth, registers/resumes, consumes the initial App Check seed, enables remote, and heartbeats.
3. Browser registers its key, sees the host, signs a request, and waits.
4. Electron shows exact device/scopes; test explicitly clicks Allow and creates hostChallenge/signature.
5. Browser creates a direct-ICE offer; host verifies and answers; each exact directional signal tuple starts at sequence 1, advances contiguously, and drains from `afterSequence: 0` through Firestore.
6. Signed hello/hello_ack succeeds.
7. Browser lists bounded terminal descriptors, creates or attaches one approved terminal, types a deterministic harmless printf marker, receives binary output, acknowledges the durable cursor, resizes, and detaches without closing the local PTY.
8. Firestore emulator export and Functions logs contain control metadata only and no terminal marker/input/output.
9. Local standalone terminal remains independently usable throughout.
10. Quit/relaunch Electron. Assert no Auth/App Check/custom/ID/refresh token exists on disk, local terminal starts immediately, remote is disabled/auth-required, and no heartbeat begins.
11. Invoke the remote-test-only account bootstrap again, complete the existing-device resume proof with the same safeStorage key/generation, and prove remote can be enabled again. Assert this action exercises no production Google bridge code and that the equivalent production behavior is the full system-browser bridge.

- [ ] **Step 4: Prove copied offer/nonce and same-UID attacker fail**

Use a third device key under the same UID:

- Rules deny direct victim session/signal get, list, write, and delete.
- An Admin-only E2E fixture copies a victim offer, clientChallenge, and signal payload into an attacker-visible test record without copying any private key.
- Re-sequencing or changing participant/session/negotiation under the old signature fails signal verification.
- Reusing the victim approval in another session fails its session/transcript binding.
- Attacker's own valid key can sign a hello, but its thumbprint/generation differs from the approved client binding; host closes before TerminalManager create/attach/write.
- Assert zero new PTY, zero PTY write, and no terminal output channel for the attacker.

- [ ] **Step 5: Prove stale presence without a new snapshot**

Stop host heartbeat while leaving the device document unchanged. Advance the browser fake/controlled clock. The host disappears at server expiresAt no later than 120 seconds after its last heartbeat, with no additional Firestore event.

- [ ] **Step 6: Run the full direct gate and commit**

Run:

```sh
pnpm run test:firebase-rules
pnpm run test:remote-direct
pnpm test
pnpm typecheck
git diff --check
```

Then:

```sh
git add tests/e2e/fixtures/remote-emulator.ts tests/e2e/remote-direct.spec.ts tests/e2e/remote-auth-isolation.spec.ts scripts/run-remote-e2e.mjs apps/desktop/src apps/web/src packages/firebase functions/src
git commit -m "test: prove direct remote session isolation"
```

---

### Task 11: Harden Signal Pages, ICE Restart, Cursors, Backpressure, and Input Limits

**Depends on:** Task 10.

**Files**

- Create tests/e2e/remote-reconnect.spec.ts
- Create tests/e2e/remote-signal-pages.spec.ts
- Create tests/e2e/remote-backpressure.spec.ts
- Modify packages/firebase/src/signals.ts only as tests require
- Modify packages/firebase/test/signals.test.ts only as tests require
- Modify packages/webrtc/src/deadline.ts only as tests require
- Modify packages/webrtc/src/token-bucket.ts only as tests require
- Modify packages/webrtc/src/attachment-pump.ts only as tests require
- Modify apps/desktop/src/main/remote/host-peer.ts only as tests require
- Modify apps/desktop/src/main/remote/terminal-gateway.ts only as tests require
- Modify apps/web/src/remote/browser-peer.ts only as tests require
- Modify apps/web/src/remote/signal-cursor.ts only as tests require
- Modify apps/web/src/remote/cursor-store.ts only as tests require

Do not alter frozen schemas or build/manifests.

- [ ] **Step 1: Add deterministic 501/1001 signal page tests**

Generate correctly signed fixtures for one exact `(sessionId, negotiationId, senderDeviceId, recipientDeviceId)` direction and write them in emulator-safe batches; sequence starts at 1:

- 501 records must produce page sizes 500 then 1.
- 1001 records must produce 500, 500, then 1.
- Process every sequence exactly once and persist `afterSequence` under all four tuple components before continuing.
- A restart at sequences 499, 500, 999, and 1000 resumes without loss/duplication.
- A listener snapshot of 500 forces unsubscribe → drain → relisten.
- A listener error forces the same path from durable cursor.
- An opposite direction, wrong negotiationId, gap, duplicate, invalid signature, or expired row does not advance the cursor or reach peer callbacks.

- [ ] **Step 2: Prove browser-only ICE restart**

Force the connected path to fail:

1. Health monitor detects three missed pongs.
2. Browser obtains fresh TURN credentials if TURN is in use.
3. Browser calls RTCPeerConnection.restartIce exactly once, creates a new negotiationId and offer, and resets each new directional tuple to sequence 1/`afterSequence: 0`.
4. Host closes old PeerConnection and answers the new offer/ufrag/password with a fresh host PeerConnection.
5. Late old candidates are rejected.
6. New signed handshake is required before gateway reopens.
7. A second failure closes/rebuilds only according to the documented terminal state; it never loops restart indefinitely.

Spy asserts host has no restartIce call and session shutdown uses PeerConnection.close.

- [ ] **Step 3: Prove output recovery and responsive control**

Produce more than 10 MiB of deterministic terminal output while throttling terminal channel reads:

- bufferedAmount reaching 1 MiB pauses live frames.
- Control ping/pong and close remain responsive on the separate channel.
- At/below 256 KiB low water, host calls readFromCursor from last durable ack.
- Browser receives ordered bytes exactly once and cursor survives browser reload/reconnect.
- Compaction before ack emits resync and resumes from earliest retained cursor without rebasing.
- No terminal bytes appear in Firestore/emulator export/logs.

- [ ] **Step 4: Prove exact UTF-8 and token-bucket behavior**

With fake clock:

- 64 KiB ASCII input is accepted and the next byte rejected.
- Multibyte text is charged by TextEncoder bytes.
- Bucket starts at 128 KiB, refills continuously at 64 KiB/s, caps at 128 KiB, and is per session.
- A rejected over-limit input consumes no tokens and never calls TerminalManager.write.
- Other sessions and resize/detach/session.close/ping remain responsive; no `terminal.close` operation exists.

- [ ] **Step 5: Verify recovery gate and commit**

Run:

```sh
pnpm run test:remote-reconnect
pnpm exec playwright test tests/e2e/remote-signal-pages.spec.ts tests/e2e/remote-backpressure.spec.ts
pnpm test
pnpm typecheck
git diff --check
```

Then:

```sh
git add tests/e2e/remote-reconnect.spec.ts tests/e2e/remote-signal-pages.spec.ts tests/e2e/remote-backpressure.spec.ts packages/firebase/src packages/firebase/test packages/webrtc/src apps/desktop/src/main/remote apps/web/src/remote
git commit -m "test: harden remote recovery and flow control"
```

---

### Task 12: Prove Trusted TURN and the Release Artifact Boundary

**Depends on:** Task 11.

**Files**

- Create tests/e2e/remote-turn.spec.ts
- Create tests/e2e/release-remote-disabled.spec.ts
- Create tests/e2e/desktop-auth-bridge.live.spec.ts
- Create scripts/run-codra-live-suite.mjs
- Create scripts/test-codra-live-suite.mjs
- Create scripts/run-codra-live-preflight.mjs
- Create scripts/resume-codra-live-run.mjs
- Create scripts/run-turn-smoke.mjs
- Create scripts/run-desktop-auth-bridge-smoke.mjs
- Create scripts/build-codra-release-candidate.mjs
- Create scripts/verify-codra-release-candidate.mjs
- Create scripts/test-codra-release-candidate.mjs
- Create scripts/run-codra-release-deploy.mjs
- Create scripts/test-codra-release-deploy.mjs
- Create scripts/resolve-codra-failed-release.mjs
- Create scripts/run-safari-manual-smoke.mjs
- Create scripts/scan-client-artifacts.mjs
- Create scripts/client-public-config-allowlist.json
- Create scripts/verify-remote-release.mjs
- Create scripts/test-scanner.mjs
- Create docs/security/codra-release-candidate.schema.json
- Create docs/runbooks/remote-access.md
- Create docs/runbooks/cloudflare-turn.md
- Create docs/runbooks/codra-live-test.md
- Create docs/runbooks/codra-release-deployment.md
- Create docs/runbooks/release-remote.md

No manifest, lockfile, workspace, Electron Vite, Electron builder, or Task 1 protocol file changes are allowed.

**Produces**

- A trusted browser-allocation transport matrix with host UDP relay held constant.
- A rerun—not a reimplementation—of Task 2's guarded `codra-1b3bb` claim gate.
- One infrastructure-free live suite using stable test identities, one server-time lease, short product leases, bounded-retention side effects, and a retained high-level run tombstone.
- One deterministic complete release-candidate builder/verifier over the actual Functions and Hosting outputs.
- A separate explicitly approved release workflow with literal project/account/candidate confirmation, a project deployment maintenance lease, immutable staged artifacts, and a blocking failed-release journal; it never performs an automatic infrastructure reversal.
- Release-only scanner with public Firebase fingerprint allowlist and secret deny rules.
- Proof test-only hooks/config cannot enter release artifacts.
- Operator runbooks with no secret values.

- [ ] **Step 0: Rerun Task 2's frozen claim-isolation gate**

Task 12 does not create, edit, extend, or select a fallback for the claim canary. It reruns the exact Task 2 static refusal tests and same literal live command:

```sh
node scripts/test-live-test-guard.mjs
node scripts/test-firebase-claim-canary.mjs
node scripts/test-resume-firebase-claim-canary.mjs
CODRA_LIVE_TEST=1 pnpm run test:firebase-claim-canary -- --project codra-1b3bb --confirm-project codra-1b3bb
```

The runner internally performs its guarded project/app CLI preflight and constrained live-data ADC/WIF signing-capability probe, emits only booleans/counts/hashes plus PASS/FAIL, uses the pre-provisioned durable Google live-test UID, and retains its terminal high-level run tombstone for 30 days. It makes no Auth-management or durable-device mutation/list request, requires `isNewUser === false`, and treats identity/profile drift as an operator incident. If a prior canary hard-crashed after lease/tombstone creation, its safe failure output supplies `CODRA_LIVE_TEST=1 pnpm run resume:firebase-claim-canary -- --project codra-1b3bb --confirm-project codra-1b3bb`; run that only after the fixed lease expires. The helper requires the exact canary purpose, zero product IDs, and frozen fingerprints, terminalizes only the retained tombstone, and releases only the matching lease without Task 5 or any enumeration/deletion. A failure blocks this release; no Task 12 workaround, Rules weakening, or late identity-architecture switch is allowed.

- [ ] **Step 1: Build the actual candidate and separate release control from live tenancy**

Start with RED cases proving: the candidate builder is byte-deterministic and rejects stale/missing actual Task 5 Functions staging or Task 9 Hosting output; the live suite cannot invoke deploy or infrastructure writes; stable account/device-profile drift blocks before lease acquisition; live and release leases are mutually exclusive; the suite never issues Auth-user/device deletion or shared rate-state cleanup; very short session/signal/TURN leases remain within product schema bounds; terminalization and known-issuance revocation are durable; abandoned-run sweep/reconciliation and overdue alerts cover crashes; and every trigger rereads authoritative current source/terminal state before a derived write. Separately prove release-control ADC is distinct from live-data ADC and the CLI account, the local journal precedes the atomic remote lease/operation creation, exact selectors and readiness polls are enforced, and failure remains blocking without automatic infrastructure reversal. Reuse Task 2's failed-CLI/debug-log fixtures.

`build-codra-release-candidate.mjs` runs only after Task 5's actual `stage:functions-deploy` and Task 9's production web build. It copies the self-contained Functions stage plus exact lock/toolchain/runtime/Functions-Framework metadata, Hosting build and canonical content manifest, Rules bytes, indexes/field configurations, desired TTL/App Check/Scheduler/IAM/secret-version bindings without secret values, public app IDs/config fingerprints, Git commit, and exact Task 4+5 export list into a fresh ignored `.codra-release-artifacts/<candidateSha256>/` directory. `docs/security/codra-release-candidate.schema.json` strictly validates those fields. The builder normalizes paths, JSON key ordering, modes, and mtimes, hashes every file, writes canonical bytes twice in independent temp roots, and requires identical SHA-256. `verify-codra-release-candidate.mjs` performs an offline clean Functions install/import/export probe and Hosting/Rules/index/config hash checks without workspace siblings or network. “Sealed” means only canonical deterministic bytes, SHA-256, read-only staging, and explicit operator hash confirmation; no cryptographic signature is claimed. A hash-only candidate receipt records the builder/tool versions and source-output fingerprints.

`run-codra-live-suite.mjs` is the only normal Task 12 live-test entry point. It imports Task 2's read-only `live-test-guard.mjs`, requires `CODRA_LIVE_TEST=1 --project codra-1b3bb --confirm-project codra-1b3bb --candidate-manifest <absolute sealed path> --confirm-candidate-sha256 <exact SHA-256>`, and refuses CI, demo/default aliases, any active server live lease, any active/failed deployment lease/operation, or candidate receipt mismatch. It requires the durable Google account and stable operator-maintained host/Chrome/Firefox/Safari device-and-key profiles to match policy; it never creates or deletes those identities. It never deploys or changes Rules, indexes, Hosting, Functions, Cloud Run, TTL, App Check, Scheduler, IAM, Auth configuration, or secret bindings. It owns only: read-only candidate/attestation verification → transactionally acquire one server-time `serverLiveTestLeases/codra-1b3bb` → create one high-level `serverLiveTestRuns/{runId}` tombstone → run browser/TURN flows with very short legal product leases → terminalize/reconcile known results → mark the tombstone terminal or revocation_pending with 30-day retention → release its matching live lease. Its optional local receipt is removed after server terminal state. No child receives an infrastructure or arbitrary product-deletion capability.

`run-codra-live-preflight.mjs` is a remote-mutation-free imported stage for the top-level-provided run ID: it never acquires a lease, creates a run tombstone, deploys, or installs its own finalizer. Its only local writes are the run-owned CLI temp directories that the launcher removes before return. Before the top level acquires the live lease it:

1. Uses Task 2's bounded Firebase CLI launcher only for `projects:list --json` and `apps:list WEB --project codra-1b3bb --json`. Firebase CLI login in the live suite is metadata-only and is never deployment authority. Every invocation uses a run-owned `mkdtemp` cwd, an absolute generated `--config`, a DEBUG-free filtered environment, bounded captured streams, and exact-temp cleanup including `firebase-debug.log`; no child output is forwarded.
2. Loads `docs/security/codra-live-authority.json`, verifies the literal project, approved signer service-account ID, constrained live-data ADC/WIF principal/mode/fingerprint, signBlob binding, durable Google account fingerprint, stable device/key profile fingerprints, and approved release receipt authority, then uses Task 2's official in-memory ADC/Admin clients only for bounded reads, custom-token minting, live lease/run-tombstone writes, and known-session/issuance terminalization/revocation status work. A missing or wrong local ADC/WIF chain is an explicit prerequisite. No credential is downloaded, copied from Firebase CLI, passed on a command line, or printed.
3. Checks the exact reviewed live-data permission set before producing normal output: `iam.serviceAccounts.signBlob`; exact Auth-user/device-profile gets but no create/delete/list/disable authority; bounded product-flow calls; live lease/run-tombstone create/update; known session terminalization and issuance/revocation status reads/writes; plus read-only Rules, Hosting, Functions, Run, Scheduler, Firestore index/field/TTL, App Check, IAM-binding, secret-binding-version, project, and app metadata. It rejects arbitrary product deletion, shared rate-limit mutation outside normal product Functions, every infrastructure write, and every release-operation/receipt permission. Any absent required grant or unexpected privileged grant fails closed with only a safe permission ID/hash. The distinct release-control permission set is never loaded by the live suite.
4. Requires explicit `--confirm-google-provider google.com` and `--confirm-recaptcha-enterprise enabled`; parses only project/app metadata into booleans/counts/fingerprints; requires the canonical firebaseapp.com origin/handler, exact bridge App ID, and distinct approved desktop App Check App ID. No command dumps provider, reCAPTCHA, token, or secret configuration.
5. Through the official Firestore Admin API, reads every required `expiresAt` field resource listed in Task 3 plus both `serverLiveTestRuns.ttlDeleteAt` and `serverTurnRevocationJobs.ttlDeleteAt`, and requires each `ttlConfig.state` ACTIVE. It requires every composite index named by the sealed candidate manifest to be READY and rejects CREATING or ERROR. The suite does not mutate TTL or indexes. Through Firebase App Check Management API `v1beta/projects/{projectNumber}/services/firestore.googleapis.com`, require Firestore `enforcementMode` ENFORCED; through the bridge app's reCAPTCHA Enterprise config GET, require the exact bridge App ID/provider without retrieving a secret. The bounded Firebase Management app list from item 1 requires the distinct desktop app, and the later live custom-provider exchange behaviorally verifies it.
6. Loads the canonical candidate manifest by the operator-confirmed SHA-256, reruns the candidate verifier, and looks up `serverRemoteReleaseReceipts/{candidateSha256}` through an exact read. Through official Rules, Firestore Admin, Hosting, Cloud Functions v2, and Cloud Run v2 read APIs, it independently recomputes and compares Rules/ruleset, composite-index/field states, Hosting release/version/content, Function export/revision/region/runtime/image/build, Cloud Run serving revision, Scheduler/IAM/secret-binding versions, public-config fingerprints, and source commit against the manifest and authority-bound release receipt. Any mismatch fails before lease acquisition. Full resources remain in memory; normal output contains only booleans/counts/hashes.
7. For the deployed `authorizeDesktopLogin`, resolves `serviceConfig.serviceAccountEmail` from Cloud Functions v2 and verifies through bounded IAM policy that exact member has `roles/firebaseappcheck.tokenVerifier`. Immediately before any bridge request the child repeats the read-only function fingerprint and role check. Preflight also GETs canonical `/desktop-auth` and `/__/auth/handler` without following cross-origin redirects and returns only status classes/content fingerprints.

Preflight freezes one canonical deployed-attestation hash covering every item above. The suite rereads it immediately before each browser/TURN stage and after terminalization, and rejects Hosting, Function revision/config/image/build, Rules/ruleset, index/field/TTL, App Check, Scheduler, IAM, secret-binding-version, or release-receipt drift. Mid-run drift stops new product actions, terminalizes/reconciles known sessions and issuances, records a safe incident status in the retained run tombstone, and blocks PASS; it never attempts to change infrastructure.

After preflight succeeds, the top level transactionally creates the fixed server live lease and one `serverLiveTestRuns/{runId}` tombstone only if no deployment lease/operation or other live lease is active. The tombstone records high-level lifecycle summaries only: candidate/receipt/account/profile fingerprints, zero initial known session/issuance entries, safe counters, and the same short server-time run lease. Only exact session and issuance IDs returned successfully by product responses are appended server-side under strict caps; normal output and the optional local receipt contain hashes only. Proof/login attempt IDs, nonces, signals, trigger outputs, and shared HMAC rate-limit documents are never cataloged for suite teardown.

`run-desktop-auth-bridge-smoke.mjs`, `run-safari-manual-smoke.mjs`, and `run-turn-smoke.mjs` are imported child stages under the same server lease and run ID. Each receives an immutable bounded context and normal product clients only; it receives no deploy, arbitrary Admin deletion, shared rate-state cleanup, lease ownership, or independent finalizer capability. Children return safe post-response session/issuance IDs to the top level, which appends them to the bounded Admin-only run tombstone and emits hashes only. Server-generated proof/login attempts/nonces and asynchronous product side effects are intentionally not enumerated. A child failure is thrown to the top level, which still terminalizes known sessions and reconciles known issuances before releasing the lease or leaving it for the sweeper.

Every test session uses the shortest legal product lease and every signal/proof/login transaction uses its shortest legal expiry. The flow may create normal shared HMAC rolling-rate state; neither suite nor resume script reads or deletes those documents. Crash-before-response sessions/issuances remain authoritative product records and are handled by normal session expiry, terminal-session triggers, deterministic revocation jobs, and scheduled reconcilers. Crash-after-response known IDs are available in the run tombstone. Unknown credentials possibly created by an ambiguous one-attempt TURN generation are never guessed or revoked and remain bounded by 86,400 seconds; `ambiguousTurnUntil` and its risk window are recorded safely.

`run-codra-release-deploy.mjs` is a separate operator-attended infrastructure workflow, never imported by the suite. It requires `CODRA_RELEASE_DEPLOY=1`, literal `--project codra-1b3bb --confirm-project codra-1b3bb`, `--account <the approved nonsecret CLI email from codra-live-authority.json>`, `--confirm-account-fingerprint <exact CLI-account fingerprint>`, `--candidate-manifest <absolute sealed path>`, and `--confirm-candidate-sha256 <exact SHA-256>`. Before any Node REST read/transaction it loads and verifies the distinct `releaseControlAuthority` WIF/ADC caller, impersonated service account, credential mode, and fingerprints; it rejects the live-data principal and CLI account as release-control ADC. It pins the reviewed `firebase-tools` version and never runs `login:list`, requests/prints a token, reads Firebase CLI credential files, accepts an account alias, or derives the deploy account from ambient state. Every Firebase CLI child rejects `--token`, `FIREBASE_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, and all policy-enumerated ADC precedence keys, then uses only the exact filtered environment plus explicit policy `--account`. Release-control ADC remains in the parent Node process and never reaches CLI argv/env/output.

Before any remote mutation, the release workflow verifies the complete candidate and release-control authority, refuses an active live/deployment lease or open release operation, and handles an expired/abandoned live run first. It requires the live-run sweeper to reread each discoverable test session and invoke `cleanupExpiredRemoteSession` with that snapshot's expected update time; exact `LEASE_EXPIRED` retries are idempotent and every concurrent mismatch is reread rather than overwritten. The sweeper must drive every known issuance to HTTP 204 or durable terminal/natural-expiry state and prove no active test session remains before deployment lease acquisition. A recorded ambiguous TURN generation blocks until `ambiguousTurnUntil` unless a separately reviewed risk approval explicitly names that bound; such approval permits infrastructure release but never claims the unknown credential was revoked. The workflow then reads authoritative pre-state and creates `.codra-release-recovery/codra-1b3bb.active.json` with `O_EXCL` and fsync before any remote write. That local journal contains the candidate, selectors, pre-state hashes, operation ID, proposed fencing token, release-control/CLI fingerprints, and ambiguous-risk decision.

Only after the local fsync may one release-control transaction recheck the live lease/session gate and atomically create both `serverDeploymentMaintenanceLeases/codra-1b3bb` and mirrored `serverRemoteReleaseOperations/{opId}` with the same candidate, selectors, pre-state, principals, fencing token, state `deploying`, server-time expiry, and heartbeat. Immediately after that transaction and before the first Firebase CLI child, release-control authoritative reads must reproduce the journaled Rules/Hosting/index/field/TTL/Function/Run/Scheduler/IAM/secret-binding pre-state exactly; drift marks the operation/lease `failed_blocking` before deploy. Every subsequent stage updates the remote operation and validates its fencing token, so a separately authorized operator can resume from the server record after machine loss. Every repository deploy actor must honor this project lease. Takeover requires an expired server-time lease, the matching remote operation, separate approval, an LRO/status reread proving no prior operation still runs, and a strictly newer fencing token. Direct Console or uncoordinated deploy activity during the window is an organizational blocker; detected state drift fails closed.

The workflow copies the already sealed candidate into a fresh read-only staging directory, validates every hash again, and calls Task 2's bounded Firebase CLI adapter with explicit `--account <approved email>`, literal project, absolute generated config/source paths, and only the exact frozen Function names, single Hosting target, `firestore:rules`, and `firestore:indexes` selectors. It rejects extra Function exports and any pre-existing index alteration/removal. A canonical deployed attestation is recomputed from authoritative sources rather than copied from the candidate: Hosting release/version and content manifest; Functions build endpoint plus revision/config, image digest or runtime build hash, pinned runtime/toolchain, execution identity, traffic and behavior; Rules release to ruleset content; composite-index and field-config states; TTL operation/state; Scheduler definitions/targets/identities; IAM bindings; and secret-version bindings without secret values. It maintains the lease heartbeat and validates the fencing token/LRO ownership around every stage. It bounded-polls Rules data-plane allow/deny propagation canaries, each new index to READY or ERROR, each required TTL configuration to ACTIVE, App Check enforcement, Function/Run readiness, Scheduler readiness, and secret/IAM binding visibility before a receipt. TTL remains asynchronous retention only—never correctness or suite cleanup—and production includes a bounded sweeper plus alert for overdue data. ERROR or timeout fails the release.

Only complete exact verification transactionally writes `serverRemoteReleaseReceipts/{candidateSha256}`, marks the mirrored operation succeeded, fsyncs a hash-only local receipt, and releases the matching maintenance lease. Any deploy, poll, or verification failure performs no automatic infrastructure reversal: it marks the remote operation and lease `failed_blocking`, retains any available local journal, and blocks every new deploy/live run. `resolve-codra-failed-release.mjs` is a distinct separately reviewed roll-forward command that accepts the operation ID, rereads the mirrored server operation, and optionally verifies a matching local journal; it therefore survives machine loss. Its canonical reviewed resolution manifest mode is `new_candidate` or `sealed_prior_source_as_new_release`. The latter deploys prior source/input bytes as a new Firebase build/revision with a new image digest, authoritative attestation, and receipt—not restoration of an old runtime resource. “Reviewed” means exact canonical hash/operator confirmation unless a real signer is added later; no cryptographic signature is claimed. Resolution uses the same release-control ADC, CLI account, fencing, readiness, and receipt gates. Success closes the blocking operation/lease; failure remains blocking.

Only `run-codra-live-suite.mjs` owns normal terminalization in its outer `finally`. It closes local browser/listener/peer resources, marks the run terminalizing, sends normal terminal transitions for known nonexpired sessions, and for any now-derived-expired nonterminal session calls `cleanupExpiredRemoteSession` with its authoritative expected update time. It treats the exact `LEASE_EXPIRED` result idempotently and rereads a race instead of overwriting it, then waits a bounded time for each known issuance's deterministic revocation job to reach HTTP 204 completed or another durable safe state. It never deletes product documents, attempts/nonces/signals, shared rate-limit state, stable devices, the Auth user, or the run tombstone. It records terminal/revocation_pending/ambiguous bounds and safe counters, sets `ttlDeleteAt` to 30 days after terminal transition, releases its matching live lease only when no known active session remains, and removes the optional local receipt. Synchronous expiry, normal reconcilers, the live-run sweeper, and overdue alerts own crash/abandonment paths; TTL only removes already terminal tombstones later.

`resume-codra-live-run.mjs` is the sole interrupted-run helper. It requires the literal live gates, constrained live-data authority, and exact run ID; reads the Admin-only tombstone; terminalizes only its bounded exact known session IDs; and requests/reconciles deterministic revocation only for its bounded known issuance IDs. A known derived-expired nonterminal session goes through `cleanupExpiredRemoteSession` with the authoritative expected update time and exact idempotent retry semantics. It never deletes product data or touches unknown proof/login/rate-limit records. Crash-before-ledger sessions/issuances remain governed by their authoritative product state, short expiry, terminal-session trigger, and normal scheduled reconciler. Resume updates the tombstone/lease status and emits hashes only. If unknown ambiguous generation remains, it preserves `ambiguousTurnUntil=createdAt+86400` and reports the wait/risk-approval boundary without inventing a credential.

- [ ] **Step 2: Prove the durable Google desktop identity in automated and manual browsers**

`run-desktop-auth-bridge-smoke.mjs` accepts only the guarded `codra-1b3bb` target, validates the active live lease/run tombstone and approved distinct Web App IDs, prebinds the same strict 127.0.0.1 callback used by Electron, and never accepts a Google password/token as an argument or environment variable. It automates actual installed Chrome and Firefox one at a time using the exact operator-maintained test profiles and their pre-provisioned browser device/key identities; the host uses its stable pre-provisioned Electron device/key profile. Before and after every browser case, exact Auth/device reads must match the policy UID, creation/email/provider fingerprint, enabled state, device IDs/generations, and key thumbprints. Absence, deletion/recreation, disablement, generation/key drift, or a new identity is an operator incident. The suite never creates or deletes the account or durable devices.

Safari is an operator-attended stage in ordinary Safari under a dedicated macOS test user and the exact operator-maintained Safari profile/device/key identity. `run-codra-live-suite.mjs` invokes `run-safari-manual-smoke.mjs` inside the same server live lease and run ID used by Chrome/Firefox; the script is not a standalone mutating command. It automates no Safari UI and never receives credentials. It starts only the external verifier and exact loopback listener, displays the canonical bridge URL plus a hash-only challenge, and waits for a bounded result. The operator opens that URL in ordinary Safari, completes the same normal product flow with short retention bounds, then closes the exact test tab/window and ends the test browser session; the verifier closes its listener in `finally`. Returned session/issuance IDs are appended to the high-level server tombstone, while server-generated attempts/nonces and rate state are left to normal retention. The script cannot claim profile creation/deletion or browser closure. Its safe result binds candidate, account/profile/App-ID, callback/challenge, time-window, and status hashes and is required before PASS.

Every Google return must resolve to the known policy UID, match the account/profile fingerprints, and report `isNewUser === false`; `true` or any drift aborts without repair. The test reuses the stable host plus three stable browser device identities. It bounds the run to six desktop login attempts, four very-short-lease sessions, twelve TURN issuances, and the documented server-generated attempt/signal/rate limits. Only successful returned session/issuance IDs enter the Admin-only tombstone. Proof/login attempts, nonces, signals, trigger outputs, and shared rolling-rate documents remain normal product-owned bounded-retention state and are neither predicted nor queried for deletion.

For every browser, assert the canonical `/desktop-auth` → Firebase `/__/auth/handler` redirect, the dedicated named in-memory Auth plus explicit `getRedirectResult(bridgeAuth)` flow, exact `await signInWithRedirect(bridgeAuth, new GoogleAuthProvider())` invocation, recent google.com provider, reCAPTCHA Enterprise App Check, and new limited-use tokens for inspect and Allow. Replay each limited-use token once and prove `request.app.alreadyConsumed` denial occurs before a rate/transaction/business read. Verify exact device name/fingerprint display, explicit Allow, and the single top-level loopback navigation containing only attempt/code/state. Deliberately prevent one callback from completing and prove there is no same-code navigation control: Electron times out, signed-cancels when possible, closes its listener, then a desktop action creates a wholly new attempt/code/state and succeeds. Redeem through the live Function, assert the custom token and initial App Check seed target distinct approved app IDs without printing either bearer, and record only browser name, app-ID fingerprints, safe run hashes, bounded mutation counts, timings, and PASS/FAIL.

The bridge child closes only its listener and run-launched automation processes; it leaves operator-maintained profiles and durable identities intact and deletes no Firebase data. On success it returns bounded safe status plus any successful session IDs for the high-level tombstone. On failure it throws to the suite's outer `finally`, which terminalizes known sessions. Server expiry, authoritative-reread triggers, the scheduled reconciler/sweeper, and overdue alerts handle attempts and delayed work unknown to the tombstone.

- [ ] **Step 3: Add a guarded trusted TURN runner**

run-turn-smoke.mjs validates the same candidate, server live lease/run ID, stable UID/device profile, and known session context, and verifies by behavior plus authoritative secret-version binding metadata that the rotated structured Firebase secret is bound without accepting or printing the Cloudflare API token locally. It refuses normal CI, a run/lease/profile mismatch, or any request that exceeds the short session/issuance/rate bounds.

The runner records safe issuance ID hashes, candidate types, browser configured URL family, host normalized relay type, selected pair types, timings, and cleanup outcome. It does not record SDP, candidates, usernames, passwords, headers, tokens, or terminal content.

It owns only local per-stage socket/peer closure. It returns bounded successful session/issuance IDs for the high-level tombstone and exercises normal terminal transition/revoke APIs. It performs no catch-all server cleanup, product deletion, shared rate-state access, lease release, or independent finalizer. Failure throws to the top level, which terminalizes known sessions and waits boundedly for known deterministic revocation-job state; unknown/late product work remains under authoritative expiry and reconciliation.

- [ ] **Step 4: Prove the honest Cloudflare relay matrix**

For all rows, set browser iceTransportPolicy relay, set node-datachannel host relay-only with Cloudflare TurnUdp, require a relay/relay selected candidate pair, run the signed handshake and a harmless terminal round-trip, then revoke credentials.

Matrix:

| Row | Browser allowed allocation URL | Host allocation        |
| --- | ------------------------------ | ---------------------- |
| UDP | Cloudflare turn UDP only       | Cloudflare UDP TurnUdp |
| TCP | Cloudflare turn TCP only       | Cloudflare UDP TurnUdp |
| TLS | Cloudflare turns TLS only      | Cloudflare UDP TurnUdp |

The browser-side assertion proves the configured single URL family plus the browser relay candidate/selected pair; TCP/TLS row names describe only the browser allocation transport. Host instrumentation must show TurnUdp for every row. The report must not claim node-datachannel host TCP or TLS support.

Also prove reconnect receives a new issuance, old issuance revokes through POST with HTTP 204, expired/closed sessions cannot issue, and client artifacts/Firestore never receive the long-lived Cloudflare secret. Inject controlled generation timeout/network/5xx/truncated-response boundaries and assert exactly one generate request for each, `TURN_GENERATION_AMBIGUOUS`, retained rolling attempt, released reservation, no returned credential, no issuance username, and no fabricated revoke; document that any unknown orphan dies within ttl 86400. These generation cases never use the durable revocation schedule, which applies only after a validated username is known. In one guarded disposable observation, POST revoke twice for the same run-owned credential and record only each status class/safe code. The second response is observational: if it is not 204, assert server code leaves it terminal_failure until naturally_expired; never redefine success semantics from an undocumented live response without a new review.

- [ ] **Step 5: Build an exact non-echoing source, Git, and artifact scanner**

client-public-config-allowlist.json contains only:

- The approved public Firebase field name.
- SHA-256 fingerprint of that approved value.
- Allowed release artifact path class.

It contains no plaintext values. Allowed fields are limited to apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, and measurementId. The scanner hashes discovered public config values, compares exact field/fingerprint/path tuples, and never prints the value or matched bytes.

Load and strictly validate `docs/security/remote-baseline.json`, require its 40-hex `baselineCommit` to be an ancestor of HEAD, and scan all content introduced since that baseline:

- Enumerate `git rev-list --objects "$baselineCommit..HEAD"`, inspect every blob with `git cat-file --batch-check`/`--batch`, and preserve the object-to-relative-path mapping. This scans an introduced secret even if a later commit deletes it.
- Independently scan index blobs, modified tracked worktree bytes, and untracked files under repository scope, excluding only `.git` object storage and scanner-owned temporary/output directories by exact normalized path.
- Scan the release archive and unpacked app without following symlinks or accepting traversal paths. Decode/minified/binary inspection remains bounded and non-echoing.
- A Git-source denial emits only rule ID, normalized relative path, and at most a 12-hex object prefix; it never prints commit messages, blob bytes, matched text, or surrounding context.

Separate deny rules cover:

- PEM/private-key headers, private_key, private_key_id, service_account type, service-account client email patterns.
- Authorization Bearer forms, Firebase Admin credentials, refresh/ID/App Check token shapes, Cloudflare API token/key secret fields, TURN passwords/usernames in persisted output.
- CLOUDFLARE_TURN_CONFIG and server-only endpoint configuration in any client bundle.
- CODRA_RATE_LIMIT_PEPPER or its decoded/digested value in any client bundle, artifact, log, or persisted live-test output.
- demo-codra, loopback emulator endpoints, com.codra.desktop.remote-test, CODRA Remote Test, safe-storage-test-only, inert App Check, E2E IPC/global hooks in release output.
- Terminal marker/output fixtures, emulator exports, `.codra-live-run-receipts`, live-run/release-operation journals, trace/video paths, and test provenance inside a release archive.

On failure print only DENY rule ID and artifact-relative path. On allow print only field name/path and fingerprint match status. Never print matched content, surrounding context, decoded bundle string, or secret-looking value.

test-scanner.mjs uses synthetic fixtures to prove every allow/deny rule, baseline/ancestor failure, an introduced-then-deleted secret blob, index/worktree/untracked coverage, path normalization, archive traversal rejection, symlink rejection, binary scanning, minified-bundle scanning, public-field fingerprint matching, and non-echo behavior.

Use the TypeScript AST plus the actual release dependency graph for executable checks rather than banning words in documentation/tests. Fail on a production import or call of `setCustomUserClaims`; a release-reachable `signInWithEmailAndPassword` or password-test adapter; Electron-main Auth persistence other than `inMemoryPersistence` or any `setPersistence` call; an OAuth path through `BrowserWindow`, `BrowserView`, `webview`, iframe, or direct Google/Firebase handler redirect to loopback; equal bridge/desktop Firebase App IDs; or a release-reachable demo/loopback/inert-App-Check adapter. Treat bootstrap custom tokens, ID/refresh tokens, App Check tokens, Google credentials, Authorization values, and TURN credentials as branded/validated credential types; fail when one flows to fs/safeStorage/SQLite/JSON persistence, renderer IPC, telemetry, or logger sink. This check does not flag unrelated identifiers such as token-bucket state or prose containing the word “token.”

- [ ] **Step 6: Prove separate test and release artifact provenance**

Remote-test artifact:

- Must have Task 2 test app ID/product/output and provenance testOnly true/configMode emulator.
- May contain fake SafeStoragePort and inert App Check solely because compile-time alias selected them.
- Is never signed/notarized/uploaded/archived as CODRA release.

Release artifact:

- Must have production app ID/product and real safe-storage-electron binding only.
- Scanner proves fake storage, inert App Check, demo project, loopback endpoints, test app ID, and E2E control endpoints are absent.
- No environment variable or runtime option can select a test implementation.
- Packaged smoke runs with remote disabled only and proves local create/input/output/resize/reopen/Quit.
- Trusted remote E2E never runs against or modifies the release artifact.

verify-remote-release.mjs validates hashes/provenance, invokes the scanner, runs native module probe, and runs release-remote-disabled.spec.ts.

- [ ] **Step 7: Write operator runbooks without secrets**

remote-access.md documents opt-in, trusted-web Google sign-in, Electron system-browser bridge, exact Hosting/Google handler URLs, Task 3's `/desktop-auth` rewrite and reserved-handler exclusion, distinct bridge/desktop App IDs, one-shot callback behavior, device binding, approval scopes, presence/expiry, session closure, key loss, stale cleanup, and local-terminal independence. It explains that an interrupted callback ends that bridge page: Electron signed-cancels when possible, closes the listener, and a user starts a new attempt/code/state. It states that email/password is emulator/remote-test-only and cannot be enabled in a release build.

cloudflare-turn.md documents:

- Rotate the previously exposed credential before any deployment.
- Set CLOUDFLARE_TURN_CONFIG through Firebase secret management without shell-history value examples.
- Release only the bound issue/revoke Functions to asia-northeast3 through the separately approved deployment runbook.
- Verify the pre-existing Firestore Admin TTL policies named in Task 3, including `serverTurnRateLimits.expiresAt`, `serverLiveTestRuns.ttlDeleteAt`, and `serverTurnRevocationJobs.ttlDeleteAt`; explicitly state that empty `fieldOverrides` deploys no TTL and the live suite refuses rather than mutates an incorrect policy. TTL is retention only; synchronous checks, the bounded sweeper, and overdue-data alerts own correctness.
- Generate once only: timeout/network/5xx/ambiguous output is `TURN_GENERATION_AMBIGUOUS`, retains the rate attempt, releases the reservation, and is never automatically repeated. Without a validated username no revoke is fabricated; a possible unknown orphan is bounded by ttl 86400.
- Revoke only with POST; only 204 means completed. An undocumented repeated-POST 4xx is recorded safely and remains terminal_failure until natural expiry, never treated as already revoked.
- Run the guarded trusted matrix, inspect hash-only results, terminalize known sessions, reconcile known credentials, and use the retained run tombstone/resume workflow after interruption.

codra-live-test.md states that codra-1b3bb is the only real target and demo-codra is emulator-only. It documents literal project/candidate confirmation plus CODRA_LIVE_TEST, why normal CI never runs live gates, and that Firebase CLI is limited to project/app metadata reads. The constrained live-data WIF/ADC principal owns signing, exact durable-account/profile reads, live lease/run-tombstone state, normal product flow, and known-session/issuance terminalization only. It freezes the signer/live-data/release-control/CLI identities as distinct, never accepts a downloaded key, and forbids Auth/device deletion, arbitrary product cleanup, shared rate-state access, release-control writes, and infrastructure writes in the suite. It separately documents the pre-Task-3 `resume:firebase-claim-canary` command shape: only a fixed expired `claim-isolation-canary` lease with zero session/issuance IDs and exact account/profile fingerprints may be terminalized; a nonexpired lease refuses, and the helper neither invokes Task 5 nor enumerates/deletes anything.

The live runbook freezes bridge/distinct desktop App IDs, durable account and host/Chrome/Firefox/Safari profile fingerprints, explicit provider/reCAPTCHA confirmations, canonical Hosting/handler checks, Firestore App Check ENFORCED, TTL ACTIVE, READY indexes, and runtime identity. It requires the complete candidate/release receipt and authoritative Hosting, Functions build/revision/image/config, Rules/ruleset, index/field/TTL, App Check, Scheduler, IAM, and secret-binding attestation before each stage and after terminalization; drift blocks PASS. It documents shortest legal test leases, product-owned bounded-retention attempts/nonces/signals/rate state, 30-day run tombstones, sweeper/alerts, 86,400-second ambiguous TURN bound, and why TTL is not correctness. It references the separate rate-limit pepper runbook.

Document `run-codra-live-suite.mjs` as one bounded-retention lifecycle owner: read-only preflight, one mutually exclusive server-time live lease, one high-level run tombstone, stable Chrome/Firefox/ordinary-Safari/host identities, normal product flows, bounded known returned session/issuance IDs, and outer terminalization/revocation status handling. It deletes no product data and makes no complete-cleanup or delay-free-state claim. `resume-codra-live-run.mjs` handles only known server-ledger sessions/issuances after interruption; both it and the sweeper use `cleanupExpiredRemoteSession` with authoritative expected update time and idempotent exact-result reconciliation. Unknown product state expires/reconciles normally. Firebase CLI children use isolated temp cwd, absolute config, filtered token/ADC/debug-free environments, bounded capture, and exact temp/debug-log cleanup.

codra-release-deployment.md is the only infrastructure procedure. It documents deterministic candidate build/verification; literal project, approved nonsecret CLI `--account`, candidate SHA-256 confirmation; distinct release-control WIF/ADC; pre-mutation local journal; atomic server lease/operation mirror; fencing/heartbeat/takeover; post-lease pre-state reread; exact selectors; authoritative readiness/behavior polling; and receipt. Expired live runs must be swept through the expected-update-time/idempotent Admin cleanup helper to no active test sessions and known issuances durable-safe before acquisition; ambiguous TURN waits until its bound unless exact risk approval is recorded. An open/failed operation blocks everything. Failure has no automatic infrastructure reversal; reviewed resolution is a new roll-forward release with a new build/revision/image/receipt. No cryptographic signature is claimed without a real signer.

release-remote.md documents distinct remote-test/release artifacts, why fake SafeStoragePort/email-password/inert App Check are compile-time test-only, allowed public Firebase fingerprints, the Task 2 canary rerun, automated stable-profile Chrome/Firefox smoke, and the same-live-lease operator-attended ordinary-Safari stage under its dedicated macOS test user/profile. The operator closes the exact Safari tab/window/session and the external verifier closes its listener; no script automates Safari or claims profile deletion. It also documents scanner behavior and the remote-disabled packaged release smoke.

- [ ] **Step 8: Run the final release gate**

Run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm run format:check
pnpm run test:firebase-rules
node scripts/test-live-test-guard.mjs
node scripts/test-firebase-claim-canary.mjs
node scripts/test-resume-firebase-claim-canary.mjs
node scripts/test-codra-live-suite.mjs
node scripts/test-codra-release-candidate.mjs
node scripts/test-codra-release-deploy.mjs
pnpm run test:remote-direct
pnpm run test:remote-reconnect
pnpm run package:remote-test
pnpm run package:mac
pnpm run stage:functions-deploy
pnpm --filter @codra/web build
pnpm run build:release-candidate
pnpm run verify:release-candidate
pnpm run verify:native-package
pnpm run scan:client-artifacts
pnpm run test:release-remote-disabled
pnpm run verify:remote-release
git diff --check
```

Normal CI stops there and needs neither real Firebase access nor either structured secret. First, an explicitly approved operator releases the already sealed candidate through the separate maintenance-lease workflow; this is not part of the live suite:

```sh
CODRA_RELEASE_DEPLOY=1 node scripts/run-codra-release-deploy.mjs --project codra-1b3bb --confirm-project codra-1b3bb --account <approved-email-from-policy> --confirm-account-fingerprint <approved-account-sha256> --candidate-manifest <absolute-sealed-candidate.json> --confirm-candidate-sha256 <candidate-sha256>
```

If it leaves a failed blocking journal, do not run a new release or smoke. After separate review, perform only an approved new roll-forward release:

```sh
CODRA_RELEASE_DEPLOY=1 node scripts/resolve-codra-failed-release.mjs --project codra-1b3bb --confirm-project codra-1b3bb --account <approved-email-from-policy> --operation-id <failed-operation-id> --resolution-manifest <absolute-canonical-resolution.json>
```

After the exact candidate has a verified release receipt, run this operator-attended live-data block:

```sh
CODRA_LIVE_TEST=1 pnpm run test:firebase-claim-canary -- --project codra-1b3bb --confirm-project codra-1b3bb
CODRA_LIVE_TEST=1 node scripts/run-codra-live-suite.mjs --project codra-1b3bb --confirm-project codra-1b3bb --candidate-manifest <absolute-sealed-candidate.json> --confirm-candidate-sha256 <candidate-sha256> --confirm-google-provider google.com --confirm-recaptcha-enterprise enabled --automated-browsers chrome,firefox --operator-safari ordinary
```

The suite owns one server live lease/run tombstone and imported Chrome/Firefox/Safari/TURN stages. Success means the attestation stayed exact, known sessions were terminalized, known issuances reached durable-safe revocation state, and remaining product-owned records are within declared retention bounds; it never claims every datum was deleted. After an interrupted run, resume only known server-ledger work with:

```sh
CODRA_LIVE_TEST=1 node scripts/resume-codra-live-run.mjs --project codra-1b3bb --confirm-project codra-1b3bb --run-id <server-live-run-id>
```

Resume terminalizes/reconciles bounded known sessions/issuances, deletes nothing, and never starts tests or changes infrastructure. Infrastructure release/resolution remains exclusively in codra-release-deployment.md.

- [ ] **Step 9: Perform the final security/contract audit**

Search source and artifacts and fail if:

- Stored RemoteSessionStatus includes expired.
- Host code contains restartIce, TurnTcp, TurnTls, or destroy.
- Per-signal APIs omit the exact session/negotiation/sender/recipient tuple, `afterSequence`, or bounded limit; a direction does not start at 1/advance contiguously/reset only on a new negotiation.
- Any participant rule falls back to UID-only access or an account-only token can access sessions/signals.
- Production executable code imports/invokes `setCustomUserClaims`, or the release graph reaches the email/password test adapter.
- Any device-scoped operational Rules/Functions authorization path omits the authoritative device active/generation check, or exceeds Firestore rule document-access budgets.
- Production register/resume/re-enable accepts anything except a recent, future-skew-safe google.com account token; the emulator password provider works without all three remote-test/demo-codra/FUNCTIONS_EMULATOR guards.
- The canary/browser account is not the exact durable policy UID/creation-time/email/provider fingerprint before and after, any exchange returns `isNewUser === true` without blocking as an incident, or a suite requests Auth create/delete/disable/list.
- Claim-canary crash recovery can run without both literal project/live guards or constrained live-data authority; accepts a nonexpired/wrong-purpose lease, nonzero session/issuance entries, or wrong account/profile fingerprints; enumerates/deletes anything; depends on Task 5; or fails to atomically terminalize only the matching tombstone and release only its fixed expired lease.
- The exact named Admin app/options and `getAuth(exactApp)` path drift; custom JWT alg/iss/sub/aud/uid/iat/exp is not checked in memory; or exchanged ID-token signature/project aud/securetoken iss/uid/custom provider/timing and refreshed claim isolation are unverified.
- Electron release output persists/restores Firebase Auth/App Check/custom/ID/refresh tokens or uses a non-public/internal Auth persistence adapter.
- Electron uses embedded OAuth, opens a noncanonical bridge, accepts a loopback host/path/state mismatch, or restores remote without the full system-browser bridge after restart.
- Electron PKCE is not exactly 32 random bytes→43 unpadded base64url characters→SHA-256 over ASCII, or the loopback listener consumes/closes on invalid traffic, admits two winners, or closes before bounded success-response flush.
- The bridge Auth is not a dedicated named initializeAuth instance with inMemoryPersistence/browserPopupRedirectResolver/getRedirectResult, sessionStorage contains fields beyond attempt/state/createdAt, or cleanup misses an exit path.
- Production account bootstrap does not call exactly `signInWithPopup(accountAuth, provider)`, bridge bootstrap does not call exactly `signInWithRedirect(bridgeAuth, new GoogleAuthProvider())`, or modular-function spies do not prove the exact Auth instance passed.
- The bridge and desktop Firebase Web App IDs are absent/equal, inspect/Allow does not reject absent/wrong/alreadyConsumed request.app before business logic, the two calls reuse a limited-use token, or Google/Firebase redirects directly to loopback.
- A bridge page offers a same-code second-navigation control, reuses attempt/code/state after callback failure, or Electron fails to signed-cancel when possible, close its listener, and require a completely new login attempt.
- Raw desktop App Check bootstrap imports Firebase Functions/App Check.
- Any raw onRequest export sets `enforceAppCheck: false` instead of omitting the unsupported option.
- App Check ttlMillis is used as an absolute timestamp.
- Presence accepts a client timestamp or Rules allow client device writes.
- Rate limits use fixed bucket document IDs instead of rolling timestamps.
- CODRA_RATE_LIMIT_PEPPER is absent/under 32 decoded bytes, bound to an export that does not hash IP, shared with CLOUDFLARE_TURN_CONFIG, or reaches output/client code.
- Cloudflare generate success can return before issuance persistence.
- A Cloudflare generation timeout/network/5xx/ambiguous outcome triggers another generate fetch, erases the rolling attempt, retains a reservation, fabricates an unknown username/revoke, returns credentials, or fails to use safe `TURN_GENERATION_AMBIGUOUS` and the 86,400-second orphan bound.
- Cloudflare revoke uses a method other than POST, accepts a non-204 response as completed, or marks revokedAt on natural expiry.
- A terminal transition can return before its durable TURN revocation job is transactionally enqueued, or an outbox worker lacks lease/retry reconciliation.
- Release code can select fake safeStorage/inert App Check/demo config at runtime.
- A Firebase Functions v2 export omits explicit `asia-northeast3` metadata.
- Session expiry is required to equal eight hours, exceeds the maximum, or an expired nonterminal session permits any normal/client write/delete, signal, TURN issue, or PTY operation. Fail as well if the Admin cleanup is client-callable, omits authoritative expiry/expected update time/idempotency, changes anything except `failed`/`LEASE_EXPIRED`/server `closedAt`, removes anything beyond the exact registry IDs, or fails to transactionally enqueue/reconcile deterministic revocation for known persisted issuances.
- A remote `terminal.close` path exists, `terminal.detach` kills a local PTY, or terminal.list/create returns the local TerminalDescriptor, lacks an actual repository SQL LIMIT, or leaks cwd/command/environment/scrollback/output.
- firebase.json lacks the exact `/desktop-auth` rewrite, a wildcard captures `/__/auth/handler`, or direct-navigation emulator coverage is absent.
- A live command can run without literal project/candidate gates, targets anything except codra-1b3bb, runs in normal CI, uses an implicit alias, invokes a Firebase CLI subcommand outside exact projects/apps metadata reads, mutates infrastructure, or assumes Firebase CLI can sign/Admin-read. A release command can run without project/account/candidate confirmations, deterministic candidate verification, exact selectors, or project maintenance lease.
- A Firebase CLI child lacks the pinned firebase-tools version, explicit approved `--account` on release children, a run-owned temporary cwd, absolute generated config/source paths, rejection of `--token`/FIREBASE_TOKEN/GOOGLE_APPLICATION_CREDENTIALS/unintended ADC precedence/DEBUG/FIREBASE_DEBUG, bounded non-forwarded capture, or exact-temp cleanup of a failure-created `firebase-debug.log`; or any script runs login:list/reads CLI credential files.
- The signer, constrained live-data, distinct release-control WIF/ADC, and CLI account identities/modes/fingerprints/permissions are absent or cross-used; a downloaded key is accepted; missing ADC is hidden; a token reaches output/disk/argv; release-control ADC reaches a CLI child; or secret payload permission is granted.
- Candidate construction runs before actual Task 5 Functions staging or Task 9 Hosting build, is nondeterministic, omits required artifact/config/binding metadata, includes secret values, trusts workspace siblings/network, or claims a cryptographic signature without a real signer.
- Live preflight acquires state; the suite lacks one mutually exclusive server-time lease/high-level tombstone; stable account/device/key profiles drift or are created/deleted; children receive arbitrary Admin deletion; shared HMAC rate state is read/deleted; product-generated attempt/nonce/signal IDs are cataloged for deletion; or resume does anything beyond known-session terminalization/known-issuance reconciliation.
- Short live-test leases/retention caps, 30-day terminal tombstone, abandoned-run sweeper, overdue alerts, crash-before-ledger expiry/reconciler coverage, or the 86,400-second ambiguous TURN bound are absent; a suite claims complete deletion or absence of delayed work; or an at-least-once trigger writes without rereading authoritative current source and terminal state.
- The live suite mutates Rules, TTL, App Check, indexes, Hosting, Functions, Run, Scheduler, IAM, or secret bindings; any required TTL is not ACTIVE; Firestore App Check is not ENFORCED; an index is not READY; or pre/per-stage/post authoritative attestation drift is ignored.
- A release begins remote mutation before its local intended/pre-state/fencing/selectors journal is fsynced; fails to atomically create the server lease plus mirrored release operation; omits post-lease pre-state equality, heartbeat/takeover/LRO fencing, or machine-loss recovery; trusts the candidate without authoritative Hosting/Functions build-revision-image-config/Rules/index-field/TTL/App Check/Scheduler/IAM/secret-binding reads and behavior canaries; or writes a receipt before readiness succeeds.
- Release lease acquisition proceeds while an expired/abandoned live run still has an active test session or a known issuance outside durable-safe revocation state, or before an ambiguous TURN bound expires without an exact reviewed risk approval naming that bound.
- A failed release automatically changes infrastructure, releases its blocking lease/journal, reuses an old receipt, or calls deployment of prior sealed source a restoration instead of a separately approved new roll-forward build/revision with a new authoritative receipt.
- The deployed authorizeDesktopLogin execution service account lacks `roles/firebaseappcheck.tokenVerifier`, or provider/reCAPTCHA/Hosting/App-ID/index checks are unverified.
- A script automates Safari, receives Safari/Google credentials, claims to create/delete its stable profile/device identity, or runs ordinary Safari outside the suite's shared server live lease/run ID; or operator/verifier closure responsibilities are absent.
- Scanner emits matched content.
- Scanner omits baseline-to-HEAD blobs, index/worktree/untracked content, or an introduced-then-deleted fixture.
- Terminal content reaches Firebase/Functions/logs.

Review actual diff, packaged contents, Firestore Rules tests, emulator network trace, same-UID attack trace, and trusted TURN report. Fix every Critical/Important finding before completion.

- [ ] **Step 10: Commit**

```sh
git add tests/e2e/remote-turn.spec.ts tests/e2e/release-remote-disabled.spec.ts tests/e2e/desktop-auth-bridge.live.spec.ts scripts/run-codra-live-suite.mjs scripts/test-codra-live-suite.mjs scripts/run-codra-live-preflight.mjs scripts/resume-codra-live-run.mjs scripts/run-turn-smoke.mjs scripts/run-desktop-auth-bridge-smoke.mjs scripts/build-codra-release-candidate.mjs scripts/verify-codra-release-candidate.mjs scripts/test-codra-release-candidate.mjs scripts/run-codra-release-deploy.mjs scripts/test-codra-release-deploy.mjs scripts/resolve-codra-failed-release.mjs scripts/run-safari-manual-smoke.mjs scripts/scan-client-artifacts.mjs scripts/client-public-config-allowlist.json scripts/verify-remote-release.mjs scripts/test-scanner.mjs docs/security/codra-release-candidate.schema.json docs/runbooks
git commit -m "test: gate trusted turn and remote release"
```

## Completion criteria

Remote access is complete only when:

- Fresh standalone gate still passes with remote disabled and no Firebase availability.
- Browser and running Electron retain distinct device-scoped custom-token claims through refresh; account-only, inactive/stale-generation, and same-UID other-device sessions cannot access participant data.
- Every device-scoped operational Rules/Functions path checks the authoritative active device generation within call budgets; production register/resume/re-enable instead requires a recent, future-skew-safe google.com account proof plus key proof, so a stolen device-scoped token cannot register another key. The email/password equivalent exists only in the triple-guarded emulator artifact.
- Browser persists only its scoped custom-token Auth session. Electron persists no Auth/App Check token, starts remote-disabled after every restart, and requires the complete system-browser Google bridge plus existing-key proof while local terminal starts immediately.
- Automated stable-profile Chrome/Firefox and operator-attended ordinary Safari under the dedicated macOS test user pass the guarded `codra-1b3bb` live flow with distinct bridge/desktop App IDs and one shared server live lease/run ID; the durable account and host/browser device/key fingerprints remain exact with `isNewUser === false`, and callback failure closes the listener and requires a new attempt.
- A hard crash immediately after the Task 2 claim canary creates its lease/tombstone is recoverable before Task 3 without Task 5: only the exact expired zero-product-ID canary tombstone is retained terminal for 30 days and only its matching lease is released.
- The infrastructure-free live suite verifies authoritative attestation before/during/after, uses shortest legal product leases, retains one 30-day high-level tombstone, terminalizes known sessions, reconciles known issuances, and leaves attempts/nonces/signals/shared rate state to synchronous expiry plus authoritative-reread reconcilers/sweeper/alerts. Resume handles only known IDs, no script claims complete deletion, and ambiguous TURN remains honestly bounded to 86,400 seconds.
- The complete candidate deterministically combines actual Task 5 Functions staging and Task 9 Hosting output with Rules/config/binding metadata and is confirmed by canonical SHA-256 without an invented signature. Infrastructure release uses a distinct release-control WIF/ADC principal plus exact nonsecret CLI `--account`, pre-mutation local journal, atomic mirrored server operation/lease, fencing/heartbeat/post-lease pre-state check, exact selectors, readiness/behavior polling, and a new receipt. Failed state requires a separately reviewed new roll-forward release.
- authorizeDesktopLogin's deployed Gen2 execution service account holds roles/firebaseappcheck.tokenVerifier, and inspect/Allow each reject a reused limited-use token before business logic.
- Browser private key remains non-extractable; Electron private key remains safeStorage ciphertext.
- Every proof nonce is one-shot, every signal and mutual handshake verifies before SDP/ICE/PTY use, and copied offer/nonce attacks create no PTY.
- Server-authored presence expires locally without a new snapshot.
- Stored sessions never use expired; derived expiry blocks every normal/client write, signal, TURN issue, and PTY operation. The non-callable Admin cleanup alone idempotently writes `failed`/`LEASE_EXPIRED` with server `closedAt`, removes the exact two registry memberships, and enqueues/reconciles known-issuance revocation under an expected-update-time precondition.
- 501/1001 signals drain/relisten exactly, one browser-only ICE restart works, and old negotiation data is ignored.
- Direct and trusted relay paths carry terminal bytes only over DataChannels.
- Host TURN remains UDP-only while browser UDP/TCP/TLS allocation rows are reported honestly.
- Rolling TURN limits, separate >=32-byte rate-limit pepper binding, one-attempt fail-closed generation with bounded unknown-orphan semantics, persistence compensation for known credentials, POST-only 204 revocation, natural-expiry state, pre-existing ACTIVE TTL verification, and Firestore App Check ENFORCED verification pass.
- Remote terminal list/create expose only strict RemoteTerminalDescriptor values, with repository-level LIMIT 100 and no cwd/command/environment/scrollback/output.
- Release artifacts cannot select or contain test SafeStorage/App Check/config hooks, and the non-echoing scanner passes.
- No long-lived Cloudflare secret or terminal data is present in source, Git history added by this work, Firebase, logs, traces, or artifacts.
