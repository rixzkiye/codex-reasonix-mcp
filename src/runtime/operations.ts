import path from 'node:path';

import type { BridgeConfig } from '../config.js';
import { configFingerprint } from '../config.js';
import { contractHash, parseTaskContract } from '../contracts.js';
import { BridgeError } from '../errors.js';
import { transitionTask } from '../lifecycle.js';
import {
  assertSourceClean,
  discoverRepository,
  resolveBaseCommit,
  validateTaskId,
} from '../repository.js';
import { parseSandboxContext } from '../sandbox.js';
import type { StateStore } from '../state.js';
import { EMPTY_USAGE, TERMINAL_STATUSES, type TaskRecord } from '../types.js';
import type { ControlInput, DelegateInput } from './api.js';
import { assertSupportedPlatform, type CollisionAccess } from './collision.js';
import type { FinalizationAccess } from './finalization.js';
import type { PermissionAccess } from './permissions.js';
import type { SessionAccess } from './session-supervision.js';
import { now, taskView } from './shared.js';

export interface OperationDependencies {
  config: BridgeConfig;
  store: StateStore;
  collision: Pick<
    CollisionAccess,
    'assertExistingTask' | 'assertTaskRepository' | 'holdLease' | 'releaseLease' | 'guardTask'
  >;
  permissions: Pick<PermissionAccess, 'respond' | 'cancelTaskInteractions'>;
  sessions: Pick<
    SessionAccess,
    'beginProvision' | 'beginResume' | 'workerForTask' | 'cancelWorker' | 'closeWorker'
  >;
  finalization: FinalizationAccess;
}

export interface OperationAccess {
  delegate(input: DelegateInput, requestMeta: unknown): Promise<Record<string, unknown>>;
  control(input: ControlInput, requestMeta: unknown): Promise<Record<string, unknown>>;
}

export class OperationController implements OperationAccess {
  constructor(private readonly dependencies: OperationDependencies) {}

