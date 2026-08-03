import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import { BridgeError } from '../../src/errors.js';
import { discoverRepository } from '../../src/repository.js';
import { PermissionController } from '../../src/runtime/permissions.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import type { TaskRecord } from '../../src/types.js';
import { contractFixture, createGitRepository, waitUntil } from '../helpers.js';

function permission(
  task: TaskRecord,
  argv: [string, ...string[]],
  toolCallId = 'command-1',
): RequestPermissionRequest {
  return {
    sessionId: task.acpSessionId!,
    toolCall: {
      toolCallId,
      kind: 'execute',
      status: 'pending',
      rawInput: { command: argv.join(' ') },
      _meta: {
        'reasonix.io': {
          approvalId: toolCallId,
          commandSchemaVersion: 1,
          tool: 'bash',
          argv,
          cwd: task.worktree,
        },
      },
    },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
    ],
  };
}

function inputPermission(task: TaskRecord, toolCallId: string): RequestPermissionRequest {
  return {
    sessionId: task.acpSessionId!,
    toolCall: {
      toolCallId,
      kind: 'other',
      status: 'pending',
      rawInput: { question: 'Choose a bounded option' },
    },
    options: [
      { optionId: 'choice-a', name: 'Choice A', kind: 'allow_once' },
      { optionId: 'choice-b', name: 'Choice B', kind: 'reject_once' },
    ],
  };
}

