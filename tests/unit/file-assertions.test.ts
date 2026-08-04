import { symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  parseTaskContract,
  canonicalContractJson,
  contractHash,
  type TaskContractV1,
} from '../../src/contracts.js';
import {
  fileAssertionEvidenceForCriterion,
  verifyFileAssertions,
} from '../../src/file-assertions.js';
import { BridgeError } from '../../src/errors.js';
import { contractFixture } from '../helpers.js';

async function worktreeFixture(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-assertions-'));
}

function contractWithAssertions(assertions: TaskContractV1['file_assertions']): TaskContractV1 {
  return parseTaskContract(
    contractFixture({
      acceptance_criteria: [
        { id: 'ac_result', requirement: 'result.txt matches', evidence: 'automated' },
      ],
      verification: [],
      file_assertions: assertions,
    }),
  );
}

describe('file assertions', () => {
  it('verifies exact UTF-8 bytes including the trailing newline', async () => {
    const worktree = await worktreeFixture();
    const contract = contractWithAssertions([
      {
        id: 'fa_result',
        path: 'result.txt',
        expected_utf8: 'offline result\n',
        proves: ['ac_result'],
      },
    ]);
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\n', 'utf8');
    const evidence = await verifyFileAssertions(worktree, contract);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      id: 'fa_result',
      path: 'result.txt',
      outputBytes: 15,
      proves: ['ac_result'],
    });
    expect(evidence[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence[0]!.sha256).not.toContain('offline');
  });

  it('rejects an extra line as a repairable verification failure', async () => {
    const worktree = await worktreeFixture();
    const contract = contractWithAssertions([
      {
        id: 'fa_result',
        path: 'result.txt',
        expected_utf8: 'offline result\n',
        proves: ['ac_result'],
      },
    ]);
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\nextra line\n', 'utf8');
    await expect(verifyFileAssertions(worktree, contract)).rejects.toMatchObject({
      code: 'verification_failed',
    });
  });

  it('rejects a missing trailing newline', async () => {
    const worktree = await worktreeFixture();
    const contract = contractWithAssertions([
      {
        id: 'fa_result',
        path: 'result.txt',
        expected_utf8: 'offline result\n',
        proves: ['ac_result'],
      },
    ]);
    await writeFile(path.join(worktree, 'result.txt'), 'offline result', 'utf8');
    let failure: unknown;
    try {
      await verifyFileAssertions(worktree, contract);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BridgeError);
    expect(failure).toMatchObject({ code: 'verification_failed' });
    expect((failure as BridgeError).details).toMatchObject({
      expectedBytes: 15,
      actualBytes: 14,
      differsOnlyInBytes: false,
    });
  });

  it('rejects a missing assertion target without leaking content', async () => {
    const worktree = await worktreeFixture();
    const contract = contractWithAssertions([
      {
        id: 'fa_result',
        path: 'result.txt',
        expected_utf8: 'offline result\n',
        proves: ['ac_result'],
      },
    ]);
    let failure: unknown;
    try {
      await verifyFileAssertions(worktree, contract);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'verification_failed' });
    expect(JSON.stringify((failure as BridgeError).details)).not.toContain('offline result');
  });

  it('rejects sensitive assertion paths as secret_detected', async () => {
    const worktree = await worktreeFixture();
    const contract = contractWithAssertions([
      {
        id: 'fa_env',
        path: '.env',
        expected_utf8: 'TOKEN=x\n',
        proves: ['ac_result'],
      },
    ]);
    await writeFile(path.join(worktree, '.env'), 'TOKEN=x\n', 'utf8');
    await expect(verifyFileAssertions(worktree, contract)).rejects.toMatchObject({
      code: 'secret_detected',
    });
  });

  it('resolves symlink escapes in assertion paths as scope violations', async () => {
    const worktree = await worktreeFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
    await symlink(outside, path.join(worktree, 'link'));
    const contract = contractWithAssertions([
      {
        id: 'fa_link',
        path: 'link/secret.txt',
        expected_utf8: 'outside\n',
        proves: ['ac_result'],
      },
    ]);
    await expect(verifyFileAssertions(worktree, contract)).rejects.toMatchObject({
      code: 'scope_violation',
    });
  });

  it('aggregates hash and byte length evidence per criterion', async () => {
    const worktree = await worktreeFixture();
    const contract = contractWithAssertions([
      {
        id: 'fa_a',
        path: 'a.txt',
        expected_utf8: 'aaa\n',
        proves: ['ac_result'],
      },
      {
        id: 'fa_b',
        path: 'b.txt',
        expected_utf8: 'bbbb\n',
        proves: ['ac_result'],
      },
    ]);
    await writeFile(path.join(worktree, 'a.txt'), 'aaa\n', 'utf8');
    await writeFile(path.join(worktree, 'b.txt'), 'bbbb\n', 'utf8');
    const evidence = await verifyFileAssertions(worktree, contract);
    const aggregated = fileAssertionEvidenceForCriterion(evidence, 'ac_result');
    expect(aggregated).toBeDefined();
    expect(aggregated!.source).toBe('file_assertion:fa_a,file_assertion:fa_b');
    expect(aggregated!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(aggregated!.outputBytes).toBe(9);
    expect(JSON.stringify(aggregated)).not.toContain('aaa');
  });
});

describe('file assertion contract lint', () => {
  it('accepts assertions that prove automated criteria and rejects review criteria', () => {
    expect(() =>
      contractWithAssertions([
        {
          id: 'fa_result',
          path: 'result.txt',
          expected_utf8: 'offline result\n',
          proves: ['ac_result'],
        },
      ]),
    ).not.toThrow();
    expect(() =>
      parseTaskContract(
        contractFixture({
          acceptance_criteria: [{ id: 'ac_review', requirement: 'reviewed', evidence: 'review' }],
          verification: [],
          file_assertions: [
            {
              id: 'fa_result',
              path: 'result.txt',
              expected_utf8: 'x\n',
              proves: ['ac_review'],
            },
          ],
        }),
      ),
    ).toThrow(/can only prove automated acceptance criteria/);
  });

  it('rejects assertions for unknown criteria and oversized expected content', () => {
    expect(() =>
      contractWithAssertions([
        {
          id: 'fa_bad',
          path: 'result.txt',
          expected_utf8: 'x\n',
          proves: ['missing_criterion'],
        },
      ]),
    ).toThrow(/Unknown acceptance criterion/);
    expect(() =>
      contractWithAssertions([
        {
          id: 'fa_big',
          path: 'result.txt',
          expected_utf8: 'x'.repeat(64 * 1024 + 1),
          proves: ['ac_result'],
        },
      ]),
    ).toThrow();
  });

  it('keeps the contract hash backward compatible when file_assertions is absent', () => {
    const base = parseTaskContract(contractFixture());
    expect(base.file_assertions).toBeUndefined();
    // Contracts without file_assertions hash exactly as before: no default
    // array is injected into the canonical JSON.
    const again = parseTaskContract(contractFixture());
    expect(canonicalContractJson(again)).toBe(canonicalContractJson(base));
    expect(contractHash(again)).toBe(contractHash(base));
  });

  it('normalizes assertion paths repository-relative', () => {
    const contract = contractWithAssertions([
      {
        id: 'fa_nested',
        path: './sub/./result.txt',
        expected_utf8: 'x\n',
        proves: ['ac_result'],
      },
    ]);
    expect(contract.file_assertions?.[0]?.path).toBe('sub/result.txt');
  });
});
