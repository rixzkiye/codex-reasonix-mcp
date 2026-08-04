import { mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';
import { parseTaskContract } from '../../src/contracts.js';
import {
  createIsolatedWorktree,
  discoverRepository,
  resolveBaseCommit,
} from '../../src/repository.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import {
  parsePruneDuration,
  runTaskCli,
  TaskOperations,
  type TaskTombstone,
} from '../../src/task-operations.js';
import type { TaskRecord, TaskStatus } from '../../src/types.js';
import { contractFixture, createGitRepository } from '../helpers.js';

async function fixtureTask(
  taskId: string,
  status: TaskStatus,
  options: { worktree?: 'real' | 'missing'; now?: string } = {},
): Promise<{ root: string; repository: string; store: StateStore; task: TaskRecord }> {
  const repository = await createGitRepository();
  const identity = await discoverRepository(repository);
  const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-operations-'));
  const store = new StateStore(root);
  await store.initialize();
  const task = makeTaskRecordForTest(
    taskId,
    parseTaskContract(contractFixture()),
    identity,
    path.join(root, 'missing', taskId),
  );
  task.baseCommit = await resolveBaseCommit(identity, 'HEAD');
  task.status = status;
  task.phase = status;
  if (options.now) {
    task.createdAt = options.now;
    task.updatedAt = options.now;
  }
  if (options.worktree === 'real') {
    const isolated = await createIsolatedWorktree(
      identity,
      store.worktreesDir(),
      taskId,
      task.baseCommit,
    );
    task.branch = isolated.branch;
    task.worktree = isolated.worktree;
  }
  await store.createTask(task);
  return { root, repository, store, task };
}

