import { randomUUID } from 'node:crypto';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

import type { BridgeConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { canTransition, transitionTask } from '../lifecycle.js';
import { decidePermission } from '../policy.js';
import { redact } from '../redaction.js';
import {
  assertChangedFilesInScope,
  assertFileSizes,
  assertNoWorkerCommits,
  changedFiles,
} from '../repository.js';
import { scanWorkingFiles } from '../security.js';
import type { StateStore } from '../state.js';
import type { InteractionRecord, TaskRecord } from '../types.js';
import type { ControlInput } from './api.js';
import type { SourceCollisionAccess } from './collision.js';
import { now, taskView } from './shared.js';

interface PendingInteraction {
  taskId: string;
  canAllow: boolean;
  params: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

export interface PermissionDependencies {
  config: BridgeConfig;
  store: StateStore;
  taskIdForSession(sessionId: string): string | undefined;
  cancelSession(task: TaskRecord): Promise<void>;
  steerRecovery(task: TaskRecord, message: string): Promise<void>;
  collision: Pick<SourceCollisionAccess, 'guardTask'>;
}

export interface PermissionAccess {
  onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onToolCallUpdate(
    taskId: string,
    toolCallId: string,
    status: string | null | undefined,
  ): Promise<void>;
  finishPrompt(taskId: string): Promise<void>;
  respond(
    task: TaskRecord,
    input: Extract<ControlInput, { action: 'respond' }>,
  ): Promise<Record<string, unknown>>;
  cancelTaskInteractions(taskId: string): void;
  cancelAllInteractions(): void;
}

interface ActiveCommand {
  taskId: string;
  toolCallId: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}

interface DenialLoop {
  count: number;
  recoverySent: boolean;
}

/** Runs the mandatory post-command checks without changing task state. */
export async function scanTaskAfterCommand(
  task: TaskRecord,
  config: BridgeConfig,
): Promise<string[]> {
  await assertNoWorkerCommits(task.worktree, task.baseCommit);
  const files = await changedFiles(task.worktree);
  await assertChangedFilesInScope(task.worktree, task.contract, files);
  await assertFileSizes(task.worktree, files, config);
  await scanWorkingFiles(task.worktree, files, config);
  return files;
}

function permissionSelection(
  params: RequestPermissionRequest,
  kind: 'allow' | 'reject',
): RequestPermissionResponse {
  const desired =
    kind === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const option = params.options.find((candidate) => desired.includes(candidate.kind));
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

export class PermissionController implements PermissionAccess {
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly activeCommands = new Map<string, ActiveCommand>();
  private readonly denialLoops = new Map<string, DenialLoop>();

  constructor(private readonly dependencies: PermissionDependencies) {}

  private commandKey(taskId: string, toolCallId: string): string {
    return `${taskId}\0${toolCallId}`;
  }

  private denialKey(taskId: string, fingerprint: string): string {
    return `${taskId}\0${fingerprint}`;
  }

  private defer(operation: () => Promise<void>): void {
    setImmediate(() => {
      void operation().catch(() => undefined);
    });
  }

  private async pauseTask(
    taskId: string,
    phase: string,
    reason: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<TaskRecord> {
    const task = await this.dependencies.store.recordEvent(taskId, event, data, (record) => {
      if (canTransition(record.status, 'paused')) {
        transitionTask(record, 'paused', phase, reason);
        record.inspectedAfterPause = false;
      }
    });
    this.clearTaskCommands(taskId);
    return task;
  }

  private startCommandWatchdog(task: TaskRecord, toolCallId: string, timeoutSeconds: number): void {
    const key = this.commandKey(task.taskId, toolCallId);
    this.clearCommand(key);
    const timer = setTimeout(() => {
      this.activeCommands.delete(key);
      void this.pauseTask(
        task.taskId,
        'command_timeout',
        `Command watchdog timed out after ${String(timeoutSeconds)} seconds`,
        'command_timeout',
        { toolCallId, timeoutSeconds },
      )
        .then(async (current) => await this.dependencies.cancelSession(current))
        .catch(() => undefined);
    }, timeoutSeconds * 1_000);
    timer.unref();
    this.activeCommands.set(key, {
      taskId: task.taskId,
      toolCallId,
      startedAt: Date.now(),
      timer,
    });
  }

  private clearCommand(key: string): ActiveCommand | undefined {
    const active = this.activeCommands.get(key);
    if (!active) return undefined;
    clearTimeout(active.timer);
    this.activeCommands.delete(key);
    return active;
  }

  private clearTaskCommands(taskId: string): void {
    for (const [key, command] of this.activeCommands) {
      if (command.taskId === taskId) this.clearCommand(key);
    }
  }

  private clearTaskDenials(taskId: string): void {
    const prefix = `${taskId}\0`;
    for (const key of this.denialLoops.keys()) {
      if (key.startsWith(prefix)) this.denialLoops.delete(key);
    }
  }

  async onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const taskId = this.dependencies.taskIdForSession(params.sessionId);
    if (!taskId) return { outcome: { outcome: 'cancelled' } };
    const task = await this.dependencies.store.loadTask(taskId);
    const decision = await decidePermission(params, task.contract, task.worktree);
    if (decision.action === 'allow') {
      try {
        await this.dependencies.collision.guardTask(taskId, 'before_worker_mutation');
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'ownership_ambiguous') throw error;
        this.defer(async () => await this.dependencies.cancelSession(task));
        return permissionSelection(params, 'reject');
      }
      await this.dependencies.store.recordEvent(taskId, 'permission_auto_allowed', {
        toolCallId: params.toolCall.toolCallId,
        reason: decision.reason,
      });
      if (params.toolCall.kind === 'execute' && decision.timeoutSeconds !== undefined) {
        this.startCommandWatchdog(task, params.toolCall.toolCallId, decision.timeoutSeconds);
      }
      return { outcome: { outcome: 'selected', optionId: decision.optionId } };
    }
    if (decision.action === 'deny') {
      const denialKey = this.denialKey(taskId, decision.fingerprint);
      const loop = this.denialLoops.get(denialKey) ?? { count: 0, recoverySent: false };
      loop.count += 1;
      this.denialLoops.set(denialKey, loop);
      await this.dependencies.store.recordEvent(taskId, 'permission_auto_denied', {
        toolCallId: params.toolCall.toolCallId,
        reason: decision.reason,
        fingerprint: decision.fingerprint,
        occurrence: loop.count,
      });
      if (!loop.recoverySent) {
        loop.recoverySent = true;
        await this.dependencies.store.recordEvent(taskId, 'permission_recovery_scheduled', {
          fingerprint: decision.fingerprint,
        });
        this.defer(async () => {
          const current = await this.dependencies.store.loadTask(taskId);
          await this.dependencies.steerRecovery(
            current,
            `The previous tool request was rejected by immutable bridge policy: ${decision.reason} ${decision.recoveryHint}`,
          );
        });
      }
      if (loop.count >= 3) {
        const paused = await this.pauseTask(
          taskId,
          'repeated_policy_denial',
          'Third identical immutable policy denial in one prompt; turn cancelled',
          'permission_denial_loop_stopped',
          { fingerprint: decision.fingerprint, occurrence: loop.count },
        );
        this.defer(async () => await this.dependencies.cancelSession(paused));
      }
      return decision.optionId
        ? { outcome: { outcome: 'selected', optionId: decision.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }

    const interactionId = `${taskId}-${randomUUID()}`;
    const interaction: InteractionRecord = {
      id: interactionId,
      kind: decision.interactionKind,
      status: 'pending',
      createdAt: now(),
      request: redact({
        toolCall: params.toolCall,
        options: params.options,
        reason: decision.reason,
        canAllow: decision.canAllow,
      }) as Record<string, unknown>,
    };
    await this.dependencies.store.recordEvent(
      taskId,
      'interaction_waiting',
      interaction,
      (record) => {
        record.interactions.push(interaction);
        transitionTask(
          record,
          decision.interactionKind === 'input' ? 'waiting_input' : 'waiting_permission',
          'interaction_waiting',
          decision.reason,
        );
      },
    );
    return await new Promise<RequestPermissionResponse>((resolve) => {
      this.interactions.set(interactionId, {
        taskId,
        canAllow: decision.canAllow,
        params,
        resolve,
      });
    });
  }

  async onToolCallUpdate(
    taskId: string,
    toolCallId: string,
    status: string | null | undefined,
  ): Promise<void> {
    if (status !== 'completed' && status !== 'failed') return;
    const active = this.clearCommand(this.commandKey(taskId, toolCallId));
    const durationMs = active ? Date.now() - active.startedAt : undefined;
    try {
      await this.dependencies.collision.guardTask(taskId, 'after_worker_mutation');
      const task = await this.dependencies.store.loadTask(taskId);
      const files = await scanTaskAfterCommand(task, this.dependencies.config);
      await this.dependencies.store.recordEvent(taskId, 'command_postflight_passed', {
        toolCallId,
        status,
        durationMs,
        changedFiles: files,
      });
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'ownership_ambiguous') {
        const paused = await this.dependencies.store.loadTask(taskId);
        await this.dependencies.cancelSession(paused);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const paused = await this.pauseTask(
        taskId,
        'command_postflight_failed',
        `Post-command safety scan failed: ${reason}`,
        'command_postflight_failed',
        { toolCallId, status, durationMs, reason },
      );
      await this.dependencies.cancelSession(paused);
    }
  }

  async finishPrompt(taskId: string): Promise<void> {
    const commands = [...this.activeCommands.values()].filter((item) => item.taskId === taskId);
    for (const command of commands) {
      await this.onToolCallUpdate(taskId, command.toolCallId, 'failed');
    }
    this.clearTaskDenials(taskId);
  }

  async respond(
    task: TaskRecord,
    input: Extract<ControlInput, { action: 'respond' }>,
  ): Promise<Record<string, unknown>> {
    const pending = this.interactions.get(input.interaction_id);
    if (!pending || pending.taskId !== task.taskId) {
      throw new BridgeError(
        'interaction_not_found',
        `Unknown pending interaction: ${input.interaction_id}`,
      );
    }
    if (input.decision === 'allow' && !pending.canAllow) {
      throw new BridgeError(
        'invalid_request',
        'This interaction cannot override immutable scope, Git, credential, network, or destructive-command policy',
      );
    }
    let response: RequestPermissionResponse;
    if (input.decision === 'deny') {
      response = permissionSelection(pending.params, 'reject');
    } else if (input.option_id || input.answer) {
      const selected = pending.params.options.find(
        (option) => option.optionId === input.option_id || option.name === input.answer,
      );
      if (!selected)
        throw new BridgeError('invalid_request', 'Response does not match an offered option');
      response = { outcome: { outcome: 'selected', optionId: selected.optionId } };
    } else {
      response = permissionSelection(pending.params, 'allow');
    }
    this.interactions.delete(input.interaction_id);
    await this.dependencies.store.recordEvent(
      task.taskId,
      'interaction_resolved',
      { id: input.interaction_id },
      (record) => {
        const interaction = record.interactions.find((item) => item.id === input.interaction_id);
        if (interaction) {
          interaction.status = 'resolved';
          interaction.resolvedAt = now();
          interaction.response = redact({
            decision: input.decision,
            optionId: input.option_id,
          }) as Record<string, unknown>;
        }
        if (record.status === 'waiting_input' || record.status === 'waiting_permission') {
          transitionTask(record, 'running', 'goal_running');
        }
      },
    );
    pending.resolve(response);
    return taskView(await this.dependencies.store.loadTask(task.taskId));
  }

  cancelTaskInteractions(taskId: string): void {
    for (const [id, interaction] of this.interactions) {
      if (interaction.taskId !== taskId) continue;
      interaction.resolve({ outcome: { outcome: 'cancelled' } });
      this.interactions.delete(id);
    }
    this.clearTaskCommands(taskId);
    this.clearTaskDenials(taskId);
  }

  cancelAllInteractions(): void {
    for (const interaction of this.interactions.values()) {
      interaction.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.interactions.clear();
    for (const key of this.activeCommands.keys()) this.clearCommand(key);
    this.denialLoops.clear();
  }
}
