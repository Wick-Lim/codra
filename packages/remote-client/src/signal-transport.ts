import {
  publishSignal as publishFirebaseSignal,
  subscribeSignals,
  type FirebaseRuntime,
} from "@codra/firebase";
import {
  REMOTE_SESSION_MAX_LEASE_MS,
  SIGNAL_LEASE_MS,
  RemoteSessionSchema,
  SignalSchema,
  buildSignalSigningPayload,
  type RemoteSession,
  type Signal,
} from "@codra/protocol";
import { SignalVerifier, signCanonical } from "@codra/webrtc";

export interface SignalSubscription {
  sessionId: string;
  negotiationId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  afterSequence: number;
  verify?(signal: Signal): boolean | Promise<boolean>;
  onSignals(signals: Signal[]): void;
  onError(error: Error): void;
}

export interface SignalTransportBackend {
  publish(signal: Signal): Promise<Signal>;
  subscribe(subscription: SignalSubscription): () => void;
}

export interface LocalSignalIdentity {
  deviceId: string;
  keyThumbprint: string;
  generation: number;
  privateKey: CryptoKey;
}

export interface PeerSignalIdentity {
  deviceId: string;
  keyThumbprint: string;
  generation: number;
  publicKey: CryptoKey;
}

export interface SignedSignalTransportOptions {
  session: RemoteSession;
  negotiationId: string;
  local: LocalSignalIdentity;
  peer: PeerSignalIdentity;
  backend: SignalTransportBackend;
  now?: () => number;
}

export function createFirebaseSignalBackend(
  runtime: FirebaseRuntime,
  uid: string,
): SignalTransportBackend {
  return {
    publish: (signal) => publishFirebaseSignal(runtime.functions, signal),
    subscribe: (subscription) =>
      subscribeSignals({
        firestore: runtime.firestore,
        uid,
        ...subscription,
      }),
  };
}

function assertParticipantBindings(
  options: SignedSignalTransportOptions,
): void {
  const session = options.session;
  const localIsClient =
    options.local.deviceId === session.clientDeviceId &&
    options.local.keyThumbprint === session.clientKeyThumbprint &&
    options.local.generation === session.clientDeviceGeneration;
  const localIsHost =
    options.local.deviceId === session.hostDeviceId &&
    options.local.keyThumbprint === session.hostKeyThumbprint &&
    options.local.generation === session.hostDeviceGeneration;
  const peerMatches = localIsClient
    ? options.peer.deviceId === session.hostDeviceId &&
      options.peer.keyThumbprint === session.hostKeyThumbprint &&
      options.peer.generation === session.hostDeviceGeneration
    : localIsHost
      ? options.peer.deviceId === session.clientDeviceId &&
        options.peer.keyThumbprint === session.clientKeyThumbprint &&
        options.peer.generation === session.clientDeviceGeneration
      : false;
  if ((!localIsClient && !localIsHost) || !peerMatches) {
    throw new Error("SIGNAL_PARTICIPANT_BINDING_MISMATCH");
  }
}

export class SignedSignalTransport {
  private readonly session: RemoteSession;
  private readonly now: () => number;
  private sequence = 0;
  private publishTail: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  constructor(private readonly options: SignedSignalTransportOptions) {
    this.session = RemoteSessionSchema.parse(options.session);
    if (
      this.session.status !== "approved" &&
      this.session.status !== "signaling" &&
      this.session.status !== "connected"
    ) {
      throw new Error("SIGNAL_SESSION_NOT_APPROVED");
    }
    if (!options.negotiationId || options.negotiationId.length > 4096) {
      throw new Error("SIGNAL_NEGOTIATION_INVALID");
    }
    assertParticipantBindings({ ...options, session: this.session });
    this.now = options.now ?? Date.now;
  }

  publish(payload: Signal["payload"]): Promise<Signal> {
    const operation = this.publishTail
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) throw new Error("SIGNAL_TRANSPORT_CLOSED");
        const createdAt = this.now();
        const expiresAt = Math.min(
          this.session.expiresAt,
          createdAt + Math.min(SIGNAL_LEASE_MS, REMOTE_SESSION_MAX_LEASE_MS),
        );
        if (expiresAt <= createdAt) throw new Error("SIGNAL_SESSION_EXPIRED");
        const sequence = ++this.sequence;
        const unsigned = SignalSchema.parse({
          sessionId: this.session.sessionId,
          negotiationId: this.options.negotiationId,
          senderDeviceId: this.options.local.deviceId,
          recipientDeviceId: this.options.peer.deviceId,
          signerThumbprint: this.options.local.keyThumbprint,
          signerDeviceGeneration: this.options.local.generation,
          sequence,
          kind: payload.type,
          payload,
          createdAt,
          expiresAt,
          signature: "A".repeat(86),
        });
        const signal = SignalSchema.parse({
          ...unsigned,
          signature: await signCanonical(
            this.options.local.privateKey,
            buildSignalSigningPayload(unsigned),
          ),
        });
        return this.options.backend.publish(signal);
      });
    this.publishTail = operation;
    return operation;
  }

  start(
    onSignals: (signals: Signal[]) => void,
    onError: (error: Error) => void,
  ): void {
    if (this.closed) throw new Error("SIGNAL_TRANSPORT_CLOSED");
    if (this.unsubscribe) throw new Error("SIGNAL_TRANSPORT_ALREADY_STARTED");
    const verifier = new SignalVerifier({
      sessionId: this.session.sessionId,
      negotiationId: this.options.negotiationId,
      senderDeviceId: this.options.peer.deviceId,
      recipientDeviceId: this.options.local.deviceId,
      signerThumbprint: this.options.peer.keyThumbprint,
      signerDeviceGeneration: this.options.peer.generation,
      publicKeyResolver: async (thumbprint) =>
        thumbprint === this.options.peer.keyThumbprint
          ? this.options.peer.publicKey
          : undefined,
      now: this.now,
    });
    this.unsubscribe = this.options.backend.subscribe({
      sessionId: this.session.sessionId,
      negotiationId: this.options.negotiationId,
      senderDeviceId: this.options.peer.deviceId,
      recipientDeviceId: this.options.local.deviceId,
      afterSequence: 0,
      verify: async (signal) => {
        await verifier.verify(signal);
        return true;
      },
      onSignals: (signals) => {
        if (!this.closed) onSignals(signals);
      },
      onError: (error) => {
        if (!this.closed) onError(error);
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
