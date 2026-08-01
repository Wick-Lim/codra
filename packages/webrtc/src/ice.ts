export type BrowserTurnTransport = "udp" | "tcp" | "tls";

export interface IceServerInput {
  urls: string | readonly string[];
  username?: string;
  credential?: string;
}

export interface BrowserIceServer {
  urls: string;
  username: string;
  credential: string;
  transport: BrowserTurnTransport;
}

export interface HostIceServer {
  url: string;
  hostname: string;
  port: number;
  username: string;
  credential: string;
  password: string;
  relayType: "TurnUdp";
  transport: "TurnUdp";
}

const maxIceServers = 8;
const cloudflareHost = (hostname: string): boolean =>
  hostname === "cloudflare.com" || hostname.endsWith(".cloudflare.com");

function normalizeInput(input: IceServerInput): string[] {
  const urls = typeof input.urls === "string" ? [input.urls] : [...input.urls];
  if (urls.length === 0 || urls.length > maxIceServers)
    throw new Error("TURN_SERVER_LIST_BOUNDED");
  if (!input.username || !input.credential)
    throw new Error("TURN_CREDENTIALS_REQUIRED");
  if (input.username.length > 512 || input.credential.length > 2048)
    throw new Error("TURN_CREDENTIALS_BOUNDED");
  return urls;
}

function parseTurnUrl(value: string): {
  url: URL;
  transport: BrowserTurnTransport;
} {
  const match = /^(turns?):([^?:]+)(?::(\d+))?(?:\?([^#]*))?$/u.exec(value);
  if (!match) throw new Error("TURN_URL_INVALID");
  const [, scheme, hostname, port, query = ""] = match;
  if (scheme !== "turn" && scheme !== "turns")
    throw new Error("TURN_SCHEME_UNSUPPORTED");
  if (!cloudflareHost(hostname)) throw new Error("TURN_HOST_UNSUPPORTED");
  if (port === "53") throw new Error("TURN_PORT_UNSUPPORTED");
  const requested = new URLSearchParams(query).get("transport");
  if (scheme === "turns" && requested && requested !== "tcp")
    throw new Error("TURN_TRANSPORT_UNSUPPORTED");
  const transport: BrowserTurnTransport =
    scheme === "turns" ? "tls" : requested === "tcp" ? "tcp" : "udp";
  if (requested && requested !== "udp" && requested !== "tcp")
    throw new Error("TURN_TRANSPORT_UNSUPPORTED");
  return {
    url: new URL(`https://${hostname}${port ? `:${port}` : ""}`),
    transport,
  };
}

export function normalizeBrowserIceServers(
  inputs: readonly IceServerInput[],
): BrowserIceServer[] {
  if (inputs.length === 0 || inputs.length > maxIceServers)
    throw new Error("TURN_SERVER_LIST_BOUNDED");
  const normalized = inputs.flatMap((input) => {
    const urls = normalizeInput(input);
    return urls.map((value) => {
      const parsed = parseTurnUrl(value);
      return {
        urls: value,
        username: input.username as string,
        credential: input.credential as string,
        transport: parsed.transport,
      };
    });
  });
  if (normalized.length > maxIceServers)
    throw new Error("TURN_SERVER_LIST_BOUNDED");
  return normalized;
}

export function normalizeHostIceServers(
  inputs: readonly BrowserIceServer[],
  options: { relayOnly?: boolean } = {},
): HostIceServer[] {
  const udp = inputs
    .filter((input) => input.transport === "udp")
    .map((input) => {
      const parsed = parseTurnUrl(input.urls);
      const port = parsed.url.port
        ? Number.parseInt(parsed.url.port, 10)
        : 3478;
      return {
        url: input.urls,
        hostname: parsed.url.hostname,
        port,
        username: input.username,
        credential: input.credential,
        password: input.credential,
        relayType: "TurnUdp" as const,
        transport: "TurnUdp" as const,
      };
    });
  if (options.relayOnly && udp.length === 0)
    throw new Error("HOST_TURN_UDP_UNAVAILABLE");
  return udp;
}
