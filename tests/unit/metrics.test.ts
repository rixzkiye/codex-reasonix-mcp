import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_METRICS_RETENTION,
  metricForAuditEvent,
  MetricsStore,
  parseMetricEvent,
} from '../../src/metrics.js';
import { parseTaskContract } from '../../src/contracts.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import { contractFixture } from '../helpers.js';

async function metrics(retention = 2_048): Promise<{ root: string; store: MetricsStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-metrics-'));
  const store = new MetricsStore(root, retention);
  await store.initialize();
  return { root, store };
}

describe('privacy-safe local metrics', () => {
  it('persists only whitelisted fields even when callers supply raw sensitive payloads', async () => {
    const { store } = await metrics();
    await store.record('secret-task-name', {
      kind: 'permission',
      decision: 'deny',
      prompt: 'PASSWORD=hunter2',
      argv: ['curl', 'https://token.invalid'],
      output: 'private command output',
      fileContents: 'TOP SECRET',
      changedPaths: ['customer/alice.txt'],
    } as never);

    const files = await readdir(store.directory);
    const raw = await readFile(path.join(store.directory, files[0]!), 'utf8');
    const persisted: unknown = JSON.parse(raw);
    expect(raw).not.toContain('secret-task-name');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('curl');
    expect(raw).not.toContain('private command output');
    expect(raw).not.toContain('TOP SECRET');
    expect(raw).not.toContain('alice');
    expect(persisted).toMatchObject({ kind: 'permission', decision: 'deny' });
    if (typeof persisted !== 'object' || persisted === null) throw new Error('invalid fixture');
    expect(Object.keys(persisted)).toEqual([
      'schemaVersion',
      'id',
      'timestamp',
      'taskHash',
      'kind',
      'decision',
    ]);
  });

  it('records every required closed metric class through authoritative audit events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-metrics-state-'));
    const state = new StateStore(root);
    await state.initialize();
    const task = makeTaskRecordForTest(
      'metric-events',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/missing',
    );
    await state.createTask(task);
    await state.recordEvent(task.taskId, 'permission_auto_allowed', { reason: 'raw reason' });
    await state.recordEvent(task.taskId, 'permission_auto_denied', { reason: 'secret' });
    await state.recordEvent(task.taskId, 'interaction_waiting', { request: 'secret prompt' });
    await state.recordEvent(task.taskId, 'permission_denial_loop_stopped', {
      occurrence: 3,
      fingerprint: 'raw-fingerprint',
    });
    await state.recordEvent(task.taskId, 'command_postflight_passed', {
      status: 'completed',
      durationMs: 42,
      changedFiles: ['private.txt'],
    });
    await state.recordEvent(task.taskId, 'command_timeout', { timeoutSeconds: 2 });
    await state.recordEvent(task.taskId, 'source_collision_detected', {
      unavailable: false,
      overlappingPaths: ['private.txt'],
    });
    await state.recordEvent(task.taskId, 'source_collision_cleared', {});
    await state.recordEvent(task.taskId, 'verification_finished', {
      argv: ['print-secret'],
      output: 'secret',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      passed: false,
      timedOut: true,
    });
    await state.recordEvent(task.taskId, 'reasonix_usage', {}, (record) => {
      record.usage.promptTokens = 10;
      record.usage.completionTokens = 5;
    });
    await state.recordEvent(task.taskId, 'task_cancel_requested', {}, (record) => {
      record.status = 'cancelled';
    });

    const events = await state.metrics.read();
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'permission',
        'denial_loop',
        'command',
        'collision',
        'verification',
        'provider_usage',
        'lifecycle',
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('raw reason');
    expect(serialized).not.toContain('private.txt');
    expect(serialized).not.toContain('print-secret');
    expect(serialized).not.toContain('secret prompt');
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'denial_loop', occurrence: 3, stopped: true }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'command', outcome: 'timeout', durationMs: 2_000 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'verification', outcome: 'timeout', durationMs: 1_000 }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'provider_usage', promptTokens: 10, completionTokens: 5 }),
    );
  });

  it('is concurrent, restart-safe, and enforces bounded retention', async () => {
    const { root, store } = await metrics(25);
    const writes = Promise.all(
      Array.from(
        { length: 80 },
        async (_, index) =>
          await store.record(`task-${String(index % 4)}`, {
            kind: 'command',
            outcome: index % 2 === 0 ? 'completed' : 'failed',
            durationMs: index,
          }),
      ),
    );
    const reads = Array.from({ length: 10 }, async () => {
      await Promise.resolve();
      await store.read();
    });
    await Promise.all([writes, ...reads]);
    const restarted = new MetricsStore(root, 25);
    const events = await restarted.read();
    expect(events).toHaveLength(25);
    expect(events.every((event) => event.kind === 'command')).toBe(true);
    expect((await readdir(store.directory)).filter((file) => file.endsWith('.json'))).toHaveLength(
      25,
    );
  });

  it('fails closed on unknown fields and corrupt persisted events', async () => {
    const { store } = await metrics();
    const valid = await store.record('task', {
      kind: 'permission',
      decision: 'allow',
    });
    expect(() => parseMetricEvent({ ...valid, prompt: 'must not persist' })).toThrow(
      /invalid permission metric/,
    );
    await writeFile(
      path.join(store.directory, '9999999999999-corrupt.json'),
      '{"kind":"permission"}\n',
    );
    await expect(store.read()).rejects.toThrow(/invalid metric event identity/);
  });

  it('bounds retention, task identities, timestamps, counters, and durations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-metric-bounds-'));
    for (const retention of [0, -1, 1.5, MAX_METRICS_RETENTION + 1]) {
      expect(() => new MetricsStore(root, retention)).toThrow(/metrics retention/);
    }
    const store = new MetricsStore(root, 1);
    await expect(
      store.record('../raw-task', { kind: 'permission', decision: 'allow' }),
    ).rejects.toThrow(/task identity/);

    const valid = await store.record('bounded-task', {
      kind: 'command',
      outcome: 'completed',
      durationMs: 1,
    });
    expect(() => parseMetricEvent({ ...valid, timestamp: '2026-99-99T00:00:00.000Z' })).toThrow(
      /identity/,
    );
    expect(() => parseMetricEvent({ ...valid, durationMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /command metric/,
    );
    expect(() => parseMetricEvent({ ...valid, durationMs: 1.5 })).toThrow(/command metric/);
  });

  it('validates every persisted event variant and normalizes invalid numeric input', async () => {
    const { store } = await metrics();
    const base = {
      schemaVersion: 1,
      id: 'event',
      timestamp: '2026-08-03T00:00:00.000Z',
      taskHash: 'a'.repeat(64),
    };
    for (const invalid of [
      null,
      { ...base, kind: 'unknown' },
      { ...base, kind: 'denial_loop', occurrence: -1, stopped: true },
      { ...base, kind: 'command', outcome: 'other', durationMs: 1 },
      { ...base, kind: 'collision', outcome: 'detected', unavailable: 'no', overlapCount: 1 },
      { ...base, kind: 'lifecycle', status: 'future', durationMs: 1 },
      { ...base, kind: 'verification', outcome: 'passed', durationMs: -1 },
      { ...base, kind: 'verification', outcome: 'passed', durationMs: 1, extra: true },
      {
        ...base,
        kind: 'provider_usage',
        promptTokens: -1,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        estimatedCost: null,
      },
    ]) {
      expect(() => parseMetricEvent(invalid)).toThrow();
    }

    const normalized = await store.record('task', {
      kind: 'provider_usage',
      promptTokens: Number.POSITIVE_INFINITY,
      completionTokens: -2,
      reasoningTokens: Number.MAX_VALUE,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      estimatedCost: Number.NaN,
    } as never);
    expect(normalized).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: Number.MAX_SAFE_INTEGER,
      estimatedCost: 0,
    });

    const task = makeTaskRecordForTest(
      'metric-branches',
      parseTaskContract(contractFixture()),
      { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'abc' },
      '/missing',
    );
    expect(metricForAuditEvent('command_postflight_failed', {}, task)).toMatchObject({
      outcome: 'failed',
      durationMs: 0,
    });
    expect(
      metricForAuditEvent('command_postflight_passed', { status: 'failed' }, task),
    ).toMatchObject({ outcome: 'failed' });
    expect(metricForAuditEvent('verification_finished', { passed: true }, task)).toMatchObject({
      outcome: 'passed',
      durationMs: 0,
    });
    expect(metricForAuditEvent('verification_finished', {}, task)).toMatchObject({
      outcome: 'failed',
      durationMs: 0,
    });
    expect(metricForAuditEvent('permission_denial_loop_stopped', null, task)).toMatchObject({
      occurrence: 0,
    });
    expect(metricForAuditEvent('command_timeout', {}, task)).toMatchObject({ durationMs: 0 });
  });
});
