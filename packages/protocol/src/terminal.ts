import { z } from "zod";

export const TerminalIdSchema = z.string().uuid();
export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
});
export const CreateTerminalRequestSchema = TerminalSizeSchema.extend({
  cwd: z.string().min(1).max(4096).optional(),
});
export const WriteTerminalRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  data: z.string().min(1).max(65_536),
});
export const ResizeTerminalRequestSchema = TerminalSizeSchema.extend({
  terminalId: TerminalIdSchema,
});
export const ReplayTerminalRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  afterSequence: z.number().int().min(0),
  limit: z.number().int().min(1).max(1000).default(500),
});

export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;
export type WriteTerminalRequest = z.infer<typeof WriteTerminalRequestSchema>;
export type ResizeTerminalRequest = z.infer<typeof ResizeTerminalRequestSchema>;
export type ReplayTerminalRequest = z.infer<typeof ReplayTerminalRequestSchema>;

export interface TerminalDescriptor {
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  state: "running" | "exited";
  createdAt: string;
  exitCode?: number;
}

export interface TerminalOutputChunk {
  terminalId: string;
  sequence: number;
  data: string;
}

export const TerminalDescriptorSchema: z.ZodType<TerminalDescriptor> = z.object(
  {
    id: TerminalIdSchema,
    title: z.string().min(1).max(200),
    cwd: z.string().min(1).max(4096),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
    state: z.enum(["running", "exited"]),
    createdAt: z.string().datetime(),
    exitCode: z.number().int().optional(),
  },
);

export const TerminalOutputChunkSchema: z.ZodType<TerminalOutputChunk> =
  z.object({
    terminalId: TerminalIdSchema,
    sequence: z.number().int().positive(),
    data: z.string(),
  });
