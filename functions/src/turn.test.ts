import { describe, expect, it, vi } from "vitest";
import { requestCloudflareTurnCredentials } from "./turn";

const config = { keyId: "turn-key", bearerToken: "secret-token" };

describe("Cloudflare TURN boundary", () => {
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
  });

  it("fails closed if Cloudflare returns no credentialed TURN entry", async () => {
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
  });

  it("fails closed on the legacy snake_case shape rather than silently accepting it", async () => {
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
  });

  it("fails closed without retrying an ambiguous response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("upstream failed", { status: 503 }),
    );
    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).rejects.toThrow("TURN_GENERATION_AMBIGUOUS");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
