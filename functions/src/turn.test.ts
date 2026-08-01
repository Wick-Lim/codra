import { describe, expect, it, vi } from "vitest";
import { requestCloudflareTurnCredentials } from "./turn";

const config = { keyId: "turn-key", bearerToken: "secret-token" };

describe("Cloudflare TURN boundary", () => {
  it("posts one 24-hour request and returns only validated ICE servers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      });
      expect(init?.body).toBe(JSON.stringify({ ttl: 86400 }));
      return new Response(
        JSON.stringify({
          ice_servers: [
            {
              urls: "turn:turn.cloudflare.com:3478?transport=udp",
              username: "short-lived-user",
              credential: "short-lived-password",
            },
          ],
        }),
        { status: 201 },
      );
    });

    await expect(
      requestCloudflareTurnCredentials(config, fetchImpl),
    ).resolves.toEqual([
      {
        urls: "turn:turn.cloudflare.com:3478?transport=udp",
        username: "short-lived-user",
        credential: "short-lived-password",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
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
