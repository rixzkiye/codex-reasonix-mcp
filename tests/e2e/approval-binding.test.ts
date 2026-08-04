import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.shutdown()));
});

async function runtimeFixture(overrides: Partial<BridgeConfig> = {}): Promise<BridgeRuntime> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-binding-state-'));
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

describe('snapshot-bound approvals and pause acknowledgment', () => {
  it('rejects a finalize approval that does not match the reviewed snapshot', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'stale-approval', contract: contractFixture(), worker_lane: 'deep' },
      sandboxMeta(repository),
    );
    const review = await waitUntil(
      async () => await runtime.store.loadTask('stale-approval'),
      (task) => task.status === 'review_required',
    );
    await expect(
      runtime.control(
        {
          task_id: 'stale-approval',
          action: 'finalize',
          expected_review_revision: review.reviewRevision + 1,
          expected_review_tree_hash: review.reviewTreeHash!,
          review_summary: 'Approved a snapshot that does not exist.',
          approved_review_criteria: [],
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { checkpoint: 'finalize_start' },
    });
    const after = await runtime.store.loadTask('stale-approval');
    expect(after.status).toBe('review_required');
    expect(after.commitHash).toBeUndefined();
  });

  it('rejects an approval captured before a repair (stale after re-capture)', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    await runtime.delegate(
      { task_id: 'stale-after-repair', contract: contractFixture(), worker_lane: 'deep' },
      sandboxMeta(repository),
    );
    const beforeRepair = await waitUntil(
      async () => await runtime.store.loadTask('stale-after-repair'),
      (task) => task.status === 'review_required',
    );
    const staleApproval = approvalFor(beforeRepair);

    // Mutate the worktree after review, then finalize: the tree mismatch
    // triggers the repair path which re-captures the tree and bumps the
    // review revision.
    await writeFile(
      path.join(beforeRepair.worktree, 'result.txt'),
      'hand edit after review\n',
      'utf8',
    );
    await expect(
      runtime.control(
        {
          task_id: 'stale-after-repair',
          action: 'finalize',
          ...staleApproval,
          review_summary: 'Approved before the hand edit.',
          approved_review_criteria: [],
          wait_timeout_seconds: 0,
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    const repaired = await waitUntil(
      async () => await runtime.store.loadTask('stale-after-repair'),
      (task) =>
        task.status === 'review_required' &&
        (task.reviewRevision ?? 0) > beforeRepair.reviewRevision,
      20_000,
    );

    // The pre-repair approval must now be rejected at finalize_start.
    await expect(
      runtime.control(
        {
          task_id: 'stale-after-repair',
          action: 'finalize',
          ...staleApproval,
          review_summary: 'Still approving the pre-repair snapshot.',
          approved_review_criteria: [],
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: { checkpoint: 'finalize_start' },
    });

    // A fresh approval of the repaired snapshot completes the task.
    const completed = await runtime.control(
      {
        task_id: 'stale-after-repair',
        action: 'finalize',
        ...approvalFor(repaired),
        review_summary: 'Approved the repaired snapshot.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    expect(completed.state).toBe('completed');
  });

  it('rejects stale pause acknowledgments and accepts the current one', async () => {
    const repository = await createGitRepository();
    const runtime = await runtimeFixture();
    const taskId = 'pause-binding';
    await runtime.delegate(
      { task_id: taskId, contract: contractFixture() },
      sandboxMeta(repository),
    );
    await waitUntil(
      async () => await runtime.store.loadTask(taskId),
      (task) => task.status === 'review_required',
    );

    // Inject a source collision at before_commit to pause the task.
    const collision = (
      runtime as unknown as {
        collision: { guardTask(taskId: string, checkpoint: string): Promise<void> };
      }
    ).collision;
    const originalGuard = collision.guardTask.bind(collision);
    let injected = false;
    vi.spyOn(collision, 'guardTask').mockImplementation(
      async (guardedTaskId, currentCheckpoint) => {
        if (!injected && currentCheckpoint === 'before_commit') {
          injected = true;
          await writeFile(
            path.join(repository, 'result.txt'),
            'collision during finalize\n',
            'utf8',
          );
        }
        await originalGuard(guardedTaskId, currentCheckpoint);
      },
    );
    await expect(
      runtime.control(
        {
          task_id: taskId,
          action: 'finalize',
          ...approvalFor(await runtime.store.loadTask(taskId)),
          review_summary: 'Reviewed before the injected collision.',
          approved_review_criteria: [],
          wait_timeout_seconds: 0,
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    const paused = await waitUntil(
      async () => await runtime.store.loadTask(taskId),
      (task) => task.status === 'paused',
      20_000,
    );
    expect(paused.pauseRevision).toBe(1);
    expect(paused.pauseReasonHash).toMatch(/^[0-9a-f]{64}$/);

    // A stale acknowledgment (old revision) is rejected with the fresh tokens.
    await expect(
      runtime.delegate(
        {
          task_id: taskId,
          contract: contractFixture(),
          pause_revision: 0,
          pause_reason_hash: '0'.repeat(64),
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      details: {
        pause_revision: paused.pauseRevision,
        pause_reason_hash: paused.pauseReasonHash,
      },
    });

    // The inspect output carries the current tokens and is read-only.
    const inspected = (await runtime.inspect({ task_id: taskId })) as {
      sections?: { status?: { pause_revision?: number; pause_reason_hash?: string } };
    };
    expect(inspected.sections?.status?.pause_revision).toBe(paused.pauseRevision);
    expect(inspected.sections?.status?.pause_reason_hash).toBe(paused.pauseReasonHash);
    const afterInspect = await runtime.store.loadTask(taskId);
    expect(afterInspect.pauseRevision).toBe(1);
    expect(afterInspect.pauseReasonHash).toBe(paused.pauseReasonHash);
    expect(afterInspect.inspectedAfterPause).toBe(false);

    // Resuming with the current tokens passes the acknowledgment check (the
    // token check runs before the source-collision guard, so the rejection
    // below proves the tokens were accepted; the still-present source change
    // is what blocks the resume).
    await expect(
      runtime.delegate(
        {
          task_id: taskId,
          contract: contractFixture(),
          pause_revision: paused.pauseRevision,
          pause_reason_hash: paused.pauseReasonHash,
        },
        sandboxMeta(repository),
      ),
    ).rejects.toMatchObject({ code: 'ownership_ambiguous' });
  });
});
