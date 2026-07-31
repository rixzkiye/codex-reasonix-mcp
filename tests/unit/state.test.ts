import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { acquireLease } from '../../src/lease.js';
import { CursorCodec, paginateText } from '../../src/pagination.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import { contractFixture } from '../helpers.js';

describe('private persistent state', () => {
  it('writes private snapshots, append-only events, and pauses interrupted tasks on restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-state-'));
    const store = new StateStore(root);
    await store.initialize();
    const task = makeTaskRecordForTest(
      'recover-me',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/worktree',
    );
    await store.createTask(task);
    await store.updateTask(task.taskId, (record) => {
      record.status = 'running';
    });
    expect((await stat(store.statePath(task.taskId))).mode & 0o777).toBe(0o600);

    const recovered = await store.recoverInterruptedTasks();
    expect(recovered).toEqual(['recover-me']);
    expect((await store.loadTask(task.taskId)).status).toBe('paused');
    expect((await store.readEvents(task.taskId)).map((event) => event.type)).toContain(
      'restart_recovery',
    );
  });

  it('enforces one cross-process lease owner and releases by nonce', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-lock-'));
    const first = await acquireLease(root, 'repo', 100, 10_000);
    await expect(acquireLease(root, 'repo', 100, 10_000)).rejects.toMatchObject({
      code: 'lease_conflict',
    });
    await first.release();
    const second = await acquireLease(root, 'repo', 100, 10_000);
    await second.release();
  });

  it('recovers a stale lease only when its recorded process is no longer alive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-stale-lock-'));
    await writeFile(
      path.join(root, 'repo.lease'),
      `${JSON.stringify({
        pid: 2_147_483_647,
        processStartToken: 'dead-process',
        createdAt: '1970-01-01T00:00:00.000Z',
        heartbeatAt: '1970-01-01T00:00:00.000Z',
        nonce: 'stale-owner',
      })}\n`,
      { mode: 0o600 },
    );
    const recovered = await acquireLease(root, 'repo', 100, 10_000);
    expect(await readdir(root)).toContain('repo.lease.stale.stale-owner');
    await recovered.release();
  });

  it('signs opaque bounded cursors and rejects tampering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-cursor-'));
    const codec = await CursorCodec.create(root);
    const first = paginateText(codec, 'task', 'diff', 'abcdefghij', 'digest', 4);
    expect(first).toMatchObject({ value: 'abcd', truncated: true });
    expect(first.nextCursor).toBeTruthy();
    const second = paginateText(codec, 'task', 'diff', 'abcdefghij', 'digest', 4, first.nextCursor);
    expect(second.value).toBe('efgh');
    expect(() => codec.decode(`${first.nextCursor}x`)).toThrow(/cursor/i);
  });

  it('paginates on UTF-8 boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-unicode-cursor-'));
    const codec = await CursorCodec.create(root);
    const first = paginateText(codec, 'task', 'diff', 'a🙂b', 'unicode', 5);
    expect(first.value).toBe('a🙂');
    expect(first.value).not.toContain('�');
    const second = paginateText(codec, 'task', 'diff', 'a🙂b', 'unicode', 5, first.nextCursor);
    expect(second.value).toBe('b');
  });
});
