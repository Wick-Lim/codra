import { describe, expect, it } from "vitest";
import { AttachmentPump } from "../src/attachment-pump";

describe("attachment pump", () => {
  it("frames output and pauses at high water", async () => {
    const sent: ArrayBuffer[] = [];
    const pump = new AttachmentPump({
      terminalId: "8c2f3a20-9eb7-4d4a-83bd-26f0f171d18f",
      store: {
        readFromCursor: async () => ({
          chunks: [],
          earliestCursor: 0n,
          latestCursor: 0n,
          truncated: false,
        }),
      },
      channel: {
        get bufferedAmount() {
          return 1_048_576;
        },
        send: (value) => sent.push(value),
      },
    });
    await pump.pump();
    expect(sent).toHaveLength(0);
  });
});
