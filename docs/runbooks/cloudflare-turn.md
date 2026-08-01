# Cloudflare TURN secret

CODRA calls Cloudflare TURN only from the Firebase Functions boundary. The
desktop and browser clients receive short-lived `iceServers` data from the
`issueTurnCredentials` callable; they never receive the Cloudflare bearer
token.

Provision the Firebase Secret Manager value `CLOUDFLARE_TURN_CONFIG` as JSON:

```json
{ "keyId": "<cloudflare-turn-key-id>", "bearerToken": "<rotated-token>" }
```

The callable sends one bounded request with `ttl: 86400` to Cloudflare. A
timeout, network error, non-201 response, or malformed response fails closed as
`TURN_GENERATION_AMBIGUOUS`; it is never retried because the endpoint has no
idempotency key. Do not put the token in source, `.env` files, fixtures, logs,
commands, or build artifacts. Rotate any previously exposed token before
provisioning this secret.
