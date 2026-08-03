# Remote access — follow-ups

Carried out of the 2026-08-02 remote access completion work. The final
whole-branch review triaged 27 deferred minor findings and judged that none
blocked merge. Two were recorded here because they are latent traps rather than
polish — each harmless for a reason that will stop being true. One remains open;
the other is resolved and kept below for the reasoning.

## `safe-storage-test-alias` is inert, and will silently stay inert

`docs/security/remote-baseline.json` carries an artifact-content rule for each
test-only binding, so that a direct import of a test implementation from shared
main-process code is caught in the built bundle rather than only in the Vite
config.

Two of those rules cannot fire. The scanner matches file **content**, but this
bundler strips module paths — a build of `apps/desktop/out/main/index.js`
contains no `*.ts` path strings at all, while `process.env.*` literals survive
intact. A rule whose pattern is a module's own filename therefore never matches.

`session-auto-approve-test-only` was fixed by exporting a marker whose value is
the alias string, attached so it survives tree-shaking:

```ts
Object.assign(disposer, { seamMarker });
```

A first attempt using `void seamMarker;` was dead-code-eliminated, confirmed by
building with the test alias deliberately swapped in and grepping the output.

`safe-storage-test-alias` and `account-bootstrap-test-alias` were deliberately
left alone. `account-bootstrap-test-only` is covered incidentally by two other
live rules (`email-password-sign-in`, `remote-test-credential-env`) that match
code it genuinely contains. `safe-storage-test-only` is covered by nothing — it
is inert today only because `@codra/remote-safe-storage` has zero consumers and
no `declare module` block. **The moment that seam is wired to a real caller, the
same tree-shaking failure applies and the rule protecting it will pass
vacuously.** Apply the `seamMarker` treatment at that point.

## The approval modal cannot name a browser requester

Found by `tests/e2e/web-console.spec.ts` while proving the console's session
flow end to end. When the browser console requests a session, the host's
approval modal reads:

```
Allow Device 9962657c… to connect?
```

rather than `Allow CODRA browser to connect?`. The browser does register a
display name — `BrowserRemoteController.connect` sends
`displayName: "CODRA browser"` with `kind: "browser"` — but
`HostController.resolveRequesterName`
(`apps/desktop/src/main/remote/host-controller.ts`) resolves it by scanning
`listHostDevices`, and that callable filters to `kind == "host"`
(`functions/src/index.ts`). A browser client is therefore never found, and
`SessionApprovalRegistry.present` falls back to the device-id label.

This is cosmetic in the sense that nothing is misidentified — the id shown is
the requester's real device id — but it is the one screen where a user decides
whether to hand an unknown device `agent.launch` on their Mac, and a truncated
uuid is the least useful thing that screen could say. The fix is to resolve the
name through `getSessionPeerDevice`, which returns the session's peer device
whatever its kind and is already called during negotiation, rather than through
the host-only list.

Deliberately not fixed in the task that found it: that task's remit was
verification and docs, and this is a behaviour change in the desktop host that
needs its own failing test first. `web-console.spec.ts` accepts either
spelling, so closing the gap will not break it.

## Resolved

### The `signing-key-id-field` scanner rule was over-broad

`docs/security/remote-baseline.json` banned the bare literal `keyId` from client
bundles. That was correct at the time, but `keyId` and `kid` are ordinary field
names in JWT, JWK, and WebAuthn libraries. A vendored dependency shipping one
into the renderer or web bundle would have tripped the rule with a false
positive, and the cheapest response under time pressure is to delete a noisy
rule rather than narrow it.

It is now a regex anchored to serialized-object-key shape:

```
["']keyId\\*["']\s*:
```

The rule still denies the Cloudflare TURN credential
(`docs/runbooks/cloudflare-turn.md:11`) in both forms it can reach a bundle in —
written plainly as `{"keyId": ...}`, and inlined by the bundler from a
JSON-valued env var as `"{\"keyId\":\"...\"}"`, where every inner quote is
escaped. The `\\*` is what covers that second form, and it is the one that
matters: an anchor requiring the closing quote to sit flush against `keyId`
passes the plain case and silently misses the likelier leak.

What the rule no longer denies is `keyId` outside serialized-key position — a
bare identifier, a property access, a shorthand property, a parameter name, or
the unquoted object key a minifier emits. Those are the JWT/JWK shapes.
`scripts/test-scan-client-artifacts.mjs` pins both directions: two poisoned
fixtures for the denied payload shapes, two clean fixtures for the allowed JWK
shapes.

This narrowing is not the only guard on that payload. `host-bearer-token-field`
still bans the bare literal `bearerToken`, which appears in every form of the
credential the scanner is protecting against, serialized or not.

## Recorded limitations, not follow-ups

These are deliberate and documented in
`docs/superpowers/specs/2026-08-02-remote-access-completion-design.md`:

- TURN relay is not covered by the two-device harness. Loopback peers use host
  candidates, and `packages/webrtc/src/ice.ts` rejects any TURN host that is not
  Cloudflare, so a local relay cannot be substituted. Relay is verified manually
  after live deployment — see `docs/runbooks/remote-access.md`.
- App Check is disabled.
- `firestore.rules` has no tests.
- `apps/desktop/src/main/remote/desktop-peer-connector.ts` has no unit tests; the
  end-to-end specs exercise it instead.
- The remote end-to-end specs skip on non-darwin.
