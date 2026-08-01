import { chmod, glob, stat } from "node:fs/promises";
import path from "node:path";

export default async function ensurePackagedHelperMode(context) {
  if (context.electronPlatformName !== "darwin") return;

  const unpackedNodePtyPath = path.join(
    context.appOutDir,
    "CODRA.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  const selectedHelperPath = path.join(
    unpackedNodePtyPath,
    "build",
    "Release",
    "spawn-helper",
  );
  const pattern = path.join(
    unpackedNodePtyPath,
    "prebuilds",
    "darwin-*",
    "spawn-helper",
  );
  const enforceExecutableMode = async (helperPath) => {
    await chmod(helperPath, 0o755);
    if (((await stat(helperPath)).mode & 0o777) !== 0o755) {
      throw new Error(`node-pty spawn-helper is not mode 0755: ${helperPath}`);
    }
  };

  await enforceExecutableMode(selectedHelperPath);
  let helperCount = 0;
  for await (const helperPath of glob(pattern)) {
    await enforceExecutableMode(helperPath);
    helperCount += 1;
  }
  if (helperCount === 0) {
    throw new Error(`No packaged node-pty spawn-helper matched ${pattern}`);
  }
}
