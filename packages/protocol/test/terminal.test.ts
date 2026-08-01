import { describe, expect, it } from "vitest";
import {
  CreateTerminalRequestSchema,
  ResizeTerminalRequestSchema,
  WriteTerminalRequestSchema,
} from "../src/terminal";

describe("terminal protocol", () => {
  it("accepts a bounded terminal creation request", () => {
    expect(CreateTerminalRequestSchema.parse({ cols: 120, rows: 32 })).toEqual({
      cols: 120,
      rows: 32,
    });
  });

  it("rejects unsafe resize and oversized input", () => {
    expect(() =>
      ResizeTerminalRequestSchema.parse({
        terminalId: crypto.randomUUID(),
        cols: 2,
        rows: 2,
      }),
    ).toThrow();
    expect(() =>
      WriteTerminalRequestSchema.parse({
        terminalId: crypto.randomUUID(),
        data: "x".repeat(65_537),
      }),
    ).toThrow();
  });
});
