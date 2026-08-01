import {
  initializeApp,
  getApp,
  getApps,
  type FirebaseApp,
  type FirebaseOptions,
} from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import {
  connectFirestoreEmulator,
  collection,
  doc,
  getFirestore,
  getDocs,
  limit as firestoreLimit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type FirestoreDataConverter,
  type Query,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
} from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
  type Functions,
} from "firebase/functions";
import {
  DEMO_PROJECT_ID,
  emulatorDeployment,
  type EmulatorDeploymentConfig,
} from "@codra/protocol/emulator";
import {
  ProductionDeploymentConfigSchema,
  createProductionDeployment,
  productionPublicConfig,
  type ProductionDeploymentConfig,
} from "@codra/protocol/production";
import {
  deriveSessionState,
  RemoteDeviceSchema,
  RemoteSessionSchema,
  SignalSchema,
  SIGNAL_PAGE_LIMIT,
  PENDING_SESSION_LIMIT,
  validateSignalSequence,
  type RemoteDevice,
  type RemoteSession,
  type Signal,
} from "@codra/protocol";
import { z } from "zod";

export * from "./auth-client";

type DeploymentConfig = ProductionDeploymentConfig | EmulatorDeploymentConfig;

export const DEMO_FIREBASE_OPTIONS = {
  apiKey: "demo-codra-api-key",
  authDomain: "127.0.0.1:5000",
  projectId: DEMO_PROJECT_ID,
  storageBucket: "demo-codra.appspot.com",
  messagingSenderId: "demo-codra-sender",
  appId: "demo-codra-app",
} as const satisfies FirebaseOptions;

export type FirebaseRuntimeMode = "production" | "emulator";

export interface FirebaseRuntime {
  app: FirebaseApp;
  auth: Auth;
  firestore: Firestore;
  functions: Functions;
  deployment: DeploymentConfig;
}

export function assertFirebaseRuntimeConfig(
  mode: FirebaseRuntimeMode,
  options: FirebaseOptions,
  desktopAppCheckFirebaseAppId?: string,
): void {
  if (mode === "emulator") {
    if (options.projectId !== DEMO_PROJECT_ID)
      throw new Error("Emulator Firebase config must use demo-codra");
    return;
  }
  const config = createProductionDeployment({
    desktopAppCheckFirebaseAppId: desktopAppCheckFirebaseAppId ?? "",
    operatorApproved: true,
  });
  ProductionDeploymentConfigSchema.parse({
    ...config,
    publicConfig: options,
  });
}

export interface CreateFirebaseRuntimeOptions {
  mode: FirebaseRuntimeMode;
  desktopAppCheckFirebaseAppId?: string;
  appName?: string;
}

export function createFirebaseRuntime(
  options: CreateFirebaseRuntimeOptions,
): FirebaseRuntime {
  const appName = options.appName ?? `codra-${options.mode}`;
  const deployment: DeploymentConfig =
    options.mode === "emulator"
      ? emulatorDeployment
      : createProductionDeployment({
          desktopAppCheckFirebaseAppId:
            options.desktopAppCheckFirebaseAppId ?? "",
          operatorApproved: true,
        });
  const firebaseOptions: FirebaseOptions =
    options.mode === "emulator"
      ? DEMO_FIREBASE_OPTIONS
      : productionPublicConfig;
  assertFirebaseRuntimeConfig(
    options.mode,
    firebaseOptions,
    options.desktopAppCheckFirebaseAppId,
  );
  const app = getApps().some((candidate) => candidate.name === appName)
    ? getApp(appName)
    : initializeApp(firebaseOptions, appName);
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const functions = getFunctions(app, deployment.functionsRegion);
  if (deployment.mode === "emulator") {
    connectAuthEmulator(auth, deployment.authOrigin, {
      disableWarnings: true,
    });
    const firestoreUrl = new URL(deployment.firestoreOrigin);
    connectFirestoreEmulator(
      firestore,
      firestoreUrl.hostname,
      Number(firestoreUrl.port),
    );
    const functionsUrl = new URL(deployment.functionsOrigin);
    connectFunctionsEmulator(
      functions,
      functionsUrl.hostname,
      Number(functionsUrl.port),
    );
  }
  return { app, auth, firestore, functions, deployment };
}

function normalizeFirestoreValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map(normalizeFirestoreValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeFirestoreValue(item),
      ]),
    );
  }
  return value;
}

function safeConverter<T>(schema: z.ZodType<T>): FirestoreDataConverter<T> {
  return {
    toFirestore(value: T): DocumentData {
      return value as unknown as DocumentData;
    },
    fromFirestore(
      snapshot: QueryDocumentSnapshot,
      options: SnapshotOptions,
    ): T {
      void options;
      const parsed = schema.safeParse(normalizeFirestoreValue(snapshot.data()));
      if (!parsed.success) {
        throw new Error(`Invalid Firebase document at ${snapshot.ref.path}`);
      }
      return parsed.data;
    },
  };
}

const deviceConverter = safeConverter<RemoteDevice>(RemoteDeviceSchema);
const sessionConverter = safeConverter<RemoteSession>(RemoteSessionSchema);
const signalConverter = safeConverter<Signal>(SignalSchema);

export function deviceCollection(
  firestore: Firestore,
  uid: string,
): CollectionReference<RemoteDevice> {
  return collection(firestore, `users/${uid}/devices`).withConverter(
    deviceConverter,
  );
}

