import { z } from 'zod';

import { taskContractSchema } from './contracts.js';
import { INSPECT_SECTIONS } from './runtime.js';

const taskIdSchema = z.string().min(1).max(64);

export const delegateInputSchema = z
  .object({
    task_id: taskIdSchema,
    contract: taskContractSchema,
    base_ref: z.string().min(1).max(1_024).optional(),
    resume: z.boolean().optional().default(true),
  })
  .strict();

export const controlInputSchema = z.discriminatedUnion('action', [
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
