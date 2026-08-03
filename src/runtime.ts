import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import { ReasonixPool, type ReasonixCallbacks, type ReasonixProcess } from './acp.js';
import type { BridgeConfig } from './config.js';
import { configFingerprint } from './config.js';
import {
  contractHash,
  parseTaskContract,
  renderGoalPrompt,
  type TaskContractV1,
} from './contracts.js';
import { BridgeError, asBridgeError } from './errors.js';
import { acquireLease, type Lease } from './lease.js';
import { canTransition, transitionTask } from './lifecycle.js';
import { CursorCodec, paginateText } from './pagination.js';
import { decidePermission } from './policy.js';
import { redact, redactString } from './redaction.js';
import {
  assertChangedFilesInScope,
  assertFileSizes,
  assertNoWorkerCommits,
  assertSourceClean,
  assertStagedChecks,
  changedFiles,
  createAtomicCommit,
  createIsolatedWorktree,
  defaultCommitMessage,
  diffStat,
  discoverRepository,
  resolveBaseCommit,
  stageExplicitFiles,
  stagedDiff,
  validateCommitMessage,
  validateTaskId,
  workingDiff,
} from './repository.js';
import type { ReasonixStatus, ReasonixStatusUpdate } from './reasonix-status.js';
import { parseSandboxContext } from './sandbox.js';
import { evidenceHash, scanStagedFiles, scanWorkingFiles } from './security.js';
import { StateStore } from './state.js';
import {
  EMPTY_USAGE,
  TERMINAL_STATUSES,
  type AcceptanceEvidence,
  type InteractionRecord,
  type RepositoryIdentity,
  type TaskRecord,
} from './types.js';
import { runAllVerification } from './verification.js';

export interface DelegateInput {
  task_id: string;
  contract: unknown;
  base_ref?: string;
  resume?: boolean;
}

export type ControlInput =
  | { task_id: string; action: 'steer'; message: string }
  | {
      task_id: string;
      action: 'respond';
      interaction_id: string;
      decision: 'allow' | 'deny';
      option_id?: string;
      answer?: string;
    }
  | { task_id: string; action: 'cancel' }
  | {
      task_id: string;
      action: 'finalize';
      review_summary: string;
      approved_review_criteria: string[];
      commit_message?: string;
    }
  | { task_id: string; action: 'close' };

export const INSPECT_SECTIONS = [
  'status',
  'summary',
  'changed_files',
  'diff_stat',
  'diff',
  'verification',
  'acceptance_evidence',
  'risks',
  'usage',
  'interactions',
  'events',
] as const;

export type InspectSection = (typeof INSPECT_SECTIONS)[number];

export interface InspectInput {
  task_id: string;
  include?: InspectSection[];
  wait_ms?: number;
  cursor?: string;
  max_bytes?: number;
}

interface PendingInteraction {
  taskId: string;
  canAllow: boolean;
  params: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

interface RepositoryLease {
  lease: Lease;
  tasks: Set<string>;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function taskView(task: TaskRecord): Record<string, unknown> {
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

function statusToUsage(status: ReasonixStatus): TaskRecord['usage'] {
  return { ...status.usage.cumulative };
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new BridgeError(
      'unsupported_platform',
      'Native Windows is unsupported in v1; run codex-reasonix-mcp inside WSL',
    );
  }
}

export class BridgeRuntime {
  readonly store: StateStore;
  private cursor!: CursorCodec;
  private readonly pool: ReasonixPool;
  private readonly sessionToTask = new Map<string, string>();
  private readonly taskProcesses = new Map<string, ReasonixProcess>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly leases = new Map<string, RepositoryLease>();
  private readonly leaseAcquisitions = new Map<string, Promise<RepositoryLease>>();
  private readonly finalizationAbort = new Map<string, AbortController>();
  private readonly finalizationTasks = new Map<string, Promise<void>>();

