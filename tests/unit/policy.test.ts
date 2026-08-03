import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { classifyStaticCommand, decidePermission } from '../../src/policy.js';
import { contractFixture } from '../helpers.js';

function request(
  kind: RequestPermissionRequest['toolCall']['kind'],
  rawInput: unknown,
  locations: Array<{ path: string }> = [],
  meta?: Record<string, unknown>,
): RequestPermissionRequest {
  return {
    sessionId: 'session',
    toolCall: {
      toolCallId: 'tool',
      kind,
      rawInput,
      locations,
      status: 'pending',
      ...(meta ? { _meta: meta } : {}),
    },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

function execute(argv: [string, ...string[]], cwd: string, raw: Record<string, unknown> = {}) {
  return request('execute', { command: argv.join(' '), ...raw }, [], {
    'reasonix.io': {
      approvalId: 'tool',
      commandSchemaVersion: 1,
      tool: 'bash',
      argv,
      cwd,
    },
  });
}

describe('shell-first permission policy', () => {
  const contract = parseTaskContract(
    contractFixture({
      allowed_commands: [
        { id: 'project_test', argv: ['pnpm', 'test'], cwd: '.', timeout_seconds: 90 },
        {
          id: 'env_test',
          argv: ['env', 'CI=1', '--', 'pnpm', 'test'],
          cwd: '.',
          timeout_seconds: 90,
        },
      ],
    }),
  );
  let worktree: string;

  beforeAll(async () => {
    worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-policy-worktree-'));
    await mkdir(path.join(worktree, 'src'));
    await writeFile(path.join(worktree, 'result.txt'), 'fixture\n', 'utf8');
  });

  it('auto-allows audited read argv and sanitized Git read-only commands', () => {
    const safe: Array<[string, ...string[]]> = [
      ['rg', '--files', 'src'],
      ['sed', '-n', '1,20p', 'result.txt'],
      ['cat', 'result.txt'],
      ['ls', '-la', 'src'],
      ['find', 'src', '-type', 'f', '-print'],
      ['git', 'status', '--short'],
      ['git', '--no-pager', 'diff', '--stat'],
      ['git', 'rev-parse', 'HEAD'],
    ];
    for (const argv of safe) {
      expect(classifyStaticCommand({ argv, cwd: '.' }, contract)).toMatchObject({
        action: 'allow',
      });
    }
  });

  it('hard-denies immutable command categories even when exact-listed', () => {
    const unsafe: Array<[string, ...string[]]> = [
      ['git', 'checkout', '-b', 'worker-change'],
      ['gh', 'pr', 'view'],
      ['curl', 'https://example.com'],
      ['sudo', 'id'],
      ['rm', '-rf', 'src'],
      ['bash', '-c', 'echo unsafe'],
      ['node', '-e', 'process.exit(0)'],
      ['pnpm', 'publish'],
      ['npm', 'run', 'release'],
      ['pnpm', 'install'],
      ['mv', 'result.txt', 'other.txt'],
    ];
    const listed = parseTaskContract({
      ...contractFixture(),
      allowed_commands: unsafe.map((argv, index) => ({ id: `unsafe_${String(index)}`, argv })),
    });
    for (const argv of unsafe) {
      expect(classifyStaticCommand({ argv, cwd: '.' }, listed)).toMatchObject({ action: 'deny' });
    }
  });

  it('allows exact contract commands and a restricted exact env wrapper only', () => {
    expect(classifyStaticCommand({ argv: ['pnpm', 'test'], cwd: '.' }, contract)).toEqual({
      action: 'allow',
      reason: 'Exact contract allowed command',
      timeoutSeconds: 90,
    });
    expect(
      classifyStaticCommand({ argv: ['env', 'CI=1', '--', 'pnpm', 'test'], cwd: '.' }, contract),
    ).toMatchObject({ action: 'allow' });
    for (const argv of [
      ['env', 'NODE_OPTIONS=--require=evil', '--', 'pnpm', 'test'],
      ['env', 'API_TOKEN=secret', '--', 'pnpm', 'test'],
      ['env', '-S', 'pnpm test'],
    ] as Array<[string, ...string[]]>) {
      expect(classifyStaticCommand({ argv, cwd: '.' }, contract)).toMatchObject({
        action: 'deny',
        code: 'env_injection',
      });
    }
  });

  it('rejects path escape and unknown executables with an actionable hint', () => {
    expect(classifyStaticCommand({ argv: ['cat', '../secret'], cwd: '.' }, contract)).toMatchObject(
      {
        action: 'deny',
      },
    );
    expect(
      classifyStaticCommand({ argv: ['du', '--files0-from=/etc/passwd'], cwd: '.' }, contract),
    ).toMatchObject({ action: 'deny' });
    const unknown = classifyStaticCommand(
      { argv: ['custom-project-tool', 'check'], cwd: '.' },
      contract,
    );
    expect(unknown).toMatchObject({ action: 'deny', code: 'unknown_executable' });
    expect(unknown.action === 'deny' ? unknown.recoveryHint : '').toContain(
      'new immutable contract',
    );
  });

  it('requires v1 static metadata and rejects metadata spoofing or mismatch', async () => {
    const missing = await decidePermission(
      request('execute', { argv: ['pnpm', 'test'], cwd: worktree }),
      contract,
      worktree,
    );
    expect(missing).toMatchObject({ action: 'deny' });
    expect(missing.reason).toContain('_meta.reasonix.io');

    const approvalMismatch = execute(['pnpm', 'test'], worktree);
    (approvalMismatch.toolCall._meta!['reasonix.io'] as Record<string, unknown>).approvalId =
      'other';
    const approval = await decidePermission(approvalMismatch, contract, worktree);
    expect(approval).toMatchObject({ action: 'deny' });
    expect(approval.reason).toContain('approvalId');

    const cwdMismatch = await decidePermission(
      execute(['pnpm', 'test'], worktree, { cwd: path.join(worktree, 'src') }),
      contract,
      worktree,
    );
    expect(cwdMismatch).toMatchObject({ action: 'deny' });
    expect(cwdMismatch.reason).toContain('does not match');

    const argvMismatch = execute(['pnpm', 'test'], worktree, { argv: ['pnpm', 'lint'] });
    const argvDecision = await decidePermission(argvMismatch, contract, worktree);
    expect(argvDecision).toMatchObject({ action: 'deny' });
    expect(argvDecision.reason).toContain('argv does not match');

    const escaped = await decidePermission(
      execute(['pnpm', 'test'], path.dirname(worktree)),
      contract,
      worktree,
    );
    expect(escaped).toMatchObject({ action: 'deny' });
    expect(escaped.reason).toContain('escapes');
  });

  it('allows the exact normalized argv and cwd from authoritative metadata', async () => {
    await expect(
      decidePermission(execute(['pnpm', 'test'], worktree), contract, worktree),
    ).resolves.toMatchObject({
      action: 'allow',
      timeoutSeconds: 90,
    });
    const mismatchedCwd = await decidePermission(
      execute(['pnpm', 'test'], path.join(worktree, 'src')),
      contract,
      worktree,
    );
    expect(mismatchedCwd).toMatchObject({ action: 'deny' });
    expect(mismatchedCwd.reason).toContain('not an audited');
  });

  it('rejects out-of-scope edits and Git or credential paths without waiting_permission', async () => {
    const broad = parseTaskContract({ ...contractFixture(), write_scope: ['**'] });
    await writeFile(path.join(worktree, '.env'), 'SECRET=value\n', 'utf8');
    await symlink('.env', path.join(worktree, 'apparently-safe.txt'));
    expect(
      await decidePermission(
        request('edit', { path: 'README.md' }, [{ path: `${worktree}/README.md` }]),
        contract,
        worktree,
      ),
    ).toMatchObject({ action: 'deny' });
    for (const value of [
      request('read', { path: '.env' }),
      request('read', { path: 'apparently-safe.txt' }),
      request('edit', { path: '.git/config', content: 'unsafe' }, [
        { path: `${worktree}/.git/config` },
      ]),
    ]) {
      expect(await decidePermission(value, broad, worktree)).toMatchObject({ action: 'deny' });
    }
  });

  it('classifies Reasonix ask interactions separately', async () => {
    const value = request('other', { question: 'Pick' });
    value.toolCall.toolCallId = 'ask-1';
    expect(await decidePermission(value, contract, worktree)).toMatchObject({
      action: 'ask',
      interactionKind: 'input',
    });
    const spoofed = execute(['curl', 'https://example.com'], worktree);
    spoofed.toolCall.toolCallId = 'ask-spoof';
    (spoofed.toolCall._meta!['reasonix.io'] as Record<string, unknown>).approvalId = 'ask-spoof';
    expect(await decidePermission(spoofed, contract, worktree)).toMatchObject({ action: 'deny' });
  });
});