export function deviceRef(
  firestore: Firestore,
  uid: string,
  deviceId: string,
): DocumentReference<RemoteDevice> {
  return doc(deviceCollection(firestore, uid), deviceId);
}

export function remoteSessionCollection(
  firestore: Firestore,
  uid: string,
): CollectionReference<RemoteSession> {
  return collection(firestore, `users/${uid}/remoteSessions`).withConverter(
    sessionConverter,
  );
}

export function remoteSessionRef(
  firestore: Firestore,
  uid: string,
  sessionId: string,
): DocumentReference<RemoteSession> {
  return doc(remoteSessionCollection(firestore, uid), sessionId);
}

export function signalCollection(
  firestore: Firestore,
  uid: string,
  sessionId: string,
): CollectionReference<Signal> {
  return collection(
    firestore,
    `users/${uid}/remoteSessions/${sessionId}/signals`,
  ).withConverter(signalConverter);
}

export interface SessionSubscriptionOptions {
  firestore: Firestore;
  uid: string;
  deviceId: string;
  keyThumbprint: string;
  generation: number;
  limit?: number;
  now?: () => number;
  onChange: (sessions: RemoteSession[]) => void;
  onError: (error: Error) => void;
}

function subscribeSessions(
  baseQuery: Query<RemoteSession>,
  options: Pick<SessionSubscriptionOptions, "now" | "onChange" | "onError">,
): () => void {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: RemoteSession[] = [];
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    const next = current
      .map((session) => session.expiresAt)
      .filter((expiresAt) => expiresAt > now())
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    timer = setTimeout(
      () => {
        options.onChange(
          current.filter(
            (session) => deriveSessionState(session, now()) !== "expired",
          ),
        );
        schedule();
      },
      Math.max(0, next - now()),
    );
  };
  const unsubscribe = onSnapshot(
    baseQuery,
    (snapshot) => {
      current = snapshot.docs
        .map((document) => document.data())
        .filter((session) => deriveSessionState(session, now()) !== "expired");
      options.onChange(current);
      schedule();
    },
    (error) =>
      options.onError(
        new Error(`Firebase session listener failed: ${error.code}`),
      ),
  );
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

export function subscribePendingSessions(
  options: SessionSubscriptionOptions,
): () => void {
  const boundedLimit = Math.min(
    options.limit ?? PENDING_SESSION_LIMIT,
    PENDING_SESSION_LIMIT,
  );
  const sessions = remoteSessionCollection(options.firestore, options.uid);
  return subscribeSessions(
    query(
      sessions,
      where("hostDeviceId", "==", options.deviceId),
      where("hostKeyThumbprint", "==", options.keyThumbprint),
      where("hostDeviceGeneration", "==", options.generation),
      where("status", "==", "requested"),
      orderBy("createdAt", "asc"),
      firestoreLimit(boundedLimit),
    ),
    options,
  );
}

export function subscribeClientSessions(
  options: SessionSubscriptionOptions,
): () => void {
  const boundedLimit = Math.min(
    options.limit ?? PENDING_SESSION_LIMIT,
    PENDING_SESSION_LIMIT,
  );
  const sessions = remoteSessionCollection(options.firestore, options.uid);
  return subscribeSessions(
    query(
      sessions,
      where("clientDeviceId", "==", options.deviceId),
      where("clientKeyThumbprint", "==", options.keyThumbprint),
      where("clientDeviceGeneration", "==", options.generation),
      orderBy("createdAt", "desc"),
      firestoreLimit(boundedLimit),
    ),
    options,
  );
}

export interface SignalPage {
  signals: Signal[];
  afterSequence: number;
  hasMore: boolean;
}

export interface DrainSignalsOptions {
  firestore: Firestore;
  uid: string;
  sessionId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  negotiationId: string;
  afterSequence: number;
  limit?: number;
  verify?: (signal: Signal) => boolean | Promise<boolean>;
}

export async function drainSignals(
  options: DrainSignalsOptions,
): Promise<SignalPage> {
  const pageLimit = options.limit ?? SIGNAL_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > SIGNAL_PAGE_LIMIT
  )
    throw new RangeError("Signal page limit must be between 1 and 500");
  if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)
    throw new RangeError("Signal cursor must be a non-negative safe integer");
  let cursor = options.afterSequence;
  let previous: Signal | undefined;
  const signals: Signal[] = [];
  while (true) {
    const page = await getDocs(
      query(
        signalCollection(options.firestore, options.uid, options.sessionId),
        where("senderDeviceId", "==", options.senderDeviceId),
        where("recipientDeviceId", "==", options.recipientDeviceId),
        where("negotiationId", "==", options.negotiationId),
        orderBy("sequence", "asc"),
        startAfter(cursor),
        firestoreLimit(pageLimit),
      ),
    );
    if (page.empty) {
      return { signals, afterSequence: cursor, hasMore: false };
    }
    for (const document of page.docs) {
      const signal = document.data();
      if (signal.sessionId !== options.sessionId)
        throw new Error("SIGNAL_SESSION_MISMATCH");
      const valid = options.verify ? await options.verify(signal) : true;
      if (!valid) throw new Error("SIGNAL_SIGNATURE_INVALID");
      if (previous === undefined && options.afterSequence > 0) {
        if (signal.sequence !== cursor + 1)
          throw new Error("SIGNAL_SEQUENCE_GAP");
      } else {
        validateSignalSequence(previous, signal);
      }
      previous = signal;
      signals.push(signal);
      cursor = signal.sequence;
    }
    if (page.size !== pageLimit) break;
  }
  return { signals, afterSequence: cursor, hasMore: false };
}
