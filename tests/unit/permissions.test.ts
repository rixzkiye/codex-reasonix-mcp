import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import { discoverRepository } from '../../src/repository.js';
import { PermissionController } from '../../src/runtime/permissions.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import type { TaskRecord } from '../../src/types.js';
import { contractFixture, createGitRepository } from '../helpers.js';

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
});
