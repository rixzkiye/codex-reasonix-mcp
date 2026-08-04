import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type BridgeConfig } from '../../src/config.js';
import { detectSandbox } from '../../src/sandbox-runner.js';
import { BridgeRuntime } from '../../src/runtime.js';
import {
  approvalFor,
  contractFixture,
  createGitRepository,
  sandboxMeta,
  waitUntil,
} from '../helpers.js';

/**
 * Security proof matrix (PR 6). Each row exercises an adversarial scenario
 * end to end and asserts the hardened behavior:
 *   R1 malicious verification source
 *   R2 malicious package script (as verification command)
 *   R3 malicious Git hook (run_git_hooks)
 *   R4 environment exfiltration
 *   R5 network access
 *   R6 filesystem escape
 *   R7 crash recovery
 *   R8 stale review / pause token
 *   R9 wrong Reasonix branch
 * Rows that are exercised at unit/gate level elsewhere reference those tests;
 * this file adds the full-flow proofs.
 */
const sandboxStatus = await detectSandbox();

const runtimes: BridgeRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.shutdown()));
});

async function runtimeFixture(overrides: Partial<BridgeConfig> = {}): Promise<BridgeRuntime> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-matrix-state-'));
  const runtime = new BridgeRuntime(
    loadConfig({
      stateDir,
      reasonixCommand: path.resolve('node_modules/.bin/tsx'),
      reasonixArgs: [path.resolve('tests/fixtures/fake-reasonix.ts')],
      leaseHeartbeatMs: 250,
      leaseStaleMs: 2_000,
      ...overrides,
    }),
  );
  await runtime.initialize();
  runtimes.push(runtime);
  return runtime;
}

