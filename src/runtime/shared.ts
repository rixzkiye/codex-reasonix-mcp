import { createHash } from 'node:crypto';

import { contractHash, type TaskContractV1 } from '../contracts.js';
import type { ReasonixStatus } from '../reasonix-status.js';
import { EMPTY_USAGE, type RepositoryIdentity, type TaskRecord } from '../types.js';

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
    session_id: task.acpSessionId,
    repair_rounds: task.repairRounds,
    updated_at: task.updatedAt,
    reason: task.reason,
    commit_hash: task.commitHash,
  };
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
    schemaVersion: 2,
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
  };
}
