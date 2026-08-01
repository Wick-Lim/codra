import { chmod, glob } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

if (process.platform === "darwin") {
  const pattern = path.resolve(
    "apps/desktop/node_modules/node-pty/prebuilds/darwin-*/spawn-helper",
  );
  let helperCount = 0;
  for await (const helperPath of glob(pattern)) {
    await chmod(helperPath, 0o755);
    helperCount += 1;
  }
  if (helperCount === 0) {
    throw new Error(`No node-pty spawn-helper matched ${pattern}`);
  }
}
