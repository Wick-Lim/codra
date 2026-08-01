import { describe, expect, it } from "vitest";
import { ByteTokenBucket } from "../src/token-bucket";

describe("byte token bucket", () => {
  it("refills continuously from an injected clock", () => {
    let now = 0;
    const bucket = new ByteTokenBucket({ now: () => now });
    expect(bucket.tryConsume(128 * 1024)).toBe(true);
    expect(bucket.tryConsume(1)).toBe(false);
    now = 1_000;
    expect(bucket.tryConsume(64 * 1024)).toBe(true);
  });
});