describe('task operations', () => {
  it('lists active tasks by default and bounded identities from every storage class with --all JSON', async () => {
    const { root, store } = await fixtureTask('active-list', 'paused');
    const terminal = makeTaskRecordForTest(
      'terminal-list',
      parseTaskContract(contractFixture()),
      { id: 'repo-two', root: '/missing', commonDir: '/missing/.git', head: 'abc' },
      '/missing',
    );
    terminal.status = 'cancelled';
    terminal.phase = 'cancelled';
    await store.createTask(terminal);
    const operations = new TaskOperations(store);
    await operations.archive(terminal.taskId, true);

    expect((await operations.list()).map((entry) => entry.task_id)).toEqual(['active-list']);
    const result = await runTaskCli(['list', '--all', '--json'], { stateDir: root });
    expect(result.exitCode).toBe(0);
    const entries = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.task_id)).toEqual(['active-list', 'terminal-list']);
    expect(entries[1]).toMatchObject({ storage: 'archive', repository_id: 'repo-two' });
    expect(result.stdout).not.toContain('Create an offline result file');
    expect(result.stdout).not.toContain('result.txt');
  });

  it('keeps mutating CLI commands dry-run unless --apply is present', async () => {
    const { root, store, task } = await fixtureTask('dry-run', 'cancelled');
    const dry = await runTaskCli(['archive', task.taskId], { stateDir: root });
    expect(dry.stdout).toContain('Would archive');
    expect(await store.exists(task.taskId)).toBe(true);
    const applied = await runTaskCli(['archive', task.taskId, '--apply'], { stateDir: root });
    expect(applied.stdout).toContain('Archived');
    expect(await store.exists(task.taskId)).toBe(false);

    const pruneDry = await runTaskCli(['prune', '--older-than', '0d'], { stateDir: root });
    expect(pruneDry.stdout).toContain('Would prune 1 archive');
    await stat(path.join(root, 'archive', task.taskId));
    const pruneApplied = await runTaskCli(['prune', '--older-than', '0d', '--apply'], {
      stateDir: root,
    });
    expect(pruneApplied.stdout).toContain(`Pruned 1 archive(s): ${task.taskId}`);
    await stat(path.join(root, 'tombstones', `${task.taskId}.json`));
  });

  it('renders the default list table and maps task CLI operational errors', async () => {
    const { root, task } = await fixtureTask('table-list', 'paused');
    const listed = await runTaskCli(['list'], { stateDir: root });
    expect(listed).toMatchObject({ exitCode: 0, stderr: '' });
    expect(listed.stdout).toContain(`${task.taskId}\tpaused\tlive`);

    const invalid = await runTaskCli(['archive', '../escape'], { stateDir: root });
    expect(invalid).toMatchObject({ exitCode: 2, stdout: '' });
    expect(invalid.stderr).toContain('Invalid task id');

    const missing = await runTaskCli(['archive', 'missing-task'], { stateDir: root });
    expect(missing).toMatchObject({ exitCode: 1, stdout: '' });
    expect(missing.stderr).toContain('Unknown task');

    const defaultPrune = await runTaskCli(['prune'], { stateDir: root });
    expect(defaultPrune).toMatchObject({ exitCode: 0, stderr: '' });
    expect(defaultPrune.stdout).toContain('Would prune 0 archive');

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'reasonix-empty-list-'));
    expect(await runTaskCli(['list'], { stateDir: emptyRoot })).toMatchObject({
      exitCode: 0,
      stdout: 'No tasks.\n',
      stderr: '',
    });
  });

  it('archives terminal clean or missing worktrees, preserves audit content and Git refs', async () => {
    const { store, repository, task } = await fixtureTask('archive-clean', 'completed', {
      worktree: 'real',
    });
    task.commitHash = task.baseCommit;
    await store.updateTask(task.taskId, (record) => {
      record.commitHash = task.baseCommit;
    });
    await writeFile(
      path.join(store.taskDir(task.taskId), 'third-party-audit.txt'),
      'preserve me\n',
    );
    const operations = new TaskOperations(store);
    const result = await operations.archive(task.taskId, true);

    expect(result.apply).toBe(true);
    await expect(stat(task.worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    const archive = path.join(operations.archiveRoot, task.taskId);
    expect(await readFile(path.join(archive, 'third-party-audit.txt'), 'utf8')).toBe(
      'preserve me\n',
    );
    const metadata = JSON.parse(
      await readFile(path.join(archive, 'archive.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      taskId: task.taskId,
      branch: task.branch,
      ref: `refs/heads/${task.branch}`,
      baseCommit: task.baseCommit,
      commitHash: task.baseCommit,
    });
    const branchCheck = await import('../../src/command.js').then(
      async ({ runCommand }) =>
        await runCommand({
          argv: ['git', 'show-ref', '--verify', `refs/heads/${task.branch}`],
          cwd: repository,
        }),
    );
    expect(branchCheck.exitCode).toBe(0);
    expect((await operations.archive(task.taskId, true)).message).toContain('already archived');
    await expect(store.createTask(task)).rejects.toMatchObject({ code: 'task_conflict' });
  });

  it('rejects active tasks and dirty worker worktrees without modifying user content', async () => {
    const active = await fixtureTask('archive-active', 'paused');
    await expect(
      new TaskOperations(active.store).archive(active.task.taskId, true),
    ).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(await active.store.exists(active.task.taskId)).toBe(true);

    const dirty = await fixtureTask('archive-dirty', 'cancelled', { worktree: 'real' });
    const userFile = path.join(dirty.task.worktree, 'user-untracked.txt');
    await writeFile(userFile, 'do not remove\n');
    await expect(
      new TaskOperations(dirty.store).archive(dirty.task.taskId, true),
    ).rejects.toMatchObject({
      code: 'dirty_repository',
    });
    expect(await readFile(userFile, 'utf8')).toBe('do not remove\n');
    expect(await dirty.store.exists(dirty.task.taskId)).toBe(true);
  });

  it('refuses to detach a different clean worktree named by corrupt task state', async () => {
    const fixture = await fixtureTask('archive-identity', 'cancelled', { worktree: 'real' });
    await fixture.store.updateTask(fixture.task.taskId, (record) => {
      record.worktree = fixture.repository;
    });
    await expect(
      new TaskOperations(fixture.store).archive(fixture.task.taskId, true),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
    expect(await readFile(path.join(fixture.repository, 'README.md'), 'utf8')).toBe('# Fixture\n');
    await stat(fixture.repository);
    await stat(fixture.task.worktree);
  });

  it('leaves recoverable live state after archive interruption and succeeds on retry', async () => {
    const { store, task } = await fixtureTask('archive-interrupt', 'failed');
    const firstArchiveAt = new Date('2026-08-01T00:00:00.000Z');
    const interrupted = new TaskOperations(
      store,
      {
        afterArchivePrepared: () => {
          throw new Error('simulated crash');
        },
      },
      () => firstArchiveAt,
    );
    await expect(interrupted.archive(task.taskId, true)).rejects.toThrow('simulated crash');
    expect((await store.loadTask(task.taskId)).status).toBe('failed');
    expect(
      JSON.parse(await readFile(path.join(store.taskDir(task.taskId), 'archive.json'), 'utf8')),
    ).toMatchObject({ taskId: task.taskId });

    const restarted = new TaskOperations(store, {}, () => new Date('2026-08-02T00:00:00.000Z'));
    await expect(restarted.archive(task.taskId, true)).resolves.toMatchObject({ apply: true });
    await stat(path.join(restarted.archiveRoot, task.taskId, 'state.json'));
    expect(
      JSON.parse(
        await readFile(path.join(restarted.archiveRoot, task.taskId, 'archive.json'), 'utf8'),
      ),
    ).toMatchObject({ archivedAt: firstArchiveAt.toISOString() });
  });

  it('recovers after detaching a clean worktree without deleting its branch, ref, commit, or audit', async () => {
    const { store, repository, task } = await fixtureTask('archive-detach-interrupt', 'completed', {
      worktree: 'real',
    });
    await store.updateTask(task.taskId, (record) => {
      record.commitHash = record.baseCommit;
    });
    await writeFile(path.join(store.taskDir(task.taskId), 'complete-audit.json'), '{"ok":true}\n');
    const firstArchiveAt = new Date('2026-08-01T03:00:00.000Z');
    const interrupted = new TaskOperations(
      store,
      {
        afterWorkerWorktreeDetached: () => {
          throw new Error('simulated crash after detach');
        },
      },
      () => firstArchiveAt,
    );

    await expect(interrupted.archive(task.taskId, true)).rejects.toThrow(
      'simulated crash after detach',
    );
    await expect(stat(task.worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    await stat(path.join(store.taskDir(task.taskId), 'state.json'));
    await expect(stat(path.join(interrupted.archiveRoot, task.taskId))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const ref = `refs/heads/${task.branch}`;
    const refAfterCrash = await runCommand({
      argv: ['git', 'show-ref', '--verify', ref],
      cwd: repository,
    });
    expect(refAfterCrash.exitCode).toBe(0);
    expect(refAfterCrash.stdout.trim()).toBe(`${task.baseCommit} ${ref}`);
    expect(
      (
        await runCommand({
          argv: ['git', 'cat-file', '-e', `${task.baseCommit}^{commit}`],
          cwd: repository,
        })
      ).exitCode,
    ).toBe(0);

    const restarted = new TaskOperations(store, {}, () => new Date('2026-08-02T03:00:00.000Z'));
    await expect(restarted.archive(task.taskId, true)).resolves.toMatchObject({
      apply: true,
      taskIds: [task.taskId],
    });
    expect(await store.exists(task.taskId)).toBe(false);
    const archive = path.join(restarted.archiveRoot, task.taskId);
    expect(await readFile(path.join(archive, 'complete-audit.json'), 'utf8')).toBe('{"ok":true}\n');
    expect(JSON.parse(await readFile(path.join(archive, 'archive.json'), 'utf8'))).toMatchObject({
      archivedAt: firstArchiveAt.toISOString(),
      ref,
      commitHash: task.baseCommit,
    });
    const refAfterRetry = await runCommand({
      argv: ['git', 'show-ref', '--verify', ref],
      cwd: repository,
    });
    expect(refAfterRetry.exitCode).toBe(0);
    expect(refAfterRetry.stdout.trim()).toBe(`${task.baseCommit} ${ref}`);
    expect(
      (
        await runCommand({
          argv: ['git', 'cat-file', '-e', `${task.baseCommit}^{commit}`],
          cwd: repository,
        })
      ).exitCode,
    ).toBe(0);
  });

  it('prunes only at the inclusive age boundary and writes complete permanent tombstones', async () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    const old = await fixtureTask('prune-old', 'completed', { now: '2026-06-01T00:00:00.000Z' });
    old.task.verification = [
      {
        id: 'verify',
        argv: ['true'],
        cwd: '.',
        startedAt: old.task.createdAt,
        finishedAt: old.task.createdAt,
        exitCode: 0,
        timedOut: false,
        passed: true,
        proves: ['ac_result'],
        logPath: '/private/log',
        sha256: 'a'.repeat(64),
        outputBytes: 0,
      },
    ];
    old.task.acceptanceEvidence = [
      {
        criterionId: 'ac_result',
        evidence: 'automated',
        approved: true,
        source: 'private-source',
        sha256: 'b'.repeat(64),
      },
    ];
    old.task.commitHash = 'c'.repeat(40);
    await old.store.saveTask(old.task);
    const archiveNow = new Date(now.getTime() - parsePruneDuration('30d'));
    const operations = new TaskOperations(old.store, {}, () => archiveNow);
    await operations.archive(old.task.taskId, true);

    const before = new TaskOperations(old.store, {}, () => new Date(now.getTime() - 1));
    expect((await before.prune(parsePruneDuration('30d'), false)).taskIds).toEqual([]);
    const boundary = new TaskOperations(old.store, {}, () => now);
    expect((await boundary.prune(parsePruneDuration('30d'), true)).taskIds).toEqual([
      old.task.taskId,
    ]);
    const tombstone = JSON.parse(
      await readFile(path.join(boundary.tombstonesRoot, `${old.task.taskId}.json`), 'utf8'),
    ) as TaskTombstone;
    expect(tombstone).toMatchObject({
      contractHash: old.task.contractHash,
      status: 'completed',
      branch: old.task.branch,
      ref: `refs/heads/${old.task.branch}`,
      baseCommit: old.task.baseCommit,
      commitHash: old.task.commitHash,
      createdAt: old.task.createdAt,
      completedAt: old.task.updatedAt,
      archivedAt: archiveNow.toISOString(),
      prunedAt: now.toISOString(),
    });
    expect(tombstone.verificationEvidenceHashes).toEqual(['a'.repeat(64)]);
    expect(tombstone.acceptanceEvidenceHashes).toEqual(['b'.repeat(64)]);
    expect(JSON.stringify(tombstone)).not.toContain('private-source');
    expect(JSON.stringify(tombstone)).not.toContain('/private/log');
    await expect(stat(path.join(boundary.archiveRoot, old.task.taskId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(old.store.createTask(old.task)).rejects.toMatchObject({ code: 'task_conflict' });
    expect(await boundary.list(true)).toContainEqual(
      expect.objectContaining({
        task_id: old.task.taskId,
        storage: 'tombstone',
        repository_id: null,
      }),
    );
    expect((await boundary.prune(0, true)).taskIds).toEqual([]);
  });

  it('recovers an interrupted prune to exactly one complete tombstone', async () => {
    const fixture = await fixtureTask('prune-interrupt', 'cancelled');
    const now = new Date('2026-08-03T00:00:00.000Z');
    const operations = new TaskOperations(
      fixture.store,
      {},
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    await operations.archive(fixture.task.taskId, true);
    const interrupted = new TaskOperations(
      fixture.store,
      {
        afterPruneStaged: () => {
          throw new Error('simulated prune crash');
        },
      },
      () => now,
    );
    await expect(interrupted.prune(0, true)).rejects.toThrow('simulated prune crash');
    await expect(
      stat(path.join(interrupted.archiveRoot, fixture.task.taskId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = new TaskOperations(fixture.store, {}, () => now);
    await restarted.initialize();
    const tombstonePath = path.join(restarted.tombstonesRoot, `${fixture.task.taskId}.json`);
    expect(JSON.parse(await readFile(tombstonePath, 'utf8'))).toMatchObject({
      taskId: fixture.task.taskId,
    });
    expect((await restarted.prune(0, true)).taskIds).toEqual([]);
  });

  it('finishes cleanup after a crash that persisted the tombstone before deleting the archive', async () => {
    const fixture = await fixtureTask('prune-persisted', 'failed');
    const archivedAt = new Date('2026-01-01T00:00:00.000Z');
    await new TaskOperations(fixture.store, {}, () => archivedAt).archive(
      fixture.task.taskId,
      true,
    );
    const interrupted = new TaskOperations(
      fixture.store,
      {
        afterTombstonePersisted: () => {
          throw new Error('simulated post-persist crash');
        },
      },
      () => new Date('2026-08-03T00:00:00.000Z'),
    );
    await expect(interrupted.prune(0, true)).rejects.toThrow('simulated post-persist crash');
    const tombstonePath = path.join(interrupted.tombstonesRoot, `${fixture.task.taskId}.json`);
    await stat(tombstonePath);
    const [stagingEntry] = await readdir(interrupted.pruneStagingRoot);
    await unlink(path.join(interrupted.pruneStagingRoot, stagingEntry!, 'tombstone.pending.json'));

    const restarted = new TaskOperations(fixture.store);
    await restarted.initialize();
    expect(JSON.parse(await readFile(tombstonePath, 'utf8'))).toMatchObject({
      taskId: fixture.task.taskId,
      archivedAt: archivedAt.toISOString(),
    });
    expect(await readdir(restarted.pruneStagingRoot)).toEqual([]);
    expect((await restarted.prune(0, true)).taskIds).toEqual([]);
  });

  it.each(['30', '-1d', '1.5d', 'd', '1w', '9007199254740992d'])(
    'rejects invalid prune duration %s',
    (value) => {
      expect(() => parsePruneDuration(value)).toThrow();
    },
  );

  it('rejects invalid direct prune ages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-prune-age-'));
    const operations = new TaskOperations(new StateStore(root));
    for (const age of [-1, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(operations.prune(age, false)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
  });

  it('rejects ambiguous CLI grammar', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-cli-task-'));
    for (const args of [
      ['list', '--wat'],
      ['list', '--all', '--all'],
      ['archive'],
      ['archive', 'id', '--apply', '--apply'],
      ['prune', '--older-than'],
      ['prune', '--older-than', '30d', '--older-than', '2d'],
    ]) {
      const result = await runTaskCli(args, { stateDir: root });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
  });
});
