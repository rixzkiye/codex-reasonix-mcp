import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import { runAllVerification } from '../../src/verification.js';
import { contractFixture } from '../helpers.js';

describe('verification subprocess isolation', () => {
  it('does not forward provider credentials to contract commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-verification-state-'));
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-verification-worktree-'));
    const store = new StateStore(root);
    await store.initialize();
    const secret = 'provider-secret-must-not-leak';
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = secret;
    try {
      const contract = parseTaskContract(
        contractFixture({
          verification: [
            {
              id: 'verify_env',
              argv: [process.execPath, '-e', 'if (process.env.DEEPSEEK_API_KEY) process.exit(17)'],
              cwd: '.',
              timeout_seconds: 30,
              proves: ['ac_result'],
            },
          ],
        }),
      );
      const task = makeTaskRecordForTest(
        'verify-env',
        contract,
        { id: 'repo', root: worktree, commonDir: path.join(worktree, '.git'), head: 'base' },
        worktree,
      );
      await store.createTask(task);
      const evidence = await runAllVerification(task, store);
      expect(evidence).toMatchObject([{ id: 'verify_env', passed: true }]);
      expect(await readFile(evidence[0]!.logPath, 'utf8')).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