async function fixture(timeoutSeconds = 1) {
  const repositoryRoot = await createGitRepository();
  const repository = await discoverRepository(repositoryRoot);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reasonix-permissions-state-'));
  const store = new StateStore(stateDir);
  await store.initialize();
  const contract = parseTaskContract(
    contractFixture({
      allowed_commands: [
        { id: 'project_test', argv: ['pnpm', 'test'], timeout_seconds: timeoutSeconds },
      ],
    }),
  );
  const task = makeTaskRecordForTest('permission-task', contract, repository, repositoryRoot);
  task.status = 'running';
  task.phase = 'goal_running';
  task.acpSessionId = 'session-1';
  await store.createTask(task);
  const cancelSession = vi.fn(() => Promise.resolve());
  const steerRecovery = vi.fn(() => Promise.resolve());
  const guardTask = vi.fn(() => Promise.resolve());
  const controller = new PermissionController({
    config: loadConfig({ stateDir }),
    store,
    collision: { guardTask },
    taskIdForSession: (sessionId) => (sessionId === task.acpSessionId ? task.taskId : undefined),
    cancelSession,
    steerRecovery,
  });
  return {
    controller,
    store,
    task,
    repositoryRoot,
    cancelSession,
    steerRecovery,
    guardTask,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('command supervision', () => {
  it('times out a command, cancels the session, and pauses with stable evidence', async () => {
    vi.useFakeTimers();
    const { controller, store, task, cancelSession } = await fixture();
    await expect(controller.onPermission(permission(task, ['pnpm', 'test']))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => {
      expect((await store.loadTask(task.taskId)).status).toBe('paused');
    });
    const paused = await store.loadTask(task.taskId);
    expect(paused).toMatchObject({
      status: 'paused',
      phase: 'command_timeout',
      inspectedAfterPause: false,
    });
    expect(paused.reason).toContain('watchdog timed out');
    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect((await store.readEvents(task.taskId)).map((event) => event.type)).toContain(
      'command_timeout',
    );
  });

  it('clears the watchdog on completion and performs immediate postflight scans', async () => {
    vi.useFakeTimers();
    const { controller, store, task, cancelSession, guardTask } = await fixture();
    await controller.onPermission(permission(task, ['pnpm', 'test']));
    await controller.onToolCallUpdate(task.taskId, 'command-1', 'completed');
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await store.loadTask(task.taskId)).status).toBe('running');
    expect(cancelSession).not.toHaveBeenCalled();
    expect(guardTask.mock.calls).toEqual([
      [task.taskId, 'before_worker_mutation'],
      [task.taskId, 'after_worker_mutation'],
    ]);
    expect((await store.readEvents(task.taskId)).map((event) => event.type)).toContain(
      'command_postflight_passed',
    );
  });

  it('pauses and cancels when a post-command scope/security scan fails', async () => {
    const { controller, store, task, repositoryRoot, cancelSession } = await fixture();
    await controller.onPermission(permission(task, ['pnpm', 'test']));
    await writeFile(path.join(repositoryRoot, 'README.md'), '# unauthorized change\n', 'utf8');
    await controller.onToolCallUpdate(task.taskId, 'command-1', 'failed');
    expect(await store.loadTask(task.taskId)).toMatchObject({
      status: 'paused',
      phase: 'command_postflight_failed',
    });
    expect(cancelSession).toHaveBeenCalledTimes(1);
  });

  it('sends one recovery steer and stops the third identical denial in a prompt', async () => {
    vi.useFakeTimers();
    const { controller, store, task, cancelSession, steerRecovery } = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      await expect(
        controller.onPermission(
          permission(task, ['curl', 'https://example.com'], `curl-${String(index)}`),
        ),
      ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    }
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(steerRecovery).toHaveBeenCalledTimes(1);
      expect(cancelSession).toHaveBeenCalledTimes(1);
    });
    expect(steerRecovery).toHaveBeenCalledTimes(1);
    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(await store.loadTask(task.taskId)).toMatchObject({
      status: 'paused',
      phase: 'repeated_policy_denial',
    });
    const events = await store.readEvents(task.taskId);
    expect(events.filter((event) => event.type === 'permission_auto_denied')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'permission_recovery_scheduled')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'interaction_waiting')).toHaveLength(0);
  });

  it('cancels requests from unknown sessions and immutable collision failures', async () => {
    const { controller, task, guardTask, cancelSession } = await fixture();
    const unknown = permission(task, ['pnpm', 'test']);
    unknown.sessionId = 'unknown';
    await expect(controller.onPermission(unknown)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });

    guardTask.mockRejectedValueOnce(new BridgeError('ownership_ambiguous', 'collision'));
    await expect(controller.onPermission(permission(task, ['pnpm', 'test']))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    await vi.waitFor(() => expect(cancelSession).toHaveBeenCalledTimes(1));
  });

  it('resolves input interactions by deny, option id, and answer while validating identities', async () => {
    const { controller, store, task } = await fixture();
    await expect(
      controller.respond(task, {
        task_id: task.taskId,
        action: 'respond',
        interaction_id: 'missing',
        decision: 'deny',
      }),
    ).rejects.toMatchObject({ code: 'interaction_not_found' });

    const cases = [
      { decision: 'deny' as const, expected: 'choice-b' },
      { decision: 'allow' as const, option_id: 'choice-a', expected: 'choice-a' },
      { decision: 'allow' as const, answer: 'Choice A', expected: 'choice-a' },
      { decision: 'allow' as const, expected: 'choice-a' },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const priorCount = (await store.loadTask(task.taskId)).interactions.length;
      const request = inputPermission(task, `ask-${String(index)}`);
      const pending = controller.onPermission(request);
      const current = await waitUntil(
        async () => await store.loadTask(task.taskId),
        (record) => record.interactions.length > priorCount,
      );
      const interaction = current.interactions.at(-1)!;
      await controller.respond(task, {
        task_id: task.taskId,
        action: 'respond',
        interaction_id: interaction.id,
        decision: cases[index]!.decision,
        ...(cases[index]!.option_id ? { option_id: cases[index]!.option_id } : {}),
        ...(cases[index]!.answer ? { answer: cases[index]!.answer } : {}),
      });
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: cases[index]!.expected },
      });
      expect((await store.loadTask(task.taskId)).status).toBe('running');
    }
  });

  it('rejects an unoffered interaction answer and cancels pending interactions explicitly', async () => {
    const { controller, store, task } = await fixture();
    let priorCount = (await store.loadTask(task.taskId)).interactions.length;
    const first = controller.onPermission(inputPermission(task, 'ask-invalid'));
    let current = await waitUntil(
      async () => await store.loadTask(task.taskId),
      (record) => record.interactions.length > priorCount,
    );
    let interaction = current.interactions.at(-1)!;
    await expect(
      controller.respond(task, {
        task_id: task.taskId,
        action: 'respond',
        interaction_id: interaction.id,
        decision: 'allow',
        answer: 'not offered',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    controller.cancelTaskInteractions(task.taskId);
    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } });

    priorCount = current.interactions.length;
    const second = controller.onPermission(inputPermission(task, 'ask-cancel-all'));
    current = await waitUntil(
      async () => await store.loadTask(task.taskId),
      (record) => record.interactions.length > priorCount,
    );
    interaction = current.interactions.at(-1)!;
    expect(interaction).toBeTruthy();
    controller.cancelAllInteractions();
    await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('finishes active commands as failed and ignores non-terminal tool updates', async () => {
    const { controller, store, task } = await fixture();
    await controller.onPermission(permission(task, ['pnpm', 'test']));
    await controller.onToolCallUpdate(task.taskId, 'command-1', 'running');
    await controller.finishPrompt(task.taskId);
    const events = await store.readEvents(task.taskId);
    expect(events).toContainEqual(expect.objectContaining({ type: 'command_postflight_passed' }));
  });
});
