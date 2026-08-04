import { createHash } from 'node:crypto';

import { contractHash, type TaskContractV1 } from '../contracts.js';
import { BridgeError } from '../errors.js';
import type { ReasonixStatus } from '../reasonix-status.js';
import type { StateStore } from '../state.js';
import {
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  EMPTY_USAGE,
  TASK_RECORD_SCHEMA_VERSION,
  type RepositoryIdentity,
  type TaskRecord,
} from '../types.js';
import type { RuntimeCallContext } from './api.js';

export function now(): string {
  return new Date().toISOString();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function taskView(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.taskId,
    state: task.status,
    phase: task.phase,
    contract_hash: task.contractHash,
    repository_id: task.repository.id,
    branch: task.branch,
    worktree: task.worktree,
    worker_lane: task.executionProfile.workerLane,
    session_id: task.acpSessionId,
    repair_rounds: task.repairRounds,
    review_revision: task.reviewRevision,
    ...(task.reasonixWorkMode ? { reasonix_work_mode: task.reasonixWorkMode } : {}),
    ...(task.reasonixSessionMode ? { reasonix_session_mode: task.reasonixSessionMode } : {}),
    updated_at: task.updatedAt,
    reason: task.reason,
    commit_hash: task.commitHash,
    source_collision: task.sourceCollision,
    requested_reasoning_effort: task.executionProfile.requestedReasoningEffort,
    effective_reasoning_effort: task.executionProfile.effectiveReasoningEffort,
    execution_timeout_seconds: task.executionProfile.executionTimeoutSeconds,
    source_checkout_integrated: false,
    ...(task.commitHash ? { integration_command: `git cherry-pick ${task.commitHash}` } : {}),
  };
}

export function hasPendingInteraction(task: TaskRecord): boolean {
  return task.interactions.some((interaction) => interaction.status === 'pending');
}

export function waitTimeoutMs(seconds: number | undefined): number {
  return Math.min(Math.max(seconds ?? 600, 0), 600) * 1_000;
}

export async function waitForTask(
  store: StateStore,
  taskId: string,
  initial: TaskRecord,
  timeoutMs: number,
  predicate: (task: TaskRecord) => boolean,
  context: RuntimeCallContext = {},
  progressMessage = 'Waiting for an important task lifecycle change',
): Promise<{ task: TaskRecord; timedOut: boolean }> {
  let task = initial;
  if (predicate(task) || timeoutMs <= 0) return { task, timedOut: !predicate(task) };
  const deadline = Date.now() + timeoutMs;
  let nextHeartbeat = 0;
  for (;;) {
    if (context.signal?.aborted) {
      throw new BridgeError('invalid_state', 'Long-running MCP request was cancelled');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { task, timedOut: true };
    if (Date.now() >= nextHeartbeat) {
      await context.onProgress?.(progressMessage);
      nextHeartbeat = Date.now() + 15_000;
    }
    const previousUpdatedAt = task.updatedAt;
    task = await store.waitForChange(
      taskId,
      previousUpdatedAt,
      Math.min(remaining, 10_000),
      context.signal,
    );
    if (predicate(task)) return { task, timedOut: false };
  }
}

export function statusToUsage(status: ReasonixStatus): TaskRecord['usage'] {
  return { ...status.usage.cumulative };
}

export function makeTaskRecordForTest(
  taskId: string,
  contract: TaskContractV1,
  repository: RepositoryIdentity,
  worktree: string,
): TaskRecord {
  const timestamp = now();
  return {
    schemaVersion: TASK_RECORD_SCHEMA_VERSION,
    executionProfile: {
      requestedReasoningEffort: 'medium',
      effectiveReasoningEffort: 'medium',
      executionTimeoutSeconds: DEFAULT_EXECUTION_TIMEOUT_SECONDS,
      workerLane: 'deep',
    },
    taskId,
    contract,
    contractHash: contractHash(contract),
    repository,
    baseRef: 'HEAD',
    baseCommit: repository.head,
    branch: `reasonix/${taskId}`,
    worktree,
    networkEnabled: false,
    status: 'provisioning',
    phase: 'test',
    createdAt: timestamp,
    updatedAt: timestamp,
    statusSequence: 0,
    reasonixStatusSequence: 0,
    eventSequence: 0,
    repairRounds: 0,
    repairActive: false,
    inspectedAfterPause: false,
    summary: '',
    changedFiles: [],
    risks: [],
    interactions: [],
    verification: [],
    acceptanceEvidence: [],
    usage: { ...EMPTY_USAGE },
    reviewRevision: 0,
  };
}
