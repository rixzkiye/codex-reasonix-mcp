import type {
  PromptResponse,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import { ReasonixPool, type ReasonixCallbacks, type ReasonixProcess } from '../acp.js';
import type { BridgeConfig } from '../config.js';
import { renderGoalPrompt } from '../contracts.js';
import { BridgeError, asBridgeError } from '../errors.js';
import { canTransition, transitionTask } from '../lifecycle.js';
import type { ReasonixStatus, ReasonixStatusUpdate } from '../reasonix-status.js';
import { redact, redactString } from '../redaction.js';
import { createIsolatedWorktree } from '../repository.js';
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

export class SessionSupervisor implements SessionAccess {
  private readonly pool: ReasonixPool;
  private readonly sessionToTask = new Map<string, string>();
  private readonly taskProcesses = new Map<string, ReasonixProcess>();

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
    const worker = await this.pool.forRepository(task.repository, task.networkEnabled);
    const session = await worker.createSession(taskId, task.worktree, task.networkEnabled);
    this.sessionToTask.set(session.sessionId, taskId);
    this.taskProcesses.set(taskId, worker);
    await this.dependencies.store.recordEvent(
      taskId,
      'reasonix_session_ready',
      { sessionId: session.sessionId, status: session.status },
      (record) => {
        record.acpSessionId = session.sessionId;
        record.reasonixStatusSequence = session.status.sequence;
        record.usage = statusToUsage(session.status);
        transitionTask(record, 'running', 'goal_running');
      },
    );
    const prompt = renderGoalPrompt(taskId, task.contract, task.contractHash);
    worker.prompt(session.sessionId, prompt);
  }

  private async resumeTask(task: TaskRecord): Promise<void> {
    await this.dependencies.collision.guardTask(task.taskId, 'resume');
    const worker = await this.pool.forRepository(task.repository, task.networkEnabled);
    if (!task.acpSessionId) {
      const session = await worker.createSession(task.taskId, task.worktree, task.networkEnabled);
      task.acpSessionId = session.sessionId;
      this.sessionToTask.set(session.sessionId, task.taskId);
      this.taskProcesses.set(task.taskId, worker);
      await this.dependencies.store.recordEvent(
        task.taskId,
        'session_recreated_before_first_prompt',
        {},
        (record) => {
          record.acpSessionId = session.sessionId;
          transitionTask(record, 'running', 'goal_running');
        },
      );
      worker.prompt(
        session.sessionId,
        renderGoalPrompt(task.taskId, task.contract, task.contractHash),
      );
      return;
    }
    const status = await worker.resumeSession(
      task.taskId,
      task.acpSessionId,
      task.worktree,
      task.networkEnabled,
    );
    this.sessionToTask.set(task.acpSessionId, task.taskId);
    this.taskProcesses.set(task.taskId, worker);
    await this.dependencies.store.recordEvent(
      task.taskId,
      'session_resumed',
      { status },
      (record) => {
        record.reasonixStatusSequence = status.sequence;
        record.usage = statusToUsage(status);
        transitionTask(record, 'running', 'goal_resuming');
      },
    );
    worker.prompt(
      task.acpSessionId,
      'Resume the existing delegated goal from persisted session and worktree state. Re-inspect current files, do not replay completed side effects, remain inside the immutable contract, and stop for Codex review when ready.',
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
      await this.dependencies.store.recordEvent(taskId, 'agent_message', { text }, (task) => {
        task.finalMessage = `${task.finalMessage ?? ''}${text}`.slice(-64 * 1024);
        task.summary = task.finalMessage;
      });
      return;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
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
    await this.dependencies.store.recordEvent(
      taskId,
      `reasonix_${update.event}`,
      update,
      (task) => {
        if (update.sequence <= task.reasonixStatusSequence) return;
        task.reasonixStatusSequence = update.sequence;
        task.phase = update.status.phase;
        task.usage = statusToUsage(update.status);
        task.summary = update.status.finalReadiness.summary || task.summary;
        task.risks = [...update.status.finalReadiness.risks];
        if (update.event === 'pause' && canTransition(task.status, 'paused')) {
          transitionTask(task, 'paused', update.status.phase, update.status.turnOutcome.reason);
          task.inspectedAfterPause = false;
        }
      },
    );
  }

  private async onPromptComplete(
    sessionId: string,
    response: PromptResponse | undefined,
    status: ReasonixStatus | undefined,
    error?: unknown,
  ): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return;
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
    let release = false;
    await this.dependencies.store.recordEvent(
      taskId,
      'prompt_finished',
      { response, status },
      (task) => {
        if (status.sequence > task.reasonixStatusSequence) {
          task.reasonixStatusSequence = status.sequence;
          task.usage = statusToUsage(status);
        }
        task.summary = status.finalReadiness.summary || task.summary;
        task.risks = [...status.finalReadiness.risks];
        task.repairActive = false;
        if (
          status.finalReadiness.readyForReview ||
          status.goal.status === 'complete' ||
          (response?.stopReason === 'end_turn' && status.turnOutcome.kind === 'completed')
        ) {
          if (canTransition(task.status, 'review_required')) {
            transitionTask(task, 'review_required', 'codex_review');
          }
        } else if (status.goal.status === 'cancelled' || response?.stopReason === 'cancelled') {
          if (canTransition(task.status, 'cancelled')) {
            transitionTask(task, 'cancelled', 'cancelled');
          }
          release = true;
        } else if (status.goal.status === 'failed' || status.turnOutcome.kind === 'error') {
          if (canTransition(task.status, 'failed')) {
            transitionTask(task, 'failed', 'reasonix_error', status.turnOutcome.reason);
          }
          release = true;
        } else if (canTransition(task.status, 'paused')) {
          transitionTask(
            task,
            'paused',
            status.phase,
            status.turnOutcome.reason ?? 'Goal is not review-ready',
          );
          task.inspectedAfterPause = false;
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
      await this.dependencies.store.recordEvent(
        taskId,
        'reasonix_process_crashed',
        { error: String(error) },
        (task) => {
          if (!TERMINAL_STATUSES.has(task.status) && canTransition(task.status, 'paused')) {
            transitionTask(
              task,
              'paused',
              'worker_crashed',
              'Reasonix process exited; inspect before resume',
            );
            task.inspectedAfterPause = false;
          }
        },
      );
      const task = await this.dependencies.store.loadTask(taskId);
      await this.dependencies.collision.releaseLease(task.repository.id, taskId);
      this.taskProcesses.delete(taskId);
      this.sessionToTask.delete(sessionId);
    }
  }
}
