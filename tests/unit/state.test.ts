import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { acquireLease } from '../../src/lease.js';
import { CursorCodec, paginateText } from '../../src/pagination.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import type { TaskRecord } from '../../src/types.js';
import { contractFixture } from '../helpers.js';

function sampleTask(taskId: string): TaskRecord {
  return makeTaskRecordForTest(
    taskId,
    parseTaskContract(contractFixture()),
    { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
    '/worktree',
  );
}

function richTask(taskId: string): TaskRecord {
  const task = sampleTask(taskId);
  task.reason = 'inspect before resume';
  task.acpSessionId = 'session-1';
  task.processFingerprint = 'fingerprint-1';
  task.status = 'review_required';
  task.phase = 'awaiting_review';
  task.statusSequence = 3;
  task.reasonixStatusSequence = 7;
  task.eventSequence = 9;
  task.repairRounds = 2;
  task.repairActive = true;
  task.inspectedAfterPause = true;
  task.summary = 'summary text';
  task.finalMessage = 'final message';
  task.changedFiles = ['result.txt'];
  task.risks = ['risk one'];
  task.networkEnabled = true;
  task.interactions = [
    {
      id: 'interaction-1',
      kind: 'permission',
      status: 'resolved',
      createdAt: '2025-01-01T00:00:00.000Z',
      resolvedAt: '2025-01-01T00:00:01.000Z',
      request: { toolCallId: 'call-1', options: [] },
      response: { decision: 'allow' },
    },
    {
      id: 'interaction-2',
      kind: 'input',
      status: 'pending',
      createdAt: '2025-01-01T00:00:02.000Z',
      request: { prompt: 'answer' },
    },
  ];
  task.verification = [
    {
      id: 'verify_result',
      argv: ['pnpm', 'test'],
      cwd: '.',
      startedAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T00:00:05.000Z',
      exitCode: 0,
      timedOut: false,
      passed: true,
      proves: ['ac_result'],
      logPath: '/state/verify_result.log',
      sha256: 'a'.repeat(64),
      outputBytes: 42,
    },
    {
      id: 'verify_timeout',
      argv: ['true'],
      cwd: '.',
      startedAt: '2025-01-01T00:00:06.000Z',
      finishedAt: '2025-01-01T00:00:07.000Z',
      exitCode: null,
      timedOut: true,
      passed: false,
      proves: ['ac_result'],
      logPath: '/state/verify_timeout.log',
      sha256: 'b'.repeat(64),
      outputBytes: 0,
    },
  ];
  task.acceptanceEvidence = [
    {
      criterionId: 'ac_result',
      evidence: 'automated',
      approved: true,
      source: 'verify_result',
      sha256: 'c'.repeat(64),
    },
    {
      criterionId: 'ac_review',
      evidence: 'review',
      approved: true,
      source: 'Codex finalize approval',
    },
  ];
  task.usage = {
    promptTokens: 1,
    completionTokens: 2,
    reasoningTokens: 3,
    cacheHitTokens: 4,
    cacheMissTokens: 5,
    cacheHitRatio: 0.5,
    estimatedCost: 1.25,
    currency: 'USD',
    usageSource: 'reasonix',
  };
  task.reviewSummary = 'review summary';
  task.commitHash = 'f'.repeat(40);
  return task;
}

async function newStore(): Promise<StateStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-state-'));
  const store = new StateStore(root);
  await store.initialize();
  return store;
}

async function persistAsVersion(
  store: StateStore,
  task: TaskRecord,
  version: 1 | 2,
): Promise<string> {
  await store.createTask(task);
  const raw = `${JSON.stringify({ ...task, schemaVersion: version }, null, 2)}\n`;
  await writeFile(store.statePath(task.taskId), raw, 'utf8');
  return raw;
}

