import { z } from "zod";

export const TerminalIdSchema = z.string().uuid();
export const TerminalCwdSchema = z.string().min(1).max(4096);
export const ChooseTerminalCwdRequestSchema = z
  .object({
    defaultPath: TerminalCwdSchema,
  })
  .strict();
export const ChooseTerminalCwdResultSchema = TerminalCwdSchema.nullable();
export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
});
export const AgentKindSchema = z.enum(["codex", "claude", "gemini", "ollama"]);
export const AgentSetupActionSchema = z.enum(["install", "authenticate"]);
export const AgentSetupRequestSchema = z
  .object({
    kind: AgentKindSchema,
    action: AgentSetupActionSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.kind === "ollama" && request.action === "authenticate") {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Ollama does not require provider authentication",
      });
    }
  });
export const AgentModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/,
    "Model identifiers may only contain CLI-safe model characters",
  );
export const AgentEffortIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Effort identifiers may only contain CLI-safe characters",
  );
export const AgentLaunchRequestSchema = z
  .object({
    kind: AgentKindSchema,
    yolo: z.boolean(),
    model: AgentModelIdSchema.optional(),
    effort: AgentEffortIdSchema.optional(),
    prompt: z.string().trim().min(1).max(16_000),
  })
  .strict()
  .superRefine((launch, context) => {
    if (launch.kind === "ollama" && !launch.model) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Ollama requires a model",
      });
    }
    if (launch.kind === "ollama" && launch.yolo) {
      context.addIssue({
        code: "custom",
        path: ["yolo"],
        message: "Ollama does not support agent approval modes",
      });
    }
  });
export const AgentEffortOptionSchema = z
  .object({
    id: AgentEffortIdSchema,
    label: z.string().trim().min(1).max(80),
  })
  .strict();
export const AgentModelOptionSchema = z
  .object({
    id: AgentModelIdSchema,
    label: z.string().trim().min(1).max(120),
    efforts: AgentEffortOptionSchema.array().max(12).optional(),
  })
  .strict();
export const AgentRuntimeSchema = z
  .object({
    kind: AgentKindSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
    available: z.boolean(),
    supportsYolo: z.boolean(),
    modelRequired: z.boolean(),
    efforts: AgentEffortOptionSchema.array().max(12),
    models: AgentModelOptionSchema.array().max(200),
    installHint: z.string().trim().min(1).max(240),
    setup: z
      .object({
        installMethod: z.enum(["managed_npm", "external"]),
        authentication: z.enum(["required", "not_required"]),
      })
      .strict(),
  })
  .strict();
export const CreateTerminalRequestSchema = TerminalSizeSchema.extend({
  cwd: TerminalCwdSchema.optional(),
  agent: AgentLaunchRequestSchema.optional(),
  agentSetup: AgentSetupRequestSchema.optional(),
}).superRefine((request, context) => {
  if (request.agent && request.agentSetup) {
    context.addIssue({
      code: "custom",
      path: ["agentSetup"],
      message: "A terminal cannot launch an agent and a setup workflow",
    });
  }
});
export const WriteTerminalRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  data: z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
      "Terminal input exceeds 64 KiB",
    ),
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
export type ChooseTerminalCwdRequest = z.infer<
  typeof ChooseTerminalCwdRequestSchema
>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type AgentSetupAction = z.infer<typeof AgentSetupActionSchema>;
export type AgentSetupRequest = z.infer<typeof AgentSetupRequestSchema>;
export type AgentEffortOption = z.infer<typeof AgentEffortOptionSchema>;
export type AgentModelOption = z.infer<typeof AgentModelOptionSchema>;
export type AgentLaunchRequest = z.infer<typeof AgentLaunchRequestSchema>;
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
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

export interface TerminalOutputCursorChunk {
  sequence: bigint;
  startCursor: bigint;
  endCursor: bigint;
  data: Uint8Array;
}

export interface TerminalOutputCursorReadResult {
  chunks: TerminalOutputCursorChunk[];
  earliestCursor: bigint;
  latestCursor: bigint;
  truncated: boolean;
}

export const TerminalDescriptorSchema: z.ZodType<TerminalDescriptor> = z.object(
  {
    id: TerminalIdSchema,
    title: z.string().min(1).max(200),
    cwd: TerminalCwdSchema,
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