  constructor(readonly config: BridgeConfig) {
    this.store = new StateStore(config.stateDir);
    const callbacks: ReasonixCallbacks = {
      onPermission: async (params) => await this.onPermission(params),
      onSessionUpdate: async (notification) => await this.onSessionUpdate(notification),
      onStatusUpdate: async (update) => await this.onStatusUpdate(update),
      onPromptComplete: async (sessionId, response, status, error) =>
        await this.onPromptComplete(sessionId, response, status, error),
      onProcessError: async (sessionIds, error) => await this.onProcessError(sessionIds, error),
      onOperationalLog: () => undefined,
    };
    this.pool = new ReasonixPool(config, callbacks);
  }

  async initialize(): Promise<string[]> {
    await this.store.initialize();
    this.cursor = await CursorCodec.create(this.store.root);
    return await this.store.recoverInterruptedTasks();
  }

  private assertPlatform(): void {
    assertSupportedPlatform();
  }

  private async holdLease(repository: RepositoryIdentity, taskId: string): Promise<void> {
    const existing = this.leases.get(repository.id);
    if (existing) {
      existing.tasks.add(taskId);
      return;
    }

    let acquisition = this.leaseAcquisitions.get(repository.id);
    if (!acquisition) {
      acquisition = acquireLease(
        this.store.locksDir(),
        `repo-${repository.id}`,
        this.config.leaseStaleMs,
        this.config.leaseHeartbeatMs,
      ).then((lease) => {
        const held = { lease, tasks: new Set<string>() };
        this.leases.set(repository.id, held);
        return held;
      });
      this.leaseAcquisitions.set(repository.id, acquisition);
    }

    try {
      const held = await acquisition;
      held.tasks.add(taskId);
    } finally {
      if (this.leaseAcquisitions.get(repository.id) === acquisition) {
        this.leaseAcquisitions.delete(repository.id);
      }
    }
  }

  private async releaseLease(repositoryId: string, taskId: string): Promise<void> {
    const held = this.leases.get(repositoryId);
    if (!held) return;
    held.tasks.delete(taskId);
    if (held.tasks.size === 0) {
      this.leases.delete(repositoryId);
      await held.lease.release();
    }
  }

