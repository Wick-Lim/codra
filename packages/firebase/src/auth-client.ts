import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  type Auth,
  type UserCredential,
} from "firebase/auth";
import { httpsCallable, type Functions } from "firebase/functions";

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
