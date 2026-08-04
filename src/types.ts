import type { TaskContractV1 } from './contracts.js';

export const TASK_STATUSES = [
  'provisioning',
  'running',
  'waiting_permission',
  'waiting_input',
  'paused',
  'review_required',
  'verifying',
  'completed',
  'commit_failed',
  'failed',
  'cancelled',
  'closed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'commit_failed',
  'failed',
  'cancelled',
  'closed',
]);

/** Every effort value that may appear in persisted task state, including legacy `minimal`. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Effort values accepted by the wire schema and new configuration; `minimal` is legacy-only. */
export const WIRE_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export type WireReasoningEffort = (typeof WIRE_REASONING_EFFORTS)[number];

export const WORKER_LANES = ['fast', 'deep'] as const;

export type WorkerLane = (typeof WORKER_LANES)[number];

export const DEFAULT_FAST_LANE_EXECUTION_TIMEOUT_SECONDS = 600;
export const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 3_600;
export const LEGACY_EXECUTION_TIMEOUT_SECONDS = 600;
export const MIN_EXECUTION_TIMEOUT_SECONDS = 60;
export const MAX_EXECUTION_TIMEOUT_SECONDS = 14_400;

export interface ExecutionProfile {
  requestedReasoningEffort: ReasoningEffort;
  effectiveReasoningEffort: ReasoningEffort;
  executionTimeoutSeconds: number;
  workerLane: WorkerLane;
}

export const TASK_RECORD_SCHEMA_VERSION = 4 as const;
export const TASK_RECORD_V1_SCHEMA_VERSION = 1 as const;
export const TASK_RECORD_V2_SCHEMA_VERSION = 2 as const;
export const TASK_RECORD_V3_SCHEMA_VERSION = 3 as const;

export interface RepositoryIdentity {
  id: string;
  root: string;
  commonDir: string;
  head: string;
}

export interface VerificationEvidence {
  id: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  proves: string[];
  logPath: string;
  sha256: string;
  outputBytes: number;
}

export interface AcceptanceEvidence {
  criterionId: string;
  evidence: 'automated' | 'review';
  approved: boolean;
  source: string;
  sha256?: string;
  /** Verified byte length when the evidence is a file assertion or command output. */
  outputBytes?: number;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatio: number | null;
  estimatedCost: number | null;
  currency: string | null;
  usageSource: string;
}

export interface InteractionRecord {
  id: string;
  kind: 'permission' | 'input';
  status: 'pending' | 'resolved' | 'cancelled';
  createdAt: string;
  resolvedAt?: string;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
}

export interface SourceCollisionEvidence {
  checkpoint: string;
  baseCommit: string;
  sourceHead?: string;
  dirtyPaths: string[];
  committedPaths: string[];
  overlappingPaths: string[];
  unavailable: boolean;
  detectedAt: string;
}

interface TaskRecordFields {
  taskId: string;
  contract: TaskContractV1;
  contractHash: string;
  repository: RepositoryIdentity;
  baseRef: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  networkEnabled: boolean;
  status: TaskStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  acpSessionId?: string;
  processFingerprint?: string;
  statusSequence: number;
  reasonixStatusSequence: number;
  eventSequence: number;
  repairRounds: number;
  repairActive: boolean;
  inspectedAfterPause: boolean;
  summary: string;
  finalMessage?: string;
  changedFiles: string[];
  risks: string[];
  interactions: InteractionRecord[];
  verification: VerificationEvidence[];
  acceptanceEvidence: AcceptanceEvidence[];
  usage: UsageTotals;
  reviewSummary?: string;
  commitHash?: string;
  sourceCollision?: SourceCollisionEvidence;
  /** Canonical worktree tree hash captured when the task entered review_required. */
  reviewTreeHash?: string;
  /** Monotonic count of review rounds (incremented on each review_required entry). */
  reviewRevision: number;
  /** Last observed effective Reasonix work mode (economy|balanced|delivery). */
  reasonixWorkMode?: string;
  /** Last observed effective Reasonix session mode (normal|plan|goal). */
  reasonixSessionMode?: string;
}

/** Persisted v1 task records: eligible for migration through the current schema. */
export interface TaskRecordV1 extends TaskRecordFields {
  schemaVersion: typeof TASK_RECORD_V1_SCHEMA_VERSION;
}

/** Persisted v2 task records: eligible for migration to v3. */
export interface TaskRecordV2 extends TaskRecordFields {
  schemaVersion: typeof TASK_RECORD_V2_SCHEMA_VERSION;
}

/** Persisted task records: the current schema version. */
export interface TaskRecord extends TaskRecordFields {
  schemaVersion: typeof TASK_RECORD_SCHEMA_VERSION;
  executionProfile: ExecutionProfile;
}

export interface JournalEvent {
  seq: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export const EMPTY_USAGE: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  cacheHitRatio: null,
  estimatedCost: null,
  currency: null,
  usageSource: 'reasonix',
};
