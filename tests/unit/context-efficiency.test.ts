import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import { transitionTask } from '../../src/lifecycle.js';
import { BridgeRuntime, makeTaskRecordForTest } from '../../src/runtime.js';
import { InspectionController } from '../../src/runtime/inspection.js';
import { SessionSupervisor } from '../../src/runtime/session-supervision.js';
import { taskView, waitForTask } from '../../src/runtime/shared.js';
import { StateStore } from '../../src/state.js';
import { delegateOutputSchema } from '../../src/tool-schemas.js';
import type { TaskRecord } from '../../src/types.js';
import { contractFixture, createGitRepository, sandboxMeta } from '../helpers.js';

const runtimes: BridgeRuntime[] = [];
const supervisors: SessionSupervisor[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.shutdown()));
  await Promise.all(supervisors.splice(0).map(async (supervisor) => await supervisor.shutdown()));
});

async function stateFixture(
  taskId: string,
  worktree: string,
): Promise<{
  store: StateStore;
  task: TaskRecord;
  inspection: InspectionController;
}> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reasonix-context-state-'));
  const store = new StateStore(stateDir);
  await store.initialize();
  const task = makeTaskRecordForTest(
    taskId,
    parseTaskContract(contractFixture()),
    { id: 'repo', root: worktree, commonDir: path.join(worktree, '.git'), head: 'HEAD' },
    worktree,
  );
  await store.createTask(task);
  const inspection = new InspectionController({ config: loadConfig({ stateDir }), store });
  await inspection.initialize();
  return { store, task, inspection };
}

async function offlineRuntime(): Promise<BridgeRuntime> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reasonix-context-runtime-'));
  const runtime = new BridgeRuntime(
    loadConfig({
      stateDir,
      reasonixCommand: path.resolve('node_modules/.bin/tsx'),
      reasonixArgs: [path.resolve('tests/fixtures/fake-reasonix.ts')],
      leaseHeartbeatMs: 250,
      leaseStaleMs: 2_000,
    }),
  );
  await runtime.initialize();
  runtimes.push(runtime);
  return runtime;
}

