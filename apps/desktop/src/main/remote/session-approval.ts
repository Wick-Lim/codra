import {
  PendingRemoteSessionListSchema,
  type ApproveRemoteSessionRequest,
  type PendingRemoteSession,
  type RejectRemoteSessionRequest,
  type RemoteSession,
} from "@codra/protocol";

const REQUESTER_DISPLAY_NAME_MAX_LENGTH = 200;

export interface SessionApprovalDependencies {
  approve(
    session: RemoteSession,
    approvedScopes: readonly string[],
  ): Promise<void>;
  reject(session: RemoteSession): Promise<void>;
  resolveRequesterName(session: RemoteSession): Promise<string | undefined>;
  ensureWindow(): Promise<void>;
  now(): number;
  reportError(error: unknown): void;
}

interface PendingEntry {
  session: RemoteSession;
  requesterDisplayName?: string;
}

function toPendingRemoteSession(entry: PendingEntry): PendingRemoteSession {
  const pending: PendingRemoteSession = {
    sessionId: entry.session.sessionId,
    clientDeviceId: entry.session.clientDeviceId,
    requestedScopes: [...entry.session.requestedScopes],
    expiresAt: entry.session.expiresAt,
  };
  if (entry.requesterDisplayName !== undefined)
    pending.requesterDisplayName = entry.requesterDisplayName;
  return pending;
}

export class SessionApprovalRegistry {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly listeners = new Set<
    (sessions: PendingRemoteSession[]) => void
  >();

  constructor(private readonly dependencies: SessionApprovalDependencies) {}

  handlePending(session: RemoteSession): void {
    if (this.entries.has(session.sessionId)) return;
    if (session.expiresAt <= this.dependencies.now()) return;
    this.entries.set(session.sessionId, { session });
    void this.present(session);
  }

  list(): PendingRemoteSession[] {
    this.prune();
    return PendingRemoteSessionListSchema.parse(
      [...this.entries.values()].map(toPendingRemoteSession),
    );
  }

  async approve(request: ApproveRemoteSessionRequest): Promise<void> {
    const session = this.requirePending(request.sessionId);
    for (const scope of request.approvedScopes) {
      if (!session.requestedScopes.includes(scope))
        throw new Error("REMOTE_SCOPES_NOT_REQUESTED");
    }
    this.entries.delete(session.sessionId);
    this.notify();
    await this.dependencies.approve(session, request.approvedScopes);
  }

  async reject(request: RejectRemoteSessionRequest): Promise<void> {
    const session = this.requirePending(request.sessionId);
    this.entries.delete(session.sessionId);
    this.notify();
    await this.dependencies.reject(session);
  }

  onChanged(listener: (sessions: PendingRemoteSession[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.notify();
  }

  private requirePending(sessionId: string): RemoteSession {
    this.prune();
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("REMOTE_SESSION_NOT_PENDING");
    return entry.session;
  }

  private prune(): void {
    const now = this.dependencies.now();
    for (const [sessionId, entry] of this.entries) {
      if (entry.session.expiresAt <= now) this.entries.delete(sessionId);
    }
  }

  private async present(session: RemoteSession): Promise<void> {
    try {
      await this.dependencies.ensureWindow();
    } catch (error) {
      this.dependencies.reportError(error);
      this.entries.delete(session.sessionId);
      this.notify();
      await this.dependencies
        .reject(session)
        .catch((rejectError: unknown) =>
          this.dependencies.reportError(rejectError),
        );
      return;
    }
    this.notify();
    let requesterDisplayName: string | undefined;
    try {
      requesterDisplayName =
        await this.dependencies.resolveRequesterName(session);
    } catch (error) {
      this.dependencies.reportError(error);
      return;
    }
    const bounded = requesterDisplayName
      ?.trim()
      .slice(0, REQUESTER_DISPLAY_NAME_MAX_LENGTH);
    if (!bounded) return;
    const entry = this.entries.get(session.sessionId);
    if (!entry) return;
    entry.requesterDisplayName = bounded;
    this.notify();
  }

  private notify(): void {
    const sessions = this.list();
    for (const listener of this.listeners) {
      try {
        listener(sessions);
      } catch (error) {
        this.dependencies.reportError(error);
      }
    }
  }
}
