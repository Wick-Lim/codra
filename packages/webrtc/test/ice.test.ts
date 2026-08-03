import { describe, expect, it } from "vitest";
import {
  normalizeBrowserIceServers,
  normalizeHostIceServers,
} from "../src/ice";

describe("TURN normalization", () => {
  it("keeps browser UDP/TCP/TLS but host only receives Cloudflare UDP", () => {
    const servers = normalizeBrowserIceServers([
      {
        urls: "turn:turn.cloudflare.com:3478?transport=udp",
        username: "u",
        credential: "p",
      },
      {
        urls: "turns:turn.cloudflare.com:5349?transport=tcp",
        username: "u",
        credential: "p",
      },
    ]);
    expect(servers).toHaveLength(2);
    expect(normalizeHostIceServers(servers)).toHaveLength(1);
    expect(normalizeHostIceServers(servers)[0]?.transport).toBe("TurnUdp");
  });

  it("tolerates Cloudflare's unsupported :53 URL variant within an otherwise-usable credential set", () => {
    // This is the exact url bouquet a live call to Cloudflare's
    // generate-ice-servers endpoint returns for one credential set: udp/tcp
    // on 3478, tls on 5349, a :53 fallback, and tcp/tls fallbacks on 80/443.
    // The :53 variant is intentionally unsupported (TURN_PORT_UNSUPPORTED
    // below), but that must only drop that one url, not the whole
    // credential set — Cloudflare always includes it, so an all-or-nothing
    // rule would make every production TURN issuance unusable.
    const servers = normalizeBrowserIceServers([
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turn:turn.cloudflare.com:53?transport=udp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "u",
        credential: "p",
      },
    ]);
    expect(servers).toHaveLength(5);
    expect(servers.map((server) => server.urls)).not.toContain(
      "turn:turn.cloudflare.com:53?transport=udp",
    );
    const hostServers = normalizeHostIceServers(servers, { relayOnly: true });
    expect(hostServers).toHaveLength(1);
    expect(hostServers[0]?.port).toBe(3478);
  });

  it("does not swallow a tampered host mixed into an otherwise-usable credential set", () => {
    // Only the specific, known-benign Cloudflare :53 fallback is tolerated.
    // A rogue url injected alongside real Cloudflare urls (e.g. by a
    // compromised or spoofed upstream) must still fail the whole entry
    // closed, exactly as it did before per-url tolerance was introduced —
    // otherwise silent per-url tolerance plus no server-side logging would
    // make a tampered response indistinguishable from a healthy one.
    expect(() =>
      normalizeBrowserIceServers([
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:evil.example.com:3478?transport=udp",
          ],
          username: "u",
          credential: "p",
        },
      ]),
    ).toThrow("TURN_HOST_UNSUPPORTED");
  });

  it("still fails closed when every url in a multi-url credential set is the unsupported :53 variant", () => {
    // Pins the fail-closed rule at the arity that motivated per-url
    // tolerance (multiple urls), not just the single-url case above.
    expect(() =>
      normalizeBrowserIceServers([
        {
          urls: [
            "turn:turn.cloudflare.com:53?transport=udp",
            "turns:turn.cloudflare.com:53?transport=tcp",
          ],
          username: "u",
          credential: "p",
        },
      ]),
    ).toThrow("TURN_PORT_UNSUPPORTED");
  });

  it("bounds expanded URL lists and rejects contradictory turns transport", () => {
    expect(() =>
      normalizeBrowserIceServers(
        Array.from({ length: 2 }, (_, index) => ({
          urls: Array.from(
            { length: 5 },
            (_, urlIndex) =>
              `turn:turn${index}-${urlIndex}.cloudflare.com:3478?transport=udp`,
          ),
          username: "u",
          credential: "p",
        })),
      ),
    ).toThrow("TURN_SERVER_LIST_BOUNDED");
    expect(() =>
      normalizeBrowserIceServers([
        {
          urls: "turns:turn.cloudflare.com:5349?transport=udp",
          username: "u",
          credential: "p",
        },
      ]),
    ).toThrow("TURN_TRANSPORT_UNSUPPORTED");
  });
});
