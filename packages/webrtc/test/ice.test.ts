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
