import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import {
  assertChangedFilesInScope,
  assertNoWorkerCommits,
  assertSourceClean,
  assertStagedChecks,
  changedFiles,
  createAtomicCommit,
  createIsolatedWorktree,
  discoverRepository,
  resolveGitIdentity,
  stageExplicitFiles,
  validateTaskId,
} from '../../src/repository.js';
import { scanStagedFiles, scanWorkingFiles } from '../../src/security.js';
import { runCommand } from '../../src/command.js';
import { contractFixture, createGitRepository } from '../helpers.js';

describe('isolated Git finalization', () => {
  it('rejects dirty source worktrees and task/branch injection', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    await writeFile(path.join(source, 'dirty.txt'), 'uncommitted\n', 'utf8');
    await expect(assertSourceClean(repository)).rejects.toMatchObject({ code: 'dirty_repository' });
    for (const taskId of ['../escape', 'task..other', 'task.lock', '-option', 'task/name']) {
      expect(() => validateTaskId(taskId)).toThrow();
    }
  });

  it('creates one worker commit while leaving the source branch untouched', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    await assertSourceClean(repository);
    const worktrees = path.join(source, '.ignored-state-worktrees');
    const isolated = await createIsolatedWorktree(
      repository,
      worktrees,
      'git-success',
      repository.head,
    );
    await writeFile(path.join(isolated.worktree, 'result.txt'), 'offline result\n', 'utf8');
    const contract = parseTaskContract(contractFixture());
    const files = await changedFiles(isolated.worktree);
    expect(files).toEqual(['result.txt']);
    await assertNoWorkerCommits(isolated.worktree, repository.head);
    await assertChangedFilesInScope(isolated.worktree, contract, files);
    const config = loadConfig({ stateDir: path.join(source, '.state') });
    await scanWorkingFiles(isolated.worktree, files, config);
    await stageExplicitFiles(isolated.worktree, files);
    await assertStagedChecks(isolated.worktree);
    await scanStagedFiles(isolated.worktree, files);
    const commit = await createAtomicCommit(
      isolated.worktree,
      repository.head,
      'git-success: create result',
      await resolveGitIdentity(repository),
    );
    expect(commit).not.toBe(repository.head);
    const sourceHead = await runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: source });
    expect(sourceHead.stdout.trim()).toBe(repository.head);
    const count = await runCommand({
      argv: ['git', 'rev-list', '--count', `${repository.head}..${commit}`],
      cwd: source,
    });
    expect(count.stdout.trim()).toBe('1');
  });

  it('rejects out-of-scope files and secrets before staging', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'git-reject',
      repository.head,
    );
    await writeFile(path.join(isolated.worktree, 'README.md'), 'changed\n', 'utf8');
    await expect(
      assertChangedFilesInScope(
        isolated.worktree,
        parseTaskContract(contractFixture()),
        await changedFiles(isolated.worktree),
      ),
    ).rejects.toMatchObject({ code: 'scope_violation' });

    await writeFile(
      path.join(isolated.worktree, 'result.txt'),
      'sk-proj-abcdefghijklmnop\n',
      'utf8',
    );
    await expect(
      scanWorkingFiles(
        isolated.worktree,
        ['result.txt'],
        loadConfig({ stateDir: path.join(source, '.state') }),
      ),
    ).rejects.toMatchObject({ code: 'secret_detected' });
    const staged = await runCommand({
      argv: ['git', 'diff', '--cached', '--name-only'],
      cwd: isolated.worktree,
    });
    expect(staged.stdout).toBe('');
  });

  it('rolls back bridge-owned paths when explicit staging does not match', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'staging-rollback',
      repository.head,
    );
    await writeFile(path.join(isolated.worktree, 'result.txt'), 'still in the worktree\n', 'utf8');

    await expect(
      stageExplicitFiles(isolated.worktree, ['result.txt', 'README.md']),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
    const staged = await runCommand({
      argv: ['git', 'diff', '--cached', '--name-only'],
      cwd: isolated.worktree,
    });
    expect(staged.stdout).toBe('');
    expect(await readFile(path.join(isolated.worktree, 'result.txt'), 'utf8')).toBe(
      'still in the worktree\n',
    );
  });

  it('resolves in-worktree symlinks before evaluating write scope', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'symlink-scope',
      repository.head,
    );
    await symlink('README.md', path.join(isolated.worktree, 'result.txt'));
    await expect(
      assertChangedFilesInScope(
        isolated.worktree,
        parseTaskContract(contractFixture()),
        await changedFiles(isolated.worktree),
      ),
    ).rejects.toMatchObject({ code: 'scope_violation' });
  });

  it('rejects a worker-created commit as ownership ambiguity', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'worker-commit',
      repository.head,
    );
    await writeFile(path.join(isolated.worktree, 'result.txt'), 'worker commit\n', 'utf8');
    for (const argv of [
      ['git', 'add', '--', 'result.txt'],
      ['git', 'commit', '-m', 'worker: forbidden commit'],
    ] as Array<[string, ...string[]]>) {
      const result = await runCommand({ argv, cwd: isolated.worktree });
      expect(result.exitCode).toBe(0);
    }
    await expect(assertNoWorkerCommits(isolated.worktree, repository.head)).rejects.toMatchObject({
      code: 'ownership_ambiguous',
    });
  });

  it('leaves history unchanged when a commit hook fails', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'hook-failure',
      repository.head,
    );
    await writeFile(path.join(isolated.worktree, 'result.txt'), 'hook guarded\n', 'utf8');
    await stageExplicitFiles(isolated.worktree, ['result.txt']);
    const hooks = path.join(repository.commonDir, 'hooks');
    await mkdir(hooks, { recursive: true });
    const hook = path.join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 23\n', 'utf8');
    await chmod(hook, 0o755);

    await expect(
      createAtomicCommit(
        isolated.worktree,
        repository.head,
        'hook-failure: should not commit',
        await resolveGitIdentity(repository),
      ),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    const head = await runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: isolated.worktree });
    expect(head.stdout.trim()).toBe(repository.head);
  });

  it('rejects a successful pre-commit hook that mutates the reviewed tree', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'hook-mutation',
      repository.head,
    );
    await writeFile(path.join(isolated.worktree, 'result.txt'), 'reviewed\n', 'utf8');
    await stageExplicitFiles(isolated.worktree, ['result.txt']);
    const hooks = path.join(repository.commonDir, 'hooks');
    await mkdir(hooks, { recursive: true });
    const hook = path.join(hooks, 'pre-commit');
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "hook mutation\\n" > result.txt\ngit add -- result.txt\nexit 0\n',
      'utf8',
    );
    await chmod(hook, 0o755);

    await expect(
      createAtomicCommit(
        isolated.worktree,
        repository.head,
        'hook-mutation: reject mutation',
        await resolveGitIdentity(repository),
      ),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
    const head = await runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: isolated.worktree });
    expect(head.stdout.trim()).toBe(repository.head);
    const count = await runCommand({
      argv: ['git', 'rev-list', '--count', `${repository.head}..HEAD`],
      cwd: isolated.worktree,
    });
    expect(count.stdout.trim()).toBe('0');
  });

  it('creates a commit from bridge environment identity without Git identity config', async () => {
    const source = await createGitRepository();
    const repository = await discoverRepository(source);
    const isolated = await createIsolatedWorktree(
      repository,
      path.join(source, '.ignored-state-worktrees'),
      'environment-identity',
      repository.head,
    );
    for (const key of ['user.name', 'user.email']) {
      const unset = await runCommand({
        argv: ['git', 'config', '--unset', key],
        cwd: isolated.worktree,
      });
      expect(unset.exitCode).toBe(0);
    }
    await writeFile(path.join(isolated.worktree, 'result.txt'), 'environment identity\n', 'utf8');
    await stageExplicitFiles(isolated.worktree, ['result.txt']);
    const identity = await resolveGitIdentity(repository, {
      GIT_AUTHOR_NAME: 'Bridge Environment Author',
      GIT_AUTHOR_EMAIL: 'bridge-environment@example.invalid',
    });

    const commit = await createAtomicCommit(
      isolated.worktree,
      repository.head,
      'environment-identity: commit without config',
      identity,
    );
    const author = await runCommand({
      argv: ['git', 'show', '-s', '--format=%an <%ae>', commit],
      cwd: isolated.worktree,
    });
    expect(author.stdout.trim()).toBe(
      'Bridge Environment Author <bridge-environment@example.invalid>',
    );
  });

  it('contains no bridge code path that invokes git push', async () => {
    const source = await readFile(path.resolve('src/repository.ts'), 'utf8');
    expect(source).not.toMatch(/git(?:Checked)?\([^)]*\[\s*['"]push['"]/s);
  });
});
