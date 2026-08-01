import assert from "node:assert/strict";
import { assertLiveTestGuard } from "./live-test-guard.mjs";

assert.throws(() => assertLiveTestGuard([], {}));
assert.throws(() =>
  assertLiveTestGuard(
    ["--project", "demo-codra", "--confirm-project", "demo-codra"],
    { CODRA_LIVE_TEST: "1" },
  ),
);
assert.throws(() =>
  assertLiveTestGuard(
    ["--project", "codra-1b3bb", "--confirm-project", "codra-1b3bb"],
    { CODRA_LIVE_TEST: "1", CI: "1" },
  ),
);
assert.throws(() =>
  assertLiveTestGuard(["codra-1b3bb"], { CODRA_LIVE_TEST: "1" }),
);
assert.throws(() =>
  assertLiveTestGuard(
    [
      "--project",
      "codra-1b3bb",
      "--project",
      "codra-1b3bb",
      "--confirm-project",
      "codra-1b3bb",
    ],
    { CODRA_LIVE_TEST: "1" },
  ),
);
assert.deepEqual(
  assertLiveTestGuard(
    ["--project", "codra-1b3bb", "--confirm-project", "codra-1b3bb"],
    { CODRA_LIVE_TEST: "1" },
  ),
  { project: "codra-1b3bb", readOnly: true },
);
