import { z } from 'zod';

import {
  allowedCommandSchema,
  fileAssertionSchema,
  taskContractSchema,
  verificationCommandSchema,
} from './contracts.js';
import { BRIDGE_ERROR_CODES, BridgeError, NEXT_ACTIONS } from './errors.js';
import { INSPECT_SECTIONS } from './runtime.js';
import {
  MAX_EXECUTION_TIMEOUT_SECONDS,
  MIN_EXECUTION_TIMEOUT_SECONDS,
  REASONING_EFFORTS,
  TASK_STATUSES,
  WIRE_REASONING_EFFORTS,
  WORKER_LANES,
} from './types.js';

const taskIdSchema = z.string().min(1).max(64);

// Keep the host-facing schema and the action-specific domain validator on the
// same snapshot contract. The wire fields stay globally optional so Codex can
// use the flat schema for every action; `controlDomainSchema` requires them
// only for finalize.
const expectedReviewRevisionSchema = z.number().int().min(0);
const expectedReviewTreeHashSchema = z.string().regex(/^[0-9a-f]{40}$/);

const verificationCommandWireSchema = verificationCommandSchema.extend({
  // MCP hosts expect one homogeneous JSON Schema in `items`. TaskContractV1
  // applies the stronger first-argument rule after the wire value is decoded.
  argv: z.array(z.string().max(4_096)).min(1).max(128),
});

const allowedCommandWireSchema = allowedCommandSchema.extend({
  argv: z.array(z.string().max(4_096)).min(1).max(128),
});

const taskContractWireSchema = taskContractSchema.extend({
  verification: z.array(verificationCommandWireSchema).max(256),
  allowed_commands: z.array(allowedCommandWireSchema).max(256).optional(),
  file_assertions: z.array(fileAssertionSchema).max(256).optional(),
});

export const delegateInputSchema = z
  .object({
    task_id: taskIdSchema,
    contract: taskContractWireSchema,
    base_ref: z.string().min(1).max(1_024).optional(),
    worker_lane: z
      .enum(WORKER_LANES)
      .optional()
      .describe(
        'Worker execution lane. fast (default) is a direct-edit Reasonix session without Goal/AutoResearch/subagents; deep is an explicit long-horizon Goal session. Omitted resumes preserve the stored lane.',
      ),
    reasoning_effort: z
      .enum(WIRE_REASONING_EFFORTS)
      .optional()
      .describe('Reasoning effort; low is the lowest supported value for new tasks.'),
    execution_timeout_seconds: z
      .number()
      .int()
      .min(MIN_EXECUTION_TIMEOUT_SECONDS)
      .max(MAX_EXECUTION_TIMEOUT_SECONDS)
      .optional()
      .describe(
        'Task execution deadline. New fast-lane tasks default to 600 seconds and deep-lane tasks to 3600 seconds; omitted resumes preserve the stored value. A wait timeout never cancels the worker.',
      ),
    wait_mode: z.enum(['review', 'background']).optional().default('review'),
    wait_timeout_seconds: z.number().int().min(0).max(600).optional().default(600),
    // Pause acknowledgment binding: resume must echo the pause revision and
    // reason hash from the inspect output; stale acknowledgments are rejected.
    pause_revision: z.number().int().min(0).optional(),
    pause_reason_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    path_base: z
      .enum(['cwd', 'repository'])
      .optional()
      .describe('Defaults to cwd for new tasks; omitted legacy resumes preserve stored semantics.'),
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
      // Snapshot binding: the approval must echo the reviewed snapshot the
      // client actually inspected. Stale approvals (captured before a repair
      // that re-captured the tree) are rejected by the bridge.
      expected_review_revision: expectedReviewRevisionSchema,
      expected_review_tree_hash: expectedReviewTreeHashSchema,
      commit_message: z.string().min(1).max(5_000).optional(),
      wait_timeout_seconds: z.number().int().min(0).max(600).optional().default(600),
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
      .min(0)
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
      .describe(
        'Required when action is finalize; omit for other actions. Any valid acceptance id is accepted; automated ids are ignored for approval, but every review-evidence criterion must be present.',
      ),
    expected_review_revision: expectedReviewRevisionSchema
      .optional()
      .describe(
        'Required when action is finalize: copy review_revision from the reviewed task view. Omit for other actions.',
      ),
    expected_review_tree_hash: expectedReviewTreeHashSchema
      .optional()
      .describe(
        'Required when action is finalize: copy review_tree_hash from the reviewed task view. Omit for other actions.',
      ),
    commit_message: z
      .string()
      .min(1)
      .max(5_000)
      .optional()
      .describe('Optional commit message for action finalize; omit for other actions.'),
    wait_timeout_seconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe('Optional wait timeout for action finalize; omit for other actions.'),
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
    wait_until: z
      .enum(['change', 'review_required', 'interaction', 'terminal'])
      .optional()
      .default('change'),
  })
  .strict();

const sourceCollisionEvidenceSchema = z
  .object({
    checkpoint: z.string().min(1),
    baseCommit: z.string().min(1),
    sourceHead: z.string().min(1).optional(),
    dirtyPaths: z.array(z.string()),
    committedPaths: z.array(z.string()),
    overlappingPaths: z.array(z.string()),
    unavailable: z.boolean(),
    detectedAt: z.string().min(1),
  })
  .strict();

