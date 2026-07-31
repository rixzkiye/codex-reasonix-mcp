import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertPathInsideWorktree,
  canonicalContractJson,
  contractHash,
  isWriteAllowed,
  parseTaskContract,
  renderGoalPrompt,
} from '../../src/contracts.js';
import { BridgeError } from '../../src/errors.js';
import { contractFixture } from '../helpers.js';

describe('TaskContractV1', () => {
  it('normalizes paths and hashes canonical JSON deterministically', () => {
    const first = parseTaskContract({
      ...contractFixture(),
      write_scope: ['src\\**\\*.ts'],
      verification: contractFixture().verification.map((item) => ({ ...item, cwd: './' })),
    });
    const second = parseTaskContract(JSON.parse(JSON.stringify(first)));
    expect(first.write_scope).toEqual(['src/**/*.ts']);
    expect(first.verification[0]?.cwd).toBe('.');
    expect(contractHash(first)).toBe(contractHash(second));
    expect(canonicalContractJson(first)).toMatch(/"schema_version": 1/);
  });

  it.each(['/absolute', '../escape', 'src/../../escape', 'C:\\escape'])(
    'rejects unsafe scope %s',
    (scope) => {
      expect(() => parseTaskContract({ ...contractFixture(), write_scope: [scope] })).toThrow(
        BridgeError,
      );
    },
  );

  it('requires every automated criterion to have verification evidence', () => {
    expect(() => parseTaskContract({ ...contractFixture(), verification: [] })).toThrow(
      /lack verification/,
    );
  });

  it('makes forbidden_scope win over write_scope', () => {
    const contract = parseTaskContract({
      ...contractFixture(),
      write_scope: ['src/**'],
      forbidden_scope: ['src/secrets/**'],
    });
    expect(isWriteAllowed(contract, 'src/index.ts')).toBe(true);
    expect(isWriteAllowed(contract, 'src/secrets/key.ts')).toBe(false);
  });

  it('detects symlink escapes for existing and not-yet-created descendants', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'contract-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'contract-outside-'));
    await mkdir(path.join(outside, 'nested'));
    await symlink(outside, path.join(root, 'link'));
    await expect(assertPathInsideWorktree(root, 'link/nested/new.txt')).rejects.toMatchObject({
      code: 'scope_violation',
    });
  });

  it('rejects dangling symlinks instead of treating their lexical parent as safe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'contract-dangling-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'contract-dangling-outside-'));
    await symlink(path.join(outside, 'missing'), path.join(root, 'link'));
    await expect(assertPathInsideWorktree(root, 'link')).rejects.toMatchObject({
      code: 'scope_violation',
    });
  });

  it('renders a deterministic Goal prompt with immutable supervisor boundaries', () => {
    const contract = parseTaskContract(contractFixture());
    const prompt = renderGoalPrompt('task-1', contract, contractHash(contract));
    expect(prompt).toContain('Do not commit, stage, push, merge, rebase');
    expect(prompt).toContain('[ac_result] (automated)');
    expect(prompt).toContain(JSON.stringify(contract.verification[0]?.argv));
  });
});
