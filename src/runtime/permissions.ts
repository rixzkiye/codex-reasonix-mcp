import { randomUUID } from 'node:crypto';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

import { BridgeError } from '../errors.js';
import { transitionTask } from '../lifecycle.js';
import { decidePermission } from '../policy.js';
import { redact } from '../redaction.js';
import type { StateStore } from '../state.js';
import type { InteractionRecord, TaskRecord } from '../types.js';
import type { ControlInput } from './api.js';
import { now, taskView } from './shared.js';

interface PendingInteraction {
  taskId: string;
  canAllow: boolean;
  params: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

export interface PermissionDependencies {
  store: StateStore;
  taskIdForSession(sessionId: string): string | undefined;
}

export interface PermissionAccess {
  onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  respond(
    task: TaskRecord,
    input: Extract<ControlInput, { action: 'respond' }>,
  ): Promise<Record<string, unknown>>;
  cancelTaskInteractions(taskId: string): void;
  cancelAllInteractions(): void;
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

  constructor(private readonly dependencies: PermissionDependencies) {}

  async onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const taskId = this.dependencies.taskIdForSession(params.sessionId);
    if (!taskId) return { outcome: { outcome: 'cancelled' } };
    const task = await this.dependencies.store.loadTask(taskId);
    const decision = await decidePermission(params, task.contract, task.worktree);
    if (decision.action === 'allow') {
      await this.dependencies.store.recordEvent(taskId, 'permission_auto_allowed', {
        toolCallId: params.toolCall.toolCallId,
        reason: decision.reason,
      });
      return { outcome: { outcome: 'selected', optionId: decision.optionId } };
    }
    if (decision.action === 'deny') {
      await this.dependencies.store.recordEvent(taskId, 'permission_auto_denied', {
        toolCallId: params.toolCall.toolCallId,
        reason: decision.reason,
      });
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
  }

  cancelAllInteractions(): void {
    for (const interaction of this.interactions.values()) {
      interaction.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.interactions.clear();
  }
}
