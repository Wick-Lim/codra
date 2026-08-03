# Remote access — follow-ups

Carried out of the 2026-08-02 remote access completion work. The final
whole-branch review triaged 27 deferred minor findings and judged that none
blocked merge. Two are recorded here because they are latent traps rather than
polish — each is currently harmless for a reason that will stop being true.

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

## The `signing-key-id-field` scanner rule is over-broad

`docs/security/remote-baseline.json` bans the literal `keyId` from client
bundles. That is correct today, but `keyId` and `kid` are ordinary field names
in JWT, JWK, and WebAuthn libraries. A future vendored dependency shipping one
of those into the renderer or web bundle would trip this rule with a false
positive, and the cheapest response under time pressure is to delete the rule
rather than narrow it.

Narrow it to a JSON-key-shaped anchor before that happens.

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
