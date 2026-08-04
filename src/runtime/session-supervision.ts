import type {
  PromptResponse,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import { ReasonixPool, type ReasonixCallbacks, type ReasonixProcess } from '../acp.js';
import type { BridgeConfig } from '../config.js';
import { renderFastPrompt, renderGoalPrompt } from '../contracts.js';
import { BridgeError, asBridgeError } from '../errors.js';
import { canTransition, enterPaused, transitionTask } from '../lifecycle.js';
import type { ReasonixStatus, ReasonixStatusUpdate } from '../reasonix-status.js';
import { redact, redactString } from '../redaction.js';
import { canonicalWorktreeTree, createIsolatedWorktree } from '../repository.js';
import type { StateStore } from '../state.js';
import { TERMINAL_STATUSES, type TaskRecord } from '../types.js';
import type { CollisionAccess } from './collision.js';
import type { PermissionAccess } from './permissions.js';
import { statusToUsage } from './shared.js';

export interface SessionSupervisionDependencies {
  config: BridgeConfig;
  store: StateStore;
  permissions: Pick<PermissionAccess, 'onPermission' | 'onToolCallUpdate' | 'finishPrompt'>;
  collision: Pick<CollisionAccess, 'guardTask' | 'releaseLease'>;
}

export interface SessionAccess {
  taskIdForSession(sessionId: string): string | undefined;
  beginProvision(taskId: string): void;
  beginResume(task: TaskRecord): void;
  workerForTask(task: TaskRecord): ReasonixProcess;
  cancelWorker(task: TaskRecord): Promise<void>;
  closeWorker(task: TaskRecord): Promise<void>;
  shutdown(): Promise<void>;
}

const FAST_LANE_FORBIDDEN_MARKERS = /auto\s?research|subagent|review\s+skill|task\s+skill/i;

/** Effective Reasonix posture that violates the task worker lane, if any. */
export function laneViolation(task: TaskRecord, status: ReasonixStatus): string | undefined {
  const lane = task.executionProfile.workerLane;
  if (lane === 'fast') {
    if (status.mode !== 'normal') return `fast lane forbids session mode: ${status.mode}`;
    if (status.goal.status !== 'none')
      return `fast lane forbids Goal activity: ${status.goal.status}`;
    if (status.workMode !== 'economy')
      return `fast lane requires economy work mode: ${status.workMode}`;
    return undefined;
  }
  if (status.mode !== 'goal') return `deep lane requires goal session mode: ${status.mode}`;
  if (status.workMode !== 'delivery')
    return `deep lane requires delivery work mode: ${status.workMode}`;
  return undefined;
}

/** Fast-lane session events that name AutoResearch, review/task skills, or subagents. */
export function fastLaneSessionViolation(task: TaskRecord, update: unknown): string | undefined {
  if (task.executionProfile.workerLane !== 'fast') return undefined;
  const text = JSON.stringify(update);
  if (FAST_LANE_FORBIDDEN_MARKERS.test(text)) {
    return 'fast lane forbids AutoResearch, review/task skills, and subagents';
  }
  return undefined;
}

export function reasonixCompletionDisposition(
  response: PromptResponse | undefined,
  status: ReasonixStatus,
): 'cancelled' | 'failed' | 'review_required' | 'paused' {
  if (status.goal.status === 'cancelled' || response?.stopReason === 'cancelled') {
    return 'cancelled';
  }
  if (status.goal.status === 'failed' || status.turnOutcome.kind === 'error') return 'failed';
  if (
    status.finalReadiness.readyForReview ||
    status.goal.status === 'complete' ||
    (response?.stopReason === 'end_turn' && status.turnOutcome.kind === 'completed')
  ) {
    return 'review_required';
  }
  return 'paused';
}

export class SessionSupervisor implements SessionAccess {
  private readonly pool: ReasonixPool;
  private readonly sessionToTask = new Map<string, string>();
  private readonly taskProcesses = new Map<string, ReasonixProcess>();
  private readonly messageBuffers = new Map<string, string>();

  constructor(private readonly dependencies: SessionSupervisionDependencies) {
    const callbacks: ReasonixCallbacks = {
      onPermission: async (params): Promise<RequestPermissionResponse> =>
        await this.dependencies.permissions.onPermission(params),
      onSessionUpdate: async (notification) => await this.onSessionUpdate(notification),
      onStatusUpdate: async (update) => await this.onStatusUpdate(update),
      onPromptComplete: async (sessionId, response, status, error) =>
        await this.onPromptComplete(sessionId, response, status, error),
      onProcessError: async (sessionIds, error) => await this.onProcessError(sessionIds, error),
      onOperationalLog: () => undefined,
    };
    this.pool = new ReasonixPool(this.dependencies.config, callbacks);
  }

  taskIdForSession(sessionId: string): string | undefined {
    return this.sessionToTask.get(sessionId);
  }

  beginProvision(taskId: string): void {
    void this.provisionTask(taskId).catch(async (error: unknown) => {
      if (error instanceof BridgeError && error.code === 'ownership_ambiguous') return;
      await this.failTask(taskId, error);
    });
  }

  beginResume(task: TaskRecord): void {
    void this.resumeTask(task).catch(async (error: unknown) => {
      if (error instanceof BridgeError && error.code === 'ownership_ambiguous') return;
      await this.failTask(task.taskId, error);
    });
  }

  workerForTask(task: TaskRecord): ReasonixProcess {
    const worker = this.taskProcesses.get(task.taskId);
    if (!worker || !task.acpSessionId || !worker.hasSession(task.acpSessionId)) {
      throw new BridgeError(
        'invalid_state',
        'Task has no live Reasonix session; inspect and resume first',
      );
    }
    return worker;
  }

  async cancelWorker(task: TaskRecord): Promise<void> {
    const worker = this.taskProcesses.get(task.taskId);
    if (worker && task.acpSessionId) {
      await worker.cancel(task.acpSessionId).catch(() => undefined);
    }
  }

  async closeWorker(task: TaskRecord): Promise<void> {
    const worker = this.taskProcesses.get(task.taskId);
    if (worker && task.acpSessionId) {
      await worker.cancel(task.acpSessionId).catch(() => undefined);
      await worker.closeSession(task.acpSessionId).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  private async failTask(taskId: string, error: unknown, phase = 'failed'): Promise<void> {
    const bridgeError = asBridgeError(error);
    let repositoryId: string | undefined;
    await this.dependencies.store.recordEvent(
      taskId,
      'task_failed',
      { code: bridgeError.code, message: bridgeError.message, details: bridgeError.details },
      (task) => {
        repositoryId = task.repository.id;
        if (!TERMINAL_STATUSES.has(task.status) && canTransition(task.status, 'failed')) {
          transitionTask(task, 'failed', phase, `${bridgeError.code}: ${bridgeError.message}`);
        }
      },
    );
    if (repositoryId) {
      await this.dependencies.collision.releaseLease(repositoryId, taskId);
    }
  }

  private async provisionTask(taskId: string): Promise<void> {
    let task = await this.dependencies.store.loadTask(taskId);
    await this.dependencies.store.recordEvent(taskId, 'provisioning_started', {}, (record) => {
      record.phase = 'creating_worktree';
    });
    const isolated = await createIsolatedWorktree(
      task.repository,
      this.dependencies.store.worktreesDir(),
      task.taskId,
      task.baseCommit,
    );
    await this.dependencies.store.recordEvent(taskId, 'worktree_created', isolated, (record) => {
      record.branch = isolated.branch;
      record.worktree = isolated.worktree;
      record.phase = 'starting_reasonix';
    });
    task = await this.dependencies.store.loadTask(taskId);
    await this.dependencies.collision.guardTask(taskId, 'before_worker_start');
    const worker = await this.pool.forRepository(
      task.repository,
      task.networkEnabled,
      task.executionProfile.workerLane,
    );
    const requestedEffort = task.executionProfile.requestedReasoningEffort;
    const session = await worker.createSession(
      taskId,
      task.worktree,
      task.networkEnabled,
      requestedEffort,
      task.executionProfile.executionTimeoutSeconds,
      task.executionProfile.workerLane,
    );
    this.sessionToTask.set(session.sessionId, taskId);
    this.taskProcesses.set(taskId, worker);
    await this.dependencies.store.recordEvent(
      taskId,
      'reasonix_session_ready',
      { sessionId: session.sessionId, status: session.status },
      (record) => {
        record.acpSessionId = session.sessionId;
        record.reasonixStatusSequence = session.status.sequence;
        record.executionProfile.effectiveReasoningEffort = session.status.effort;
        record.reasonixWorkMode = session.status.workMode;
        record.reasonixSessionMode = session.status.mode;
        record.usage = statusToUsage(session.status);
        transitionTask(record, 'running', 'goal_running');
      },
    );
    const prompt = this.workerPrompt(
      task.executionProfile.workerLane,
      taskId,
      task.contract,
      task.contractHash,
    );
    worker.prompt(session.sessionId, prompt);
  }

  private async resumeTask(task: TaskRecord): Promise<void> {
    await this.dependencies.collision.guardTask(task.taskId, 'resume');
    const worker = await this.pool.forRepository(
      task.repository,
      task.networkEnabled,
      task.executionProfile.workerLane,
    );
    if (!task.acpSessionId) {
      const requestedEffort = task.executionProfile.requestedReasoningEffort;
      const session = await worker.createSession(
        task.taskId,
        task.worktree,
        task.networkEnabled,
        requestedEffort,
        task.executionProfile.executionTimeoutSeconds,
        task.executionProfile.workerLane,
      );
      task.acpSessionId = session.sessionId;
      this.sessionToTask.set(session.sessionId, task.taskId);
      this.taskProcesses.set(task.taskId, worker);
      await this.dependencies.store.recordEvent(
        task.taskId,
        'session_recreated_before_first_prompt',
        {},
        (record) => {
          record.acpSessionId = session.sessionId;
          record.executionProfile.effectiveReasoningEffort = session.status.effort;
          record.reasonixWorkMode = session.status.workMode;
          record.reasonixSessionMode = session.status.mode;
          transitionTask(record, 'running', 'goal_running');
        },
      );
      worker.prompt(
        session.sessionId,
        this.workerPrompt(
          task.executionProfile.workerLane,
          task.taskId,
          task.contract,
          task.contractHash,
        ),
      );
      return;
    }
    const status = await worker.resumeSession(
      task.taskId,
      task.acpSessionId,
      task.worktree,
      task.networkEnabled,
      task.executionProfile.requestedReasoningEffort,
      task.executionProfile.executionTimeoutSeconds,
      task.executionProfile.workerLane,
    );
    this.sessionToTask.set(task.acpSessionId, task.taskId);
    this.taskProcesses.set(task.taskId, worker);
    await this.dependencies.store.recordEvent(
      task.taskId,
      'session_resumed',
      { status },
      (record) => {
        record.reasonixStatusSequence = status.sequence;
        record.executionProfile.effectiveReasoningEffort = status.effort;
        record.reasonixWorkMode = status.workMode;
        record.reasonixSessionMode = status.mode;
        record.usage = statusToUsage(status);
        transitionTask(record, 'running', 'goal_resuming');
      },
    );
    worker.prompt(
      task.acpSessionId,
      task.executionProfile.workerLane === 'fast'
        ? 'Resume the existing delegated edit task from persisted session and worktree state. Re-inspect current files, do not replay completed side effects, remain inside the immutable contract, and stop for Codex review when ready. Do not create plans, todos, goal sessions, AutoResearch runs, review or task skills, or subagents.'
        : 'Resume the existing delegated goal from persisted session and worktree state. Re-inspect current files, do not replay completed side effects, remain inside the immutable contract, and stop for Codex review when ready.',
    );
  }

  private async onSessionUpdate(notification: SessionNotification): Promise<void> {
    const taskId = this.sessionToTask.get(notification.sessionId);
    if (!taskId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'agent_thought_chunk') return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type !== 'text') return;
      const text = redactString(update.content.text, 16_384);
      const aggregate = `${this.messageBuffers.get(taskId) ?? ''}${text}`.slice(-64 * 1024);
      this.messageBuffers.set(taskId, aggregate);
      return;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const task = await this.dependencies.store.loadTask(taskId);
      const violation = fastLaneSessionViolation(task, update);
      if (violation) {
        await this.failFast(task, violation);
        return;
      }
      await this.dependencies.permissions.onToolCallUpdate(
        taskId,
        update.toolCallId,
        update.status,
      );
      await this.dependencies.store.recordEvent(taskId, update.sessionUpdate, redact(update));
      return;
    }
    await this.dependencies.store.recordEvent(
      taskId,
      `session_${update.sessionUpdate}`,
      redact(update),
    );
  }

  private async onStatusUpdate(update: ReasonixStatusUpdate): Promise<void> {
    const taskId = this.sessionToTask.get(update.sessionId);
    if (!taskId) return;
    const task = await this.dependencies.store.loadTask(taskId);
    if (TERMINAL_STATUSES.has(task.status)) return;
    const violation = laneViolation(task, update.status);
    if (violation) {
      await this.failFast(task, violation, update);
      return;
    }
    await this.dependencies.store.recordEvent(
      taskId,
      `reasonix_${update.event}`,
      update,
      (task) => {
        if (update.sequence <= task.reasonixStatusSequence) return;
        if (TERMINAL_STATUSES.has(task.status)) return;
        task.reasonixStatusSequence = update.sequence;
        task.executionProfile.effectiveReasoningEffort = update.status.effort;
        task.reasonixWorkMode = update.status.workMode;
        task.reasonixSessionMode = update.status.mode;
        task.phase = update.status.phase;
        task.usage = statusToUsage(update.status);
        task.summary = update.status.finalReadiness.summary || task.summary;
        task.risks = [...update.status.finalReadiness.risks];
        if (update.event === 'pause' && canTransition(task.status, 'paused')) {
          enterPaused(task, update.status.phase, update.status.turnOutcome.reason);
        }
      },
    );
  }

  /** Cancels the worker and fails the task on a fast-lane policy violation. */
  private async failFast(
    task: TaskRecord,
    violation: string,
    update?: ReasonixStatusUpdate,
  ): Promise<void> {
    await this.dependencies.store.recordEvent(
      task.taskId,
      'lane_policy_violation',
      { violation, status: update?.status },
      (record) => {
        if (!TERMINAL_STATUSES.has(record.status) && canTransition(record.status, 'failed')) {
          transitionTask(record, 'failed', 'lane_policy_violation', violation);
        }
      },
    );
    await this.cancelWorker(task);
    await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
  }

  private async onPromptComplete(
    sessionId: string,
    response: PromptResponse | undefined,
    status: ReasonixStatus | undefined,
    error?: unknown,
  ): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return;
    await this.flushMessage(taskId);
    await this.dependencies.permissions.finishPrompt(taskId);
    try {
      await this.dependencies.collision.guardTask(taskId, 'review_readiness');
    } catch (collision) {
      if (collision instanceof BridgeError && collision.code === 'ownership_ambiguous') {
        const task = await this.dependencies.store.loadTask(taskId);
        await this.cancelWorker(task);
        return;
      }
      throw collision;
    }
    if (error || !status) {
      await this.failTask(
        taskId,
        error ?? new BridgeError('reasonix_incompatible', 'Reasonix omitted final status snapshot'),
        'prompt_failed',
      );
      return;
    }
    const taskSnapshot = await this.dependencies.store.loadTask(taskId);
    if (status.effort !== taskSnapshot.executionProfile.requestedReasoningEffort) {
      await this.failTask(
        taskId,
        new BridgeError(
          'reasonix_incompatible',
          'Reasonix effective reasoning effort changed unexpectedly',
          {
            requestedEffort: taskSnapshot.executionProfile.requestedReasoningEffort,
            effectiveEffort: status.effort,
          },
        ),
        'prompt_failed',
      );
      return;
    }
    const violation = laneViolation(taskSnapshot, status);
    if (violation) {
      await this.failFast(taskSnapshot, violation, {
        schemaVersion: 1,
        sequence: status.sequence,
        sessionId,
        event: 'completion',
        status,
      } satisfies ReasonixStatusUpdate);
      return;
    }
    const disposition = reasonixCompletionDisposition(response, status);
    let reviewTree: string | undefined;
    if (disposition === 'review_required') {
      try {
        reviewTree = await canonicalWorktreeTree(taskSnapshot.worktree, taskSnapshot.baseCommit);
      } catch (captureError) {
        await this.failTask(
          taskId,
          new BridgeError(
            'reasonix_incompatible',
            'Unable to capture the canonical review tree before review',
            {
              cause: captureError instanceof Error ? captureError.message : String(captureError),
            },
          ),
          'prompt_failed',
        );
        return;
      }
    }
    let release = false;
    await this.dependencies.store.recordEvent(
      taskId,
      'prompt_finished',
      { response, status },
      (task) => {
        if (status.sequence > task.reasonixStatusSequence) {
          task.reasonixStatusSequence = status.sequence;
          task.executionProfile.effectiveReasoningEffort = status.effort;
          task.reasonixWorkMode = status.workMode;
          task.reasonixSessionMode = status.mode;
          task.usage = statusToUsage(status);
        }
        task.summary = status.finalReadiness.summary || task.summary;
        task.risks = [...status.finalReadiness.risks];
        task.repairActive = false;
        if (disposition === 'review_required') {
          if (canTransition(task.status, 'review_required')) {
            task.reviewTreeHash = reviewTree;
            task.reviewRevision = (task.reviewRevision ?? 0) + 1;
            transitionTask(task, 'review_required', 'codex_review');
          }
        } else if (disposition === 'cancelled') {
          if (canTransition(task.status, 'cancelled')) {
            transitionTask(task, 'cancelled', 'cancelled');
          }
          release = true;
        } else if (disposition === 'failed') {
          if (canTransition(task.status, 'failed')) {
            transitionTask(task, 'failed', 'reasonix_error', status.turnOutcome.reason);
          }
          release = true;
        } else if (canTransition(task.status, 'paused')) {
          enterPaused(task, status.phase, status.turnOutcome.reason ?? 'Goal is not review-ready');
        }
      },
    );
    if (release) {
      const task = await this.dependencies.store.loadTask(taskId);
      await this.dependencies.collision.releaseLease(task.repository.id, taskId);
    }
  }

  private async onProcessError(sessionIds: string[], error: unknown): Promise<void> {
    for (const sessionId of sessionIds) {
      const taskId = this.sessionToTask.get(sessionId);
      if (!taskId) continue;
      await this.flushMessage(taskId);
      await this.dependencies.store.recordEvent(
        taskId,
        'reasonix_process_crashed',
        { error: String(error) },
        (task) => {
          if (!TERMINAL_STATUSES.has(task.status) && canTransition(task.status, 'paused')) {
            enterPaused(task, 'worker_crashed', 'Reasonix process exited; inspect before resume');
          }
        },
      );
      const task = await this.dependencies.store.loadTask(taskId);
      await this.dependencies.collision.releaseLease(task.repository.id, taskId);
      this.taskProcesses.delete(taskId);
      this.sessionToTask.delete(sessionId);
    }
  }

  private workerPrompt(
    lane: 'fast' | 'deep',
    taskId: string,
    contract: TaskRecord['contract'],
    hash: string,
  ): string {
    if (lane === 'fast') {
      return [
        'Your responsibility is limited to editing the isolated worktree for this task.',
        'The bridge owns scope scanning, acceptance verification, staging, and commit creation.',
        'Do not create commits, modify the source checkout, or claim that verification/commit is complete.',
        renderFastPrompt(taskId, contract, hash),
      ].join('\n\n');
    }
    return [
      'Your responsibility is limited to editing the isolated worktree for this task.',
      'The bridge owns scope scanning, acceptance verification, staging, and commit creation.',
      'Do not create commits, modify the source checkout, or claim that verification/commit is complete.',
      renderGoalPrompt(taskId, contract, hash),
    ].join('\n\n');
  }

  private async flushMessage(taskId: string): Promise<void> {
    const text = this.messageBuffers.get(taskId);
    if (!text) return;
    this.messageBuffers.delete(taskId);
    await this.dependencies.store.recordEvent(taskId, 'agent_message', { text }, (task) => {
      task.finalMessage = text;
      task.summary = text;
    });
  }
}
