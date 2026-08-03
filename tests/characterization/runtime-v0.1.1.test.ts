import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import { BridgeError } from '../../src/errors.js';
import { discoverRepository } from '../../src/repository.js';
import * as runtimeModule from '../../src/runtime.js';
import {
  BridgeRuntime,
  INSPECT_SECTIONS,
  assertSupportedPlatform,
  makeTaskRecordForTest,
} from '../../src/runtime.js';
import { contractFixture, createGitRepository, sandboxMeta } from '../helpers.js';

const runtimes: BridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.shutdown()));
});

async function runtimeFixture(stateDir?: string): Promise<BridgeRuntime> {
  const runtimeState =
    stateDir ?? (await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-runtime-v011-')));
  const runtime = new BridgeRuntime(
    loadConfig({
      stateDir: runtimeState,
      reasonixCommand: 'unused-in-characterization',
      reasonixArgs: [],
    }),
  );
  await runtime.initialize();
  runtimes.push(runtime);
  return runtime;
}

describe('v0.1.1 runtime characterization', () => {
  it('keeps the runtime module surface and platform error stable', () => {
    expect(Object.keys(runtimeModule).sort()).toEqual([
      'BridgeRuntime',
      'INSPECT_SECTIONS',
      'assertSupportedPlatform',
      'makeTaskRecordForTest',
    ]);
    expect(INSPECT_SECTIONS).toEqual([
      'status',
      'summary',
      'changed_files',
      'diff_stat',
      'diff',
      'verification',
      'acceptance_evidence',
      'risks',
      'usage',
      'interactions',
      'events',
    ]);

    let failure: unknown;
    try {
      assertSupportedPlatform('win32');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BridgeError);
    expect(failure).toMatchObject({
      name: 'BridgeError',
      code: 'unsupported_platform',
      message: 'Native Windows is unsupported in v1; run codex-reasonix-mcp inside WSL',
    });
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });

  it('keeps the test task record defaults stable', () => {
    const contract = parseTaskContract(contractFixture());
    const task = makeTaskRecordForTest(
      'shape-task',
      contract,
      { id: 'repo-id', root: '/repo', commonDir: '/repo/.git', head: 'abc123' },
      '/state/worktrees/shape-task',
    );

    expect(Object.keys(task).sort()).toEqual([
      'acceptanceEvidence',
      'baseCommit',
      'baseRef',
      'branch',
      'changedFiles',
      'contract',
      'contractHash',
      'createdAt',
      'eventSequence',
      'inspectedAfterPause',
      'interactions',
      'networkEnabled',
      'phase',
      'reasonixStatusSequence',
      'repairActive',
      'repairRounds',
      'repository',
      'risks',
      'schemaVersion',
      'status',
      'statusSequence',
      'summary',
      'taskId',
      'updatedAt',
      'usage',
      'verification',
      'worktree',
    ]);
    expect(task).toMatchObject({
      schemaVersion: 2,
      taskId: 'shape-task',
      contract,
      repository: { id: 'repo-id', root: '/repo', commonDir: '/repo/.git', head: 'abc123' },
      baseRef: 'HEAD',
      baseCommit: 'abc123',
      branch: 'reasonix/shape-task',
      worktree: '/state/worktrees/shape-task',
      networkEnabled: false,
      status: 'provisioning',
      phase: 'test',
      statusSequence: 0,
      reasonixStatusSequence: 0,
      eventSequence: 0,
      repairRounds: 0,
      repairActive: false,
      inspectedAfterPause: false,
      summary: '',
      changedFiles: [],
      risks: [],
      interactions: [],
      verification: [],
      acceptanceEvidence: [],
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        cacheHitRatio: null,
        estimatedCost: null,
        currency: null,
        usageSource: 'reasonix',
      },
    });
    expect(task.contractHash).toMatch(/^[0-9a-f]{64}$/);
    expect(task.createdAt).toBe(task.updatedAt);
  });

  it('recovers interrupted tasks and marks a paused task inspected before returning it', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-runtime-recovery-'));
    const first = await runtimeFixture(stateDir);
    const contract = parseTaskContract(contractFixture());
    const record = makeTaskRecordForTest(
      'recover-task',
      contract,
      { id: 'repo-id', root: '/repo', commonDir: '/repo/.git', head: 'abc123' },
      '/missing-worktree',
    );
    record.status = 'running';
    record.phase = 'goal_running';
    await first.store.createTask(record);
    await first.shutdown();
    runtimes.splice(runtimes.indexOf(first), 1);

    const recovered = new BridgeRuntime(loadConfig({ stateDir }));
    runtimes.push(recovered);
    await expect(recovered.initialize()).resolves.toEqual(['recover-task']);

    const beforeInspect = await recovered.store.loadTask('recover-task');
    expect(beforeInspect).toMatchObject({
      status: 'paused',
      phase: 'restart_recovery',
      reason: 'Bridge restart detected; inspect before explicit resume',
      inspectedAfterPause: false,
    });
    const result = await recovered.inspect({
      task_id: 'recover-task',
      include: ['status', 'events'],
    });
    expect(result).toMatchObject({
      task_id: 'recover-task',
      truncated: false,
      sections: {
        status: {
          task_id: 'recover-task',
          state: 'paused',
          phase: 'restart_recovery',
          reason: 'Bridge restart detected; inspect before explicit resume',
        },
      },
    });
    expect(await recovered.store.loadTask('recover-task')).toMatchObject({
      inspectedAfterPause: true,
    });
    const events = (result.sections as { events: Array<{ type: string }> }).events;
    expect(events.map((event) => event.type)).toEqual(['task_created', 'restart_recovery']);
  });

  it('paginates inspect sections with signed cursors and rejects section reuse', async () => {
    const runtime = await runtimeFixture();
    const contract = parseTaskContract(contractFixture());
    const record = makeTaskRecordForTest(
      'inspect-pages',
      contract,
      { id: 'repo-id', root: '/repo', commonDir: '/repo/.git', head: 'abc123' },
      '/missing-worktree',
    );
    record.status = 'review_required';
    record.phase = 'codex_review';
    record.summary = 'é'.repeat(900);
    await runtime.store.createTask(record);

    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await runtime.inspect({
        task_id: 'inspect-pages',
        include: ['summary'],
        max_bytes: 1_024,
        ...(cursor ? { cursor } : {}),
      });
      pages.push((page.sections as { summary: string }).summary);
      cursor = page.next_cursor as string | undefined;
      expect(page.truncated).toBe(Boolean(cursor));
    } while (cursor);
    expect(pages.join('')).toBe(record.summary);
    expect(pages.length).toBeGreaterThan(1);

    const first = await runtime.inspect({
      task_id: 'inspect-pages',
      include: ['summary'],
      max_bytes: 1_024,
    });
    await expect(
      runtime.inspect({
        task_id: 'inspect-pages',
        include: ['events'],
        cursor: first.next_cursor as string,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Cursor section is not requested in include',
    });
  });

  it('preserves existing-task collision checks without starting a worker', async () => {
    const repositoryRoot = await createGitRepository();
    const repository = await discoverRepository(repositoryRoot);
    const runtime = await runtimeFixture();
    const contract = parseTaskContract(contractFixture());
    const record = makeTaskRecordForTest(
      'existing-task',
      contract,
      repository,
      path.join(repositoryRoot, '.unused-worktree'),
    );
    record.status = 'review_required';
    record.phase = 'codex_review';
    await runtime.store.createTask(record);

    await expect(
      runtime.delegate(
        { task_id: 'existing-task', contract: contractFixture(), resume: false },
        sandboxMeta(repositoryRoot),
      ),
    ).resolves.toMatchObject({
      task_id: 'existing-task',
      state: 'review_required',
      phase: 'codex_review',
      repository_id: repository.id,
    });
    await expect(
      runtime.delegate(
        {
          task_id: 'existing-task',
          contract: contractFixture({ objective: 'A conflicting objective' }),
          resume: false,
        },
        sandboxMeta(repositoryRoot),
      ),
    ).rejects.toMatchObject({
      code: 'task_conflict',
      message: 'task_id already belongs to a different repository or contract hash',
    });
    await expect(
      runtime.delegate(
        {
          task_id: 'existing-task',
          contract: contractFixture(),
          base_ref: 'HEAD~0',
          resume: false,
        },
        sandboxMeta(repositoryRoot),
      ),
    ).resolves.toMatchObject({ task_id: 'existing-task' });
  });

  it('keeps control validation ordering and terminal cancellation idempotence', async () => {
    const runtime = await runtimeFixture();
    const contract = parseTaskContract(contractFixture());
    const record = makeTaskRecordForTest(
      'control-task',
      contract,
      { id: 'repo-id', root: '/repo', commonDir: '/repo/.git', head: 'abc123' },
      '/missing-worktree',
    );
    record.status = 'running';
    record.phase = 'goal_running';
    await runtime.store.createTask(record);

    await expect(
      runtime.control({ task_id: 'control-task', action: 'steer', message: '   ' }, undefined),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'steer message must be non-empty and at most 20,000 chars',
    });
    await expect(
      runtime.control({ task_id: 'control-task', action: 'steer', message: 'continue' }, undefined),
    ).rejects.toMatchObject({
      code: 'invalid_state',
      message: 'Task has no live Reasonix session; inspect and resume first',
    });

    const cancelled = await runtime.control(
      { task_id: 'control-task', action: 'cancel' },
      undefined,
    );
    expect(cancelled).toMatchObject({
      task_id: 'control-task',
      state: 'cancelled',
      phase: 'cancelled',
    });
    const sequence = (await runtime.store.loadTask('control-task')).eventSequence;
    await expect(
      runtime.control({ task_id: 'control-task', action: 'cancel' }, undefined),
    ).resolves.toMatchObject({ state: 'cancelled' });
    expect((await runtime.store.loadTask('control-task')).eventSequence).toBe(sequence);
  });
});
