import { z } from "zod";

export const FUNCTION_REGION = "asia-northeast3" as const;
export const CODRA_PROJECT_ID = "codra-1b3bb" as const;
export const DEMO_PROJECT_ID = "demo-codra" as const;
export const BRIDGE_FIREBASE_APP_ID =
  "1:92715578857:web:6c07f26a4866a1d4d3c778" as const;
export const DESKTOP_APPCHECK_FIREBASE_APP_ID =
  "1:92715578857:web:f955949d45ca300ed3c778" as const;

const httpsOrigin = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"));
const loopbackOrigin = z.literal("http://127.0.0.1:5000");

export const ProductionDeploymentConfigSchema = z
  .object({
    mode: z.literal("production"),
    projectId: z.literal(CODRA_PROJECT_ID),
    publicConfig: z
      .object({
        apiKey: z.string().min(1),
        authDomain: z.literal("codra-1b3bb.firebaseapp.com"),
        projectId: z.literal(CODRA_PROJECT_ID),
        storageBucket: z.literal("codra-1b3bb.firebasestorage.app"),
        messagingSenderId: z.literal("92715578857"),
        appId: z.literal(BRIDGE_FIREBASE_APP_ID),
        measurementId: z.string().min(1),
      })
      .strict(),
    bridgeFirebaseAppId: z.literal(BRIDGE_FIREBASE_APP_ID),
    desktopAppCheckFirebaseAppId: z
      .string()
      .regex(/^1:\d+:web:[a-f0-9]+$/u)
      .refine(
        (value) => value !== BRIDGE_FIREBASE_APP_ID,
        "Desktop App Check app must be distinct",
      ),
    accountBootstrapProvider: z.literal("google.com"),
    browserOrigins: z.tuple([
      z.literal("https://codra-1b3bb.web.app"),
      z.literal("https://codra-1b3bb.firebaseapp.com"),
    ]),
    desktopAuthBridgeUrl: z.literal(
      "https://codra-1b3bb.firebaseapp.com/desktop-auth",
    ),
    firebaseAuthHandlerUrl: z.literal(
      "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
    ),
    authAppCheckEnforcement: z.literal(false),
    functionsRegion: z.literal(FUNCTION_REGION),
  })
  .strict()
  .superRefine((value, context) => {
    for (const origin of value.browserOrigins) {
      const parsed = httpsOrigin.safeParse(origin);
      if (!parsed.success)
        context.addIssue({
          code: "custom",
          message: "Production origins must be HTTPS",
        });
    }
  });

export type ProductionDeploymentConfig = z.infer<
  typeof ProductionDeploymentConfigSchema
>;

export const EmulatorDeploymentConfigSchema = z
  .object({
    mode: z.literal("emulator"),
    projectId: z.literal(DEMO_PROJECT_ID),
    browserOrigin: loopbackOrigin,
    authOrigin: z.literal("http://127.0.0.1:9099"),
    firestoreOrigin: z.literal("http://127.0.0.1:8080"),
    functionsOrigin: z.literal("http://127.0.0.1:5001"),
    hostingOrigin: loopbackOrigin,
    accountBootstrapProvider: z.literal("password-test-only"),
    buildFlavor: z.literal("remote-test"),
    authAppCheckEnforcement: z.literal(false),
    functionsRegion: z.literal(FUNCTION_REGION),
  })
  .strict();

export type EmulatorDeploymentConfig = z.infer<
  typeof EmulatorDeploymentConfigSchema
>;

export type DeploymentConfig =
  ProductionDeploymentConfig | EmulatorDeploymentConfig;

export interface ApprovedDesktopAppCheckInput {
  desktopAppCheckFirebaseAppId: string;
  operatorApproved: true;
}

export function createProductionDeployment(
  input: ApprovedDesktopAppCheckInput,
  publicConfig: ProductionDeploymentConfig["publicConfig"] = {
    apiKey: "AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o",
    authDomain: "codra-1b3bb.firebaseapp.com",
    projectId: CODRA_PROJECT_ID,
    storageBucket: "codra-1b3bb.firebasestorage.app",
    messagingSenderId: "92715578857",
    appId: BRIDGE_FIREBASE_APP_ID,
    measurementId: "G-YVR71LBSVB",
  },
): ProductionDeploymentConfig {
  if (input.operatorApproved !== true)
    throw new Error(
      "A separately provisioned operator-approved desktop App Check app ID is required",
    );
  return ProductionDeploymentConfigSchema.parse({
    mode: "production",
    projectId: CODRA_PROJECT_ID,
    publicConfig,
    bridgeFirebaseAppId: BRIDGE_FIREBASE_APP_ID,
    desktopAppCheckFirebaseAppId: input.desktopAppCheckFirebaseAppId,
    accountBootstrapProvider: "google.com",
    browserOrigins: [
      "https://codra-1b3bb.web.app",
      "https://codra-1b3bb.firebaseapp.com",
    ],
    desktopAuthBridgeUrl: "https://codra-1b3bb.firebaseapp.com/desktop-auth",
    firebaseAuthHandlerUrl:
      "https://codra-1b3bb.firebaseapp.com/__/auth/handler",
    authAppCheckEnforcement: false,
    functionsRegion: FUNCTION_REGION,
  });
}

export const emulatorDeployment: EmulatorDeploymentConfig = {
  mode: "emulator",
  projectId: DEMO_PROJECT_ID,
  browserOrigin: "http://127.0.0.1:5000",
  authOrigin: "http://127.0.0.1:9099",
  firestoreOrigin: "http://127.0.0.1:8080",
  functionsOrigin: "http://127.0.0.1:5001",
  hostingOrigin: "http://127.0.0.1:5000",
  accountBootstrapProvider: "password-test-only",
  buildFlavor: "remote-test",
  authAppCheckEnforcement: false,
  functionsRegion: FUNCTION_REGION,
};

export const productionPublicConfig = {
  apiKey: "AIzaSyDqVsIBxX09Gv3WQJSgvE51uU4DfJU4x2o",
  authDomain: "codra-1b3bb.firebaseapp.com",
  projectId: CODRA_PROJECT_ID,
  storageBucket: "codra-1b3bb.firebasestorage.app",
  messagingSenderId: "92715578857",
  appId: BRIDGE_FIREBASE_APP_ID,
  measurementId: "G-YVR71LBSVB",
} as const;
