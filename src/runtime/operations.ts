import path from 'node:path';

import type { BridgeConfig } from '../config.js';
import { configFingerprint } from '../config.js';
import { contractHash, parseTaskContractForInvocation, type TaskContractV1 } from '../contracts.js';
import { BridgeError } from '../errors.js';
import { transitionTask } from '../lifecycle.js';
import { classifyStaticCommand } from '../policy.js';
import {
  assertSourceClean,
  discoverRepository,
  resolveBaseCommit,
  resolveGitIdentity,
  validateTaskId,
} from '../repository.js';
import { parseSandboxContext } from '../sandbox.js';
import type { StateStore } from '../state.js';
import {
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  DEFAULT_FAST_LANE_EXECUTION_TIMEOUT_SECONDS,
  EMPTY_USAGE,
  MAX_EXECUTION_TIMEOUT_SECONDS,
  MIN_EXECUTION_TIMEOUT_SECONDS,
  TASK_RECORD_SCHEMA_VERSION,
  TERMINAL_STATUSES,
  type TaskRecord,
} from '../types.js';
import type { ControlInput, DelegateInput, RuntimeCallContext } from './api.js';
import { assertSupportedPlatform, type CollisionAccess } from './collision.js';
import type { FinalizationAccess } from './finalization.js';
import type { InspectionAccess } from './inspection.js';
import type { PermissionAccess } from './permissions.js';
import type { SessionAccess } from './session-supervision.js';
import { hasPendingInteraction, now, taskView, waitForTask, waitTimeoutMs } from './shared.js';

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
  inspection: Pick<InspectionAccess, 'reviewBundle'>;
}

export interface OperationAccess {
  delegate(
    input: DelegateInput,
    requestMeta: unknown,
    context?: RuntimeCallContext,
  ): Promise<Record<string, unknown>>;
  control(
    input: ControlInput,
    requestMeta: unknown,
    context?: RuntimeCallContext,
  ): Promise<Record<string, unknown>>;
}

export class OperationController implements OperationAccess {
  constructor(private readonly dependencies: OperationDependencies) {}

  async delegate(
    input: DelegateInput,
    requestMeta: unknown,
    context: RuntimeCallContext = {},
  ): Promise<Record<string, unknown>> {
    assertSupportedPlatform();
    const taskId = validateTaskId(input.task_id);
    if (
      input.execution_timeout_seconds !== undefined &&
      (!Number.isInteger(input.execution_timeout_seconds) ||
        input.execution_timeout_seconds < MIN_EXECUTION_TIMEOUT_SECONDS ||
        input.execution_timeout_seconds > MAX_EXECUTION_TIMEOUT_SECONDS)
    ) {
      throw new BridgeError(
        'invalid_request',
        `execution_timeout_seconds must be an integer between ${String(MIN_EXECUTION_TIMEOUT_SECONDS)} and ${String(MAX_EXECUTION_TIMEOUT_SECONDS)}`,
      );
    }
    const sandbox = parseSandboxContext(requestMeta);
    const repository = await discoverRepository(sandbox.cwd);
    const exists = await this.dependencies.store.exists(taskId);
    const existing = exists ? await this.dependencies.store.loadTask(taskId) : undefined;
    const contract = existing
      ? this.parseContractForExistingTask(
          input,
          sandbox.cwd,
          repository.root,
          existing.contractHash,
        )
      : parseTaskContractForInvocation(input.contract, {
          invocationCwd: sandbox.cwd,
          repositoryRoot: repository.root,
          pathBase: input.path_base ?? 'cwd',
        });
    const hash = contractHash(contract);

    if (existing) {
      let resumeOrigin: Pick<TaskRecord, 'phase' | 'statusSequence'> | undefined;
      await this.dependencies.collision.assertExistingTask(
        existing,
        repository,
        hash,
        input.base_ref,
      );
      if (
        input.worker_lane !== undefined &&
        input.worker_lane !== existing.executionProfile.workerLane
      ) {
        throw new BridgeError(
          'task_conflict',
          'Explicit worker_lane differs from the existing task execution profile',
          {
            requested: input.worker_lane,
            stored: existing.executionProfile.workerLane,
          },
        );
      }
      if (
        input.reasoning_effort !== undefined &&
        input.reasoning_effort !== existing.executionProfile.requestedReasoningEffort
      ) {
        throw new BridgeError(
          'task_conflict',
          'Explicit reasoning_effort differs from the existing task execution profile',
          {
            requested: input.reasoning_effort,
            stored: existing.executionProfile.requestedReasoningEffort,
          },
        );
      }
      if (
        input.execution_timeout_seconds !== undefined &&
        input.execution_timeout_seconds !== existing.executionProfile.executionTimeoutSeconds
      ) {
        throw new BridgeError(
          'task_conflict',
          'Explicit execution_timeout_seconds differs from the existing task execution profile',
          {
            requested: input.execution_timeout_seconds,
            stored: existing.executionProfile.executionTimeoutSeconds,
          },
        );
      }
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
        await resolveGitIdentity(repository);
        this.assertVerifierPolicyCompatible(existing.contract);
        await this.dependencies.collision.holdLease(repository, taskId);
        this.dependencies.sessions.beginResume(existing);
        resumeOrigin = {
          phase: existing.phase,
          statusSequence: existing.statusSequence,
        };
      }
      return await this.delegateResult(
        await this.dependencies.store.loadTask(taskId),
        input,
        context,
        resumeOrigin,
      );
    }

