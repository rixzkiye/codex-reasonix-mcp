import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { BridgeError } from './errors.js';
import { redactString } from './redaction.js';
import { runSandboxed } from './sandbox-runner.js';
import { evidenceHash } from './security.js';
import { atomicWrite, type StateStore } from './state.js';
import type { TaskRecord, VerificationEvidence } from './types.js';
import type { BridgeConfig } from './config.js';

async function verificationCwd(worktree: string, repositoryCwd: string): Promise<string> {
  const target = path.resolve(worktree, ...repositoryCwd.split('/'));
  const [root, resolved] = await Promise.all([realpath(worktree), realpath(target)]);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BridgeError('scope_violation', `Verification cwd escapes worktree: ${repositoryCwd}`);
  }
  return resolved;
}

export async function runAllVerification(
  task: TaskRecord,
  store: StateStore,
  config: BridgeConfig,
  signal?: AbortSignal,
): Promise<VerificationEvidence[]> {
  const output: VerificationEvidence[] = [];
  const directory = store.verificationDir(task.taskId);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (const verification of task.contract.verification) {
    const cwd = await verificationCwd(task.worktree, verification.cwd ?? '.');
    const startedAt = new Date().toISOString();
    const result = await runSandboxed(
      {
        worktree: task.worktree,
        argv: verification.argv,
        cwd,
        timeoutMs: (verification.timeout_seconds ?? 600) * 1_000,
        maxOutputBytes: 4 * 1024 * 1024,
        signal,
      },
      config.allowUnsandboxed,
    );
    const finishedAt = new Date().toISOString();
    const log = redactString(
      [
        `$ ${JSON.stringify(verification.argv)}`,
        `cwd: ${verification.cwd ?? '.'}`,
        `exit: ${String(result.exitCode)} timeout: ${String(result.timedOut)}`,
        '',
        result.stdout,
        result.stderr,
      ].join('\n'),
      4 * 1024 * 1024,
    );
    const logPath = path.join(directory, `${verification.id}.log`);
    await atomicWrite(logPath, log);
    const evidence: VerificationEvidence = {
      id: verification.id,
      argv: [...verification.argv],
      cwd: verification.cwd ?? '.',
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      passed: result.exitCode === 0 && !result.timedOut && !result.outputTruncated,
      proves: [...verification.proves],
      logPath,
      sha256: evidenceHash(log),
      outputBytes: Buffer.byteLength(log),
    };
    output.push(evidence);
    await store.recordEvent(task.taskId, 'verification_finished', evidence, (record) => {
      record.verification = [...output];
    });
  }
  return output;
}
