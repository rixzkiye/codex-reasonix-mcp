import { z } from 'zod';

import { taskContractSchema, verificationCommandSchema } from './contracts.js';
import { BridgeError } from './errors.js';
import { INSPECT_SECTIONS } from './runtime.js';

const taskIdSchema = z.string().min(1).max(64);

const verificationCommandWireSchema = verificationCommandSchema.extend({
  // MCP hosts expect one homogeneous JSON Schema in `items`. TaskContractV1
  // applies the stronger first-argument rule after the wire value is decoded.
  argv: z.array(z.string().max(4_096)).min(1).max(128),
});

const taskContractWireSchema = taskContractSchema.extend({
  verification: z.array(verificationCommandWireSchema).max(256),
});

export const delegateInputSchema = z
  .object({
    task_id: taskIdSchema,
    contract: taskContractWireSchema,
    base_ref: z.string().min(1).max(1_024).optional(),
    resume: z.boolean().optional().default(true),
  })
  .strict();

const controlDomainSchema = z.discriminatedUnion('action', [
  z
    .object({
      task_id: taskIdSchema,
      action: z.literal('steer'),
      message: z.string().min(1).max(20_000),
    })
    .strict(),
  z
    .object({
      task_id: taskIdSchema,
      action: z.literal('respond'),
      interaction_id: z.string().min(1).max(256),
      decision: z.enum(['allow', 'deny']),
      option_id: z.string().min(1).max(1_024).optional(),
      answer: z.string().min(1).max(10_000).optional(),
    })
    .strict(),
  z.object({ task_id: taskIdSchema, action: z.literal('cancel') }).strict(),
  z
    .object({
      task_id: taskIdSchema,
      action: z.literal('finalize'),
      review_summary: z.string().trim().min(1).max(20_000),
      approved_review_criteria: z.array(z.string().min(1).max(64)).max(1_000),
      commit_message: z.string().min(1).max(5_000).optional(),
    })
    .strict(),
  z.object({ task_id: taskIdSchema, action: z.literal('close') }).strict(),
]);

export const controlInputSchema = z
  .object({
    task_id: taskIdSchema,
    action: z.enum(['steer', 'respond', 'cancel', 'finalize', 'close']),
    message: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe('Required when action is steer; omit for other actions.'),
    interaction_id: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('Required when action is respond; omit for other actions.'),
    decision: z
      .enum(['allow', 'deny'])
      .optional()
      .describe('Required when action is respond; omit for other actions.'),
    option_id: z
      .string()
      .min(1)
      .max(1_024)
      .optional()
      .describe('Optional offered option for action respond; omit for other actions.'),
    answer: z
      .string()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Optional free-form answer for action respond; omit for other actions.'),
    review_summary: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .optional()
      .describe('Required when action is finalize; omit for other actions.'),
    approved_review_criteria: z
      .array(z.string().min(1).max(64))
      .max(1_000)
      .optional()
      .describe('Required when action is finalize; omit for other actions.'),
    commit_message: z
      .string()
      .min(1)
      .max(5_000)
      .optional()
      .describe('Optional commit message for action finalize; omit for other actions.'),
  })
  .strict();

export function parseControlInput(input: unknown): z.infer<typeof controlDomainSchema> {
  const parsed = controlDomainSchema.safeParse(input);
  if (!parsed.success) {
    throw new BridgeError('invalid_request', 'reasonix_control input validation failed', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export const inspectInputSchema = z
  .object({
    task_id: taskIdSchema,
    include: z.array(z.enum(INSPECT_SECTIONS)).max(INSPECT_SECTIONS.length).optional(),
    wait_ms: z.number().int().min(0).max(30_000).optional(),
    cursor: z.string().min(1).max(8_192).optional(),
    max_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(64 * 1024)
      .optional(),
  })
  .strict();

export const toolOutputSchema = z.object({}).passthrough();
