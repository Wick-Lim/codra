import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ProcessRow {
  pid: number;
  parentPid: number;
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function processRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (parts): parts is [number, number] =>
        parts.length === 2 && parts.every(Number.isSafeInteger),
    )
    .map(([pid, parentPid]) => ({ pid, parentPid }));
}

function descendantPostorder(
  rootPid: number,
  rows: readonly ProcessRow[],
): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    children.set(row.parentPid, siblings);
  }

  const ordered: number[] = [];
  const visit = (parentPid: number) => {
    for (const childPid of children.get(parentPid) ?? []) {
      visit(childPid);
      ordered.push(childPid);
    }
  };
  visit(rootPid);
  return ordered;
}

export async function rememberDescendants(
  rootPid: number,
  knownPids: Set<number>,
): Promise<void> {
  if (!processExists(rootPid)) return;
  for (const pid of descendantPostorder(rootPid, await processRows())) {
    knownPids.add(pid);
  }
}

function signalIfPresent(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(pids: readonly number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processExists) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function terminateCapturedProcessTree(options: {
  rootPid?: number;
  knownDescendantPids: Set<number>;
  knownShellPid?: number;
}): Promise<void> {
  const { rootPid, knownDescendantPids, knownShellPid } = options;
  if (rootPid !== undefined) {
    await rememberDescendants(rootPid, knownDescendantPids);
  }
  if (knownShellPid !== undefined) knownDescendantPids.add(knownShellPid);

  const descendants = [...knownDescendantPids].filter((pid) => pid !== rootPid);
  const scopedPids = [
    ...descendants,
    ...(rootPid === undefined ? [] : [rootPid]),
  ];
  for (const pid of scopedPids) signalIfPresent(pid, "SIGTERM");
  await waitForExit(scopedPids, 2_000);

  const survivors = scopedPids.filter(processExists);
  for (const pid of survivors) signalIfPresent(pid, "SIGKILL");
  await waitForExit(survivors, 2_000);

  const remaining = scopedPids.filter(processExists);
  if (remaining.length > 0) {
    throw new Error("Captured Electron process tree did not exit");
  }
}
