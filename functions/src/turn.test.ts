import { afterEach, describe, expect, it, vi } from "vitest";

// firebase-functions/logger is mocked so each catch's structured log can be
// asserted on directly: which discriminator fired, and — just as
// important — that the bearer token, username, and credential values never
// reach it.
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("firebase-functions/logger", () => ({ error: loggerError }));

import { requestCloudflareTurnCredentials } from "./turn";

const config = { keyId: "turn-key", bearerToken: "secret-token" };

describe("Cloudflare TURN boundary", () => {
  afterEach(() => {
    loggerError.mockClear();
  });

  // This fixture is the exact shape observed from a live call to
  // https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers
  // (values below are synthetic, never real minted credentials): the
  // top-level array key is `iceServers` (camelCase, not `ice_servers`), and
  // the response mixes a credential-less STUN-only entry with a second entry
  // that carries `username`/`credential` and six `urls`, one of which uses
  // port 53. An earlier version of this fixture used `ice_servers` with a
  // single already-perfect entry, which matched the code's wrong assumption
  // instead of Cloudflare's real response and let the production bug ship
  // undetected.
  const liveShapedResponse = {
    iceServers: [
      {
        urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"],
      },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turn:turn.cloudflare.com:53?transport=udp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "synthetic-short-lived-user",
        credential: "synthetic-short-lived-password",
      },
    ],
  };

  it("posts one 24-hour request and returns only the credentialed TURN entry, discarding Cloudflare's STUN-only entry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      });
      expect(init?.body).toBe(JSON.stringify({ ttl: 86400 }));
      return new Response(JSON.stringify(liveShapedResponse), {
        status: 201,
      });
    });

    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).resolves.toEqual([liveShapedResponse.iceServers[1]]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("logs a transport discriminator when the network call itself fails, without leaking the bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).rejects.toThrow("TURN_GENERATION_AMBIGUOUS");
    expect(loggerError).toHaveBeenCalledOnce();
    const [, payload] = loggerError.mock.calls[0]!;
    expect(payload).toMatchObject({ discriminator: "transport" });
    expect(JSON.stringify(loggerError.mock.calls[0])).not.toContain(
      config.bearerToken,
    );
  });

  it("logs a status discriminator carrying the actual HTTP status, and fails closed without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("upstream failed", { status: 503 }),
    );
    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).rejects.toThrow("TURN_GENERATION_AMBIGUOUS");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(loggerError).toHaveBeenCalledOnce();
    expect(loggerError.mock.calls[0]?.[1]).toMatchObject({
      discriminator: "status",
      status: 503,
    });
  });

  it("logs an empty-after-filter discriminator if Cloudflare returns no credentialed TURN entry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
          }),
          { status: 201 },
        ),
    );
    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).rejects.toThrow("TURN_GENERATION_AMBIGUOUS");
    expect(loggerError).toHaveBeenCalledOnce();
    expect(loggerError.mock.calls[0]?.[1]).toMatchObject({
      discriminator: "empty-after-filter",
    });
  });

  it("logs a parse discriminator with zod issue paths only — never values — on the legacy snake_case shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ice_servers: [
              {
                urls: "turn:turn.cloudflare.com:3478?transport=udp",
                username: "synthetic-user",
                credential: "synthetic-password",
              },
            ],
          }),
          { status: 201 },
        ),
    );
    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).rejects.toThrow("TURN_GENERATION_AMBIGUOUS");
    expect(loggerError).toHaveBeenCalledOnce();
    const payload = loggerError.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ discriminator: "parse" });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("synthetic-user");
    expect(serialized).not.toContain("synthetic-password");
    expect(serialized).not.toContain(
      "turn:turn.cloudflare.com:3478?transport=udp",
    );
  });
});
