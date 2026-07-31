import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalContractJson } from './contracts.js';
import { BridgeError } from './errors.js';
import { redact } from './redaction.js';
import { TERMINAL_STATUSES, type JournalEvent, type TaskRecord } from './types.js';

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

  async loadTask(taskId: string): Promise<TaskRecord> {
    try {
      const raw = await readFile(this.statePath(taskId), 'utf8');
      return JSON.parse(raw) as TaskRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError('task_not_found', `Unknown task: ${taskId}`);
      }
      throw error;
    }
  }

  async saveTask(record: TaskRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await atomicWrite(this.statePath(record.taskId), `${JSON.stringify(record, null, 2)}\n`);
  }

  async updateTask(
    taskId: string,
    update: (record: TaskRecord) => void | Promise<void>,
  ): Promise<TaskRecord> {
    const prior = this.updates.get(taskId) ?? Promise.resolve();
    const current = prior.then(async () => {
      const record = await this.loadTask(taskId);
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
    const record = await this.loadTask(taskId);
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
