import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';
import {
  discoverRepository,
  resolveGitIdentity,
  resolveGitIdentityAt,
} from '../../src/repository.js';
import type { RepositoryIdentity } from '../../src/types.js';
import { createGitRepository } from '../helpers.js';

describe('repository preflight', () => {
  it('prefers the bridge author environment over repository Git config', async () => {
    const repository = await discoverRepository(await createGitRepository());

    await expect(
      resolveGitIdentity(repository, {
        GIT_AUTHOR_NAME: 'Bridge Author',
        GIT_AUTHOR_EMAIL: 'bridge@example.invalid',
      }),
    ).resolves.toEqual({ name: 'Bridge Author', email: 'bridge@example.invalid' });
  });

  it('falls back independently to repository Git config', async () => {
    const repository = await discoverRepository(await createGitRepository());

    await expect(resolveGitIdentity(repository, {})).resolves.toEqual({
      name: 'Codex Reasonix Test',
      email: 'codex-reasonix@example.invalid',
    });
    await expect(
      resolveGitIdentity(repository, { GIT_AUTHOR_NAME: 'Environment Name' }),
    ).resolves.toEqual({
      name: 'Environment Name',
      email: 'codex-reasonix@example.invalid',
    });
  });

  it('reads standard global Git config without broadly exposing the bridge environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-global-identity-repo-'));
    const configHome = await mkdtemp(path.join(os.tmpdir(), 'reasonix-global-identity-home-'));
    const initialized = await runCommand({ argv: ['git', 'init', '-b', 'main'], cwd: root });
    expect(initialized.exitCode).toBe(0);
    await writeFile(
      path.join(configHome, '.gitconfig'),
      '[user]\n\tname = Global Author\n\temail = global@example.invalid\n',
      'utf8',
    );

    await expect(resolveGitIdentityAt(root, { HOME: configHome })).resolves.toEqual({
      name: 'Global Author',
      email: 'global@example.invalid',
    });
  });

  it('fails with a stable pre-provider error when identity is absent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-no-identity-'));
    const initialized = await runCommand({ argv: ['git', 'init', '-b', 'main'], cwd: root });
    expect(initialized.exitCode).toBe(0);
    const repository: RepositoryIdentity = {
      id: 'missing-identity',
      root,
      commonDir: path.join(root, '.git'),
      head: '0'.repeat(40),
    };

    await expect(resolveGitIdentity(repository, {})).rejects.toMatchObject({
      code: 'invalid_request',
      details: { missing: ['name', 'email'] },
    });
  });
});