describe('rc.3 context efficiency', () => {
  it('does not resolve a lifecycle waiter for an ordinary journal event', async () => {
    const repository = await createGitRepository();
    const { store, task } = await stateFixture('important-lifecycle-wait', repository);
    let settled = false;
    const waiter = waitForTask(
      store,
      task.taskId,
      task,
      2_000,
      (record) => record.status === 'review_required',
    ).then((result) => {
      settled = true;
      return result;
    });

    await store.appendEvent(task.taskId, 'ordinary_progress', { step: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    await store.updateTask(task.taskId, (record) => {
      transitionTask(record, 'running', 'goal_running');
      transitionTask(record, 'review_required', 'codex_review');
    });
    await expect(waiter).resolves.toMatchObject({
      timedOut: false,
      task: { status: 'review_required' },
    });
  });

  it('keeps journal events opt-in during default inspection', async () => {
    const repository = await createGitRepository();
    const { store, task, inspection } = await stateFixture('inspect-default', repository);
    await store.appendEvent(task.taskId, 'diagnostic_event', { detail: 'must be opt-in' });

    const defaultResult = await inspection.inspect({ task_id: task.taskId });
    expect(defaultResult.sections).not.toHaveProperty('events');

    const explicitResult = await inspection.inspect({
      task_id: task.taskId,
      include: ['events'],
    });
    expect(explicitResult.sections).toHaveProperty('events');
    expect(JSON.stringify(explicitResult.sections)).toContain('diagnostic_event');
  });

  it('aggregates message chunks into one bounded journal event', async () => {
    const repository = await createGitRepository();
    const { store, task } = await stateFixture('chunk-aggregation', repository);
    const supervisor = new SessionSupervisor({
      config: loadConfig({ stateDir: store.root }),
      store,
      permissions: {
        onPermission: vi.fn(),
        onToolCallUpdate: vi.fn(),
        finishPrompt: vi.fn(),
      },
      collision: { guardTask: vi.fn(), releaseLease: vi.fn() },
    });
    supervisors.push(supervisor);
    const internals = supervisor as unknown as {
      sessionToTask: Map<string, string>;
      onSessionUpdate(notification: unknown): Promise<void>;
      flushMessage(taskId: string): Promise<void>;
    };
    internals.sessionToTask.set('session-context', task.taskId);

    for (let index = 0; index < 100; index += 1) {
      await internals.onSessionUpdate({
        sessionId: 'session-context',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${String(index).padStart(3, '0')}:${'x'.repeat(996)}` },
        },
      });
    }
    await internals.flushMessage(task.taskId);

    const messages = (await store.readEvents(task.taskId)).filter(
      (event) => event.type === 'agent_message',
    );
    expect(messages).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(messages[0]))).toBeLessThanOrEqual(66 * 1024);
    expect((await store.loadTask(task.taskId)).finalMessage).toHaveLength(64 * 1024);
    expect(
      (await store.readEvents(task.taskId)).some((event) => event.type.includes('chunk')),
    ).toBe(false);
  });

  it('caps the serialized review bundle at 12 KiB', async () => {
    const repository = await createGitRepository();
    const { store, task, inspection } = await stateFixture('bounded-review', repository);
    await store.updateTask(task.taskId, (record) => {
      record.worktree = path.join(repository, 'missing-worktree');
      record.summary = 'summary '.repeat(2_000);
      record.risks = Array.from({ length: 100 }, (_, index) => `risk-${index} ${'x'.repeat(500)}`);
      record.changedFiles = Array.from(
        { length: 200 },
        (_, index) => `${String(index).padStart(3, '0')}-${'nested/'.repeat(140)}file.txt`,
      );
      record.interactions = [
        {
          id: 'interaction-bounded',
          kind: 'input',
          status: 'pending',
          createdAt: '2026-08-03T00:00:00.000Z',
          request: { prompt: 'choose '.repeat(2_000) },
        },
      ];
    });

    const bundle = await inspection.reviewBundle(task.taskId);
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(12 * 1024);
    expect(typeof bundle.summary).toBe('string');
    expect(typeof bundle.diff).toBe('string');
    expect((bundle.changed_files as string[]).length).toBeLessThan(100);
    const activeInteraction = bundle.active_interaction as Record<string, unknown>;
    expect(activeInteraction).toMatchObject({
      id: 'interaction-bounded',
      kind: 'input',
      status: 'pending',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    expect(typeof activeInteraction.request).toBe('object');
    expect(activeInteraction.request).not.toBeNull();
    const current = await store.loadTask(task.taskId);
    expect(delegateOutputSchema.safeParse({ ...taskView(current), ...bundle }).success).toBe(true);
    const compactBundle = await inspection.reviewBundle(task.taskId, 1_024);
    expect(Buffer.byteLength(JSON.stringify(compactBundle))).toBeLessThanOrEqual(1_024);
    expect(delegateOutputSchema.safeParse({ ...taskView(current), ...compactBundle }).success).toBe(
      true,
    );
  });

  it('omits active_interaction when no interaction is pending', async () => {
    const repository = await createGitRepository();
    const { task, inspection } = await stateFixture('no-active-interaction', repository);

    const bundle = await inspection.reviewBundle(task.taskId);

    expect(bundle).not.toHaveProperty('active_interaction');
  });

  it('completes the default offline happy path with one delegate and one finalize only', async () => {
    const repository = await createGitRepository();
    const runtime = await offlineRuntime();
    const delegate = vi.spyOn(runtime, 'delegate');
    const control = vi.spyOn(runtime, 'control');
    const inspect = vi.spyOn(runtime, 'inspect');

    const review = await runtime.delegate(
      { task_id: 'two-call-happy-path', contract: contractFixture() },
      sandboxMeta(repository),
    );
    expect(review.state).toBe('review_required');

    const completed = await runtime.control(
      {
        task_id: 'two-call-happy-path',
        action: 'finalize',
        review_summary: 'Scoped diff reviewed.',
        approved_review_criteria: [],
      },
      sandboxMeta(repository),
    );
    expect(completed).toMatchObject({ state: 'completed' });
    expect(completed.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0]?.[0]).toMatchObject({ action: 'finalize' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
