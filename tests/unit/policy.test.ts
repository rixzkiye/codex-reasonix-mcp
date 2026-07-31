import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { decidePermission } from '../../src/policy.js';
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

describe('permission policy', () => {
  const contract = parseTaskContract(contractFixture());
  let worktree: string;

  beforeAll(async () => {
    worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-policy-worktree-'));
  });

  it('auto-allows structured edits only in write_scope', async () => {
    expect(
      await decidePermission(
        request('edit', { path: 'result.txt' }, [{ path: `${worktree}/result.txt` }]),
        contract,
        worktree,
      ),
    ).toMatchObject({ action: 'allow' });
    expect(
      await decidePermission(
        request('edit', { path: 'README.md' }, [{ path: `${worktree}/README.md` }]),
        contract,
        worktree,
      ),
    ).toMatchObject({ action: 'ask', canAllow: false });
  });

  it('auto-allows only exact verification argv and cwd', async () => {
    const argv = contract.verification[0]!.argv;
    expect(
      await decidePermission(
        request('execute', { command: 'model-supplied shell text' }, [], {
          'reasonix.io': {
            commandSchemaVersion: 1,
            tool: 'bash',
            argv,
            cwd: worktree,
          },
        }),
        contract,
        worktree,
      ),
    ).toMatchObject({ action: 'allow' });
    expect(
      await decidePermission(
        request('execute', { command: 'pnpm publish' }, [], {
          'reasonix.io': {
            commandSchemaVersion: 1,
            tool: 'bash',
            argv: ['pnpm', 'publish'],
            cwd: worktree,
          },
        }),
        contract,
        worktree,
      ),
    ).toMatchObject({ action: 'ask', canAllow: false });
  });

  it('does not trust argv supplied through model-controlled rawInput', async () => {
    expect(
      await decidePermission(
        request('execute', { argv: contract.verification[0]!.argv, cwd: '.' }),
        contract,
        worktree,
      ),
    ).toMatchObject({ action: 'ask', canAllow: false });
  });

  it('never auto-allows Git, network, destructive, or ambiguous raw commands', async () => {
    const commands: Array<[string, ...string[]]> = [
      ['git', 'status'],
      ['curl', 'https://example.com'],
      ['rm', '-rf', 'src'],
      ['sh', '-c', 'git status'],
      ['command', 'rm', '-rf', 'src'],
    ];
    const unsafeContract = parseTaskContract({
      ...contractFixture(),
      verification: commands.map((argv, index) => ({
        id: `unsafe_${String(index)}`,
        argv,
        cwd: '.',
        timeout_seconds: 30,
        proves: ['ac_result'],
      })),
    });
    for (const argv of commands) {
      expect(
        await decidePermission(
          request('execute', { command: argv.join(' ') }, [], {
            'reasonix.io': {
              commandSchemaVersion: 1,
              tool: 'bash',
              argv,
              cwd: worktree,
            },
          }),
          unsafeContract,
          worktree,
        ),
      ).toMatchObject({
        action: 'ask',
        canAllow: false,
        reason:
          'Git, network, destructive, and opaque wrapper commands are reserved for the supervisor',
      });
    }
    expect(
      await decidePermission(request('execute', { command: 'pnpm test' }), contract, worktree),
    ).toMatchObject({ action: 'ask', canAllow: false });
  });

  it('never auto-allows Git control or credential paths, including symlink aliases', async () => {
    const broad = parseTaskContract({ ...contractFixture(), write_scope: ['**'] });
    await writeFile(path.join(worktree, '.env'), 'SECRET=value\n', 'utf8');
    await symlink('.env', path.join(worktree, 'apparently-safe.txt'));
    for (const value of [
      request('read', { path: '.env' }),
      request('read', { path: '.ssh/id_ed25519' }),
      request('read', { path: 'apparently-safe.txt' }),
      request('edit', { path: '.git/config', content: 'unsafe' }, [
        { path: `${worktree}/.git/config` },
      ]),
    ]) {
      expect(await decidePermission(value, broad, worktree)).toMatchObject({
        action: 'ask',
        canAllow: false,
      });
    }
  });

  it('classifies Reasonix ask interactions separately', async () => {
    const value = request('other', { question: 'Pick' });
    value.toolCall.toolCallId = 'ask-1';
    expect(await decidePermission(value, contract, worktree)).toMatchObject({
      action: 'ask',
      interactionKind: 'input',
    });
  });
});