  async delegate(input: DelegateInput, requestMeta: unknown): Promise<Record<string, unknown>> {
    assertSupportedPlatform();
    const taskId = validateTaskId(input.task_id);
    const sandbox = parseSandboxContext(requestMeta);
    const contract = parseTaskContract(input.contract);
    const hash = contractHash(contract);
    const repository = await discoverRepository(sandbox.cwd);

    if (await this.dependencies.store.exists(taskId)) {
      const existing = await this.dependencies.store.loadTask(taskId);
      await this.dependencies.collision.assertExistingTask(
        existing,
        repository,
        hash,
        input.base_ref,
      );
      if (existing.status === 'paused' && input.resume !== false) {
        if (!existing.inspectedAfterPause) {
          return { ...taskView(existing), resume_required: true, inspect_required: true };
        }
        await this.dependencies.collision.guardTask(taskId, 'resume');
        const currentNetworkEnabled =
          this.dependencies.config.networkEnabled && sandbox.networkEnabled;
        const currentFingerprint = configFingerprint({
          ...this.dependencies.config,
          networkEnabled: currentNetworkEnabled,
        });
        if (
          existing.networkEnabled !== currentNetworkEnabled ||
          existing.processFingerprint !== currentFingerprint
        ) {
          throw new BridgeError(
            'reasonix_incompatible',
            'Current sandbox/config posture differs from the task creation fingerprint; resume is blocked',
            {
              taskNetworkEnabled: existing.networkEnabled,
              currentNetworkEnabled,
              hasStoredFingerprint: existing.processFingerprint !== undefined,
            },
          );
        }
        await this.dependencies.collision.holdLease(repository, taskId);
        this.dependencies.sessions.beginResume(existing);
      }
      return taskView(await this.dependencies.store.loadTask(taskId));
    }

    await assertSourceClean(repository);
    const baseRef = input.base_ref?.trim() || 'HEAD';
    const baseCommit = await resolveBaseCommit(repository, baseRef);
    await this.dependencies.collision.holdLease(repository, taskId);
    const createdAt = now();
    const worktree = path.join(this.dependencies.store.worktreesDir(), repository.id, taskId);
    const networkEnabled = this.dependencies.config.networkEnabled && sandbox.networkEnabled;
    const record: TaskRecord = {
      schemaVersion: 2,
      taskId,
      contract,
      contractHash: hash,
      repository,
      baseRef,
      baseCommit,
      branch: `reasonix/${taskId}`,
      worktree,
      networkEnabled,
      status: 'provisioning',
      phase: 'queued',
      createdAt,
      updatedAt: createdAt,
      processFingerprint: configFingerprint({
        ...this.dependencies.config,
        networkEnabled,
      }),
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
    try {
      await this.dependencies.store.createTask(record);
    } catch (error) {
      await this.dependencies.collision.releaseLease(repository.id, taskId);
      throw error;
    }
    this.dependencies.sessions.beginProvision(taskId);
    return taskView(await this.dependencies.store.loadTask(taskId));
  }

  async control(input: ControlInput, requestMeta: unknown): Promise<Record<string, unknown>> {
    assertSupportedPlatform();
    const taskId = validateTaskId(input.task_id);
    const task = await this.dependencies.store.loadTask(taskId);
    if (input.action === 'respond') {
      await this.dependencies.collision.guardTask(taskId, 'resume_after_interaction');
      return await this.dependencies.permissions.respond(task, input);
    }
    if (input.action === 'cancel') return await this.cancel(task);
    if (input.action === 'close') return await this.close(task);
    if (input.action === 'steer') return await this.steer(task, input.message);

    const sandbox = parseSandboxContext(requestMeta);
    const repository = await discoverRepository(sandbox.cwd);
    this.dependencies.collision.assertTaskRepository(task, repository);
    return await this.dependencies.finalization.finalize(task, input, repository);
  }

  private async steer(task: TaskRecord, message: string): Promise<Record<string, unknown>> {
    if (!message.trim() || message.length > 20_000) {
      throw new BridgeError(
        'invalid_request',
        'steer message must be non-empty and at most 20,000 chars',
      );
    }
    const worker = this.dependencies.sessions.workerForTask(task);
    await this.dependencies.collision.guardTask(task.taskId, 'before_steer');
    let repairRound = task.repairRounds;
    if (task.status === 'review_required') {
      if (task.repairRounds >= 2) {
        throw new BridgeError(
          'repair_limit_reached',
          'Two post-review repair rounds are already used',
        );
      }
      repairRound += 1;
      await this.dependencies.store.recordEvent(
        task.taskId,
        'repair_started',
        { round: repairRound },
        (record) => {
          record.repairRounds = repairRound;
          record.repairActive = true;
          transitionTask(record, 'running', `repair_${repairRound}`);
        },
      );
    } else if (task.status !== 'running') {
      throw new BridgeError('invalid_state', `Cannot steer task in ${task.status}`);
    }
    const prefix =
      repairRound > task.repairRounds
        ? `Codex review repair round ${repairRound}/2. The contract is immutable. `
        : 'Codex supervisor steering. The contract is immutable. ';
    await worker.steer(task.acpSessionId!, `${prefix}${message.trim()}`);
    await this.dependencies.store.recordEvent(task.taskId, 'steer_sent', { repairRound });
    return taskView(await this.dependencies.store.loadTask(task.taskId));
  }

  private async cancel(task: TaskRecord): Promise<Record<string, unknown>> {
    if (TERMINAL_STATUSES.has(task.status)) return taskView(task);
    let cancelled = false;
    await this.dependencies.store.recordEvent(
      task.taskId,
      'task_cancel_requested',
      {},
      (record) => {
        if (TERMINAL_STATUSES.has(record.status)) return;
        if (record.status === 'verifying' && record.phase === 'committing') {
          throw new BridgeError(
            'invalid_state',
            'Atomic commit has already started and cannot be cancelled',
          );
        }
        transitionTask(record, 'cancelled', 'cancelled');
        cancelled = true;
        for (const interaction of record.interactions) {
          if (interaction.status === 'pending') interaction.status = 'cancelled';
        }
      },
    );
    if (!cancelled) return taskView(await this.dependencies.store.loadTask(task.taskId));
    const finalization = this.dependencies.finalization.current(task.taskId);
    this.dependencies.finalization.abort(task.taskId);
    this.dependencies.permissions.cancelTaskInteractions(task.taskId);
    await this.dependencies.sessions.cancelWorker(task);
    if (finalization) await finalization;
    await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
    return taskView(await this.dependencies.store.loadTask(task.taskId));
  }

  private async close(task: TaskRecord): Promise<Record<string, unknown>> {
    if (TERMINAL_STATUSES.has(task.status)) return taskView(task);
    if (task.status === 'verifying') {
      throw new BridgeError(
        'invalid_state',
        'Cannot close a task while finalization is running; cancel it first',
      );
    }
    await this.dependencies.store.recordEvent(task.taskId, 'task_closed', {}, (record) => {
      transitionTask(record, 'closed', 'closed');
      for (const interaction of record.interactions) {
        if (interaction.status === 'pending') interaction.status = 'cancelled';
      }
    });
    this.dependencies.permissions.cancelTaskInteractions(task.taskId);
    await this.dependencies.sessions.closeWorker(task);
    await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
    return taskView(await this.dependencies.store.loadTask(task.taskId));
  }
}