const taskViewSchema = z
  .object({
    task_id: taskIdSchema,
    state: z.enum(TASK_STATUSES),
    phase: z.string(),
    contract_hash: z.string().regex(/^[0-9a-f]{64}$/),
    repository_id: z.string().min(1),
    branch: z.string().min(1),
    worktree: z.string().min(1),
    worker_lane: z.enum(WORKER_LANES),
    requested_reasoning_effort: z.enum(REASONING_EFFORTS),
    effective_reasoning_effort: z.enum(REASONING_EFFORTS),
    execution_timeout_seconds: z
      .number()
      .int()
      .min(MIN_EXECUTION_TIMEOUT_SECONDS)
      .max(MAX_EXECUTION_TIMEOUT_SECONDS),
    source_checkout_integrated: z.literal(false),
    integration_command: z.string().min(1).max(1_024).optional(),
    session_id: z.string().min(1).optional(),
    repair_rounds: z.number().int().min(0),
    review_revision: z.number().int().min(0).optional(),
    review_tree_hash: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    pause_revision: z.number().int().min(0).optional(),
    pause_reason_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    reasonix_work_mode: z.string().min(1).optional(),
    reasonix_session_mode: z.string().min(1).optional(),
    updated_at: z.string().min(1),
    reason: z.string().optional(),
    commit_hash: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    source_collision: sourceCollisionEvidenceSchema.optional(),
  })
  .strict();

const verificationEvidenceSchema = z
  .object({
    id: z.string(),
    argv: z.array(z.string()),
    cwd: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    passed: z.boolean(),
    proves: z.array(z.string()),
    logPath: z.string(),
    sha256: z.string(),
    outputBytes: z.number().int().min(0),
  })
  .strict();

const acceptanceEvidenceSchema = z
  .object({
    criterionId: z.string(),
    evidence: z.enum(['automated', 'review']),
    approved: z.boolean(),
    source: z.string(),
    sha256: z.string().optional(),
    outputBytes: z.number().int().min(0).optional(),
  })
  .strict();

const usageSchema = z
  .object({
    promptTokens: z.number().min(0),
    completionTokens: z.number().min(0),
    reasoningTokens: z.number().min(0),
    cacheHitTokens: z.number().min(0),
    cacheMissTokens: z.number().min(0),
    cacheHitRatio: z.number().min(0).max(1).nullable(),
    estimatedCost: z.number().min(0).nullable(),
    currency: z.string().nullable(),
    usageSource: z.string(),
  })
  .strict();

const interactionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['permission', 'input']),
    status: z.enum(['pending', 'resolved', 'cancelled']),
    createdAt: z.string(),
    resolvedAt: z.string().optional(),
    request: z.record(z.unknown()),
    response: z.record(z.unknown()).optional(),
  })
  .strict();

export const delegateOutputSchema = taskViewSchema.extend({
  resume_required: z.boolean().optional(),
  inspect_required: z.boolean().optional(),
  timed_out: z.boolean().optional(),
  summary: z.string().max(4_096).optional(),
  changed_files: z.array(z.string().max(1_024)).max(256).optional(),
  diff_stat: z.string().max(4_096).optional(),
  diff: z
    .string()
    .max(12 * 1_024)
    .optional(),
  risks: z.array(z.string().max(2_048)).max(128).optional(),
  usage: usageSchema.optional(),
  active_interaction: interactionSchema.optional(),
  required_review_criteria: z.array(z.string().min(1).max(64)).max(1_000).optional(),
  review_revision: z.number().int().min(0).optional(),
  review_tree_hash: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  review_diff_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const controlOutputSchema = taskViewSchema;

const journalEventSchema = z
  .object({
    seq: z.number().int().min(0),
    timestamp: z.string(),
    type: z.string(),
    data: z.unknown(),
  })
  .strict();

function paged<T extends z.ZodTypeAny>(schema: T): z.ZodUnion<[T, z.ZodString]> {
  return z.union([schema, z.string()]);
}

const inspectSectionsSchema = z
  .object({
    status: paged(taskViewSchema).optional(),
    summary: z.string().optional(),
    changed_files: paged(z.array(z.string())).optional(),
    diff_stat: z.string().optional(),
    diff: z.string().optional(),
    verification: paged(z.array(verificationEvidenceSchema)).optional(),
    acceptance_evidence: paged(z.array(acceptanceEvidenceSchema)).optional(),
    risks: paged(z.array(z.string())).optional(),
    usage: paged(usageSchema).optional(),
    interactions: paged(z.array(interactionSchema)).optional(),
    events: paged(z.array(journalEventSchema)).optional(),
  })
  .strict();

export const inspectOutputSchema = z
  .object({
    task_id: taskIdSchema,
    sections: inspectSectionsSchema,
    truncated: z.boolean(),
    next_cursor: z.string().optional(),
    updated_at: z.string().min(1),
  })
  .strict();

export const toolErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.enum(BRIDGE_ERROR_CODES),
        message: z.string(),
        retryable: z.boolean(),
        next_action: z.enum(NEXT_ACTIONS),
        details: z.record(z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