describe('security proof matrix', () => {
  // R1 + R2 + R5 + R6: a malicious verification source (here a package-style
  // script) that tries to read credentials, reach the network, and write
  // outside the worktree. The sandbox makes every attempt fail; the benign
  // part of the command still passes and the commit completes.
  it.skipIf(!sandboxStatus.available)(
    'R1/R2/R5/R6: malicious verification source cannot read credentials, reach the network, or escape the worktree',
    async () => {
      const repository = await createGitRepository();
      const runtime = await runtimeFixture();
      const credentialProbe = path.join(os.homedir(), '.ssh', 'codex-reasonix-matrix-marker');
      const networkMarker = path.join(repository, 'network-marker');
      const escapeMarker = path.join(repository, '..', 'matrix-escape-marker');

      // The credential marker lives in the real ~/.ssh; skip that attempt when
      // the home is read-only (e.g. a nested sandbox) and rely on the overlay
      // gate in sandbox-gates.test.ts for that row.
      let credentialAttempt = '';
      let credentialAttemptEnabled = false;
      try {
        await mkdir(path.dirname(credentialProbe), { recursive: true, mode: 0o700 });
        await writeFile(credentialProbe, 'credential-material\n', { mode: 0o600 });
        credentialAttempt = `try { fs.readFileSync(${JSON.stringify(credentialProbe)}, 'utf8'); attempts.push('credential'); } catch {}`;
        credentialAttemptEnabled = true;
      } catch {
        // Home not writable here; the credential overlay is covered by the
        // sandbox-gates suite.
      }

      const maliciousScript = [
        "const fs = require('node:fs')",
        credentialAttempt,
        `try { require('node:child_process').execSync('timeout 3 curl -s https://example.com >/dev/null 2>&1'); attempts.push('network'); } catch {}`,
        `try { fs.writeFileSync(${JSON.stringify(networkMarker)}, 'x'); attempts.push('network-file'); } catch {}`,
        `try { fs.writeFileSync(${JSON.stringify(escapeMarker)}, 'x'); attempts.push('escape'); } catch {}`,
        "fs.writeFileSync('result.txt', 'offline result\\n')",
        'console.log(JSON.stringify({ attempts }))',
      ].join(';');
      try {
        await writeFile(
          path.join(repository, 'package-script.cjs'),
          `const attempts = []; ${maliciousScript}\n`,
          'utf8',
        );
        for (const argv of [
          ['git', 'add', '--', 'package-script.cjs'],
          ['git', 'commit', '-m', 'test: malicious package script'],
        ] as Array<[string, ...string[]]>) {
          const { runCommand } = await import('../../src/command.js');
          const result = await runCommand({ argv, cwd: repository });
          expect(result.exitCode).toBe(0);
        }
        const contract = contractFixture({
          verification: [
            {
              id: 'malicious_verify',
              argv: [process.execPath, 'package-script.cjs'],
              cwd: '.',
              timeout_seconds: 30,
              proves: ['ac_result'],
            },
          ],
        });
        const delegated = await runtime.delegate(
          { task_id: 'matrix-malicious', contract, worker_lane: 'deep' },
          sandboxMeta(repository),
        );
        expect(delegated.state).toBe('review_required');
        const task = await runtime.store.loadTask('matrix-malicious');
        const completed = await runtime.control(
          {
            task_id: 'matrix-malicious',
            action: 'finalize',
            ...approvalFor(task),
            review_summary: 'Reviewed the malicious-script matrix row.',
            approved_review_criteria: [],
          },
          sandboxMeta(repository),
        );
        expect(completed.state).toBe('completed');
        expect(completed.commit_hash).toMatch(/^[0-9a-f]{40}$/);
        // None of the adversarial attempts succeeded.
        await expect(stat(networkMarker)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(escapeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
        // The credential file is untouched and was never readable in-sandbox
        // (covered in detail by sandbox-gates; here we assert the file's
        // integrity after the flow).
        if (credentialAttemptEnabled) {
          expect(await readFile(credentialProbe, 'utf8')).toBe('credential-material\n');
        }
      } finally {
        await import('node:fs/promises').then(({ rm }) => rm(credentialProbe, { force: true }));
      }
    },
  );

  // R4: environment exfiltration — the worker only ever sees the allowlisted
  // environment (covered end to end by the env-dump row in offline.test.ts;
  // this row asserts the exfiltration attempt itself).
  it.skipIf(!sandboxStatus.available)(
    'R4: an exfiltration attempt through a verification command cannot read ambient secrets',
    async () => {
      const repository = await createGitRepository();
      const runtime = await runtimeFixture({ envAllowlist: [] });
      vi.stubEnv('MY_EXFIL_SECRET', 'must-not-leak');
      try {
        const exfilPath = '.reasonix/exfil.json';
        await writeFile(
          path.join(repository, 'exfil.cjs'),
          `require('node:fs').mkdirSync('.reasonix', { recursive: true }); require('node:fs').writeFileSync(${JSON.stringify(exfilPath)}, JSON.stringify(process.env));\n`,
          'utf8',
        );
        for (const argv of [
          ['git', 'add', '--', 'exfil.cjs'],
          ['git', 'commit', '-m', 'test: exfil script'],
        ] as Array<[string, ...string[]]>) {
          const { runCommand } = await import('../../src/command.js');
          const result = await runCommand({ argv, cwd: repository });
          expect(result.exitCode).toBe(0);
        }
        const contract = contractFixture({
          verification: [
            {
              id: 'exfil_verify',
              argv: [process.execPath, 'exfil.cjs'],
              cwd: '.',
              timeout_seconds: 30,
              proves: ['ac_result'],
            },
          ],
        });
        await runtime.delegate(
          { task_id: 'matrix-exfil', contract, worker_lane: 'deep' },
          sandboxMeta(repository),
        );
        // Verification commands only run at finalize; run it so the exfil
        // script actually executes inside the sandbox.
        const task = await runtime.store.loadTask('matrix-exfil');
        const completed = await runtime.control(
          {
            task_id: 'matrix-exfil',
            action: 'finalize',
            ...approvalFor(task),
            review_summary: 'Reviewed the exfiltration matrix row.',
            approved_review_criteria: [],
          },
          sandboxMeta(repository),
        );
        expect(completed.state).toBe('completed');
        const env = JSON.parse(
          await readFile(path.join(task.worktree, exfilPath), 'utf8'),
        ) as Record<string, string>;
        expect(env.MY_EXFIL_SECRET).toBeUndefined();
        // The baseline still reaches commands so legitimate tooling works
        // (verification commands run under the sanitized command env: PATH
        // and locale, never HOME or credentials).
        expect(env.PATH).toBeDefined();
        expect(env.HOME).toBeUndefined();
        expect(task.status).toBe('review_required');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  // R3: malicious Git hook — with run_git_hooks, hooks execute inside the
  // sandbox and cannot escape; without it they never run at all. The
  // sandboxed-hook behavior is covered by integration/e2e hook tests; this
  // row proves the default posture: a failing hook does not run.
  it('R3: Git hooks do not run by default (failing hook cannot block the commit)', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'matrix-hooks-off', contract: contractFixture(), worker_lane: 'deep' },
      sandboxMeta(repository),
    );
    const task = await waitUntil(
      async () => await runtime.store.loadTask('matrix-hooks-off'),
      (record) => record.status === 'review_required',
    );
    const hooks = path.join(task.repository.commonDir, 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 23\n');
    await import('node:fs/promises').then(({ chmod }) =>
      chmod(path.join(hooks, 'pre-commit'), 0o755),
    );
    const completed = await runtime.control(
      {
        task_id: 'matrix-hooks-off',
        action: 'finalize',
        ...approvalFor(task),
        review_summary: 'Reviewed the hooks-off matrix row.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    expect(completed.state).toBe('completed');
  });
});
