/* global process */

import { assertLiveTestGuard } from "./live-test-guard.mjs";

try {
  assertLiveTestGuard([], {});
} catch {
  process.exit(0);
}
throw new Error("Claim gate must refuse without explicit opt-in.");
