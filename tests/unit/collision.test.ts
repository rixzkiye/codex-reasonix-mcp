import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';
import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import { discoverRepository } from '../../src/repository.js';
import { CollisionController } from '../../src/runtime/collision.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import type { TaskRecord } from '../../src/types.js';
import { contractFixture, createGitRepository } from '../helpers.js';

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand({ argv: ['git', ...args], cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, 'add', '--all');
  await git(cwd, 'commit', '-m', message);
}

async function fixture(writeScope = ['result.txt']): Promise<{
  source: string;
  task: TaskRecord;
  store: StateStore;
  collision: CollisionController;
}> {
  const source = await createGitRepository();
  const repository = await discoverRepository(source);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reasonix-collision-state-'));
  const store = new StateStore(stateDir);
  await store.initialize();
  const contract = parseTaskContract(contractFixture({ write_scope: writeScope }));
  const task = makeTaskRecordForTest('collision-task', contract, repository, '/worker');
  task.status = 'running';
  task.phase = 'goal_running';
  await store.createTask(task);
  return {
    source,
    task,
    store,
    collision: new CollisionController({ config: loadConfig({ stateDir }), store }),
  };
}

describe('core source-collision authority', () => {
  it('pauses on dirty and untracked overlap while preserving source bytes', async () => {
    const { source, task, store, collision } = await fixture();
    const readmeBefore = await readFile(path.join(source, 'README.md'));
    await writeFile(path.join(source, 'result.txt'), 'user-owned\n', 'utf8');
    const resultBefore = await readFile(path.join(source, 'result.txt'));

    await expect(collision.guardTask(task.taskId, 'after_worker_mutation')).rejects.toMatchObject({
      code: 'ownership_ambiguous',
      details: { overlappingPaths: ['result.txt'], dirtyPaths: ['result.txt'] },
    });

    expect(await readFile(path.join(source, 'README.md'))).toEqual(readmeBefore);
    expect(await readFile(path.join(source, 'result.txt'))).toEqual(resultBefore);
    expect(await store.loadTask(task.taskId)).toMatchObject({
      status: 'paused',
      phase: 'source_collision',
      sourceCollision: {
        checkpoint: 'after_worker_mutation',
        dirtyPaths: ['result.txt'],
        committedPaths: [],
        overlappingPaths: ['result.txt'],
        unavailable: false,
      },
    });
  });

  it('allows non-overlapping dirty and committed source movement', async () => {
    const { source, task, collision } = await fixture();
    await writeFile(path.join(source, 'README.md'), '# User documentation\n', 'utf8');
    await commit(source, 'docs: source movement');
    await writeFile(path.join(source, 'notes.txt'), 'untracked user note\n', 'utf8');

    await expect(collision.guardTask(task.taskId, 'resume')).resolves.toBeUndefined();
    const scan = await collision.scanTask(task, 'resume');
    expect(scan).toBeUndefined();
  });

  it('detects both sides of a committed rename after source HEAD moves', async () => {
    const source = await createGitRepository();
    await writeFile(path.join(source, 'result.txt'), 'base\n', 'utf8');
    await commit(source, 'fixture: add result');
    const repository = await discoverRepository(source);
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reasonix-rename-state-'));
    const store = new StateStore(stateDir);
    await store.initialize();
    const task = makeTaskRecordForTest(
      'rename-task',
      parseTaskContract(contractFixture()),
      repository,
      '/worker',
    );
    task.status = 'review_required';
    task.phase = 'codex_review';
    await store.createTask(task);
    const collision = new CollisionController({ config: loadConfig({ stateDir }), store });

    await rename(path.join(source, 'result.txt'), path.join(source, 'moved.txt'));
    await commit(source, 'refactor: move result');

    await expect(collision.guardTask(task.taskId, 'finalize_start')).rejects.toMatchObject({
      details: {
        committedPaths: ['moved.txt', 'result.txt'],
        overlappingPaths: ['result.txt'],
      },
    });
    expect((await store.loadTask(task.taskId)).status).toBe('paused');
  });

  it('fails closed when the recorded source worktree disappears', async () => {
    const { source, task, store, collision } = await fixture();
    const moved = `${source}-moved`;
    await rename(source, moved);
    try {
      await expect(
        collision.guardTask(task.taskId, 'immediately_before_commit'),
      ).rejects.toMatchObject({
        code: 'ownership_ambiguous',
        details: { unavailable: true, checkpoint: 'immediately_before_commit' },
      });
      expect(await store.loadTask(task.taskId)).toMatchObject({
        status: 'paused',
        sourceCollision: { unavailable: true },
      });
    } finally {
      await rename(moved, source);
    }
  });

  it('pauses recoverably when final commit must be blocked', async () => {
    const { source, task, store, collision } = await fixture();
    await store.updateTask(task.taskId, (record) => {
      record.status = 'verifying';
      record.phase = 'committing';
    });
    await writeFile(path.join(source, 'result.txt'), 'late user change\n', 'utf8');

    await expect(
      collision.guardTask(task.taskId, 'immediately_before_commit'),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
    expect(await store.loadTask(task.taskId)).toMatchObject({
      status: 'paused',
      phase: 'source_collision',
      sourceCollision: { checkpoint: 'immediately_before_commit' },
    });
  });

  it('clears persisted collision evidence once source overlap is resolved', async () => {
    const { source, task, store, collision } = await fixture();
    await writeFile(path.join(source, 'result.txt'), 'temporary overlap\n', 'utf8');
    await expect(collision.guardTask(task.taskId, 'review_readiness')).rejects.toBeDefined();
    await git(source, 'clean', '-f', '--', 'result.txt');

    await expect(collision.guardTask(task.taskId, 'resume')).resolves.toBeUndefined();
    expect((await store.loadTask(task.taskId)).sourceCollision).toBeUndefined();
    expect((await store.readEvents(task.taskId)).map((event) => event.type)).toContain(
      'source_collision_cleared',
    );
  });
});
