import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FAKE_CLAUDE = `#!/bin/sh
printf 'CODRA_FAKE_AGENT_READY %s\\n' "$*"
(
  tick=0
  while [ "$tick" -lt 900 ]; do
    tick=$((tick + 1))
    printf 'CODRA_FAKE_AGENT_TICK %s\\n' "$tick"
    sleep 0.2
  done
) &
ticker=$!
while IFS= read -r line; do
  case "$line" in
    size) printf 'CODRA_FAKE_AGENT_SIZE %s\\n' "$(stty size | tr ' ' 'x')" ;;
    where) printf 'CODRA_FAKE_AGENT_CWD %s\\n' "$(pwd)" ;;
    quit) break ;;
    *) printf 'CODRA_FAKE_AGENT_ECHO %s\\n' "$line" ;;
  esac
done
kill "$ticker" 2>/dev/null
`;

export interface FakeAgentInstallation {
  binDirectory: string;
  remove(): Promise<void>;
}

export async function installFakeClaudeAgent(): Promise<FakeAgentInstallation> {
  const binDirectory = await mkdtemp(path.join(tmpdir(), "codra-fake-agent-"));
  const executable = path.join(binDirectory, "claude");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  return {
    binDirectory,
    remove: () => rm(binDirectory, { recursive: true, force: true }),
  };
}
