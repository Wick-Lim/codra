import {
  HelloAckSchema,
  HelloSchema,
  canonicalHelloTranscriptHash,
  buildHelloAckSigningPayload,
  buildHelloSigningPayload,
  type Hello,
} from "@codra/protocol";
import { signCanonical, verifyCanonical } from "./canonical-crypto";

export type HandshakeRole = "host" | "browser";

export interface HandshakeGateOptions {
  role: HandshakeRole;
  negotiationId: string;
  sessionId?: string;
  publicKeyResolver?: (thumbprint: string) => Promise<CryptoKey | undefined>;
  signer?: CryptoKey;
}

export class HandshakeGate {
  readonly role: HandshakeRole;
  private activeNegotiationId: string;
  private peerVerified = false;
  private ackVerified = false;
  private readonly options: HandshakeGateOptions;

  constructor(options: HandshakeGateOptions) {
    this.role = options.role;
    this.activeNegotiationId = options.negotiationId;
    this.options = options;
  }

  get authorized(): boolean {
    return this.role === "host"
      ? this.peerVerified
      : this.peerVerified && this.ackVerified;
  }

  get negotiationId(): string {
    return this.activeNegotiationId;
  }

  reset(negotiationId: string): void {
    this.activeNegotiationId = negotiationId;
    this.peerVerified = false;
    this.ackVerified = false;
  }

  async verifyHello(hello: unknown): Promise<Hello> {
    const parsed = HelloSchema.parse(hello);
    if (parsed.negotiationId !== this.activeNegotiationId)
      throw new Error("HELLO_NEGOTIATION_MISMATCH");
    if (
      this.options.sessionId !== undefined &&
      parsed.sessionId !== this.options.sessionId
    )
      throw new Error("HELLO_SESSION_MISMATCH");
    if (this.options.publicKeyResolver === undefined)
      throw new Error("HELLO_KEY_RESOLVER_REQUIRED");
    const key = await this.options.publicKeyResolver(
      parsed.clientKeyThumbprint,
    );
    if (
      !key ||
      !(await verifyCanonical(
        key,
        parsed.signature,
        buildHelloSigningPayload(parsed),
      ))
    )
      throw new Error("HELLO_SIGNATURE_INVALID");
    this.peerVerified = true;
    return parsed;
  }

  async acceptClientHello(
    hello: unknown,
  ): Promise<ReturnType<typeof HelloAckSchema.parse>> {
    const parsed = await this.verifyHello(hello);
    if (this.role !== "host" || !this.options.signer)
      throw new Error("HOST_SIGNER_REQUIRED");
    const { signature: helloSignature, ...helloFields } = parsed;
    void helloSignature;
    const unsignedAck = HelloAckSchema.omit({ signature: true }).parse({
      ...helloFields,
      type: "hello_ack",
      helloTranscriptHash: canonicalHelloTranscriptHash(parsed),
    });
    const signature = await signCanonical(this.options.signer, unsignedAck);
    return HelloAckSchema.parse({ ...unsignedAck, signature });
  }

  async verifyHelloAck(ack: unknown, hello: Hello): Promise<void> {
    const parsed = HelloAckSchema.parse(ack);
    if (this.role !== "browser") throw new Error("BROWSER_ACK_ONLY");
    if (parsed.negotiationId !== this.activeNegotiationId)
      throw new Error("ACK_NEGOTIATION_MISMATCH");
    if (parsed.helloTranscriptHash !== canonicalHelloTranscriptHash(hello))
      throw new Error("ACK_TRANSCRIPT_MISMATCH");
    if (this.options.publicKeyResolver === undefined)
      throw new Error("ACK_KEY_RESOLVER_REQUIRED");
    const key = await this.options.publicKeyResolver(parsed.hostKeyThumbprint);
    if (
      !key ||
      !(await verifyCanonical(
        key,
        parsed.signature,
        buildHelloAckSigningPayload(parsed),
      ))
    )
      throw new Error("ACK_SIGNATURE_INVALID");
    this.ackVerified = true;
    this.peerVerified = true;
  }
}
