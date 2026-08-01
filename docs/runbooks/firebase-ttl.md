# Firebase TTL policy

TTL is retention only. Firestore Rules and Functions enforce presence, lease,
and revocation expiry synchronously; a TTL policy must never be used as an
authorization decision.

Configure these collection-group fields in the Firebase console or an approved
infrastructure release workflow. This repository intentionally keeps
`fieldOverrides` empty so it does not claim ownership of TTL configuration:

- `signals.expiresAt`
- `serverProofChallenges.expiresAt`
- `serverBootstrapRateLimits.expiresAt`
- `serverDesktopLoginTransactions.expiresAt`
- empty/inactive `serverDeviceSessionRegistries.expiresAt`
- `serverTurnRateLimits.expiresAt`
- `serverTurnIssuances.ttlDeleteAt`
- terminal `serverLiveTestRuns.ttlDeleteAt`
- terminal `serverTurnRevocationJobs.ttlDeleteAt`

Do not configure TTL on `users/*/devices`. An expired presence lease only makes
the host unavailable; the immutable device binding remains available for
reconnect and revocation checks.