    await assertSourceClean(repository);
    await resolveGitIdentity(repository);
    this.assertVerifierPolicyCompatible(contract);
    const baseRef = input.base_ref?.trim() || 'HEAD';
    const baseCommit = await resolveBaseCommit(repository, baseRef);
    await this.dependencies.collision.holdLease(repository, taskId);
    const createdAt = now();
    const worktree = path.join(this.dependencies.store.worktreesDir(), repository.id, taskId);
    const networkEnabled = this.dependencies.config.networkEnabled && sandbox.networkEnabled;
    const workerLane = input.worker_lane ?? 'fast';
    const record: TaskRecord = {
      schemaVersion: TASK_RECORD_SCHEMA_VERSION,
      executionProfile: {
        requestedReasoningEffort:
          input.reasoning_effort ?? this.dependencies.config.reasoningEffort,
        effectiveReasoningEffort:
          input.reasoning_effort ?? this.dependencies.config.reasoningEffort,
        executionTimeoutSeconds:
          input.execution_timeout_seconds ??
          (workerLane === 'fast'
            ? DEFAULT_FAST_LANE_EXECUTION_TIMEOUT_SECONDS
            : DEFAULT_EXECUTION_TIMEOUT_SECONDS),
        workerLane,
      },
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
      reviewRevision: 0,
    };
    try {
      await this.dependencies.store.createTask(record);
    } catch (error) {
      await this.dependencies.collision.releaseLease(repository.id, taskId);
      throw error;
    }
    this.dependencies.sessions.beginProvision(taskId);
    return await this.delegateResult(
      await this.dependencies.store.loadTask(taskId),
      input,
      context,
    );
  }

  private parseContractForExistingTask(
    input: DelegateInput,
    invocationCwd: string,
    repositoryRoot: string,
    existingHash: string,
  ): TaskContractV1 {
    const parse = (pathBase: 'cwd' | 'repository'): TaskContractV1 =>
      parseTaskContractForInvocation(input.contract, {
        invocationCwd,
        repositoryRoot,
        pathBase,
      });
    if (input.path_base !== undefined) return parse(input.path_base);

    let firstError: unknown;
    const candidates: TaskContractV1[] = [];
    for (const pathBase of ['cwd', 'repository'] as const) {
      try {
        const candidate = parse(pathBase);
        if (contractHash(candidate) === existingHash) return candidate;
        candidates.push(candidate);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (candidates[0]) return candidates[0];
    throw firstError;
  }

  private assertVerifierPolicyCompatible(contract: TaskContractV1): void {
    const issues = contract.verification.flatMap((verification) => {
      const decision = classifyStaticCommand(
        {
          argv: verification.argv,
          cwd: verification.cwd ?? '.',
        },
        contract,
      );
      return decision.action === 'deny'
        ? [
            {
              path: `verification.${verification.id}`,
              message: `${decision.code}: ${decision.reason}`,
            },
          ]
        : [];
    });
    if (issues.length > 0) {
      throw new BridgeError(
        'invalid_contract',
        'Verification commands are incompatible with immutable command policy',
        { issues },
      );
    }
  }

  async control(
    input: ControlInput,
    requestMeta: unknown,
    context: RuntimeCallContext = {},
  ): Promise<Record<string, unknown>> {
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
    return await this.dependencies.finalization.finalize(task, input, repository, context);
  }

  private async delegateResult(
    initial: TaskRecord,
    input: DelegateInput,
    context: RuntimeCallContext,
    resumeOrigin?: Pick<TaskRecord, 'phase' | 'statusSequence'>,
  ): Promise<Record<string, unknown>> {
    if ((input.wait_mode ?? 'review') === 'background') return taskView(initial);
    const waited = await waitForTask(
      this.dependencies.store,
      initial.taskId,
      initial,
      waitTimeoutMs(input.wait_timeout_seconds),
      (task) =>
        task.status === 'review_required' ||
        (task.status === 'paused' &&
          (resumeOrigin === undefined ||
            task.phase !== resumeOrigin.phase ||
            task.statusSequence !== resumeOrigin.statusSequence)) ||
        TERMINAL_STATUSES.has(task.status) ||
        hasPendingInteraction(task),
      context,
      'Reasonix is working; waiting for review or interaction',
    );
    const view = taskView(waited.task);
    if (waited.task.status === 'review_required' || hasPendingInteraction(waited.task)) {
      Object.assign(view, await this.dependencies.inspection.reviewBundle(waited.task.taskId));
    }
    return { ...view, timed_out: waited.timedOut };
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
