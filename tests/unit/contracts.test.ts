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
  normalizeContractPaths,
  parseTaskContract,
  parseTaskContractForInvocation,
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

  it('defaults administrative arrays while retaining required delivery fields', () => {
    const contract = parseTaskContract({
      schema_version: 1,
      objective: 'Implement the requested change',
      user_outcome: 'The change works',
      write_scope: ['result.txt'],
      acceptance_criteria: [{ id: 'review', requirement: 'Review passes', evidence: 'review' }],
      verification: [],
    });

    expect(contract).toMatchObject({
      verified_context: [],
      forbidden_scope: [],
      invariants: [],
      non_goals: [],
      pause_conditions: [],
    });
    expect(contract).not.toHaveProperty('allowed_commands');
  });

  it('allows repository root as verified context but not as write scope', () => {
    const contract = parseTaskContract({
      ...contractFixture(),
      verified_context: [{ path: '.', reason: 'The whole repository was inspected' }],
    });
    expect(contract.verified_context[0]?.path).toBe('.');
    expect(() => parseTaskContract({ ...contractFixture(), write_scope: ['.'] })).toThrow(
      /repository root/,
    );
  });

  it('normalizes every contract path from a nested invocation cwd before hashing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'contract-nested-repo-'));
    await mkdir(path.join(root, 'packages', 'app'), { recursive: true });
    const input = {
      ...contractFixture(),
      verified_context: [{ path: '.', reason: 'Nested package context' }],
      write_scope: ['src/**'],
      forbidden_scope: ['src/generated/**'],
      verification: [{ ...contractFixture().verification[0], cwd: '.', argv: ['pnpm', 'test'] }],
      allowed_commands: [{ id: 'lint', argv: ['pnpm', 'lint'], cwd: 'tools' }],
    };
    const nested = parseTaskContractForInvocation(input, {
      repositoryRoot: root,
      invocationCwd: path.join(root, 'packages', 'app'),
      pathBase: 'cwd',
    });

    expect(nested.verified_context[0]?.path).toBe('packages/app');
    expect(nested.write_scope).toEqual(['packages/app/src/**']);
    expect(nested.forbidden_scope).toEqual(['packages/app/src/generated/**']);
    expect(nested.verification[0]?.cwd).toBe('packages/app');
    expect(nested.allowed_commands?.[0]?.cwd).toBe('packages/app/tools');
    expect(contractHash(nested)).toBe(
      contractHash(
        parseTaskContractForInvocation(input, {
          repositoryRoot: root,
          invocationCwd: path.join(root, 'packages', 'app'),
          pathBase: 'cwd',
        }),
      ),
    );
  });

  it('canonicalizes a symlinked invocation cwd before repository-relative mapping', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'contract-symlink-repo-'));
    await mkdir(path.join(root, 'packages', 'app'), { recursive: true });
    const aliasRoot = await mkdtemp(path.join(os.tmpdir(), 'contract-symlink-alias-'));
    const alias = path.join(aliasRoot, 'app');
    await symlink(path.join(root, 'packages', 'app'), alias);

    const contract = parseTaskContractForInvocation(contractFixture(), {
      repositoryRoot: root,
      invocationCwd: alias,
      pathBase: 'cwd',
    });
    expect(contract.write_scope).toEqual(['packages/app/result.txt']);
    expect(contract.verification[0]?.cwd).toBe('packages/app');
  });

  it('preserves legacy repository-root path semantics explicitly', () => {
    const contract = parseTaskContract(contractFixture());
    expect(
      normalizeContractPaths(contract, {
        repositoryRoot: '/repo',
        invocationCwd: '/repo/packages/app',
        pathBase: 'repository',
      }),
    ).toBe(contract);
  });

  it('rejects an invocation cwd outside the repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'contract-inside-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'contract-outside-'));
    expect(() =>
      parseTaskContractForInvocation(contractFixture(), {
        repositoryRoot: root,
        invocationCwd: outside,
        pathBase: 'cwd',
      }),
    ).toThrow(/inside the repository root/);
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

  it('deduplicates identical commands and keeps verification automatically allowed', () => {
    const fixture = contractFixture();
    const verifier = fixture.verification[0]!;
    const contract = parseTaskContract({
      ...fixture,
      verification: [verifier, { ...verifier }],
      allowed_commands: [
        {
          id: verifier.id,
          argv: [...verifier.argv],
          cwd: verifier.cwd,
          timeout_seconds: verifier.timeout_seconds,
        },
        { id: 'format', argv: ['pnpm', 'format'] },
        { id: 'format', argv: ['pnpm', 'format'] },
      ],
    });

    expect(contract.verification).toHaveLength(1);
    expect(contract.allowed_commands?.map((command) => command.id)).toEqual(['format']);
    expect(contractAllowedCommands(contract).map((command) => command.id)).toEqual([
      'verify_result',
      'format',
    ]);
  });

  it('deduplicates commands after applying cwd and timeout defaults', () => {
    const fixture = contractFixture();
    const verifier = { ...fixture.verification[0]!, cwd: undefined, timeout_seconds: undefined };
    const contract = parseTaskContract({
      ...fixture,
      verification: [verifier, { ...verifier, cwd: '.', timeout_seconds: 600 }],
      allowed_commands: [
        { id: 'format', argv: ['pnpm', 'format'] },
        { id: 'format', argv: ['pnpm', 'format'], cwd: '.', timeout_seconds: 120 },
      ],
    });

    expect(contract.verification).toHaveLength(1);
    expect(contract.allowed_commands).toHaveLength(1);
    expect(
      lintTaskContract({
        ...fixture,
        verification: [verifier, { ...verifier, cwd: '.', timeout_seconds: 600 }],
      }),
    ).toEqual([]);
  });

  it('aggregates incompatible command ids with every other lint issue', () => {
    const fixture = contractFixture();
    const issues = lintTaskContract({
      ...fixture,
      write_scope: ['../escape'],
      verification: [
        fixture.verification[0],
        { ...fixture.verification[0], argv: ['pnpm', 'test'], proves: ['missing'] },
      ],
      allowed_commands: [{ id: 'verify_result', argv: ['pnpm', 'lint'] }],
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'write_scope.0',
        'verification.1.id',
        'allowed_commands.0.id',
        'verification.1.proves.0',
      ]),
    );
    expect(() =>
      parseTaskContract({
        ...fixture,
        write_scope: ['../escape'],
        allowed_commands: [{ id: 'verify_result', argv: ['pnpm', 'lint'] }],
      }),
    ).toThrow(BridgeError);
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

  it('adds safely evaluable semantic issues to structural schema failures', () => {
    const fixture = contractFixture();
    const issues = lintTaskContract({
      ...fixture,
      objective: 42,
      write_scope: ['../escape'],
      acceptance_criteria: [...fixture.acceptance_criteria, { ...fixture.acceptance_criteria[0] }],
      verification: [{ ...fixture.verification[0], proves: ['unknown'] }],
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'objective',
        'write_scope.0',
        'acceptance_criteria.1.id',
        'verification.0.proves.0',
        'verification',
      ]),
    );
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
