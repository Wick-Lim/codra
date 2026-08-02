import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import {
  rememberDescendants,
  terminateCapturedProcessTree,
} from "./process-cleanup";

// Mirrors packages/protocol/src/deployment.ts:133-146 (emulatorDeployment).
// tests/ is not a pnpm workspace member, so @codra/protocol is not resolvable
// from this file and the origins are restated rather than imported.
const EMULATOR_PROJECT_ID = "demo-codra";
const EMULATOR_AUTH_ORIGIN = "http://127.0.0.1:9099";
const EMULATOR_FIRESTORE_ORIGIN = "http://127.0.0.1:8080";
const EMULATOR_FUNCTIONS_ORIGIN = "http://127.0.0.1:5001";
// packages/firebase/src/index.ts:68 (DEMO_FIREBASE_OPTIONS.apiKey).
const EMULATOR_API_KEY = "demo-codra-api-key";
const EMULATOR_READY_TIMEOUT_MS = 300_000;
const DEVICE_LIVENESS_SETTLE_MS = 1_000;

const firebaseBin = path.resolve("node_modules/.bin/firebase");
const remoteTestMainEntry = path.resolve(
  "apps/desktop/out-remote-test/main/index.js",
);

export interface RemoteDeviceHandle {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  descendantPids: Set<number>;
}

export interface RemoteEmulators {
  authOrigin: string;
  firestoreOrigin: string;
  functionsOrigin: string;
  projectId: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transcript = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      transcript += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      transcript += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code}:\n${transcript}`,
          ),
        );
    });
  });
}

function buildDeviceEnv(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  return { ...env, ...overrides };
}

export async function startRemoteEmulators(): Promise<
  RemoteEmulators & { stop(): Promise<void> }
> {
  await runCommand("pnpm", ["--filter", "@codra/protocol", "build"]);
  await runCommand("pnpm", ["--filter", "@codra/functions", "build"]);
  await runCommand("pnpm", ["run", "stage:functions-deploy"]);
  await runCommand("pnpm", [
    "--dir",
    "functions-deploy-build",
    "install",
    "--frozen-lockfile",
  ]);

  // `--only auth,firestore,functions` is mandatory: firebase.json declares a
  // `hosting` key, and the Hosting emulator is skipped only when that key is
  // absent (firebase-tools/lib/emulator/controller.js:125-128).
  const child = spawn(
    firebaseBin,
    [
      "emulators:start",
      "--only",
      "auth,firestore,functions",
      "--config",
      "firebase.json",
      "--project",
      EMULATOR_PROJECT_ID,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const emulatorPid = child.pid;
  const emulatorDescendantPids = new Set<number>();
  let transcript = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    transcript += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    transcript += chunk;
  });

  const stop = async (): Promise<void> => {
    if (emulatorPid === undefined) return;
    await terminateCapturedProcessTree({
      rootPid: emulatorPid,
      knownDescendantPids: emulatorDescendantPids,
    });
  };

  const deadline = Date.now() + EMULATOR_READY_TIMEOUT_MS;
  while (!transcript.includes("All emulators ready")) {
    if (child.exitCode !== null) {
      throw new Error(
        `Firebase emulators exited with ${child.exitCode} before becoming ready:\n${transcript}`,
      );
    }
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`Firebase emulators never became ready:\n${transcript}`);
    }
    await sleep(250);
  }
  // Capture the Java Firestore child while the CLI is still alive; a plain
  // SIGTERM to the CLI does not reap it.
  if (emulatorPid !== undefined) {
    await rememberDescendants(emulatorPid, emulatorDescendantPids);
  }

  try {
    const authRoot = (await (
      await fetch(`${EMULATOR_AUTH_ORIGIN}/`)
    ).json()) as { authEmulator?: { ready?: boolean } };
    if (authRoot.authEmulator?.ready !== true) {
      throw new Error(`Auth emulator did not report ready:\n${transcript}`);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    authOrigin: EMULATOR_AUTH_ORIGIN,
    firestoreOrigin: EMULATOR_FIRESTORE_ORIGIN,
    functionsOrigin: EMULATOR_FUNCTIONS_ORIGIN,
    projectId: EMULATOR_PROJECT_ID,
    stop,
  };
}

export async function seedRemoteTestAccount(
  emulators: RemoteEmulators,
): Promise<{ email: string; password: string }> {
  const email = `remote-harness-${randomUUID()}@example.com`;
  const password = `harness-${randomUUID()}`;
  const response = await fetch(
    `${emulators.authOrigin}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${EMULATOR_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Auth emulator rejected the seeded account (${response.status}): ${await response.text()}`,
    );
  }
  const created = (await response.json()) as { localId?: string };
  if (!created.localId) {
    throw new Error("Auth emulator returned no localId for the seeded account");
  }
  return { email, password };
}

export async function launchRemoteDevice(options: {
  label: string;
  email: string;
  password: string;
}): Promise<RemoteDeviceHandle> {
  const userDataDir = await mkdtemp(
    path.join(tmpdir(), `codra-remote-${options.label}-`),
  );
  const descendantPids = new Set<number>();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [remoteTestMainEntry],
      env: buildDeviceEnv({
        CODRA_USER_DATA_DIR: userDataDir,
        CODRA_REMOTE_TEST_EMAIL: options.email,
        CODRA_REMOTE_TEST_PASSWORD: options.password,
      }),
    });
    const pid = app.process().pid;
    if (pid === undefined) {
      throw new Error(`Device ${options.label} reported no process id`);
    }
    // single-instance.ts:40-43 calls app.exit(0) when the lock is taken, which
    // is silent and returns success. Assert liveness rather than waiting on
    // firstWindow(), which would only hang until the project timeout.
    await sleep(DEVICE_LIVENESS_SETTLE_MS);
    if (app.process().exitCode !== null) {
      throw new Error(
        `Device ${options.label} exited with ${app.process().exitCode} during startup; CODRA_USER_DATA_DIR isolation failed`,
      );
    }
    const page = await app.firstWindow();
    await rememberDescendants(pid, descendantPids);
    return { app, page, userDataDir, descendantPids };
  } catch (error) {
    const pid = app?.process().pid;
    if (pid !== undefined) {
      await terminateCapturedProcessTree({
        rootPid: pid,
        knownDescendantPids: descendantPids,
      }).catch(() => undefined);
    }
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

export async function shutdownRemoteDevices(
  devices: readonly RemoteDeviceHandle[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const device of devices) {
    try {
      await terminateCapturedProcessTree({
        rootPid: device.app.process().pid,
        knownDescendantPids: device.descendantPids,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(device.userDataDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Remote device shutdown failed");
  }
}
