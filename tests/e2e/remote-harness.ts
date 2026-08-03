import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import {
  rememberDescendants,
  terminateCapturedProcessTree,
} from "./process-cleanup";

const execFileAsync = promisify(execFile);

// Mirrors packages/protocol/src/deployment.ts:133-146 (emulatorDeployment).
// tests/ is not a pnpm workspace member, so @codra/protocol is not resolvable
// from this file and the origins are restated rather than imported.
const EMULATOR_PROJECT_ID = "demo-codra";
const EMULATOR_AUTH_ORIGIN = "http://127.0.0.1:9099";
const EMULATOR_FIRESTORE_ORIGIN = "http://127.0.0.1:8080";
const EMULATOR_FUNCTIONS_ORIGIN = "http://127.0.0.1:5001";
/**
 * Where `firebase.emulator.json` serves `apps/web/dist-remote-test` from, and
 * therefore the origin the browser console is opened at. Only reachable when
 * `startRemoteEmulators({ hosting: true })` asked for the Hosting emulator.
 */
export const EMULATOR_HOSTING_ORIGIN = "http://127.0.0.1:5000";
// packages/firebase/src/index.ts:68 (DEMO_FIREBASE_OPTIONS.apiKey).
const EMULATOR_API_KEY = "demo-codra-api-key";
const EMULATOR_READY_TIMEOUT_MS = 300_000;
const DEVICE_LIVENESS_SETTLE_MS = 1_000;

interface EmulatorPort {
  port: number;
  label: string;
}

// The three ports firebase.json binds the emulators to (127.0.0.1:9099,
// :8080, :5001). These are baked into the compiled remote-test build (see
// firebase-emulator.ts in both apps/desktop and apps/web), so they cannot
// be reassigned per run.
const REQUIRED_EMULATOR_PORTS: ReadonlyArray<EmulatorPort> = [
  { port: 9099, label: "auth" },
  { port: 8080, label: "firestore" },
  { port: 5001, label: "functions" },
];

// Only the specs that ask for `hosting` bind this one, so it is checked only
// for them — but it must be checked, because on macOS Control Center's AirPlay
// Receiver listens on *:5000 out of the box. firebase-tools decides a port is
// unusable by running `lsof -i :<port> -sTCP:LISTEN` on darwin
// (emulator/portUtils.js `checkListenable`), which sees that wildcard listener
// and refuses to start the Hosting emulator on a fixed port. Without this
// entry the run dies inside firebase-tools with a message about port 5000
// rather than pointing at what holds it.
const HOSTING_EMULATOR_PORT: EmulatorPort = { port: 5000, label: "hosting" };

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

function runCommand(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
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
  // CODRA_REMOTE_TEST_AUTO_APPROVE must never reach a device by ambient
  // inheritance from the shell or CI job that invoked Playwright — only a
  // caller that explicitly opts in via `launchRemoteDevice`'s
  // `autoApproveSessions` option should get it, via `overrides` below.
  // Otherwise a developer or CI environment that happens to export this
  // var globally would silently turn every spec's approval modal into an
  // auto-approved no-op, including remote-direct's, which exists
  // specifically to drive that modal by hand.
  delete env.CODRA_REMOTE_TEST_AUTO_APPROVE;
  return { ...env, ...overrides };
}

const PORT_PROBE_TIMEOUT_MS = 500;

// A bind-based probe (net.createServer().listen()) is not reliable here:
// on macOS, Docker Desktop forwards published container ports through a
// userspace proxy that does not conflict with a plain loopback `listen()`
// — measured directly on this machine against a container publishing
// 0.0.0.0:8080, which a bind probe reported as free even though the
// Firestore emulator then failed with "Port 8080 is not open". A
// connect-based probe does not have this blind spot: if anything answers
// the TCP handshake, the port is unusable for the emulator, regardless of
// how the holder itself was set up.
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let settled = false;
    const settle = (free: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    // Something answered the handshake: the port is occupied.
    socket.once("connect", () => settle(false));
    // Connection refused (or any other error) means nothing is listening,
    // or the result is inconclusive — either way, do not block the
    // harness on a probe failure the emulator itself would surface more
    // clearly if it turned out to matter.
    socket.once("error", () => settle(true));
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(true));
  });
}