  private async failTask(taskId: string, error: unknown, phase = 'failed'): Promise<void> {
    const bridgeError = asBridgeError(error);
    let repositoryId: string | undefined;
    await this.store.recordEvent(
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
    if (repositoryId) await this.releaseLease(repositoryId, taskId);
  }

  async delegate(input: DelegateInput, requestMeta: unknown): Promise<Record<string, unknown>> {
    this.assertPlatform();
    const taskId = validateTaskId(input.task_id);
    const sandbox = parseSandboxContext(requestMeta);
    const contract = parseTaskContract(input.contract);
    const hash = contractHash(contract);
    const repository = await discoverRepository(sandbox.cwd);

    if (await this.store.exists(taskId)) {
      const existing = await this.store.loadTask(taskId);
      if (existing.repository.id !== repository.id || existing.contractHash !== hash) {
        throw new BridgeError(
          'task_conflict',
          'task_id already belongs to a different repository or contract hash',
        );
      }
      if (input.base_ref) {
        const requestedBase = await resolveBaseCommit(repository, input.base_ref.trim());
        if (requestedBase !== existing.baseCommit) {
          throw new BridgeError(
            'task_conflict',
            'Explicit base_ref differs from the existing task',
          );
        }
      }
      if (existing.status === 'paused' && input.resume !== false) {
        if (!existing.inspectedAfterPause) {
          return { ...taskView(existing), resume_required: true, inspect_required: true };
        }
        const currentNetworkEnabled = this.config.networkEnabled && sandbox.networkEnabled;
        const currentFingerprint = configFingerprint({
          ...this.config,
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
        await this.holdLease(repository, taskId);
        void this.resumeTask(existing).catch(
          async (error: unknown) => await this.failTask(taskId, error),
        );
      }
      return taskView(await this.store.loadTask(taskId));
    }

    await assertSourceClean(repository);
    const baseRef = input.base_ref?.trim() || 'HEAD';
    const baseCommit = await resolveBaseCommit(repository, baseRef);
    await this.holdLease(repository, taskId);
    const createdAt = now();
    const worktree = path.join(this.store.worktreesDir(), repository.id, taskId);
    const networkEnabled = this.config.networkEnabled && sandbox.networkEnabled;
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
      processFingerprint: configFingerprint({ ...this.config, networkEnabled }),
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
      await this.store.createTask(record);
    } catch (error) {
      await this.releaseLease(repository.id, taskId);
      throw error;
    }
    void this.provisionTask(taskId).catch(
      async (error: unknown) => await this.failTask(taskId, error),
    );
    return taskView(await this.store.loadTask(taskId));
  }

  private async provisionTask(taskId: string): Promise<void> {
    let task = await this.store.loadTask(taskId);
    await this.store.recordEvent(taskId, 'provisioning_started', {}, (record) => {
      record.phase = 'creating_worktree';
    });
    const isolated = await createIsolatedWorktree(
      task.repository,
      this.store.worktreesDir(),
      task.taskId,
      task.baseCommit,
    );
    await this.store.recordEvent(taskId, 'worktree_created', isolated, (record) => {
      record.branch = isolated.branch;
      record.worktree = isolated.worktree;
      record.phase = 'starting_reasonix';
    });
    task = await this.store.loadTask(taskId);
    const worker = await this.pool.forRepository(task.repository, task.networkEnabled);
    const session = await worker.createSession(taskId, task.worktree, task.networkEnabled);
    this.sessionToTask.set(session.sessionId, taskId);
    this.taskProcesses.set(taskId, worker);
    await this.store.recordEvent(
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
    const worker = await this.pool.forRepository(task.repository, task.networkEnabled);
    if (!task.acpSessionId) {
      const session = await worker.createSession(task.taskId, task.worktree, task.networkEnabled);
      task.acpSessionId = session.sessionId;
      this.sessionToTask.set(session.sessionId, task.taskId);
      this.taskProcesses.set(task.taskId, worker);
      await this.store.recordEvent(
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
    await this.store.recordEvent(task.taskId, 'session_resumed', { status }, (record) => {
      record.reasonixStatusSequence = status.sequence;
      record.usage = statusToUsage(status);
      transitionTask(record, 'running', 'goal_resuming');
    });
    worker.prompt(
      task.acpSessionId,
      'Resume the existing delegated goal from persisted session and worktree state. Re-inspect current files, do not replay completed side effects, remain inside the immutable contract, and stop for Codex review when ready.',
    );
  }

  private async onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const taskId = this.sessionToTask.get(params.sessionId);
    if (!taskId) return { outcome: { outcome: 'cancelled' } };
    const task = await this.store.loadTask(taskId);
    const decision = await decidePermission(params, task.contract, task.worktree);
    if (decision.action === 'allow') {
      await this.store.recordEvent(taskId, 'permission_auto_allowed', {
        toolCallId: params.toolCall.toolCallId,
        reason: decision.reason,
      });
      return { outcome: { outcome: 'selected', optionId: decision.optionId } };
    }
    if (decision.action === 'deny') {
      await this.store.recordEvent(taskId, 'permission_auto_denied', {
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
    await this.store.recordEvent(taskId, 'interaction_waiting', interaction, (record) => {
      record.interactions.push(interaction);
      transitionTask(
        record,
        decision.interactionKind === 'input' ? 'waiting_input' : 'waiting_permission',
        'interaction_waiting',
        decision.reason,
      );
    });
    return await new Promise<RequestPermissionResponse>((resolve) => {
      this.interactions.set(interactionId, {
        taskId,
        canAllow: decision.canAllow,
        params,
        resolve,
      });
    });
  }

  private async onSessionUpdate(notification: SessionNotification): Promise<void> {
    const taskId = this.sessionToTask.get(notification.sessionId);
    if (!taskId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'agent_thought_chunk') return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type !== 'text') return;
      const text = redactString(update.content.text, 16_384);
      await this.store.recordEvent(taskId, 'agent_message', { text }, (task) => {
        task.finalMessage = `${task.finalMessage ?? ''}${text}`.slice(-64 * 1024);
        task.summary = task.finalMessage;
      });
      return;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      await this.store.recordEvent(taskId, update.sessionUpdate, redact(update));
      return;
    }
    await this.store.recordEvent(taskId, `session_${update.sessionUpdate}`, redact(update));
  }

  private async onStatusUpdate(update: ReasonixStatusUpdate): Promise<void> {
    const taskId = this.sessionToTask.get(update.sessionId);
    if (!taskId) return;
    await this.store.recordEvent(taskId, `reasonix_${update.event}`, update, (task) => {
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
    });
  }

  private async onPromptComplete(
    sessionId: string,
    response: PromptResponse | undefined,
    status: ReasonixStatus | undefined,
    error?: unknown,
  ): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return;
    if (error || !status) {
      await this.failTask(
        taskId,
        error ?? new BridgeError('reasonix_incompatible', 'Reasonix omitted final status snapshot'),
        'prompt_failed',
      );
      return;
    }
    let release = false;
    await this.store.recordEvent(taskId, 'prompt_finished', { response, status }, (task) => {
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
        if (canTransition(task.status, 'cancelled')) transitionTask(task, 'cancelled', 'cancelled');
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
    });
    if (release) {
      const task = await this.store.loadTask(taskId);
      await this.releaseLease(task.repository.id, taskId);
    }
  }

  private async onProcessError(sessionIds: string[], error: unknown): Promise<void> {
    for (const sessionId of sessionIds) {
      const taskId = this.sessionToTask.get(sessionId);
      if (!taskId) continue;
      await this.store.recordEvent(
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
      const task = await this.store.loadTask(taskId);
      await this.releaseLease(task.repository.id, taskId);
      this.taskProcesses.delete(taskId);
      this.sessionToTask.delete(sessionId);
    }
  }

  async control(input: ControlInput, requestMeta: unknown): Promise<Record<string, unknown>> {
    this.assertPlatform();
    const taskId = validateTaskId(input.task_id);
    const task = await this.store.loadTask(taskId);
    if (input.action === 'respond') return await this.respond(task, input);
    if (input.action === 'cancel') return await this.cancel(task);
    if (input.action === 'close') return await this.close(task);
    if (input.action === 'steer') return await this.steer(task, input.message);

    const sandbox = parseSandboxContext(requestMeta);
    const repository = await discoverRepository(sandbox.cwd);
    if (repository.id !== task.repository.id) {
      throw new BridgeError('task_conflict', 'Task belongs to a different repository');
    }
    return await this.finalize(task, input, repository);
  }

  private async respond(
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
    await this.store.recordEvent(
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
    return taskView(await this.store.loadTask(task.taskId));
  }

  private workerForTask(task: TaskRecord): ReasonixProcess {
    const worker = this.taskProcesses.get(task.taskId);
    if (!worker || !task.acpSessionId || !worker.hasSession(task.acpSessionId)) {
      throw new BridgeError(
        'invalid_state',
        'Task has no live Reasonix session; inspect and resume first',
      );
    }
    return worker;
  }

  private async steer(task: TaskRecord, message: string): Promise<Record<string, unknown>> {
    if (!message.trim() || message.length > 20_000) {
      throw new BridgeError(
        'invalid_request',
        'steer message must be non-empty and at most 20,000 chars',
      );
    }
    const worker = this.workerForTask(task);
    let repairRound = task.repairRounds;
    if (task.status === 'review_required') {
      if (task.repairRounds >= 2) {
        throw new BridgeError(
          'repair_limit_reached',
          'Two post-review repair rounds are already used',
        );
      }
      repairRound += 1;
      await this.store.recordEvent(
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
    await this.store.recordEvent(task.taskId, 'steer_sent', { repairRound });
    return taskView(await this.store.loadTask(task.taskId));
  }

  private async cancel(task: TaskRecord): Promise<Record<string, unknown>> {
    if (TERMINAL_STATUSES.has(task.status)) return taskView(task);
    let cancelled = false;
    await this.store.recordEvent(task.taskId, 'task_cancel_requested', {}, (record) => {
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
    });
    if (!cancelled) return taskView(await this.store.loadTask(task.taskId));
    const finalization = this.finalizationTasks.get(task.taskId);
    this.finalizationAbort.get(task.taskId)?.abort();
    for (const [id, interaction] of this.interactions) {
      if (interaction.taskId !== task.taskId) continue;
      interaction.resolve({ outcome: { outcome: 'cancelled' } });
      this.interactions.delete(id);
    }
    const worker = this.taskProcesses.get(task.taskId);
    if (worker && task.acpSessionId) {
      await worker.cancel(task.acpSessionId).catch(() => undefined);
    }
    if (finalization) await finalization;
    await this.releaseLease(task.repository.id, task.taskId);
    return taskView(await this.store.loadTask(task.taskId));
  }

  private async close(task: TaskRecord): Promise<Record<string, unknown>> {
    if (TERMINAL_STATUSES.has(task.status)) return taskView(task);
    if (task.status === 'verifying') {
      throw new BridgeError(
        'invalid_state',
        'Cannot close a task while finalization is running; cancel it first',
      );
    }
    await this.store.recordEvent(task.taskId, 'task_closed', {}, (record) => {
      transitionTask(record, 'closed', 'closed');
      for (const interaction of record.interactions) {
        if (interaction.status === 'pending') interaction.status = 'cancelled';
      }
    });
    for (const [id, interaction] of this.interactions) {
      if (interaction.taskId !== task.taskId) continue;
      interaction.resolve({ outcome: { outcome: 'cancelled' } });
      this.interactions.delete(id);
    }
    const worker = this.taskProcesses.get(task.taskId);
    if (worker && task.acpSessionId) {
      await worker.cancel(task.acpSessionId).catch(() => undefined);
      await worker.closeSession(task.acpSessionId).catch(() => undefined);
    }
    await this.releaseLease(task.repository.id, task.taskId);
    return taskView(await this.store.loadTask(task.taskId));
  }

  private async finalize(
    task: TaskRecord,
    input: Extract<ControlInput, { action: 'finalize' }>,
    repository: RepositoryIdentity,
  ): Promise<Record<string, unknown>> {
    if (task.status !== 'review_required' || task.repairActive) {
      throw new BridgeError('invalid_state', 'finalize requires idle review_required state');
    }
    const worker = this.workerForTask(task);
    const status = await worker.status(task.acpSessionId!);
    if (status.state !== 'idle')
      throw new BridgeError('invalid_state', 'Reasonix must be idle before finalize');
    const requiredReview = task.contract.acceptance_criteria
      .filter((criterion) => criterion.evidence === 'review')
      .map((criterion) => criterion.id)
      .sort();
    const approved = [...new Set(input.approved_review_criteria)].sort();
    if (
      approved.some((id) => !requiredReview.includes(id)) ||
      requiredReview.some((id) => !approved.includes(id))
    ) {
      throw new BridgeError(
        'invalid_request',
        'All and only review acceptance criteria must be approved',
        {
          required: requiredReview,
          approved,
        },
      );
    }
    const message = input.commit_message
      ? validateCommitMessage(input.commit_message)
      : defaultCommitMessage(task.taskId, task.contract.objective);
    await this.holdLease(repository, task.taskId);
    await this.store.recordEvent(task.taskId, 'finalization_started', {}, (record) => {
      record.reviewSummary = input.review_summary.trim();
      transitionTask(record, 'verifying', 'preflight');
    });
    const controller = new AbortController();
    this.finalizationAbort.set(task.taskId, controller);
    const finalization = this.runFinalization(task.taskId, approved, message, controller.signal)
      .catch(async (error: unknown) => {
        const bridgeError = asBridgeError(error);
        await this.store.recordEvent(
          task.taskId,
          'finalization_failed',
          { code: bridgeError.code, message: bridgeError.message, details: bridgeError.details },
          (record) => {
            if (record.status === 'verifying') {
              transitionTask(
                record,
                'commit_failed',
                'finalization_failed',
                `${bridgeError.code}: ${bridgeError.message}`,
              );
            }
          },
        );
        await this.releaseLease(task.repository.id, task.taskId);
      })
      .finally(() => {
        if (this.finalizationAbort.get(task.taskId) === controller) {
          this.finalizationAbort.delete(task.taskId);
        }
        if (this.finalizationTasks.get(task.taskId) === finalization) {
          this.finalizationTasks.delete(task.taskId);
        }
      });
    this.finalizationTasks.set(task.taskId, finalization);
    void finalization;
    return taskView(await this.store.loadTask(task.taskId));
  }

  private async runFinalization(
    taskId: string,
    approvedReview: string[],
    commitMessage: string,
    signal: AbortSignal,
  ): Promise<void> {
    const assertActive = async (): Promise<void> => {
      if (signal.aborted) throw new BridgeError('invalid_state', 'Finalization was cancelled');
      const current = await this.store.loadTask(taskId);
      if (current.status !== 'verifying') {
        throw new BridgeError('invalid_state', `Finalization stopped in ${current.status}`);
      }
    };
    await assertActive();
    let task = await this.store.loadTask(taskId);
    await assertNoWorkerCommits(task.worktree, task.baseCommit);
    let files = await changedFiles(task.worktree);
    await assertChangedFilesInScope(task.worktree, task.contract, files);
    await assertFileSizes(task.worktree, files, this.config);
    await scanWorkingFiles(task.worktree, files, this.config, signal);
    const reviewedDiff = await workingDiff(task.worktree);
    await this.store.recordEvent(
      taskId,
      'preflight_passed',
      {
        files,
        diffSha256: sha256(reviewedDiff),
      },
      (record) => {
        record.changedFiles = files;
        record.phase = 'verification';
      },
    );

    await assertActive();
    const verification = await runAllVerification(task, this.store, signal);
    if (verification.some((item) => !item.passed)) {
      throw new BridgeError(
        'verification_failed',
        'One or more contract verification commands failed',
        {
          failed: verification.filter((item) => !item.passed).map((item) => item.id),
        },
      );
    }
    await assertActive();
    await assertNoWorkerCommits(task.worktree, task.baseCommit);
    const verifiedFiles = await changedFiles(task.worktree);
    await assertChangedFilesInScope(task.worktree, task.contract, verifiedFiles);
    await assertFileSizes(task.worktree, verifiedFiles, this.config);
    await scanWorkingFiles(task.worktree, verifiedFiles, this.config, signal);
    const verifiedDiff = await workingDiff(task.worktree);
    if (sha256(reviewedDiff) !== sha256(verifiedDiff)) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Verification changed the Codex-reviewed working diff',
      );
    }
    files = verifiedFiles;
    await this.store.recordEvent(taskId, 'verification_postflight_passed', {
      files,
      diffSha256: sha256(verifiedDiff),
    });
    const acceptance: AcceptanceEvidence[] = task.contract.acceptance_criteria.map((criterion) => {
      if (criterion.evidence === 'review') {
        return {
          criterionId: criterion.id,
          evidence: 'review',
          approved: approvedReview.includes(criterion.id),
          source: 'Codex finalize approval',
        };
      }
      const proofs = verification.filter(
        (item) => item.passed && item.proves.includes(criterion.id),
      );
      return {
        criterionId: criterion.id,
        evidence: 'automated',
        approved: proofs.length > 0,
        source: proofs.map((item) => item.id).join(','),
        sha256: evidenceHash(proofs.map((item) => item.sha256).join('\n')),
      };
    });
    if (acceptance.some((item) => !item.approved)) {
      throw new BridgeError('verification_failed', 'Acceptance evidence is incomplete');
    }
    await assertActive();
    await this.store.recordEvent(taskId, 'acceptance_evidence_ready', acceptance, (record) => {
      record.acceptanceEvidence = acceptance;
      record.phase = 'staging';
    });

    await assertActive();
    task = await this.store.loadTask(taskId);
    const before = verifiedDiff;
    await stageExplicitFiles(task.worktree, files);
    const staged = await stagedDiff(task.worktree);
    if (sha256(before) !== sha256(staged)) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Staged diff differs from reviewed working diff',
      );
    }
    await assertStagedChecks(task.worktree);
    await scanStagedFiles(task.worktree, files);
    await scanWorkingFiles(task.worktree, files, this.config, signal);
    await this.store.recordEvent(taskId, 'staged_diff_verified', {
      files,
      sha256: sha256(staged),
      bytes: Buffer.byteLength(staged),
    });

    await assertActive();
    await this.store.recordEvent(taskId, 'commit_started', {}, (record) => {
      if (record.status !== 'verifying') {
        throw new BridgeError('invalid_state', `Finalization stopped in ${record.status}`);
      }
      record.phase = 'committing';
    });
    const commitHash = await createAtomicCommit(task.worktree, task.baseCommit, commitMessage);
    await this.store.recordEvent(taskId, 'task_completed', { commitHash }, (record) => {
      record.commitHash = commitHash;
      transitionTask(record, 'completed', 'completed');
    });
    await this.releaseLease(task.repository.id, task.taskId);
  }

  async inspect(input: InspectInput): Promise<Record<string, unknown>> {
    const taskId = validateTaskId(input.task_id);
    let task = await this.store.loadTask(taskId);
    const waitMs = Math.min(Math.max(input.wait_ms ?? 0, 0), 30_000);
    if (task.status === 'paused' && !task.inspectedAfterPause) {
      task = await this.store.updateTask(taskId, (record) => {
        record.inspectedAfterPause = true;
      });
    }
    if (waitMs > 0 && !input.cursor) {
      task = await this.store.waitForChange(taskId, task.updatedAt, waitMs);
    }
    const include = input.include ?? [
      'status',
      'summary',
      'changed_files',
      'diff_stat',
      'verification',
      'acceptance_evidence',
      'risks',
      'usage',
      'interactions',
      'events',
    ];
    const maxBytes = Math.min(
      Math.max(input.max_bytes ?? this.config.maxInspectBytes, 1_024),
      64 * 1024,
    );
    const cursorPayload = input.cursor ? this.cursor.decode(input.cursor) : undefined;
    if (cursorPayload && !include.includes(cursorPayload.section as InspectSection)) {
      throw new BridgeError('invalid_request', 'Cursor section is not requested in include');
    }

    const values = new Map<InspectSection, unknown>();
    for (const section of include) {
      if (cursorPayload && cursorPayload.section !== section) continue;
      switch (section) {
        case 'status':
          values.set(section, taskView(task));
          break;
        case 'summary':
          values.set(section, task.summary);
          break;
        case 'changed_files':
          values.set(section, await changedFiles(task.worktree).catch(() => task.changedFiles));
          break;
        case 'diff_stat':
          values.set(section, await diffStat(task.worktree).catch(() => ''));
          break;
        case 'diff':
          values.set(section, redactString(await workingDiff(task.worktree), 16 * 1024 * 1024));
          break;
        case 'verification':
          values.set(section, task.verification);
          break;
        case 'acceptance_evidence':
          values.set(section, task.acceptanceEvidence);
          break;
        case 'risks':
          values.set(section, task.risks);
          break;
        case 'usage':
          values.set(section, task.usage);
          break;
        case 'interactions':
          values.set(section, task.interactions);
          break;
        case 'events':
          values.set(section, await this.store.readEvents(taskId));
          break;
      }
    }

    const sections: Record<string, unknown> = {};
    let budget = maxBytes - 512;
    let nextCursor: string | undefined;
    let truncated = false;
    for (const section of include) {
      if (!values.has(section)) continue;
      const value = values.get(section);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const bytes = Buffer.byteLength(text);
      if (bytes <= budget && !cursorPayload) {
        sections[section] = value;
        budget -= bytes;
        continue;
      }
      const digest = sha256(text);
      const page = paginateText(
        this.cursor,
        taskId,
        section,
        text,
        digest,
        Math.max(1, budget),
        input.cursor,
      );
      sections[section] = page.value;
      nextCursor = page.nextCursor;
      truncated = page.truncated;
      break;
    }
    return {
      task_id: taskId,
      sections,
      truncated,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      updated_at: task.updatedAt,
    };
  }

  async shutdown(): Promise<void> {
    for (const controller of this.finalizationAbort.values()) controller.abort();
    for (const interaction of this.interactions.values()) {
      interaction.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.interactions.clear();
    await Promise.allSettled(this.finalizationTasks.values());
    await this.pool.shutdown();
    await Promise.allSettled(this.leaseAcquisitions.values());
    this.leaseAcquisitions.clear();
    await Promise.all([...this.leases.values()].map(async (held) => await held.lease.release()));
    this.leases.clear();
  }
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
