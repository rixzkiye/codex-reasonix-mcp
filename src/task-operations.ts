import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { BridgeError } from './errors.js';
import { runCommand } from './command.js';
import { atomicWrite, parseTaskRecordJson, privateDirectory, StateStore } from './state.js';
import { TERMINAL_STATUSES, type TaskRecord, type TaskStatus } from './types.js';

export const ARCHIVE_SCHEMA_VERSION = 1 as const;
export const TOMBSTONE_SCHEMA_VERSION = 1 as const;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRUNE_STAGING =
  /^(.*)-([0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export interface ArchiveMetadata {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  taskId: string;
  contractHash: string;
  status: TaskStatus;
  branch: string;
  ref: string;
  baseRef: string;
  baseCommit: string;
  commitHash: string | null;
  createdAt: string;
  completedAt: string;
  archivedAt: string;
}

export interface TaskTombstone {
  schemaVersion: typeof TOMBSTONE_SCHEMA_VERSION;
  taskId: string;
  contractHash: string;
  status: TaskStatus;
  branch: string;
  ref: string;
  baseRef: string;
  baseCommit: string;
  commitHash: string | null;
  verificationEvidenceHashes: string[];
  acceptanceEvidenceHashes: string[];
  createdAt: string;
  completedAt: string;
  archivedAt: string;
  prunedAt: string;
}

export interface TaskListEntry {
  task_id: string;
  status: TaskStatus;
  phase: string;
  storage: 'live' | 'archive' | 'tombstone';
  repository_id: string | null;
  base_ref: string;
  base_commit: string;
  branch: string;
  commit_hash: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  pruned_at: string | null;
}

export interface MutationResult {
  apply: boolean;
  action: 'archive' | 'prune';
  taskIds: string[];
  message: string;
}

export interface TaskOperationFaults {
  afterArchivePrepared?(): void | Promise<void>;
  afterWorkerWorktreeDetached?(): void | Promise<void>;
  afterPruneStaged?(): void | Promise<void>;
  afterTombstonePersisted?(): void | Promise<void>;
}

function validTaskId(value: string): string {
  if (!TASK_ID.test(value) || value.includes('..') || value.endsWith('.lock') || value === '.') {
    throw new BridgeError('invalid_request', 'Invalid task id');
  }
  return value;
}

function stagingIdentity(entryName: string): { taskId: string; tombstoneHash: string } | undefined {
  const match = PRUNE_STAGING.exec(entryName);
  if (!match) return undefined;
  try {
    return { taskId: validTaskId(match[1]!), tombstoneHash: match[2]!.toLowerCase() };
  } catch {
    return undefined;
  }
}

function archiveMetadata(record: TaskRecord, archivedAt: string): ArchiveMetadata {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    taskId: record.taskId,
    contractHash: record.contractHash,
    status: record.status,
    branch: record.branch,
    ref: `refs/heads/${record.branch}`,
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    commitHash: record.commitHash ?? null,
    createdAt: record.createdAt,
    completedAt: record.updatedAt,
    archivedAt,
  };
}

function hashEvidence(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tombstoneFor(
  record: TaskRecord,
  metadata: ArchiveMetadata,
  prunedAt: string,
): TaskTombstone {
  return {
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    taskId: record.taskId,
    contractHash: record.contractHash,
    status: record.status,
    branch: metadata.branch,
    ref: metadata.ref,
    baseRef: metadata.baseRef,
    baseCommit: metadata.baseCommit,
    commitHash: metadata.commitHash,
    verificationEvidenceHashes: record.verification.map((item) => item.sha256).sort(),
    acceptanceEvidenceHashes: record.acceptanceEvidence
      .map((item) => item.sha256 ?? hashEvidence(item))
      .sort(),
    createdAt: metadata.createdAt,
    completedAt: metadata.completedAt,
    archivedAt: metadata.archivedAt,
    prunedAt,
  };
}

function parseDuration(value: string): number {
  const match = /^(0|[1-9]\d*)([dhm])$/.exec(value);
  if (!match) {
    throw new BridgeError(
      'invalid_request',
      'Duration must be a non-negative integer followed by d, h, or m (for example 30d)',
    );
  }
  const count = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  const duration = count * multiplier;
  if (!Number.isSafeInteger(duration))
    throw new BridgeError('invalid_request', 'Duration is too large');
  return duration;
}

export function parsePruneDuration(value: string): number {
  return parseDuration(value);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readRecord(directory: string): Promise<TaskRecord> {
  return parseTaskRecordJson(await readFile(path.join(directory, 'state.json'), 'utf8'));
}

async function readArchiveMetadata(directory: string): Promise<ArchiveMetadata> {
  const parsed = JSON.parse(await readFile(path.join(directory, 'archive.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const keys = [
    'schemaVersion',
    'taskId',
    'contractHash',
    'status',
    'branch',
    'ref',
    'baseRef',
    'baseCommit',
    'commitHash',
    'createdAt',
    'completedAt',
    'archivedAt',
  ];
  if (
    parsed.schemaVersion !== ARCHIVE_SCHEMA_VERSION ||
    Object.keys(parsed).length !== keys.length ||
    !Object.keys(parsed).every((key) => keys.includes(key)) ||
    typeof parsed.taskId !== 'string' ||
    !TASK_ID.test(parsed.taskId) ||
    typeof parsed.contractHash !== 'string' ||
    !SHA256.test(parsed.contractHash) ||
    typeof parsed.status !== 'string' ||
    !TERMINAL_STATUSES.has(parsed.status as TaskStatus) ||
    !['branch', 'ref', 'baseRef', 'baseCommit'].every(
      (key) => typeof parsed[key] === 'string' && parsed[key] !== '',
    ) ||
    !(parsed.commitHash === null || typeof parsed.commitHash === 'string') ||
    !['createdAt', 'completedAt', 'archivedAt'].every((key) => isExactTimestamp(parsed[key])) ||
    parsed.branch !== `reasonix/${parsed.taskId}` ||
    parsed.ref !== `refs/heads/${parsed.branch}`
  ) {
    throw new BridgeError('invalid_state', `Invalid archive metadata: ${directory}`);
  }
  return parsed as unknown as ArchiveMetadata;
}

function parseTombstone(value: unknown): TaskTombstone {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BridgeError('invalid_state', 'Invalid task tombstone');
  }
  const parsed = value as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'taskId',
    'contractHash',
    'status',
    'branch',
    'ref',
    'baseRef',
    'baseCommit',
    'commitHash',
    'verificationEvidenceHashes',
    'acceptanceEvidenceHashes',
    'createdAt',
    'completedAt',
    'archivedAt',
    'prunedAt',
  ];
  if (
    parsed.schemaVersion !== TOMBSTONE_SCHEMA_VERSION ||
    Object.keys(parsed).length !== keys.length ||
    !Object.keys(parsed).every((key) => keys.includes(key)) ||
    typeof parsed.taskId !== 'string' ||
    !TASK_ID.test(parsed.taskId) ||
    typeof parsed.contractHash !== 'string' ||
    !SHA256.test(parsed.contractHash) ||
    typeof parsed.status !== 'string' ||
    !TERMINAL_STATUSES.has(parsed.status as TaskStatus) ||
    !['branch', 'ref', 'baseRef', 'baseCommit'].every(
      (key) => typeof parsed[key] === 'string' && parsed[key] !== '',
    ) ||
    !(parsed.commitHash === null || typeof parsed.commitHash === 'string') ||
    !['verificationEvidenceHashes', 'acceptanceEvidenceHashes'].every(
      (key) =>
        Array.isArray(parsed[key]) &&
        (parsed[key] as unknown[]).every((item) => typeof item === 'string' && SHA256.test(item)),
    ) ||
    !['createdAt', 'completedAt', 'archivedAt', 'prunedAt'].every((key) =>
      isExactTimestamp(parsed[key]),
    ) ||
    parsed.branch !== `reasonix/${parsed.taskId}` ||
    parsed.ref !== `refs/heads/${parsed.branch}`
  ) {
    throw new BridgeError('invalid_state', 'Invalid task tombstone');
  }
  return parsed as unknown as TaskTombstone;
}

async function gitOutput(cwd: string, argv: string[]): Promise<string> {
  const result = await runCommand({ argv: ['git', ...argv], cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new BridgeError('ownership_ambiguous', 'Worker worktree ownership cannot be verified');
  }
  return result.stdout.trim();
}

async function workerWorktreeState(record: TaskRecord): Promise<'missing' | 'clean'> {
  const worktree = record.worktree;
  try {
    const info = await stat(worktree);
    if (!info.isDirectory())
      throw new BridgeError('ownership_ambiguous', 'Worker worktree path is not a directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  const [actualRoot, expectedRoot, actualCommonDir, expectedCommonDir, branch, head] =
    await Promise.all([
      realpath(await gitOutput(worktree, ['rev-parse', '--show-toplevel'])),
      realpath(worktree),
      gitOutput(worktree, ['rev-parse', '--git-common-dir']).then(
        async (commonDir) =>
          await realpath(
            path.isAbsolute(commonDir) ? commonDir : path.resolve(worktree, commonDir),
          ),
      ),
      realpath(record.repository.commonDir),
      gitOutput(worktree, ['symbolic-ref', '--quiet', 'HEAD']),
      gitOutput(worktree, ['rev-parse', '--verify', 'HEAD']),
    ]).catch((error: unknown) => {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('ownership_ambiguous', 'Worker worktree ownership cannot be verified');
    });
  const expectedHead = record.commitHash ?? record.baseCommit;
  if (
    actualRoot !== expectedRoot ||
    actualCommonDir !== expectedCommonDir ||
    branch !== `refs/heads/${record.branch}` ||
    head !== expectedHead
  ) {
    throw new BridgeError(
      'ownership_ambiguous',
      'Worker worktree identity does not match the terminal task record',
    );
  }
  const result = await runCommand({
    argv: ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    cwd: worktree,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new BridgeError('ownership_ambiguous', 'Worker worktree cannot be verified as clean');
  }
  if (result.stdout.length > 0) {
    throw new BridgeError('dirty_repository', 'Worker worktree has changes; archive refused');
  }
  return 'clean';
}

export class TaskOperations {
  readonly archiveRoot: string;
  readonly tombstonesRoot: string;
  readonly pruneStagingRoot: string;

  constructor(
    readonly store: StateStore,
    private readonly faults: TaskOperationFaults = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.archiveRoot = path.join(store.root, 'archive');
    this.tombstonesRoot = path.join(store.root, 'tombstones');
    this.pruneStagingRoot = path.join(store.root, 'prune-staging');
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await Promise.all([
      privateDirectory(this.archiveRoot),
      privateDirectory(this.tombstonesRoot),
      privateDirectory(this.pruneStagingRoot),
    ]);
    await this.recoverPruneStaging();
  }

  async list(all = false): Promise<TaskListEntry[]> {
    await this.initialize();
    const output: TaskListEntry[] = [];
    for (const entry of await readdir(this.store.tasksDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = await this.store.loadTask(entry.name);
      if (!all && TERMINAL_STATUSES.has(record.status)) continue;
      output.push(this.liveListEntry(record));
    }
    if (all) {
      for (const entry of await readdir(this.archiveRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(this.archiveRoot, entry.name);
        const [record, metadata] = await Promise.all([
          readRecord(directory),
          readArchiveMetadata(directory),
        ]);
        if (record.taskId !== entry.name || metadata.taskId !== entry.name) {
          throw new BridgeError('invalid_state', `Archive identity mismatch: ${directory}`);
        }
        output.push(this.archiveListEntry(record, metadata));
      }
      for (const entry of await readdir(this.tombstonesRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const tombstone = parseTombstone(
          JSON.parse(await readFile(path.join(this.tombstonesRoot, entry.name), 'utf8')),
        );
        if (entry.name !== `${tombstone.taskId}.json`) {
          throw new BridgeError(
            'invalid_state',
            `Tombstone identity mismatch: ${path.join(this.tombstonesRoot, entry.name)}`,
          );
        }
        output.push(this.tombstoneListEntry(tombstone));
      }
    }
    return output.sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.task_id.localeCompare(right.task_id),
    );
  }

  async archive(taskIdInput: string, apply: boolean): Promise<MutationResult> {
    await this.initialize();
    const taskId = validTaskId(taskIdInput);
    const destination = path.join(this.archiveRoot, taskId);
    if (await exists(destination)) {
      const metadata = await readArchiveMetadata(destination);
      if (metadata.taskId !== taskId) {
        throw new BridgeError('invalid_state', `Archive identity mismatch: ${destination}`);
      }
      return { apply, action: 'archive', taskIds: [taskId], message: 'Task is already archived' };
    }
    const tombstonePath = path.join(this.tombstonesRoot, `${taskId}.json`);
    if (await exists(tombstonePath)) {
      const tombstone = parseTombstone(JSON.parse(await readFile(tombstonePath, 'utf8')));
      if (tombstone.taskId !== taskId) {
        throw new BridgeError('invalid_state', `Tombstone identity mismatch: ${tombstonePath}`);
      }
      return { apply, action: 'archive', taskIds: [taskId], message: 'Task is already pruned' };
    }
    const record = await this.store.loadTask(taskId);
    if (!TERMINAL_STATUSES.has(record.status)) {
      throw new BridgeError(
        'invalid_state',
        `Only terminal tasks may be archived; ${taskId} is ${record.status}`,
      );
    }
    const worktreeState = await workerWorktreeState(record);
    if (!apply) {
      return {
        apply: false,
        action: 'archive',
        taskIds: [taskId],
        message: `Would archive terminal task ${taskId}${worktreeState === 'clean' ? ' and detach its clean worktree' : ''}`,
      };
    }

    const preparedPath = path.join(this.store.taskDir(taskId), 'archive.json');
    let metadata: ArchiveMetadata;
    if (await exists(preparedPath)) {
      metadata = await readArchiveMetadata(this.store.taskDir(taskId));
      if (
        metadata.taskId !== taskId ||
        metadata.contractHash !== record.contractHash ||
        metadata.status !== record.status ||
        metadata.branch !== record.branch ||
        metadata.ref !== `refs/heads/${record.branch}` ||
        metadata.baseRef !== record.baseRef ||
        metadata.baseCommit !== record.baseCommit ||
        metadata.commitHash !== (record.commitHash ?? null) ||
        metadata.createdAt !== record.createdAt ||
        metadata.completedAt !== record.updatedAt
      ) {
        throw new BridgeError(
          'invalid_state',
          'Prepared archive metadata no longer matches the terminal task',
        );
      }
    } else {
      metadata = archiveMetadata(record, this.now().toISOString());
      await atomicWrite(preparedPath, `${JSON.stringify(metadata, null, 2)}\n`);
    }
    await this.faults.afterArchivePrepared?.();
    if (worktreeState === 'clean') {
      const removal = await runCommand({
        argv: ['git', 'worktree', 'remove', '--', record.worktree],
        cwd: record.repository.root,
        timeoutMs: 5 * 60_000,
      });
      if (removal.exitCode !== 0) {
        throw new BridgeError(
          'ownership_ambiguous',
          'Git refused to detach the clean worker worktree',
        );
      }
      await this.faults.afterWorkerWorktreeDetached?.();
    }
    try {
      await rename(this.store.taskDir(taskId), destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !(await exists(destination)))
        throw error;
    }
    return { apply: true, action: 'archive', taskIds: [taskId], message: `Archived ${taskId}` };
  }

  async prune(olderThanMs: number, apply: boolean): Promise<MutationResult> {
    await this.initialize();
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
      throw new BridgeError('invalid_request', 'Prune age must be a non-negative duration');
    }
    const cutoff = this.now().getTime() - olderThanMs;
    const eligible: string[] = [];
    for (const entry of await readdir(this.archiveRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadata = await readArchiveMetadata(path.join(this.archiveRoot, entry.name));
      if (metadata.taskId !== entry.name) {
        throw new BridgeError(
          'invalid_state',
          `Archive identity mismatch: ${path.join(this.archiveRoot, entry.name)}`,
        );
      }
      if (Date.parse(metadata.archivedAt) <= cutoff) eligible.push(metadata.taskId);
    }
    eligible.sort();
    if (!apply) {
      return {
        apply: false,
        action: 'prune',
        taskIds: eligible,
        message: `Would prune ${String(eligible.length)} archive(s)`,
      };
    }
    for (const taskId of eligible) await this.pruneOne(taskId);
    return {
      apply: true,
      action: 'prune',
      taskIds: eligible,
      message: `Pruned ${String(eligible.length)} archive(s)`,
    };
  }

  private async pruneOne(taskId: string): Promise<void> {
    const archive = path.join(this.archiveRoot, taskId);
    const destination = path.join(this.tombstonesRoot, `${taskId}.json`);
    if (await exists(destination)) {
      const tombstone = parseTombstone(JSON.parse(await readFile(destination, 'utf8')));
      if (tombstone.taskId !== taskId || (await exists(archive))) {
        throw new BridgeError('invalid_state', `Conflicting tombstone for task: ${taskId}`);
      }
      return;
    }
    const [record, metadata] = await Promise.all([
      readRecord(archive),
      readArchiveMetadata(archive),
    ]);
    const tombstone = tombstoneFor(record, metadata, this.now().toISOString());
    await atomicWrite(
      path.join(archive, 'tombstone.pending.json'),
      `${JSON.stringify(tombstone, null, 2)}\n`,
    );
    const staging = path.join(
      this.pruneStagingRoot,
      `${taskId}-${hashEvidence(tombstone)}-${randomUUID()}`,
    );
    await rename(archive, staging);
    await this.faults.afterPruneStaged?.();
    await atomicWrite(destination, `${JSON.stringify(tombstone, null, 2)}\n`);
    await this.faults.afterTombstonePersisted?.();
    await rm(staging, { recursive: true });
  }

  private async recoverPruneStaging(): Promise<void> {
    for (const entry of await readdir(this.pruneStagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const staging = path.join(this.pruneStagingRoot, entry.name);
      const identity = stagingIdentity(entry.name);
      if (!identity) {
        throw new BridgeError('invalid_state', `Interrupted prune requires inspection: ${staging}`);
      }
      const pending = path.join(staging, 'tombstone.pending.json');
      let tombstone: TaskTombstone;
      try {
        tombstone = parseTombstone(JSON.parse(await readFile(pending, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new BridgeError(
            'invalid_state',
            `Interrupted prune requires inspection: ${staging}`,
          );
        }
        const { taskId } = identity;
        const destination = path.join(this.tombstonesRoot, `${taskId}.json`);
        if (await exists(destination)) {
          const persisted = parseTombstone(JSON.parse(await readFile(destination, 'utf8')));
          if (persisted.taskId === taskId && hashEvidence(persisted) === identity.tombstoneHash) {
            await rm(staging, { recursive: true });
            continue;
          }
        }
        throw new BridgeError('invalid_state', `Interrupted prune requires inspection: ${staging}`);
      }
      if (
        tombstone.taskId !== identity.taskId ||
        hashEvidence(tombstone) !== identity.tombstoneHash
      ) {
        throw new BridgeError('invalid_state', `Interrupted prune identity mismatch: ${staging}`);
      }
      const destination = path.join(this.tombstonesRoot, `${validTaskId(tombstone.taskId)}.json`);
      if (!(await exists(destination))) {
        await atomicWrite(destination, `${JSON.stringify(tombstone, null, 2)}\n`);
      } else {
        const persisted = parseTombstone(JSON.parse(await readFile(destination, 'utf8')));
        if (JSON.stringify(persisted) !== JSON.stringify(tombstone)) {
          throw new BridgeError(
            'invalid_state',
            `Interrupted prune conflicts with existing tombstone: ${staging}`,
          );
        }
      }
      await unlink(pending).catch(() => undefined);
      await rm(staging, { recursive: true });
    }
  }

  private liveListEntry(record: TaskRecord): TaskListEntry {
    return {
      task_id: record.taskId,
      status: record.status,
      phase: record.phase,
      storage: 'live',
      repository_id: record.repository.id,
      base_ref: record.baseRef,
      base_commit: record.baseCommit,
      branch: record.branch,
      commit_hash: record.commitHash ?? null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      archived_at: null,
      pruned_at: null,
    };
  }

  private archiveListEntry(record: TaskRecord, metadata: ArchiveMetadata): TaskListEntry {
    return {
      ...this.liveListEntry(record),
      storage: 'archive',
      updated_at: metadata.completedAt,
      archived_at: metadata.archivedAt,
    };
  }

  private tombstoneListEntry(tombstone: TaskTombstone): TaskListEntry {
    return {
      task_id: tombstone.taskId,
      status: tombstone.status,
      phase: 'pruned',
      storage: 'tombstone',
      repository_id: null,
      base_ref: tombstone.baseRef,
      base_commit: tombstone.baseCommit,
      branch: tombstone.branch,
      commit_hash: tombstone.commitHash,
      created_at: tombstone.createdAt,
      updated_at: tombstone.completedAt,
      archived_at: tombstone.archivedAt,
      pruned_at: tombstone.prunedAt,
    };
  }
}

export interface TaskCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const TASK_USAGE =
  'Usage: codex-reasonix-mcp task list [--all] [--json] | task archive <id> [--apply] | task prune [--older-than 30d] [--apply]';

function table(entries: TaskListEntry[]): string {
  if (entries.length === 0) return 'No tasks.\n';
  return `${entries.map((entry) => [entry.task_id, entry.status, entry.storage, entry.branch, entry.updated_at].join('\t')).join('\n')}\n`;
}

export async function runTaskCli(
  args: string[],
  options: { stateDir: string; now?: () => Date } = { stateDir: '' },
): Promise<TaskCliResult> {
  const operations = new TaskOperations(new StateStore(options.stateDir), {}, options.now);
  try {
    const command = args[0];
    if (command === 'list') {
      if (args.slice(1).some((arg) => arg !== '--all' && arg !== '--json'))
        throw new Error('usage');
      if (new Set(args.slice(1)).size !== args.slice(1).length) throw new Error('usage');
      const entries = await operations.list(args.includes('--all'));
      return {
        exitCode: 0,
        stdout: args.includes('--json') ? `${JSON.stringify(entries, null, 2)}\n` : table(entries),
        stderr: '',
      };
    }
    if (command === 'archive') {
      const taskId = args[1];
      if (
        !taskId ||
        args.slice(2).some((arg) => arg !== '--apply') ||
        args.filter((arg) => arg === '--apply').length > 1
      )
        throw new Error('usage');
      const result = await operations.archive(taskId, args.includes('--apply'));
      return { exitCode: 0, stdout: `${result.message}\n`, stderr: '' };
    }
    if (command === 'prune') {
      let duration = '30d';
      let durationSpecified = false;
      let apply = false;
      for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--apply' && !apply) apply = true;
        else if (arg === '--older-than' && !durationSpecified && args[index + 1]) {
          duration = args[++index]!;
          durationSpecified = true;
        } else throw new Error('usage');
      }
      const result = await operations.prune(parseDuration(duration), apply);
      return {
        exitCode: 0,
        stdout: `${result.message}${result.taskIds.length ? `: ${result.taskIds.join(', ')}` : ''}\n`,
        stderr: '',
      };
    }
    throw new Error('usage');
  } catch (error) {
    if (error instanceof Error && error.message === 'usage') {
      return { exitCode: 2, stdout: '', stderr: `${TASK_USAGE}\n` };
    }
    return {
      exitCode: error instanceof BridgeError && error.code === 'invalid_request' ? 2 : 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
