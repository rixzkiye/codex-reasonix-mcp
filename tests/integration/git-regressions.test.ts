import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import {
  assertChangedFilesInScope,
  canonicalWorktreeSnapshot,
  canonicalWorktreeTree,
  changedFiles,
  createIsolatedWorktree,
  diffStat,
  discoverRepository,
  stageExplicitFiles,
  stagedTree,
  workingDiff,
} from '../../src/repository.js';
import { runCommand } from '../../src/command.js';
import { contractFixture, createGitRepository } from '../helpers.js';

async function fixture(): Promise<{ source: string; worktree: string; baseCommit: string }> {
  const source = await createGitRepository();
  const repository = await discoverRepository(source);
  const isolated = await createIsolatedWorktree(
    repository,
    path.join(source, '.ignored-state-worktrees'),
    `git-regression-${Math.random().toString(36).slice(2, 10)}`,
    repository.head,
  );
  return { source, worktree: isolated.worktree, baseCommit: repository.head };
}

describe('canonical temporary-index diffs', () => {
  it('produces a canonical new-file-only diff without git add -N or --no-index', async () => {
    const { worktree } = await fixture();
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\n', 'utf8');
    const snapshot = await canonicalWorktreeSnapshot(worktree);
    expect(snapshot.files).toEqual(['result.txt']);
    expect(snapshot.diff).toContain('diff --git a/result.txt b/result.txt');
    expect(snapshot.diff).toContain('new file mode');
    expect(snapshot.stat).toContain('result.txt');
    expect(snapshot.tree).toMatch(/^[0-9a-f]{40}$/);
    // The real index must remain untouched: no intent-to-add entries.
    const indexFiles = await runCommand({
      argv: ['git', 'diff', '--cached', '--name-only'],
      cwd: worktree,
    });
    expect(indexFiles.stdout).toBe('');
    expect(await workingDiff(worktree)).toBe(snapshot.diff);
  });

  it('covers mixed tracked edits and untracked additions in one tree', async () => {
    const { worktree } = await fixture();
    await writeFile(path.join(worktree, 'README.md'), '# Modified\n', 'utf8');
    await mkdir(path.join(worktree, 'lib'), { recursive: true });
    await writeFile(path.join(worktree, 'lib', 'util.txt'), 'util\n', 'utf8');
    const files = await changedFiles(worktree);
    expect(files).toEqual(['README.md', 'lib/util.txt']);
    const snapshot = await canonicalWorktreeSnapshot(worktree);
    expect(snapshot.files).toEqual(files);
    expect(snapshot.diff).toContain('diff --git a/README.md b/README.md');
    expect(snapshot.diff).toContain('diff --git a/lib/util.txt b/lib/util.txt');
  });

  it('records deletions and mode changes canonically', async () => {
    const { worktree } = await fixture();
    await runCommand({ argv: ['chmod', '755', path.join(worktree, 'README.md')], cwd: worktree });
    await writeFile(path.join(worktree, 'gone.txt'), 'will be deleted\n', 'utf8');
    await runCommand({ argv: ['git', 'add', '--', 'gone.txt'], cwd: worktree });
    await runCommand({ argv: ['git', 'commit', '-qm', 'add gone.txt'], cwd: worktree });
    await runCommand({ argv: ['git', 'rm', '--quiet', 'gone.txt'], cwd: worktree });

    const snapshot = await canonicalWorktreeSnapshot(worktree);
    expect(snapshot.files).toEqual(['README.md', 'gone.txt']);
    expect(snapshot.diff).toContain('deleted file mode');
    expect(snapshot.diff).toContain('old mode 100644');
    expect(snapshot.diff).toContain('new mode 100755');
  });

  it('excludes untracked .reasonix/** runtime metadata everywhere', async () => {
    const { worktree } = await fixture();
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\n', 'utf8');
    await mkdir(path.join(worktree, '.reasonix', 'session'), { recursive: true });
    await writeFile(path.join(worktree, '.reasonix', 'session', 'state.json'), '{}\n', 'utf8');
    await writeFile(path.join(worktree, '.reasonix', 'journal.log'), 'trace\n', 'utf8');

    expect(await changedFiles(worktree)).toEqual(['result.txt']);
    const snapshot = await canonicalWorktreeSnapshot(worktree);
    expect(snapshot.files).toEqual(['result.txt']);
    expect(snapshot.diff).not.toContain('.reasonix');
    expect(snapshot.stat).not.toContain('.reasonix');
    // No .gitignore was added; the metadata still stays out of the canonical tree.
    const ignored = await runCommand({
      argv: ['git', 'check-ignore', '--', '.reasonix/session/state.json'],
      cwd: worktree,
    });
    expect(ignored.exitCode).toBe(1);
  });

  it('rejects tracked .reasonix/** changes as scope violations', async () => {
    const { worktree } = await fixture();
    await mkdir(path.join(worktree, '.reasonix'), { recursive: true });
    await writeFile(path.join(worktree, '.reasonix', 'tracked.txt'), 'v1\n', 'utf8');
    await runCommand({ argv: ['git', 'add', '--', '.reasonix/tracked.txt'], cwd: worktree });
    await runCommand({ argv: ['git', 'commit', '-qm', 'add tracked metadata'], cwd: worktree });
    await writeFile(path.join(worktree, '.reasonix', 'tracked.txt'), 'v2\n', 'utf8');

    const contract = parseTaskContract(
      contractFixture({ write_scope: ['result.txt', '.reasonix/**'] }),
    );
    const files = await changedFiles(worktree);
    expect(files).toEqual(['.reasonix/tracked.txt']);
    await expect(assertChangedFilesInScope(worktree, contract, files)).rejects.toMatchObject({
      code: 'scope_violation',
    });
  });

  it('matches the staged tree after explicit staging without intent-to-add', async () => {
    const { worktree } = await fixture();
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\n', 'utf8');
    await mkdir(path.join(worktree, '.reasonix'), { recursive: true });
    await writeFile(path.join(worktree, '.reasonix', 'state.json'), '{}\n', 'utf8');

    const reviewed = await canonicalWorktreeTree(worktree);
    const files = await changedFiles(worktree);
    expect(files).toEqual(['result.txt']);
    await stageExplicitFiles(worktree, files);
    expect(await stagedTree(worktree)).toBe(reviewed);
  });

  it('keeps diffStat and workingDiff consistent with the canonical snapshot', async () => {
    const { worktree } = await fixture();
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\n', 'utf8');
    const snapshot = await canonicalWorktreeSnapshot(worktree);
    expect(await diffStat(worktree)).toBe(snapshot.stat);
    expect(await workingDiff(worktree)).toBe(snapshot.diff);
    // Round-trip: staging the canonical files yields the identical tree.
    await stageExplicitFiles(worktree, snapshot.files);
    expect(await stagedTree(worktree)).toBe(snapshot.tree);
  });
});
