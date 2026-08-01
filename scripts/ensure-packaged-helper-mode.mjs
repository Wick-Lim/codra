import { chmod, glob } from "node:fs/promises";
import path from "node:path";

export default async function ensurePackagedHelperMode(context) {
  if (context.electronPlatformName !== "darwin") return;

  const pattern = path.join(
    context.appOutDir,
    "CODRA.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-*",
    "spawn-helper",
  );
  let helperCount = 0;
  for await (const helperPath of glob(pattern)) {
    await chmod(helperPath, 0o755);
    helperCount += 1;
  }
  if (helperCount === 0) {
    throw new Error(`No packaged node-pty spawn-helper matched ${pattern}`);
  }
}
