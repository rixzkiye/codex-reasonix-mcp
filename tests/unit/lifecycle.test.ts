import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { transitionTask } from '../../src/lifecycle.js';
import { assertSupportedPlatform, makeTaskRecordForTest } from '../../src/runtime.js';
import { contractFixture } from '../helpers.js';

describe('task lifecycle', () => {
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

  it('rejects native Windows while allowing WSL through the Linux platform path', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow(/WSL/);
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });
});
