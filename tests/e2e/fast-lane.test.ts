import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';
import { loadConfig, type BridgeConfig } from '../../src/config.js';
import { BridgeRuntime } from '../../src/runtime.js';
import {
  approvalFor,
  contractFixture,
  createGitRepository,
  sandboxMeta,
  waitUntil,
} from '../helpers.js';

const runtimes: BridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.shutdown()));
});

async function runtimeFixture(overrides: Partial<BridgeConfig> = {}): Promise<BridgeRuntime> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-fast-state-'));
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

function fastContract() {
  return contractFixture({
    acceptance_criteria: [
      {
        id: 'ac_result',
        requirement: 'result.txt has the exact expected content',
        evidence: 'automated',
      },
      { id: 'ac_review', requirement: 'The change is scoped and correct', evidence: 'review' },
    ],
    verification: [
      {
        id: 'verify_result',
        argv: ['test', '-f', 'result.txt'],
        cwd: '.',
        timeout_seconds: 30,
        proves: ['ac_result'],
      },
    ],
    file_assertions: [
      {
        id: 'fa_result',
        path: 'result.txt',
        expected_utf8: 'offline result\n',
        proves: ['ac_result'],
      },
    ],
  });
}

describe('fast lane worker', () => {
  it('completes the two-call happy path with file assertions, review metadata, and runtime-metadata exclusion', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const contract = fastContract();
    const started = Date.now();

    const delegated = await runtime.delegate(
      {
        task_id: 'fast-happy-path',
        contract,
        worker_lane: 'fast',
        reasoning_effort: 'low',
      },
      sandboxMeta(repository),
    );
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(delegated.state).toBe('review_required');
    expect(delegated).toMatchObject({
      worker_lane: 'fast',
      requested_reasoning_effort: 'low',
      effective_reasoning_effort: 'low',
      execution_timeout_seconds: 600,
      reasonix_work_mode: 'economy',
      reasonix_session_mode: 'normal',
      review_revision: 1,
      required_review_criteria: ['ac_review'],
    });
    expect(delegated.review_diff_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(delegated.diff).toContain('result.txt');
    expect(delegated.diff).not.toContain('.reasonix');

    // Untracked runtime metadata must never block or enter the review.
    const worktree = delegated.worktree as string;
    await mkdir(path.join(worktree, '.reasonix', 'session'), { recursive: true });
    await writeFile(path.join(worktree, '.reasonix', 'session', 'state.json'), '{}\n', 'utf8');

    const finalizeStarted = Date.now();
    const completed = await runtime.control(
      {
        task_id: 'fast-happy-path',
        action: 'finalize',
        ...approvalFor(delegated),
        review_summary: 'Scoped fast-lane diff reviewed.',
        approved_review_criteria: ['ac_review', 'ac_result'],
        commit_message: 'fast-happy-path: create result.txt',
      },
      sandboxMeta(repository),
    );
    expect(Date.now() - finalizeStarted).toBeLessThan(15_000);
    expect(completed.state).toBe('completed');
    expect(completed.commit_hash).toMatch(/^[0-9a-f]{40}$/);

    const task = await runtime.store.loadTask('fast-happy-path');
    const automated = task.acceptanceEvidence.find((item) => item.criterionId === 'ac_result');
    expect(automated).toMatchObject({
      evidence: 'automated',
      approved: true,
      source: 'file_assertion:fa_result',
      outputBytes: 15,
    });
    expect(automated?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const reviewed = task.acceptanceEvidence.find((item) => item.criterionId === 'ac_review');
    expect(reviewed).toMatchObject({ evidence: 'review', approved: true });

    // The isolated commit contains exactly the reviewed files; runtime
    // metadata and .gitignore were never added.
    const tree = await runCommand({
      argv: ['git', 'ls-tree', '-r', '--name-only', completed.commit_hash as string],
      cwd: repository,
    });
    expect(tree.stdout.split('\n').filter(Boolean).sort()).toEqual(['README.md', 'result.txt']);
    const committed = await runCommand({
      argv: ['git', 'show', `${String(completed.commit_hash)}:result.txt`],
      cwd: repository,
    });
    expect(committed.stdout).toBe('offline result\n');
  });

  it('defaults new tasks to the fast lane and 600-second deadline', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const delegated = await runtime.delegate(
      { task_id: 'fast-defaults', contract: contractFixture() },
      sandboxMeta(repository),
    );
    expect(delegated.state).toBe('review_required');
    expect(delegated).toMatchObject({
      worker_lane: 'fast',
      execution_timeout_seconds: 600,
    });
  });

  it('rejects a conflicting lane on re-delegation and preserves the stored lane on resume', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const contract = fastContract();
    await runtime.delegate(
      { task_id: 'lane-resume', contract, worker_lane: 'fast' },
      sandboxMeta(repository),
    );

    await expect(
      runtime.delegate(
        { task_id: 'lane-resume', contract, worker_lane: 'deep' },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'task_conflict' });

    await runtime.store.updateTask('lane-resume', (task) => {
      task.status = 'paused';
      task.phase = 'restart_recovery';
      task.inspectedAfterPause = true;
    });
    const resumed = await runtime.delegate(
      { task_id: 'lane-resume', contract },
      sandboxMeta(repository),
    );
    expect(resumed).toMatchObject({ worker_lane: 'fast', state: 'review_required' });
    expect((await runtime.store.loadTask('lane-resume')).executionProfile.workerLane).toBe('fast');
  });

  it('fails fast when the fast session drifts into Goal mode', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture({
      reasonixArgs: [path.resolve('tests/fixtures/fake-reasonix.ts'), '--fake-mode=fast-goal'],
    });
    const result = await runtime.delegate(
      { task_id: 'fast-goal-drift', contract: fastContract(), worker_lane: 'fast' },
      sandboxMeta(repository),
    );
    expect(result).toMatchObject({
      state: 'failed',
      phase: 'lane_policy_violation',
      worker_lane: 'fast',
    });
    expect(result.reason).toMatch(/fast lane forbids/);
    const events = await runtime.store.readEvents('fast-goal-drift');
    expect(events.some((event) => event.type === 'lane_policy_violation')).toBe(true);
    expect(events.some((event) => event.type === 'task_completed')).toBe(false);
  });

  it('fails fast when a fast session event names AutoResearch', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture({
      reasonixArgs: [
        path.resolve('tests/fixtures/fake-reasonix.ts'),
        '--fake-mode=fast-autoresearch',
      ],
    });
    const result = await runtime.delegate(
      { task_id: 'fast-autoresearch-drift', contract: fastContract(), worker_lane: 'fast' },
      sandboxMeta(repository),
    );
    expect(result).toMatchObject({
      state: 'failed',
      phase: 'lane_policy_violation',
    });
    expect(result.reason).toMatch(/AutoResearch/);
  });

  it('keeps the review bundle bounded with review metadata', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const delegated = await runtime.delegate(
      { task_id: 'fast-bundle', contract: fastContract(), worker_lane: 'fast' },
      sandboxMeta(repository),
    );
    const bundle = {
      summary: delegated.summary,
      changed_files: delegated.changed_files,
      diff_stat: delegated.diff_stat,
      diff: delegated.diff,
      risks: delegated.risks,
      usage: delegated.usage,
      required_review_criteria: delegated.required_review_criteria,
      review_revision: delegated.review_revision,
      review_diff_sha256: delegated.review_diff_sha256,
    };
    expect(Buffer.byteLength(JSON.stringify(bundle), 'utf8')).toBeLessThanOrEqual(12 * 1024);
    expect(bundle.required_review_criteria).toEqual(['ac_review']);
    expect(bundle.review_revision).toBe(1);
    expect(bundle.review_diff_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('repairs through steer and re-enters review with a fresh revision and tree', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const contract = fastContract();
    await runtime.delegate(
      { task_id: 'fast-repair', contract, worker_lane: 'fast' },
      sandboxMeta(repository),
    );
    const first = await waitUntil(
      async () => await runtime.store.loadTask('fast-repair'),
      (task) => task.status === 'review_required',
    );
    expect(first.reviewRevision).toBe(1);
    expect(first.reviewTreeHash).toMatch(/^[0-9a-f]{40}$/);

    await runtime.control(
      { task_id: 'fast-repair', action: 'steer', message: 'Keep the result file.' },
      sandboxMeta(repository),
    );
    const repaired = await waitUntil(
      async () => await runtime.store.loadTask('fast-repair'),
      (task) => task.status === 'review_required' && (task.reviewRevision ?? 0) >= 2,
    );
    expect(repaired.reviewRevision).toBe(2);
    expect(repaired.reviewTreeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(repaired.repairRounds).toBe(1);

    const completed = await runtime.control(
      {
        task_id: 'fast-repair',
        action: 'finalize',
        ...approvalFor(repaired),
        review_summary: 'Repaired diff reviewed.',
        approved_review_criteria: ['ac_review'],
      },
      sandboxMeta(repository),
    );
    expect(completed.state).toBe('completed');
    // Integration remains an explicit cherry-pick; the source worktree is untouched.
    const sourceTree = await runCommand({
      argv: ['git', 'ls-tree', '-r', '--name-only', completed.commit_hash as string],
      cwd: repository,
    });
    expect(sourceTree.stdout.split('\n').filter(Boolean).sort()).toEqual([
      'README.md',
      'result.txt',
    ]);
  });

  it('recovers from hand repairs after a review-snapshot mismatch', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const contract = fastContract();
    await runtime.delegate(
      { task_id: 'fast-hand-repair', contract, worker_lane: 'fast' },
      sandboxMeta(repository),
    );
    const first = await waitUntil(
      async () => await runtime.store.loadTask('fast-hand-repair'),
      (task) => task.status === 'review_required',
    );
    expect(first.reviewRevision).toBe(1);

    // A direct worktree edit after review is detected once, then the snapshot
    // is re-captured so the task stays repairable instead of looping.
    await writeFile(path.join(first.worktree, 'result.txt'), 'offline result v2\n', 'utf8');
    await expect(
      runtime.control(
        {
          task_id: 'fast-hand-repair',
          action: 'finalize',
          review_summary: 'Reviewed before the snapshot mismatch.',
          ...approvalFor(first),
          approved_review_criteria: ['ac_review'],
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
    const repaired = await runtime.store.loadTask('fast-hand-repair');
    expect(repaired).toMatchObject({
      status: 'review_required',
      phase: 'verification_repair_required',
      reviewRevision: 2,
    });
    expect(repaired.reviewTreeHash).not.toBe(first.reviewTreeHash);

    // The operator fixes the bytes; the change is detected and re-baselined
    // once more, then finalize completes.
    await writeFile(path.join(repaired.worktree, 'result.txt'), 'offline result\n', 'utf8');
    await expect(
      runtime.control(
        {
          task_id: 'fast-hand-repair',
          action: 'finalize',
          review_summary: 'Reviewed the hand-repaired bytes.',
          ...approvalFor(repaired),
          approved_review_criteria: ['ac_review'],
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
    const reBaselined = await runtime.store.loadTask('fast-hand-repair');
    expect(reBaselined.reviewRevision).toBe(3);

    const completed = await runtime.control(
      {
        task_id: 'fast-hand-repair',
        action: 'finalize',
        review_summary: 'Reviewed the final bytes.',
        ...approvalFor(reBaselined),
        approved_review_criteria: ['ac_review'],
      },
      sandboxMeta(repository),
    );
    expect(completed.state).toBe('completed');
    expect(completed.commit_hash).toMatch(/^[0-9a-f]{40}$/);
  });
});
