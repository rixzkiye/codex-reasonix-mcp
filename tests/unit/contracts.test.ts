import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertPathInsideWorktree,
  canonicalContractJson,
  contractAllowedCommands,
  contractHash,
  isCommandAllowedByContract,
  isWriteAllowed,
  lintTaskContract,
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

  it('preserves the legacy contract hash when allowed_commands is absent', () => {
    const contract = parseTaskContract({
      schema_version: 1,
      objective: 'Legacy objective',
      user_outcome: 'Legacy outcome',
      verified_context: [],
      write_scope: ['src/**'],
      forbidden_scope: [],
      invariants: [],
      non_goals: [],
      acceptance_criteria: [{ id: 'ac', requirement: 'It works', evidence: 'automated' }],
      verification: [{ id: 'verify', argv: ['node', '--version'], proves: ['ac'] }],
      pause_conditions: [],
    });

    expect(contract).not.toHaveProperty('allowed_commands');
    expect(contractHash(contract)).toBe(
      '717c0368d09239233ae07e38ecf639c883f6d4f74448575d3d07717246e438b6',
    );
  });

  it('normalizes allowed command defaults and matches exact argv plus cwd', () => {
    const contract = parseTaskContract({
      ...contractFixture(),
      allowed_commands: [{ id: 'project_test', argv: ['pnpm', 'test'], cwd: './packages/app' }],
    });

    expect(contract.allowed_commands).toEqual([
      {
        id: 'project_test',
        argv: ['pnpm', 'test'],
        cwd: 'packages/app',
        timeout_seconds: 120,
      },
    ]);
    expect(isCommandAllowedByContract(contract, ['pnpm', 'test'], 'packages/app')).toBe(true);
    expect(isCommandAllowedByContract(contract, ['pnpm', 'test', '--run'], 'packages/app')).toBe(
      false,
    );
    expect(isCommandAllowedByContract(contract, ['pnpm', 'test'], '.')).toBe(false);
  });

  it('implicitly allows verification without turning allowed commands into evidence', () => {
    const contract = parseTaskContract({
      ...contractFixture(),
      allowed_commands: [{ id: 'format', argv: ['pnpm', 'format'] }],
    });
    const commands = contractAllowedCommands(contract);

    expect(commands.map((command) => command.id)).toEqual(['verify_result', 'format']);
    expect(isCommandAllowedByContract(contract, contract.verification[0]!.argv, '.')).toBe(true);
    expect(contract.allowed_commands?.[0]).not.toHaveProperty('proves');
  });

  it('lints all safely-evaluable semantic problems together', () => {
    const fixture = contractFixture();
    const issues = lintTaskContract({
      ...fixture,
      verified_context: [{ path: '/absolute', reason: 'invalid path' }],
      write_scope: ['../escape'],
      acceptance_criteria: [...fixture.acceptance_criteria, { ...fixture.acceptance_criteria[0] }],
      verification: [{ ...fixture.verification[0], cwd: '../../escape', proves: ['unknown'] }],
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'verified_context.0.path',
        'write_scope.0',
        'verification.0.cwd',
        'acceptance_criteria.1.id',
        'verification.0.proves.0',
        'verification',
      ]),
    );
    expect(issues).toHaveLength(6);
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

  it.each([
    ['an empty first argument', ['', '--version']],
    ['more than 128 arguments', Array.from({ length: 129 }, () => 'arg')],
    ['an argument over 4,096 characters', ['command', 'x'.repeat(4_097)]],
  ])('rejects verification argv with %s', (_reason, argv) => {
    const fixture = contractFixture();
    expect(() =>
      parseTaskContract({
        ...fixture,
        verification: [{ ...fixture.verification[0], argv }],
      }),
    ).toThrow(BridgeError);
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
