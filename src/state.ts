import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalContractJson, contractHash, parseTaskContract } from './contracts.js';
import type { TaskContractV1 } from './contracts.js';
import { BridgeError } from './errors.js';
import { redact } from './redaction.js';
import {
  TASK_RECORD_SCHEMA_VERSION,
  TASK_RECORD_V1_SCHEMA_VERSION,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  type AcceptanceEvidence,
  type InteractionRecord,
  type JournalEvent,
  type RepositoryIdentity,
  type TaskRecord,
  type TaskStatus,
  type UsageTotals,
  type VerificationEvidence,
} from './types.js';

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWrite(file: string, value: string): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await chmod(file, 0o600);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function invalidState(message: string): never {
  throw new BridgeError('invalid_state', message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidState(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalidState(`${field} must be an array`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalidState(`${field} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text.length === 0) invalidState(`${field} must not be empty`);
  return text;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalidState(`${field} must be a boolean`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalidState(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    invalidState(`${field} must be an ISO-8601 timestamp`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    invalidState(`${field} must be a valid ISO-8601 timestamp`);
  }
  return value;
}

function requireOptionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireTimestamp(value, field);
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    invalidState(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function requireOptionalSha256(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireSha256(value, field);
}

function requireOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireRecord(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    invalidState(`${field} must be an array of strings`);
  }
  return value as string[];
}

function requireTaskId(value: unknown): string {
  const taskId = requireString(value, 'taskId');
  if (
    !TASK_ID_PATTERN.test(taskId) ||
    taskId.includes('..') ||
    taskId.endsWith('.lock') ||
    taskId === '.'
  ) {
    invalidState('taskId is not a valid task identity');
  }
  return taskId;
}

function requireTaskStatus(value: unknown): TaskStatus {
  if (typeof value !== 'string' || !(TASK_STATUSES as readonly string[]).includes(value)) {
    invalidState(`Unknown task status: ${String(value)}`);
  }
  return value as TaskStatus;
}

function requireNumberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalidState(`${field} must be a non-negative number or null`);
  }
  return value;
}

function requireStringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireRatio(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalidState(`${field} must be a ratio between 0 and 1 or null`);
  }
  return value;
}

function parseRepositoryIdentity(value: unknown): RepositoryIdentity {
  const record = requireRecord(value, 'repository');
  return {
    id: requireNonEmptyString(record.id, 'repository.id'),
    root: requireNonEmptyString(record.root, 'repository.root'),
    commonDir: requireNonEmptyString(record.commonDir, 'repository.commonDir'),
    head: requireNonEmptyString(record.head, 'repository.head'),
  };
}

function parseInteractionRecord(value: unknown): InteractionRecord {
  const record = requireRecord(value, 'interactions entry');
  if (record.kind !== 'permission' && record.kind !== 'input') {
    invalidState('interactions entry kind must be permission or input');
  }
  if (record.status !== 'pending' && record.status !== 'resolved' && record.status !== 'cancelled') {
    invalidState('interactions entry status must be pending, resolved, or cancelled');
  }
  const createdAt = requireTimestamp(record.createdAt, 'interactions entry createdAt');
  const resolvedAt = requireOptionalTimestamp(record.resolvedAt, 'interactions entry resolvedAt');
  const request = requireRecord(record.request, 'interactions entry request');
  const response = requireOptionalRecord(record.response, 'interactions entry response');
  const parsed: InteractionRecord = {
    id: requireNonEmptyString(record.id, 'interactions entry id'),
    kind: record.kind as InteractionRecord['kind'],
    status: record.status as InteractionRecord['status'],
    createdAt,
    request,
  };
  if (resolvedAt !== undefined) parsed.resolvedAt = resolvedAt;
  if (response !== undefined) parsed.response = response;
  return parsed;
}

function parseVerificationEvidence(value: unknown): VerificationEvidence {
  const record = requireRecord(value, 'verification entry');
  const argv = requireStringArray(record.argv, 'verification entry argv');
  if (argv.length === 0) invalidState('verification entry argv must not be empty');
  return {
    id: requireNonEmptyString(record.id, 'verification entry id'),
    argv,
    cwd: requireNonEmptyString(record.cwd, 'verification entry cwd'),
    startedAt: requireTimestamp(record.startedAt, 'verification entry startedAt'),
    finishedAt: requireTimestamp(record.finishedAt, 'verification entry finishedAt'),
    exitCode:
      record.exitCode === null ? null : requireInteger(record.exitCode, 'verification entry exitCode'),
    timedOut: requireBoolean(record.timedOut, 'verification entry timedOut'),
    passed: requireBoolean(record.passed, 'verification entry passed'),
    proves: requireStringArray(record.proves, 'verification entry proves'),
    logPath: requireNonEmptyString(record.logPath, 'verification entry logPath'),
    sha256: requireSha256(record.sha256, 'verification entry sha256'),
    outputBytes: requireInteger(record.outputBytes, 'verification entry outputBytes'),
  };
}

function parseAcceptanceEvidence(value: unknown): AcceptanceEvidence {
  const record = requireRecord(value, 'acceptance evidence entry');
  if (record.evidence !== 'automated' && record.evidence !== 'review') {
    invalidState('acceptance evidence entry evidence must be automated or review');
  }
  const sha256 = requireOptionalSha256(record.sha256, 'acceptance evidence entry sha256');
  const parsed: AcceptanceEvidence = {
    criterionId: requireNonEmptyString(record.criterionId, 'acceptance evidence entry criterionId'),
    evidence: record.evidence as AcceptanceEvidence['evidence'],
    approved: requireBoolean(record.approved, 'acceptance evidence entry approved'),
    source: requireString(record.source, 'acceptance evidence entry source'),
  };
  if (sha256 !== undefined) parsed.sha256 = sha256;
  return parsed;
}

function parseUsageTotals(value: unknown): UsageTotals {
  const record = requireRecord(value, 'usage');
  return {
    promptTokens: requireInteger(record.promptTokens, 'usage.promptTokens'),
    completionTokens: requireInteger(record.completionTokens, 'usage.completionTokens'),
    reasoningTokens: requireInteger(record.reasoningTokens, 'usage.reasoningTokens'),
    cacheHitTokens: requireInteger(record.cacheHitTokens, 'usage.cacheHitTokens'),
    cacheMissTokens: requireInteger(record.cacheMissTokens, 'usage.cacheMissTokens'),
    cacheHitRatio: requireRatio(record.cacheHitRatio, 'usage.cacheHitRatio'),
    estimatedCost: requireNumberOrNull(record.estimatedCost, 'usage.estimatedCost'),
    currency: requireStringOrNull(record.currency, 'usage.currency'),
    usageSource: requireNonEmptyString(record.usageSource, 'usage.usageSource'),
  };
}

/**
 * Validates every persisted TaskRecord field against the current schema.
 * v1 and v2 share the same field set, so a single validator gates both; the
 * version gate itself lives in {@link parseTaskState}. Revalidates the stored
 * TaskContractV1 and requires contractHash to match its canonical hash.
 */
function parseTaskRecordFields(state: Record<string, unknown>): TaskRecord {
  let contract: TaskContractV1;
  try {
    contract = parseTaskContract(state.contract);
  } catch (error) {
    throw new BridgeError('invalid_state', 'Stored contract failed TaskContractV1 validation', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const contractHashValue = requireSha256(state.contractHash, 'contractHash');
  if (contractHash(contract) !== contractHashValue) {
    invalidState('Stored contractHash does not match the stored contract');
  }
  // The stored contract must be the canonical parsed form: the record's
  // contract and the contractHash authority must never diverge.
  if (JSON.stringify(contract) !== JSON.stringify(state.contract)) {
    invalidState('Stored contract is not in canonical form');
  }
  const record: TaskRecord = {
    schemaVersion: TASK_RECORD_SCHEMA_VERSION,
    taskId: requireTaskId(state.taskId),
    contract,
    contractHash: contractHashValue,
    repository: parseRepositoryIdentity(state.repository),
    baseRef: requireNonEmptyString(state.baseRef, 'baseRef'),
    baseCommit: requireNonEmptyString(state.baseCommit, 'baseCommit'),
    branch: requireNonEmptyString(state.branch, 'branch'),
    worktree: requireNonEmptyString(state.worktree, 'worktree'),
    networkEnabled: requireBoolean(state.networkEnabled, 'networkEnabled'),
    status: requireTaskStatus(state.status),
    phase: requireNonEmptyString(state.phase, 'phase'),
    createdAt: requireTimestamp(state.createdAt, 'createdAt'),
    updatedAt: requireTimestamp(state.updatedAt, 'updatedAt'),
    statusSequence: requireInteger(state.statusSequence, 'statusSequence'),
    reasonixStatusSequence: requireInteger(state.reasonixStatusSequence, 'reasonixStatusSequence'),
    eventSequence: requireInteger(state.eventSequence, 'eventSequence'),
    repairRounds: requireInteger(state.repairRounds, 'repairRounds'),
    repairActive: requireBoolean(state.repairActive, 'repairActive'),
    inspectedAfterPause: requireBoolean(state.inspectedAfterPause, 'inspectedAfterPause'),
    summary: requireString(state.summary, 'summary'),
    changedFiles: requireStringArray(state.changedFiles, 'changedFiles'),
    risks: requireStringArray(state.risks, 'risks'),
    interactions: requireArray(state.interactions, 'interactions').map(parseInteractionRecord),
    verification: requireArray(state.verification, 'verification').map(parseVerificationEvidence),
    acceptanceEvidence: requireArray(state.acceptanceEvidence, 'acceptanceEvidence').map(
      parseAcceptanceEvidence,
    ),
    usage: parseUsageTotals(state.usage),
  };
  const reason = requireOptionalString(state.reason, 'reason');
  const acpSessionId = requireOptionalString(state.acpSessionId, 'acpSessionId');
  const processFingerprint = requireOptionalString(state.processFingerprint, 'processFingerprint');
  const finalMessage = requireOptionalString(state.finalMessage, 'finalMessage');
  const reviewSummary = requireOptionalString(state.reviewSummary, 'reviewSummary');
  const commitHash = requireOptionalString(state.commitHash, 'commitHash');
  if (reason !== undefined) record.reason = reason;
  if (acpSessionId !== undefined) record.acpSessionId = acpSessionId;
  if (processFingerprint !== undefined) record.processFingerprint = processFingerprint;
  if (finalMessage !== undefined) record.finalMessage = finalMessage;
  if (reviewSummary !== undefined) record.reviewSummary = reviewSummary;
  if (commitHash !== undefined) record.commitHash = commitHash;
  return record;
}

/**
 * Parses and validates raw persisted state. Returns the validated current
 * (v2) record; v1 input is converted in memory and flagged for migration.
 * Any malformed, missing, older-unknown, or future schema version fails
 * closed with BridgeError('invalid_state') before any write occurs.
 */
function parseTaskState(raw: string): {
  raw: string;
  state: Record<string, unknown>;
  record: TaskRecord;
  needsMigration: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalidState('Task state is not valid JSON');
  }
  const state = requireRecord(parsed, 'task state');
  const version = state.schemaVersion;
  if (version !== TASK_RECORD_V1_SCHEMA_VERSION && version !== TASK_RECORD_SCHEMA_VERSION) {
    invalidState(`Unsupported task state schemaVersion: ${String(version)}`);
  }
  const record = parseTaskRecordFields(state);
  return { raw, state, record, needsMigration: version === TASK_RECORD_V1_SCHEMA_VERSION };
}

export class StateStore {
  readonly root: string;
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(this.tasksDir());
    await privateDirectory(this.worktreesDir());
    await privateDirectory(this.locksDir());
  }

  tasksDir(): string {
    return path.join(this.root, 'tasks');
  }

  taskDir(taskId: string): string {
    return path.join(this.tasksDir(), taskId);
  }

  worktreesDir(): string {
    return path.join(this.root, 'worktrees');
  }

  locksDir(): string {
    return path.join(this.root, 'locks');
  }

  statePath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'state.json');
  }

  contractPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'contract.json');
  }

  journalPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'events.jsonl');
  }

  verificationDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'verification');
  }

  async exists(taskId: string): Promise<boolean> {
    try {
      await stat(this.statePath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  async createTask(record: TaskRecord): Promise<void> {
    if (record.schemaVersion !== TASK_RECORD_SCHEMA_VERSION) {
      invalidState(`Task records must use schemaVersion ${TASK_RECORD_SCHEMA_VERSION}`);
    }
    parseTaskRecordFields(record as unknown as Record<string, unknown>);
    if (await this.exists(record.taskId)) {
      throw new BridgeError('task_conflict', `Task already exists: ${record.taskId}`);
    }
    await privateDirectory(this.taskDir(record.taskId));
    await privateDirectory(this.verificationDir(record.taskId));
    await atomicWrite(this.contractPath(record.taskId), canonicalContractJson(record.contract));
    await atomicWrite(this.statePath(record.taskId), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(this.journalPath(record.taskId), '', { mode: 0o600, flag: 'wx' });
    await this.appendEvent(record.taskId, 'task_created', {
      status: record.status,
      contractHash: record.contractHash,
      repositoryId: record.repository.id,
    });
  }

  private async readTask(
    taskId: string,
  ): Promise<{
    raw: string;
    state: Record<string, unknown>;
    record: TaskRecord;
    needsMigration: boolean;
  }> {
    let raw: string;
    try {
      raw = await readFile(this.statePath(taskId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError('task_not_found', `Unknown task: ${taskId}`);
      }
      throw error;
    }
    return parseTaskState(raw);
  }

  async loadTask(taskId: string): Promise<TaskRecord> {
    const loaded = await this.readTask(taskId);
    if (!loaded.needsMigration) return loaded.record;
    return await this.persistMigration(taskId, loaded);
  }

  /**
   * Persists a fully validated v1 -> v2 conversion. Serialized with the task
   * update chain so concurrent updates, events, and migration cannot
   * interleave; a stale-read guard re-reads the file under the chain lock and
   * never overwrites a state file that changed after the initial read.
   */
  private async persistMigration(
    taskId: string,
    loaded: {
      raw: string;
      state: Record<string, unknown>;
      record: TaskRecord;
      needsMigration: boolean;
    },
  ): Promise<TaskRecord> {
    const prior = this.updates.get(taskId) ?? Promise.resolve();
    const current = prior.then(async () => {
      const latest = await this.readTask(taskId);
      if (latest.raw === loaded.raw) {
        const migrated: Record<string, unknown> = {
          ...loaded.state,
          schemaVersion: TASK_RECORD_SCHEMA_VERSION,
        };
        await atomicWrite(this.statePath(taskId), `${JSON.stringify(migrated, null, 2)}\n`);
      }
      return latest.record;
    });
    this.updates.set(taskId, current.catch(() => undefined));
    return await current;
  }

  async saveTask(record: TaskRecord): Promise<void> {
    if (record.schemaVersion !== TASK_RECORD_SCHEMA_VERSION) {
      invalidState(`Task records must use schemaVersion ${TASK_RECORD_SCHEMA_VERSION}`);
    }
    parseTaskRecordFields(record as unknown as Record<string, unknown>);
    record.updatedAt = new Date().toISOString();
    await atomicWrite(this.statePath(record.taskId), `${JSON.stringify(record, null, 2)}\n`);
  }

  async updateTask(
    taskId: string,
    update: (record: TaskRecord) => void | Promise<void>,
  ): Promise<TaskRecord> {
    const prior = this.updates.get(taskId) ?? Promise.resolve();
    const current = prior.then(async () => {
      const { record } = await this.readTask(taskId);
      await update(record);
      await this.saveTask(record);
      return record;
    });
    this.updates.set(
      taskId,
      current.catch(() => undefined),
    );
    return await current;
  }

  async appendEvent(taskId: string, type: string, data: unknown): Promise<JournalEvent> {
    const { record } = await this.readTask(taskId);
    const event: JournalEvent = {
      seq: record.eventSequence + 1,
      timestamp: new Date().toISOString(),
      type,
      data: redact(data),
    };
    const handle = await open(this.journalPath(taskId), 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    record.eventSequence = event.seq;
    await this.saveTask(record);
    return event;
  }

  async recordEvent(
    taskId: string,
    type: string,
    data: unknown,
    update?: (record: TaskRecord) => void,
  ): Promise<TaskRecord> {
    return await this.updateTask(taskId, async (record) => {
      update?.(record);
      const event: JournalEvent = {
        seq: record.eventSequence + 1,
        timestamp: new Date().toISOString(),
        type,
        data: redact(data),
      };
      const handle = await open(this.journalPath(taskId), 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      record.eventSequence = event.seq;
    });
  }

  async readEvents(taskId: string, afterSequence = 0): Promise<JournalEvent[]> {
    await this.loadTask(taskId);
    const raw = await readFile(this.journalPath(taskId), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEvent)
      .filter((event) => event.seq > afterSequence);
  }

  async recoverInterruptedTasks(): Promise<string[]> {
    await this.initialize();
    const recovered: string[] = [];
    for (const entry of await readdir(this.tasksDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = await this.loadTask(entry.name);
      if (
        !TERMINAL_STATUSES.has(record.status) &&
        record.status !== 'review_required' &&
        record.status !== 'paused'
      ) {
        await this.recordEvent(
          record.taskId,
          'restart_recovery',
          { previousStatus: record.status },
          (task) => {
            task.status = 'paused';
            task.phase = 'restart_recovery';
            task.reason = 'Bridge restart detected; inspect before explicit resume';
            task.inspectedAfterPause = false;
            for (const interaction of task.interactions) {
              if (interaction.status === 'pending') interaction.status = 'cancelled';
            }
          },
        );
        recovered.push(record.taskId);
      }
    }
    return recovered;
  }

  async waitForChange(
    taskId: string,
    updatedAt: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<TaskRecord> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const record = await this.loadTask(taskId);
      if (record.updatedAt !== updatedAt || Date.now() >= deadline || signal?.aborted)
        return record;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
        timer.unref();
      });
    }
  }
}

export { atomicWrite, privateDirectory };
