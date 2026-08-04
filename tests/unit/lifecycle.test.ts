import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { enterPaused, pauseReasonHash, transitionTask } from '../../src/lifecycle.js';
import { assertSupportedPlatform, makeTaskRecordForTest } from '../../src/runtime.js';
import { contractFixture } from '../helpers.js';

describe('task lifecycle', () => {
  it('bumps a monotonic pause revision and binds each pause to its reason hash', () => {
    const task = makeTaskRecordForTest(
      'task',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/worktree',
    );
    enterPaused(task, 'source_collision', 'source changed');
    expect(task.status).toBe('paused');
    expect(task.pauseRevision).toBe(1);
    expect(task.pauseReasonHash).toBe(pauseReasonHash('source changed'));
    expect(task.inspectedAfterPause).toBe(false);

    transitionTask(task, 'running', 'goal');
    enterPaused(task, 'worker_crashed');
    expect(task.pauseRevision).toBe(2);
    expect(task.pauseReasonHash).toBe(pauseReasonHash(undefined));
    expect(task.reason).toBeUndefined();
  });
  it('accepts the official happy path and rejects terminal resurrection', () => {
    const task = makeTaskRecordForTest(
      'task',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/worktree',
    );
    transitionTask(task, 'running', 'goal');
    transitionTask(task, 'review_required', 'review');
    transitionTask(task, 'verifying', 'tests');
    transitionTask(task, 'completed', 'done');
    expect(() => transitionTask(task, 'running', 'again')).toThrow(/Invalid task transition/);
  });

  it('tracks at most two review repairs in runtime state', () => {
    const task = makeTaskRecordForTest(
      'task',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/worktree',
    );
    task.repairRounds = 2;
    expect(task.repairRounds).toBe(2);
  });

  it('returns pre-commit verification failures to review without terminalizing the task', () => {
    const task = makeTaskRecordForTest(
      'task',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/worktree',
    );
    transitionTask(task, 'running', 'goal');
    transitionTask(task, 'review_required', 'review');
    transitionTask(task, 'verifying', 'verification');
    transitionTask(task, 'review_required', 'verification_repair_required', 'test failed');
    expect(task).toMatchObject({
      status: 'review_required',
      phase: 'verification_repair_required',
      reason: 'test failed',
    });
  });

  it('rejects native Windows while allowing WSL through the Linux platform path', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow(/WSL/);
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });
});
