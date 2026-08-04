import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkIgnore } from '../../src/repository.js';
import { createGitRepository } from '../helpers.js';

describe('read-only git check-ignore', () => {
  it('returns only explicitly ignored paths with exit code 0', async () => {
    const repository = await createGitRepository();
    await writeFile(path.join(repository, '.gitignore'), '*.log\nbuild/\n', 'utf8');
    await writeFile(path.join(repository, 'app.log'), 'trace\n', 'utf8');
    const ignored = await checkIgnore(repository, ['app.log', 'build/out.txt', 'README.md']);
    expect(ignored).toEqual(['app.log', 'build/out.txt']);
  });

  it('returns nothing when no path is ignored (exit code 1)', async () => {
    const repository = await createGitRepository();
    expect(await checkIgnore(repository, ['README.md'])).toEqual([]);
  });

  it('supports quiet and verbose modes without extra output', async () => {
    const repository = await createGitRepository();
    await writeFile(path.join(repository, '.gitignore'), '*.log\n', 'utf8');
    expect(await checkIgnore(repository, ['app.log'], { quiet: true })).toEqual([]);
    const verbose = await checkIgnore(repository, ['app.log'], { verbose: true });
    expect(verbose.length).toBe(1);
    expect(verbose[0]).toContain('.gitignore');
    expect(verbose[0]).toContain('app.log');
  });

  it('forbids empty path lists, absolute paths, parent traversal, dash paths, and NUL bytes', async () => {
    const repository = await createGitRepository();
    await expect(checkIgnore(repository, [])).rejects.toMatchObject({ code: 'invalid_request' });
    for (const unsafe of [
      '/etc/passwd',
      'C:\\windows\\file',
      '../escape',
      'a/../../escape',
      '-n',
      '--stdin',
      'path\u0000with-nul',
      '',
    ]) {
      await expect(checkIgnore(repository, [unsafe])).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
  });

  it('never forwards stdin or unknown options', async () => {
    const repository = await createGitRepository();
    // The helper only ever builds --quiet/--verbose/--; unknown option spellings
    // are rejected as unsafe paths by construction.
    await expect(checkIgnore(repository, ['--stdin-paths'])).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(checkIgnore(repository, ['-z'])).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