// Best-effort only: identifies what already holds a port so the failure
// message can point at it, but detection must never depend on this
// succeeding (no `lsof` on the PATH, unsupported platform, etc. all just
// fall back to an undefined holder description).
async function describePortHolder(port: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-P",
      "-n",
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    // First line is the `lsof` column header; keep only process rows.
    const holders = lines.slice(1);
    return holders.length > 0 ? holders.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

// Detect-and-report only: this never stops, kills, or signals whatever
// holds a required port. A conflict here means the machine running the
// harness has something else bound to a port the Firebase emulators need
// (firebase.json's `emulators.{auth,firestore,functions}.port`, baked into
// the compiled remote-test build) — that is the local environment's
// problem to fix, not a defect in the harness or in CODRA, so this fails
// fast and by name rather than surfacing as an opaque emulator-startup
// error after minutes of build work.
async function assertEmulatorPortsFree(
  required: ReadonlyArray<EmulatorPort>,
): Promise<void> {
  const conflicts: string[] = [];
  for (const { port, label } of required) {
    if (await isPortFree(port)) continue;
    const holder = await describePortHolder(port);
    conflicts.push(
      `  port ${port} (${label} emulator)` +
        (holder ? `, currently held by:\n${holder}` : ", holder unknown"),
    );
  }
  if (conflicts.length === 0) return;
  throw new Error(
    `The remote-test harness needs ports ${required
      .map(({ port }) => port)
      .join(", ")} free for the Firebase emulators (firebase.json, baked ` +
      "into the compiled remote-test build) but found:\n" +
      conflicts.join("\n") +
      "\nThis is a conflict in the local environment, not a CODRA bug " +
      "— free the port(s) above and re-run. Nothing was stopped or " +
      "signalled automatically. Port 5000 in particular is bound by " +
      "Control Center on a stock macOS: turn AirPlay Receiver off in " +
      "System Settings → General → AirDrop & Handoff.",
  );
}

export interface StartRemoteEmulatorsOptions {
  /**
   * Also start the Hosting emulator, reading `firebase.emulator.json` so it
   * serves `apps/web/dist-remote-test` on `EMULATOR_HOSTING_ORIGIN` under the
   * emulator CSP. Everything except the served tree and that CSP is identical
   * between the two config files — `scripts/verify-remote-build-config.mjs`
   * deep-equals the rewrites, the emulator ports, the Firestore block, and the
   * Functions block — so switching configs changes nothing for the specs that
   * only need auth, firestore, and functions.
   */
  hosting?: boolean;
}

export async function startRemoteEmulators(
  options: StartRemoteEmulatorsOptions = {},
): Promise<RemoteEmulators & { stop(): Promise<void> }> {
  const hosting = options.hosting === true;
  await assertEmulatorPortsFree(
    hosting
      ? [...REQUIRED_EMULATOR_PORTS, HOSTING_EMULATOR_PORT]
      : REQUIRED_EMULATOR_PORTS,
  );
  await runCommand("pnpm", ["--filter", "@codra/protocol", "build"]);
  await runCommand("pnpm", ["--filter", "@codra/functions", "build"]);
  await runCommand("pnpm", ["run", "stage:functions-deploy"]);
  await runCommand("pnpm", [
    "--dir",
    "functions-deploy-build",
    "install",
    "--frozen-lockfile",
  ]);

  // An explicit `--only` is mandatory: both config files declare a `hosting`
  // key, and the Hosting emulator is skipped only when that key is absent
  // (firebase-tools/lib/emulator/controller.js:125-128). So a spec that does
  // not serve the web bundle must leave `hosting` out of this list, or it
  // would need port 5000 for nothing.
  const child = spawn(
    firebaseBin,
    [
      "emulators:start",
      "--only",
      hosting ? "auth,firestore,functions,hosting" : "auth,firestore,functions",
      "--config",
      hosting ? "firebase.emulator.json" : "firebase.json",
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

export interface RemoteTestCredentials {
  email: string;
  password: string;
}

/**
 * A fresh emulator account's credentials, before the account exists.
 *
 * The web console needs these earlier than the desktop does. `apps/web`'s
 * `account-bootstrap-test-only.ts` reads the pair from `import.meta.env`, which
 * Vite substitutes at build time, so the bundle the Hosting emulator serves has
 * to be built before the Auth emulator is even running — and therefore before
 * `seedRemoteTestAccount` could have invented a pair of its own.
 */
export function newRemoteTestCredentials(): RemoteTestCredentials {
  return {
    email: `remote-harness-${randomUUID()}@example.com`,
    password: `harness-${randomUUID()}`,
  };
}

/**
 * Builds `apps/web/dist-remote-test`, the tree `firebase.emulator.json` serves
 * on `EMULATOR_HOSTING_ORIGIN`, with the test account baked in.
 *
 * Vite's `loadEnv` prefers `process.env` entries carrying the `VITE_` prefix
 * over any `.env` file, so passing them here is what puts this run's account
 * into the bundle.
 */
export function buildWebConsoleBundle(
  credentials: RemoteTestCredentials,
): Promise<void> {
  return runCommand("pnpm", ["--filter", "@codra/web", "build:remote-test"], {
    VITE_CODRA_REMOTE_TEST_EMAIL: credentials.email,
    VITE_CODRA_REMOTE_TEST_PASSWORD: credentials.password,
  });
}

export async function seedRemoteTestAccount(
  emulators: RemoteEmulators,
  credentials: RemoteTestCredentials = newRemoteTestCredentials(),
): Promise<RemoteTestCredentials> {
  const { email, password } = credentials;
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
  // Opt-in only: buildDeviceEnv always strips any ambient
  // CODRA_REMOTE_TEST_AUTO_APPROVE first, so a spec gets the remote-test
  // auto-approve seam only by asking for it here, never by accident.
  autoApproveSessions?: boolean;
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
        ...(options.autoApproveSessions
          ? { CODRA_REMOTE_TEST_AUTO_APPROVE: "1" }
          : {}),
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
