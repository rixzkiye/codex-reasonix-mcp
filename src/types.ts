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

export interface TaskRecord {
  schemaVersion: 1;
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