describe('private persistent state', () => {
  it('writes private snapshots, append-only events, and pauses interrupted tasks on restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-state-'));
    const store = new StateStore(root);
    await store.initialize();
    const task = makeTaskRecordForTest(
      'recover-me',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/worktree',
    );
    await store.createTask(task);
    await store.updateTask(task.taskId, (record) => {
      record.status = 'running';
    });
    expect((await stat(store.statePath(task.taskId))).mode & 0o777).toBe(0o600);

    const recovered = await store.recoverInterruptedTasks();
    expect(recovered).toEqual(['recover-me']);
    expect((await store.loadTask(task.taskId)).status).toBe('paused');
    expect((await store.readEvents(task.taskId)).map((event) => event.type)).toContain(
      'restart_recovery',
    );
  });

  it('enforces one cross-process lease owner and releases by nonce', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-lock-'));
    const first = await acquireLease(root, 'repo', 100, 10_000);
    await expect(acquireLease(root, 'repo', 100, 10_000)).rejects.toMatchObject({
      code: 'lease_conflict',
    });
    await first.release();
    const second = await acquireLease(root, 'repo', 100, 10_000);
    await second.release();
  });

  it('recovers a stale lease only when its recorded process is no longer alive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-stale-lock-'));
    await writeFile(
      path.join(root, 'repo.lease'),
      `${JSON.stringify({
        pid: 2_147_483_647,
        processStartToken: 'dead-process',
        createdAt: '1970-01-01T00:00:00.000Z',
        heartbeatAt: '1970-01-01T00:00:00.000Z',
        nonce: 'stale-owner',
      })}\n`,
      { mode: 0o600 },
    );
    const recovered = await acquireLease(root, 'repo', 100, 10_000);
    expect(await readdir(root)).toContain('repo.lease.stale.stale-owner');
    await recovered.release();
  });

  it('signs opaque bounded cursors and rejects tampering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-cursor-'));
    const codec = await CursorCodec.create(root);
    const first = paginateText(codec, 'task', 'diff', 'abcdefghij', 'digest', 4);
    expect(first).toMatchObject({ value: 'abcd', truncated: true });
    expect(first.nextCursor).toBeTruthy();
    const second = paginateText(codec, 'task', 'diff', 'abcdefghij', 'digest', 4, first.nextCursor);
    expect(second.value).toBe('efgh');
    expect(() => codec.decode(`${first.nextCursor}x`)).toThrow(/cursor/i);
  });

  it('paginates on UTF-8 boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-unicode-cursor-'));
    const codec = await CursorCodec.create(root);
    const first = paginateText(codec, 'task', 'diff', 'a🙂b', 'unicode', 5);
    expect(first.value).toBe('a🙂');
    expect(first.value).not.toContain('�');
    const second = paginateText(codec, 'task', 'diff', 'a🙂b', 'unicode', 5, first.nextCursor);
    expect(second.value).toBe('b');
  });

  it('migrates valid schemaVersion 1 state to schemaVersion 2 atomically and preserves identity', async () => {
    const store = await newStore();
    const task = richTask('migrate-me');
    const v1Raw = await persistAsVersion(store, task, 1);

    const loaded = await store.loadTask(task.taskId);
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded).toEqual({ ...task, schemaVersion: 2 });

    // The rewrite is atomic and byte-identical to the v1 file except the
    // schemaVersion value: contract/hash, repository/base/branch/worktree
    // identity, audit sequences, evidence, interactions, verification,
    // usage, and timestamps all survive untouched.
    const onDisk = await readFile(store.statePath(task.taskId), 'utf8');
    expect(onDisk).toBe(`${JSON.stringify({ ...task, schemaVersion: 2 }, null, 2)}\n`);
    expect(onDisk).toBe(v1Raw.replace('"schemaVersion": 1', '"schemaVersion": 2'));
    expect(onDisk).not.toContain('"schemaVersion": 1');

    // A second load observes the already-migrated file without rewriting.
    expect((await store.loadTask(task.taskId)).schemaVersion).toBe(2);
  });

  it('loads valid v2 state and rejects malformed, corrupt, or unknown state with invalid_state without rewriting', async () => {
    const store = await newStore();
    const task = richTask('corrupt-me');
    await store.createTask(task);
    expect((await store.loadTask(task.taskId)).schemaVersion).toBe(2);

    const base = structuredClone(task) as unknown as Record<string, unknown>;
    const variants: Array<{
      name: string;
      version?: 1 | 2;
      mutate?: (state: Record<string, unknown>) => void;
      raw?: string;
    }> = [
      { name: 'unparseable JSON', raw: '{not json' },
      { name: 'null state', raw: 'null\n' },
      { name: 'array state', raw: '[]\n' },
      { name: 'empty object', raw: '{}\n' },
      { name: 'missing schemaVersion', mutate: (state) => void delete state.schemaVersion },
      { name: 'older unknown schemaVersion 0', mutate: (state) => void (state.schemaVersion = 0) },
      { name: 'future schemaVersion 3', mutate: (state) => void (state.schemaVersion = 3) },
      { name: 'string schemaVersion', mutate: (state) => void (state.schemaVersion = '2') },
      { name: 'fractional schemaVersion', mutate: (state) => void (state.schemaVersion = 1.5) },
      { name: 'invalid taskId', mutate: (state) => void (state.taskId = 'not valid!') },
      { name: 'taskId with parent segments', mutate: (state) => void (state.taskId = 'a..b') },
      {
        name: 'malformed contract',
        mutate: (state) => void ((state.contract as Record<string, unknown>).objective = 42),
      },
      {
        name: 'contract hash mismatch',
        mutate: (state) => void (state.contractHash = 'f'.repeat(64)),
      },
      { name: 'malformed contract hash', mutate: (state) => void (state.contractHash = 'ABC') },
      { name: 'unknown status', mutate: (state) => void (state.status = 'bogus') },
      {
        name: 'valid but non-canonical contract key order',
        mutate: (state) => {
          const contract = state.contract as Record<string, unknown>;
          state.contract = Object.fromEntries(Object.entries(contract).reverse());
        },
      },
      {
        name: 'malformed repository',
        mutate: (state) => void delete (state.repository as Record<string, unknown>).root,
      },
      { name: 'empty baseCommit', mutate: (state) => void (state.baseCommit = '') },
      {
        name: 'non-boolean networkEnabled',
        mutate: (state) => void (state.networkEnabled = 'yes'),
      },
      { name: 'empty phase', mutate: (state) => void (state.phase = '') },
      { name: 'malformed timestamp', mutate: (state) => void (state.createdAt = 'yesterday') },
      {
        name: 'impossible timestamp',
        mutate: (state) => void (state.createdAt = '2025-02-30T00:00:00.000Z'),
      },
      { name: 'negative eventSequence', mutate: (state) => void (state.eventSequence = -1) },
      {
        name: 'uppercase evidence digest',
        mutate: (state) =>
          void ((state.verification as Array<Record<string, unknown>>)[0]!.sha256 = 'AB'.repeat(
            32,
          )),
      },
      {
        name: 'short evidence digest',
        mutate: (state) =>
          void ((state.verification as Array<Record<string, unknown>>)[0]!.sha256 = 'abc'),
      },
      {
        name: 'non-hex evidence digest',
        mutate: (state) =>
          void ((state.verification as Array<Record<string, unknown>>)[0]!.sha256 = 'g'.repeat(64)),
      },
      {
        name: 'missing usage field',
        mutate: (state) => void delete (state.usage as Record<string, unknown>).usageSource,
      },
      {
        name: 'non-integer usage token',
        mutate: (state) => void ((state.usage as Record<string, unknown>).promptTokens = 1.5),
      },
      {
        name: 'invalid interaction kind',
        mutate: (state) =>
          void ((state.interactions as Array<Record<string, unknown>>)[0]!.kind = 'bogus'),
      },
      {
        name: 'invalid interaction status',
        mutate: (state) =>
          void ((state.interactions as Array<Record<string, unknown>>)[0]!.status = 'bogus'),
      },
      {
        name: 'invalid interaction timestamp',
        mutate: (state) =>
          void ((state.interactions as Array<Record<string, unknown>>)[0]!.createdAt = 123),
      },
      {
        name: 'invalid acceptance evidence kind',
        mutate: (state) =>
          void ((state.acceptanceEvidence as Array<Record<string, unknown>>)[0]!.evidence =
            'bogus'),
      },
      {
        name: 'non-string changedFiles entry',
        mutate: (state) => void ((state.changedFiles as unknown[]) = ['ok', 42]),
      },
      {
        name: 'corrupt v1 state',
        version: 1,
        mutate: (state) => void delete (state.usage as Record<string, unknown>).usageSource,
      },
    ];

    for (const variant of variants) {
      const state = structuredClone(base);
      variant.mutate?.(state);
      if (variant.version !== undefined) state.schemaVersion = variant.version;
      const raw = variant.raw ?? `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(store.statePath(task.taskId), raw, 'utf8');

      await expect(store.loadTask(task.taskId)).rejects.toMatchObject({ code: 'invalid_state' });
      expect(await readFile(store.statePath(task.taskId), 'utf8')).toBe(raw);
    }

    // Unknown extra fields on an otherwise valid v2 record are tolerated; the
    // version gate is the future-proofing boundary.
    const extra = structuredClone(base);
    extra.futureField = 'x';
    await writeFile(store.statePath(task.taskId), `${JSON.stringify(extra, null, 2)}\n`, 'utf8');
    expect((await store.loadTask(task.taskId)).schemaVersion).toBe(2);
  });

  it('refuses to create or save malformed records without rewriting state', async () => {
    const store = await newStore();
    const broken = structuredClone(sampleTask('invalid-create')) as unknown as Record<
      string,
      unknown
    >;
    delete (broken.usage as Record<string, unknown>).usageSource;
    await expect(store.createTask(broken as unknown as TaskRecord)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(await store.exists('invalid-create')).toBe(false);

    // Records that are not the current schemaVersion must be rejected on
    // create and save rather than silently rewritten as v2.
    const v1Create = { ...sampleTask('v1-create'), schemaVersion: 1 } as unknown as TaskRecord;
    await expect(store.createTask(v1Create)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await store.exists('v1-create')).toBe(false);

    const task = sampleTask('invalid-save');
    await store.createTask(task);
    const before = await readFile(store.statePath(task.taskId), 'utf8');
    const brokenSave = structuredClone(task) as unknown as Record<string, unknown>;
    brokenSave.summary = 42;
    await expect(store.saveTask(brokenSave as unknown as TaskRecord)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    const v1Save = { ...task, schemaVersion: 1 } as unknown as TaskRecord;
    await expect(store.saveTask(v1Save)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await readFile(store.statePath(task.taskId), 'utf8')).toBe(before);
  });

  it('serializes concurrent updates, events, and migration on a v1 state file', async () => {
    const store = await newStore();
    const task = sampleTask('concurrent-migrate');
    await persistAsVersion(store, task, 1);

    const updates = Array.from({ length: 10 }, () =>
      store.updateTask(task.taskId, (record) => {
        record.repairRounds += 1;
      }),
    );
    const events = Array.from({ length: 5 }, (_, index) =>
      store.recordEvent(task.taskId, `event_${index}`, { index }),
    );
    await Promise.all([...updates, ...events]);

    const final = await store.loadTask(task.taskId);
    expect(final.schemaVersion).toBe(2);
    expect(final.repairRounds).toBe(10);
    expect(final.eventSequence).toBe(5);
    expect(await readFile(store.statePath(task.taskId), 'utf8')).toContain('"schemaVersion": 2');
  });

  it('never overwrites a state file that changed after the initial read', async () => {
    const store = await newStore();
    const task = sampleTask('stale-guard');
    await persistAsVersion(store, task, 1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = store.updateTask(task.taskId, async (record) => {
      await gate;
      record.summary = 'newer-snapshot';
    });
    const load = store.loadTask(task.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    release();

    const [updated, loaded] = await Promise.all([update, load]);
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.summary).toBe('newer-snapshot');
    expect(updated.summary).toBe('newer-snapshot');

    // The migration observed the file had changed since its initial read and
    // must not have rewritten it: the on-disk bytes are exactly the newer
    // snapshot written by the serialized update.
    const onDisk = await readFile(store.statePath(task.taskId), 'utf8');
    expect(onDisk).toBe(`${JSON.stringify(updated, null, 2)}\n`);
  });

  it('recovers interrupted v1 tasks deterministically through migration', async () => {
    const store = await newStore();
    const task = sampleTask('recover-v1');
    await persistAsVersion(store, task, 1);

    expect(await store.recoverInterruptedTasks()).toEqual(['recover-v1']);
    const record = await store.loadTask(task.taskId);
    expect(record.schemaVersion).toBe(2);
    expect(record.status).toBe('paused');
    expect(record.phase).toBe('restart_recovery');
    expect(record.eventSequence).toBeGreaterThanOrEqual(1);
    expect((await store.readEvents(task.taskId)).map((event) => event.type)).toContain(
      'restart_recovery',
    );

    // A second recovery pass is a no-op: same result, no extra events.
    expect(await store.recoverInterruptedTasks()).toEqual([]);
    expect(
      (await store.readEvents(task.taskId)).filter((event) => event.type === 'restart_recovery'),
    ).toHaveLength(1);
  });

  it('runtime-created records always use the current schemaVersion 2', async () => {
    const task = richTask('new-v2');
    expect(task.schemaVersion).toBe(2);
    const store = await newStore();
    await store.createTask(task);
    expect((await store.loadTask(task.taskId)).schemaVersion).toBe(2);
    expect(await readFile(store.statePath(task.taskId), 'utf8')).toContain('"schemaVersion": 2');
  });
});
