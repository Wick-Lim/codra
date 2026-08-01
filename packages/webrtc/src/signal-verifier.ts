import {
  SignalSchema,
  buildSignalSigningPayload,
  type Signal,
} from "@codra/protocol";
import { verifyCanonical } from "./canonical-crypto";

export interface SignalVerifierOptions {
  sessionId: string;
  negotiationId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  signerThumbprint?: string;
  signerDeviceGeneration?: number;
  publicKeyResolver: (thumbprint: string) => Promise<CryptoKey | undefined>;
  now: () => number;
}

export class SignalVerifier {
  private expectedSequence = 0;
  private activeNegotiationId: string;
  readonly options: Readonly<SignalVerifierOptions>;

  constructor(options: SignalVerifierOptions) {
    this.options = options;
    this.activeNegotiationId = options.negotiationId;
  }

  get cursor(): number {
    return this.expectedSequence;
  }

  get negotiationId(): string {
    return this.activeNegotiationId;
  }

  resetNegotiation(negotiationId: string): void {
    if (!negotiationId || negotiationId === this.activeNegotiationId) return;
    this.activeNegotiationId = negotiationId;
    this.expectedSequence = 0;
  }

  async verify(signal: unknown): Promise<Signal> {
    const parsed = SignalSchema.parse(signal);
    if (parsed.sessionId !== this.options.sessionId)
      throw new Error("SIGNAL_SESSION_MISMATCH");
    if (parsed.negotiationId !== this.activeNegotiationId)
      throw new Error("SIGNAL_NEGOTIATION_MISMATCH");
    if (
      parsed.senderDeviceId !== this.options.senderDeviceId ||
      parsed.recipientDeviceId !== this.options.recipientDeviceId
    )
      throw new Error("SIGNAL_PARTICIPANT_MISMATCH");
    if (
      (this.options.signerThumbprint !== undefined &&
        parsed.signerThumbprint !== this.options.signerThumbprint) ||
      (this.options.signerDeviceGeneration !== undefined &&
        parsed.signerDeviceGeneration !== this.options.signerDeviceGeneration)
    )
      throw new Error("SIGNAL_DEVICE_BINDING_MISMATCH");
    if (parsed.expiresAt <= this.options.now())
      throw new Error("SIGNAL_EXPIRED");
    if (parsed.sequence !== this.expectedSequence + 1)
      throw new Error("SIGNAL_SEQUENCE_GAP");
    const key = await this.options.publicKeyResolver(parsed.signerThumbprint);
    if (
      !key ||
      !(await verifyCanonical(
        key,
        parsed.signature,
        buildSignalSigningPayload(parsed),
      ))
    )
      throw new Error("SIGNAL_SIGNATURE_INVALID");
    this.expectedSequence = parsed.sequence;
    return parsed;
  }
}
