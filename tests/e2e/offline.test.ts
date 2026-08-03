import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCommand } from '../../src/command.js';
import { loadConfig, type BridgeConfig } from '../../src/config.js';
import { BridgeRuntime } from '../../src/runtime.js';
import { contractFixture, createGitRepository, sandboxMeta, waitUntil } from '../helpers.js';

const runtimes: BridgeRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.shutdown()));
});

async function runtimeFixture(overrides: Partial<BridgeConfig> = {}): Promise<BridgeRuntime> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-e2e-state-'));
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

async function commitFixtureScript(
  repository: string,
  name: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(repository, name), content, 'utf8');
  for (const argv of [
    ['git', 'add', '--', name],
    ['git', 'commit', '-m', `test: add ${name}`],
  ] as Array<[string, ...string[]]>) {
    const result = await runCommand({ argv, cwd: repository });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
}

describe('offline Codex -> Reasonix -> Codex flow', () => {
  it('rejects a dirty source before starting Reasonix', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await writeFile(path.join(repository, 'dirty.txt'), 'dirty\n', 'utf8');
    await expect(
      runtime.delegate(
        { task_id: 'dirty-source', contract: contractFixture() },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'dirty_repository' });
  });

  it('returns delegation quickly, auto-allows scoped edit, verifies, and creates one commit', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const started = Date.now();
    const delegated = await runtime.delegate(
      { task_id: 'offline-success', contract: contractFixture() },
      sandboxMeta(repository),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(['provisioning', 'running']).toContain(delegated.state);

    const review = await waitUntil(
      async () => await runtime.store.loadTask('offline-success'),
      (task) => task.status === 'review_required',
    );
    expect(review.summary).toContain('Created result.txt');
    expect(review.usage.cacheHitTokens).toBe(7);
    expect(review.interactions).toEqual([]);

    const finalizing = await runtime.control(
      {
        task_id: 'offline-success',
        action: 'finalize',
        review_summary: 'Scoped diff reviewed.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    expect(finalizing.state).toBe('verifying');
    const completed = await waitUntil(
      async () => await runtime.store.loadTask('offline-success'),
      (task) => task.status === 'completed',
      20_000,
    );
    expect(completed.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(completed.verification).toHaveLength(1);
    expect(completed.verification[0]?.passed).toBe(true);
    expect(completed.acceptanceEvidence).toMatchObject([
      { criterionId: 'ac_result', evidence: 'automated', approved: true },
    ]);

    const count = await runCommand({
      argv: ['git', 'rev-list', '--count', `${completed.baseCommit}..${completed.commitHash!}`],
      cwd: repository,
    });
    expect(count.stdout.trim()).toBe('1');
    const mainHead = await runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: repository });
    expect(mainHead.stdout.trim()).toBe(completed.baseCommit);
  });

  it('leaves both index and history untouched when verification fails', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const contract = contractFixture({
      verification: [
        {
          id: 'verify_result',
          argv: ['test', '!', '-f', 'result.txt'],
          cwd: '.',
          timeout_seconds: 30,
          proves: ['ac_result'],
        },
      ],
    });
    await runtime.delegate({ task_id: 'offline-failed-test', contract }, sandboxMeta(repository));
    const review = await waitUntil(
      async () => await runtime.store.loadTask('offline-failed-test'),
      (task) => task.status === 'review_required',
    );
    await runtime.control(
      {
        task_id: review.taskId,
        action: 'finalize',
        review_summary: 'Diff reviewed.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    const failed = await waitUntil(
      async () => await runtime.store.loadTask('offline-failed-test'),
      (task) => task.status === 'commit_failed',
      20_000,
    );
    expect(failed.reason).toContain('verification_failed');
    expect(failed.commitHash).toBeUndefined();
    const staged = await runCommand({
      argv: ['git', 'diff', '--cached', '--name-only'],
      cwd: failed.worktree,
    });
    expect(staged.stdout).toBe('');
    const head = await runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: failed.worktree });
    expect(head.stdout.trim()).toBe(failed.baseCommit);
  });

  it('blocks finalize when a late source change overlaps write_scope', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'source-collision-finalize', contract: contractFixture() },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('source-collision-finalize'),
      (task) => task.status === 'review_required',
    );
    await writeFile(path.join(repository, 'result.txt'), 'user-owned source change\n', 'utf8');
    const before = await readFile(path.join(repository, 'result.txt'));

    await expect(
      runtime.control(
        {
          task_id: 'source-collision-finalize',
          action: 'finalize',
          review_summary: 'Scoped diff reviewed.',
          approved_review_criteria: [],
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });

    expect(await readFile(path.join(repository, 'result.txt'))).toEqual(before);
    expect(await runtime.store.loadTask('source-collision-finalize')).toMatchObject({
      status: 'paused',
      phase: 'source_collision',
      sourceCollision: {
        checkpoint: 'finalize_start',
        overlappingPaths: ['result.txt'],
      },
    });
  });

  it('stops finalization when source moves during verification', async () => {
    const repository = await createGitRepository();
    await commitFixtureScript(
      repository,
      'slow-verification.cjs',
      'setTimeout(() => process.exit(0), 700)\n',
    );
    const runtime = await runtimeFixture();
    const contract = contractFixture({
      verification: [
        {
          id: 'verify_result',
          argv: [process.execPath, 'slow-verification.cjs'],
          cwd: '.',
          timeout_seconds: 30,
          proves: ['ac_result'],
        },
      ],
    });
    await runtime.delegate(
      { task_id: 'source-moved-verification', contract },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('source-moved-verification'),
      (task) => task.status === 'review_required',
    );
    await runtime.control(
      {
        task_id: 'source-moved-verification',
        action: 'finalize',
        review_summary: 'Scoped diff reviewed.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(path.join(repository, 'result.txt'), 'source moved mid-verification\n', 'utf8');

    const blocked = await waitUntil(
      async () => await runtime.store.loadTask('source-moved-verification'),
      (task) => task.status === 'paused',
      20_000,
    );
    expect(blocked.commitHash).toBeUndefined();
    expect(blocked.sourceCollision).toMatchObject({
      checkpoint: 'after_verification',
      overlappingPaths: ['result.txt'],
    });
    expect(await readFile(path.join(repository, 'result.txt'), 'utf8')).toBe(
      'source moved mid-verification\n',
    );
  });

  it.each(['before_commit', 'immediately_before_commit'] as const)(
    'pauses recoverably on a collision at %s',
    async (checkpoint) => {
      const repository = await createGitRepository();
      const runtime = await runtimeFixture();
      const taskId = `late-${checkpoint.replaceAll('_', '-')}`;
      await runtime.delegate(
        { task_id: taskId, contract: contractFixture() },
        sandboxMeta(repository),
      );
      await waitUntil(
        async () => await runtime.store.loadTask(taskId),
        (task) => task.status === 'review_required',
      );

      const collision = (
        runtime as unknown as {
          collision: { guardTask(taskId: string, checkpoint: string): Promise<void> };
        }
      ).collision;
      const originalGuard = collision.guardTask.bind(collision);
      const sourceContents = `user source change at ${checkpoint}\n`;
      let injected = false;
      vi.spyOn(collision, 'guardTask').mockImplementation(
        async (guardedTaskId, currentCheckpoint) => {
          if (!injected && currentCheckpoint === checkpoint) {
            injected = true;
            await writeFile(path.join(repository, 'result.txt'), sourceContents, 'utf8');
          }
          await originalGuard(guardedTaskId, currentCheckpoint);
        },
      );

      await runtime.control(
        {
          task_id: taskId,
          action: 'finalize',
          review_summary: 'Scoped diff reviewed.',
          approved_review_criteria: [],
        },
        sandboxMeta(repository),
      );
      await waitUntil(
        async () => await runtime.store.loadTask(taskId),
        (task) => task.status === 'paused',
        20_000,
      );
      const finalization = (
        runtime as unknown as {
          finalization: { current(taskId: string): Promise<void> | undefined };
        }
      ).finalization.current(taskId);
      if (finalization) await finalization;
      const settled = await runtime.store.loadTask(taskId);

      expect(injected).toBe(true);
      expect(settled).toMatchObject({
        status: 'paused',
        phase: 'source_collision',
        sourceCollision: { checkpoint, overlappingPaths: ['result.txt'] },
      });
      expect(settled.commitHash).toBeUndefined();
      expect(await readFile(path.join(repository, 'result.txt'), 'utf8')).toBe(sourceContents);
      const workerHead = await runCommand({
        argv: ['git', 'rev-parse', 'HEAD'],
        cwd: settled.worktree,
      });
      expect(workerHead.stdout.trim()).toBe(settled.baseCommit);
    },
  );

  it('bounds inspect output and paginates explicitly requested diffs', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'offline-inspect', contract: contractFixture() },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('offline-inspect'),
      (task) => task.status === 'review_required',
    );
    const inspected = await runtime.inspect({
      task_id: 'offline-inspect',
      include: ['diff', 'events'],
      max_bytes: 1_024,
    });
    expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThanOrEqual(1_536);
    expect(inspected.sections).toBeTruthy();
  });

  it('resumes idempotently even if the main worktree becomes dirty later', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'offline-idempotent', contract: contractFixture() },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('offline-idempotent'),
      (task) => task.status === 'review_required',
    );
    await writeFile(path.join(repository, 'later-user-change.txt'), 'not part of worker\n', 'utf8');

    const resumed = await runtime.delegate(
      { task_id: 'offline-idempotent', contract: contractFixture() },
      sandboxMeta(repository),
    );
    expect(resumed.state).toBe('review_required');
  });

  it('fails closed when resume sandbox posture differs from task creation', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture({ networkEnabled: true });
    await runtime.delegate(
      { task_id: 'resume-posture', contract: contractFixture() },
      sandboxMeta(repository, true),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('resume-posture'),
      (task) => task.status === 'review_required',
    );
    await runtime.store.updateTask('resume-posture', (task) => {
      task.status = 'paused';
      task.phase = 'worker_crashed';
      task.inspectedAfterPause = true;
    });

    await expect(
      runtime.delegate(
        { task_id: 'resume-posture', contract: contractFixture() },
        sandboxMeta(repository, false),
      ),
    ).rejects.toMatchObject({ code: 'reasonix_incompatible' });
  });

  it('runs two isolated sessions for the same repository', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await Promise.all([
      runtime.delegate(
        { task_id: 'multi-one', contract: contractFixture() },
        sandboxMeta(repository),
      ),
      runtime.delegate(
        { task_id: 'multi-two', contract: contractFixture() },
        sandboxMeta(repository),
      ),
    ]);
    const [first, second] = await Promise.all([
      waitUntil(
        async () => await runtime.store.loadTask('multi-one'),
        (task) => task.status === 'review_required',
      ),
      waitUntil(
        async () => await runtime.store.loadTask('multi-two'),
        (task) => task.status === 'review_required',
      ),
    ]);
    expect(first.worktree).not.toBe(second.worktree);
    expect(first.acpSessionId).not.toBe(second.acpSessionId);
  });

  it('rejects a third post-review repair round without requiring sandbox metadata', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'repair-limit', contract: contractFixture() },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('repair-limit'),
      (task) => task.status === 'review_required',
    );
    for (let round = 1; round <= 2; round += 1) {
      await runtime.control(
        { task_id: 'repair-limit', action: 'steer', message: `Repair round ${round}` },
        undefined,
      );
      await waitUntil(
        async () => await runtime.store.loadTask('repair-limit'),
        (task) => task.status === 'review_required' && task.repairRounds === round,
      );
    }
    await expect(
      runtime.control(
        { task_id: 'repair-limit', action: 'steer', message: 'Forbidden third repair' },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'repair_limit_reached' });
  });

  it('cancels an active verification command without staging or committing', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const descendantMarker = path.join(repository, 'cancelled-descendant-survived');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)}, 'unsafe'), 700)`;
    const slowVerification = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
      'setInterval(() => {}, 1000)',
    ].join(';');
    await commitFixtureScript(repository, 'slow-verification.cjs', `${slowVerification}\n`);
    const contract = contractFixture({
      verification: [
        {
          id: 'slow_verify',
          argv: [process.execPath, 'slow-verification.cjs'],
          cwd: '.',
          timeout_seconds: 30,
          proves: ['ac_result'],
        },
      ],
    });
    await runtime.delegate({ task_id: 'cancel-verification', contract }, sandboxMeta(repository));
    await waitUntil(
      async () => await runtime.store.loadTask('cancel-verification'),
      (task) => task.status === 'review_required',
    );
    await runtime.control(
      {
        task_id: 'cancel-verification',
        action: 'finalize',
        review_summary: 'Reviewed before cancellation test.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('cancel-verification'),
      (task) => task.status === 'verifying' && task.phase === 'verification',
    );
    const cancelled = await runtime.control(
      { task_id: 'cancel-verification', action: 'cancel' },
      undefined,
    );
    expect(cancelled.state).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 900));
    const task = await runtime.store.loadTask('cancel-verification');
    expect(task.status).toBe('cancelled');
    expect(task.commitHash).toBeUndefined();
    const staged = await runCommand({
      argv: ['git', 'diff', '--cached', '--name-only'],
      cwd: task.worktree,
    });
    expect(staged.stdout).toBe('');
    const head = await runCommand({ argv: ['git', 'rev-parse', 'HEAD'], cwd: task.worktree });
    expect(head.stdout.trim()).toBe(task.baseCommit);
    await expect(access(descendantMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks changed-file size after verification before staging', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture({ maxBinaryBytes: 64 });
    await commitFixtureScript(
      repository,
      'enlarge-result.cjs',
      "require('node:fs').writeFileSync('result.txt','x'.repeat(256))\n",
    );
    const contract = contractFixture({
      verification: [
        {
          id: 'enlarge_result',
          argv: [process.execPath, 'enlarge-result.cjs'],
          cwd: '.',
          timeout_seconds: 30,
          proves: ['ac_result'],
        },
      ],
    });
    await runtime.delegate({ task_id: 'post-verify-size', contract }, sandboxMeta(repository));
    await waitUntil(
      async () => await runtime.store.loadTask('post-verify-size'),
      (task) => task.status === 'review_required',
    );
    await runtime.control(
      {
        task_id: 'post-verify-size',
        action: 'finalize',
        review_summary: 'Reviewed the small worker diff.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    const failed = await waitUntil(
      async () => await runtime.store.loadTask('post-verify-size'),
      (task) => task.status === 'commit_failed',
      20_000,
    );
    expect(failed.reason).toContain('scope_violation');
    const staged = await runCommand({
      argv: ['git', 'diff', '--cached', '--name-only'],
      cwd: failed.worktree,
    });
    expect(staged.stdout).toBe('');
  });

  it('waits for aborted background finalization before shutdown returns', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await commitFixtureScript(
      repository,
      'shutdown-verification.cjs',
      'setInterval(() => {}, 1000)\n',
    );
    const contract = contractFixture({
      verification: [
        {
          id: 'shutdown_verify',
          argv: [process.execPath, 'shutdown-verification.cjs'],
          cwd: '.',
          timeout_seconds: 30,
          proves: ['ac_result'],
        },
      ],
    });
    await runtime.delegate({ task_id: 'shutdown-finalize', contract }, sandboxMeta(repository));
    await waitUntil(
      async () => await runtime.store.loadTask('shutdown-finalize'),
      (task) => task.status === 'review_required',
    );
    await runtime.control(
      {
        task_id: 'shutdown-finalize',
        action: 'finalize',
        review_summary: 'Reviewed before shutdown.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask('shutdown-finalize'),
      (task) => task.status === 'verifying' && task.phase === 'verification',
    );

    await runtime.shutdown();
    const task = await runtime.store.loadTask('shutdown-finalize');
    expect(task.status).toBe('commit_failed');
    expect(task.commitHash).toBeUndefined();
  });
});
