import { z } from "zod";
import { TerminalIdSchema } from "./terminal";

export const TERMINAL_FRAME_MAX_BYTES = 16 * 1024;
export const OUTPUT_FRAME_HEADER_BYTES = 34;
const outputFrameMagic = new Uint8Array([0x43, 0x44, 0x52, 0x46]);

export const OutputFrameSchema = z
  .object({
    terminalId: TerminalIdSchema,
    cursor: z.bigint().nonnegative().max(0xffffffffffffffffn),
    data: z.instanceof(Uint8Array),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.data.byteLength > TERMINAL_FRAME_MAX_BYTES) {
      context.addIssue({
        code: "too_big",
        maximum: TERMINAL_FRAME_MAX_BYTES,
        origin: "array",
        inclusive: true,
        message: "Output frame exceeds 16 KiB",
      });
    }
  });

export type OutputFrame = z.infer<typeof OutputFrameSchema>;

export function encodeOutputFrame(frame: OutputFrame): OutputFrame {
  const parsed = OutputFrameSchema.parse(frame);
  return {
    terminalId: parsed.terminalId,
    cursor: parsed.cursor,
    data: new Uint8Array(parsed.data),
  };
}

export function decodeOutputFrame(frame: unknown): OutputFrame {
  return OutputFrameSchema.parse(frame);
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(hex)) throw new Error("Invalid terminal id");
  return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeOutputFrameBinary(frame: OutputFrame): ArrayBuffer {
  const parsed = OutputFrameSchema.parse(frame);
  const output = new ArrayBuffer(
    OUTPUT_FRAME_HEADER_BYTES + parsed.data.byteLength,
  );
  const view = new DataView(output);
  const bytes = new Uint8Array(output);
  bytes.set(outputFrameMagic, 0);
  view.setUint8(4, 1);
  view.setUint8(5, 0);
  view.setBigUint64(6, parsed.cursor, false);
  bytes.set(uuidBytes(parsed.terminalId), 14);
  view.setUint32(30, parsed.data.byteLength, false);
  bytes.set(parsed.data, OUTPUT_FRAME_HEADER_BYTES);
  return output;
}

export function decodeOutputFrameBinary(
  input: ArrayBuffer | Uint8Array,
): OutputFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < OUTPUT_FRAME_HEADER_BYTES)
    throw new Error("Output frame header is truncated");
  if (
    !outputFrameMagic.every((byte, index) => bytes[index] === byte) ||
    bytes[4] !== 1 ||
    bytes[5] !== 0
  )
    throw new Error("Invalid output frame header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint32(30, false);
  if (
    payloadLength > TERMINAL_FRAME_MAX_BYTES ||
    OUTPUT_FRAME_HEADER_BYTES + payloadLength !== bytes.byteLength
  )
    throw new Error("Invalid output frame payload length");
  return OutputFrameSchema.parse({
    terminalId: uuidFromBytes(bytes.subarray(14, 30)),
    cursor: view.getBigUint64(6, false),
    data: bytes.slice(OUTPUT_FRAME_HEADER_BYTES),
  });
}

export const encodeOutputFrameWire = encodeOutputFrameBinary;
export const decodeOutputFrameWire = decodeOutputFrameBinary;
