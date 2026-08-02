import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  type Auth,
  type UserCredential,
} from "firebase/auth";
import { httpsCallable, type Functions } from "firebase/functions";
import {
  RemoteDeviceSchema,
  RemoteSessionSchema,
  SignalSchema,
  TurnCredentialResponseSchema,
  type RemoteDevice,
  type RemoteSession,
  type Signal,
  type TurnCredentialResponse,
} from "@codra/protocol";

export async function signInWithGoogle(auth: Auth): Promise<UserCredential> {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signInWithEmailPasswordForEmulator(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  if (!email || !password) throw new Error("TEST_ACCOUNT_CREDENTIALS_REQUIRED");
  return signInWithEmailAndPassword(auth, email, password);
}

export interface RegisterDeviceRequest {
  action: "register" | "resume" | "reenable";
  deviceId: string;
  kind: "host" | "browser";
  displayName: string;
  publicKeyJwk: Record<string, unknown>;
  keyThumbprint: string;
  capabilities: string[];
  remoteAccessEnabled: boolean;
}

export interface RegisterDeviceResponse {
  token: string;
  serverTimeMillis: number;
  device: Record<string, unknown>;
}

export async function registerDevice(
  functions: Functions,
  request: RegisterDeviceRequest,
): Promise<RegisterDeviceResponse> {
  const callable = httpsCallable<RegisterDeviceRequest, RegisterDeviceResponse>(
    functions,
    "registerDevice",
  );
  const result = await callable(request);
  return result.data;
}

export async function listHostDevices(
  functions: Functions,
): Promise<RemoteDevice[]> {
  const callable = httpsCallable<Record<string, never>, { devices: unknown[] }>(
    functions,
    "listHostDevices",
  );
  const result = await callable({});
  return result.data.devices.map((device) => RemoteDeviceSchema.parse(device));
}

export interface CreateRemoteSessionRequest {
  sessionId: string;
  hostDeviceId: string;
  hostKeyThumbprint: string;
  hostDeviceGeneration: number;
  protocolVersion: 1;
  requestedScopes: string[];
  clientChallenge: string;
  requestSignature: string;
  expiresAt: number;
}

export async function createRemoteSession(
  functions: Functions,
  request: CreateRemoteSessionRequest,
): Promise<RemoteSession> {
  const callable = httpsCallable<CreateRemoteSessionRequest, unknown>(
    functions,
    "createRemoteSession",
  );
  const result = await callable(request);
  return RemoteSessionSchema.parse(result.data);
}

export interface ApproveRemoteSessionRequest {
  sessionId: string;
  approvedScopes: string[];
  hostChallenge: string;
  approvalSignature: string;
}

export async function approveRemoteSession(
  functions: Functions,
  request: ApproveRemoteSessionRequest,
): Promise<RemoteSession> {
  const callable = httpsCallable<ApproveRemoteSessionRequest, unknown>(
    functions,
    "approveRemoteSession",
  );
  const result = await callable(request);
  return RemoteSessionSchema.parse(result.data);
}

export interface RejectRemoteSessionRequest {
  sessionId: string;
  rejectionReason: "USER_REJECTED" | "HOST_BUSY" | "HOST_DISABLED";
  rejectionSignature: string;
}

export async function rejectRemoteSession(
  functions: Functions,
  request: RejectRemoteSessionRequest,
): Promise<RemoteSession> {
  const callable = httpsCallable<RejectRemoteSessionRequest, unknown>(
    functions,
    "rejectRemoteSession",
  );
  const result = await callable(request);
  return RemoteSessionSchema.parse(result.data);
}

export async function issueTurnCredentials(
  functions: Functions,
  sessionId: string,
): Promise<TurnCredentialResponse> {
  const callable = httpsCallable<{ sessionId: string }, unknown>(
    functions,
    "issueTurnCredentials",
  );
  const result = await callable({ sessionId });
  return TurnCredentialResponseSchema.parse(result.data);
}

export async function publishSignal(
  functions: Functions,
  signal: Signal,
): Promise<Signal> {
  const callable = httpsCallable<{ signal: Signal }, unknown>(
    functions,
    "publishSignal",
  );
  const result = await callable({ signal: SignalSchema.parse(signal) });
  return SignalSchema.parse(result.data);
}

export async function getSessionPeerDevice(
  functions: Functions,
  sessionId: string,
): Promise<RemoteDevice> {
  const callable = httpsCallable<{ sessionId: string }, unknown>(
    functions,
    "getSessionPeerDevice",
  );
  const result = await callable({ sessionId });
  return RemoteDeviceSchema.parse(result.data);
}
