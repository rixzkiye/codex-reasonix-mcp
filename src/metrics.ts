import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { atomicWrite, privateDirectory } from './state.js';
import { TASK_STATUSES, type TaskRecord, type TaskStatus, type UsageTotals } from './types.js';

export const METRICS_SCHEMA_VERSION = 1 as const;
export const DEFAULT_METRICS_RETENTION = 2_048;
export const MAX_METRICS_RETENTION = 100_000;

export type PermissionDecisionClass = 'allow' | 'deny' | 'interaction';

export type LocalMetricEvent =
  | (MetricBase<'permission'> & { decision: PermissionDecisionClass })
  | (MetricBase<'denial_loop'> & { occurrence: number; stopped: boolean })
  | (MetricBase<'command'> & {
      outcome: 'completed' | 'failed' | 'timeout';
      durationMs: number;
    })
  | (MetricBase<'collision'> & {
      outcome: 'detected' | 'cleared';
      unavailable: boolean;
      overlapCount: number;
    })
  | (MetricBase<'lifecycle'> & { status: TaskStatus; durationMs: number })
  | (MetricBase<'verification'> & {
      outcome: 'passed' | 'failed' | 'timeout';
      durationMs: number;
    })
  | (MetricBase<'provider_usage'> & {
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      estimatedCost: number | null;
    });

interface MetricBase<Kind extends string> {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  id: string;
  timestamp: string;
  taskHash: string;
  kind: Kind;
}

export type MetricInput =
  | { kind: 'permission'; decision: PermissionDecisionClass }
  | { kind: 'denial_loop'; occurrence: number; stopped: boolean }
  | { kind: 'command'; outcome: 'completed' | 'failed' | 'timeout'; durationMs: number }
  | {
      kind: 'collision';
      outcome: 'detected' | 'cleared';
      unavailable: boolean;
      overlapCount: number;
    }
  | { kind: 'lifecycle'; status: TaskStatus; durationMs: number }
  | {
      kind: 'verification';
      outcome: 'passed' | 'failed' | 'timeout';
      durationMs: number;
    }
  | {
      kind: 'provider_usage';
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      estimatedCost: number | null;
    };

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

function boundedNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function boundedInteger(value: unknown): value is number {
  return boundedNumber(value) && Number.isSafeInteger(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(record).every((key) => expected.has(key)) &&
    Object.keys(record).length === keys.length
  );
}

/** Strictly validates persisted metrics. Unknown fields fail closed. */
export function parseMetricEvent(value: unknown): LocalMetricEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('metric event must be an object');
  }
  const record = value as Record<string, unknown>;
  const common =
    record.schemaVersion === METRICS_SCHEMA_VERSION &&
    typeof record.id === 'string' &&
    UUID.test(record.id) &&
    validTimestamp(record.timestamp) &&
    typeof record.taskHash === 'string' &&
    HASH.test(record.taskHash);
  if (!common) throw new Error('invalid metric event identity');

  const base = ['schemaVersion', 'id', 'timestamp', 'taskHash', 'kind'];
  switch (record.kind) {
    case 'permission':
      if (
        !exactKeys(record, [...base, 'decision']) ||
        !['allow', 'deny', 'interaction'].includes(String(record.decision))
      )
        throw new Error('invalid permission metric');
      break;
    case 'denial_loop':
      if (
        !exactKeys(record, [...base, 'occurrence', 'stopped']) ||
        !boundedInteger(record.occurrence) ||
        typeof record.stopped !== 'boolean'
      )
        throw new Error('invalid denial-loop metric');
      break;
    case 'command':
      if (
        !exactKeys(record, [...base, 'outcome', 'durationMs']) ||
        !['completed', 'failed', 'timeout'].includes(String(record.outcome)) ||
        !boundedInteger(record.durationMs)
      )
        throw new Error('invalid command metric');
      break;
    case 'collision':
      if (
        !exactKeys(record, [...base, 'outcome', 'unavailable', 'overlapCount']) ||
        !['detected', 'cleared'].includes(String(record.outcome)) ||
        typeof record.unavailable !== 'boolean' ||
        !boundedInteger(record.overlapCount)
      )
        throw new Error('invalid collision metric');
      break;
    case 'lifecycle':
      if (
        !exactKeys(record, [...base, 'status', 'durationMs']) ||
        !TASK_STATUS_SET.has(String(record.status)) ||
        !boundedInteger(record.durationMs)
      )
        throw new Error('invalid lifecycle metric');
      break;
    case 'verification':
      if (
        !exactKeys(record, [...base, 'outcome', 'durationMs']) ||
        !['passed', 'failed', 'timeout'].includes(String(record.outcome)) ||
        !boundedInteger(record.durationMs)
      )
        throw new Error('invalid verification metric');
      break;
    case 'provider_usage':
      if (
        !exactKeys(record, [
          ...base,
          'promptTokens',
          'completionTokens',
          'reasoningTokens',
          'cacheHitTokens',
          'cacheMissTokens',
          'estimatedCost',
        ]) ||
        !boundedInteger(record.promptTokens) ||
        !boundedInteger(record.completionTokens) ||
        !boundedInteger(record.reasoningTokens) ||
        !boundedInteger(record.cacheHitTokens) ||
        !boundedInteger(record.cacheMissTokens) ||
        !(record.estimatedCost === null || boundedNumber(record.estimatedCost))
      )
        throw new Error('invalid provider-usage metric');
      break;
    default:
      throw new Error('unknown metric event kind');
  }
  return record as unknown as LocalMetricEvent;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
}

function safeInteger(value: number): number {
  return Math.floor(safeNumber(value));
}

function taskHash(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex');
}

/**
 * Privacy-safe local metrics. Each event is an independently atomic file, so
 * concurrent bridge processes cannot lose each other's updates.
 */
export class MetricsStore {
  readonly directory: string;

  constructor(
    stateRoot: string,
    private readonly retention = DEFAULT_METRICS_RETENTION,
  ) {
    if (!Number.isSafeInteger(retention) || retention < 1 || retention > MAX_METRICS_RETENTION) {
      throw new Error(
        `metrics retention must be an integer between 1 and ${String(MAX_METRICS_RETENTION)}`,
      );
    }
    this.directory = path.join(stateRoot, 'metrics', 'events');
  }

  async initialize(): Promise<void> {
    await privateDirectory(this.directory);
  }

  async record(
    taskId: string,
    input: MetricInput & Record<string, unknown>,
  ): Promise<LocalMetricEvent> {
    if (
      !TASK_ID.test(taskId) ||
      taskId.includes('..') ||
      taskId.endsWith('.lock') ||
      taskId === '.'
    ) {
      throw new Error('invalid metric task identity');
    }
    await this.initialize();
    const timestamp = new Date().toISOString();
    const common = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      id: randomUUID(),
      timestamp,
      taskHash: taskHash(taskId),
      kind: input.kind,
    } as const;
    let event: LocalMetricEvent;
    switch (input.kind) {
      case 'permission':
        event = { ...common, kind: input.kind, decision: input.decision };
        break;
      case 'denial_loop':
        event = {
          ...common,
          kind: input.kind,
          occurrence: safeInteger(input.occurrence),
          stopped: input.stopped,
        };
        break;
      case 'command':
        event = {
          ...common,
          kind: input.kind,
          outcome: input.outcome,
          durationMs: safeInteger(input.durationMs),
        };
        break;
      case 'collision':
        event = {
          ...common,
          kind: input.kind,
          outcome: input.outcome,
          unavailable: input.unavailable,
          overlapCount: safeInteger(input.overlapCount),
        };
        break;
      case 'lifecycle':
        event = {
          ...common,
          kind: input.kind,
          status: input.status,
          durationMs: safeInteger(input.durationMs),
        };
        break;
      case 'verification':
        event = {
          ...common,
          kind: input.kind,
          outcome: input.outcome,
          durationMs: safeInteger(input.durationMs),
        };
        break;
      case 'provider_usage':
        event = {
          ...common,
          kind: input.kind,
          promptTokens: safeInteger(input.promptTokens),
          completionTokens: safeInteger(input.completionTokens),
          reasoningTokens: safeInteger(input.reasoningTokens),
          cacheHitTokens: safeInteger(input.cacheHitTokens),
          cacheMissTokens: safeInteger(input.cacheMissTokens),
          estimatedCost: input.estimatedCost === null ? null : safeNumber(input.estimatedCost),
        };
        break;
    }
    parseMetricEvent(event);
    const filename = `${String(Date.now()).padStart(13, '0')}-${event.id}.json`;
    await atomicWrite(path.join(this.directory, filename), `${JSON.stringify(event)}\n`);
    await this.enforceRetention();
    return event;
  }

  async read(): Promise<LocalMetricEvent[]> {
    await this.initialize();
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json')).sort();
    const events: LocalMetricEvent[] = [];
    for (const file of files.slice(-this.retention)) {
      try {
        events.push(
          parseMetricEvent(JSON.parse(await readFile(path.join(this.directory, file), 'utf8'))),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return events;
  }

  private async enforceRetention(): Promise<void> {
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json')).sort();
    await Promise.all(
      files.slice(0, Math.max(0, files.length - this.retention)).map(async (file) => {
        try {
          await unlink(path.join(this.directory, file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
    );
  }
}

function duration(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function usageMetric(usage: UsageTotals): MetricInput {
  return {
    kind: 'provider_usage',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
    estimatedCost: usage.estimatedCost,
  };
}

/** Maps authoritative audit events to a closed, privacy-safe metric schema. */
export function metricForAuditEvent(
  type: string,
  data: unknown,
  task: TaskRecord,
): MetricInput | undefined {
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  if (type === 'permission_auto_allowed') return { kind: 'permission', decision: 'allow' };
  if (type === 'permission_auto_denied') return { kind: 'permission', decision: 'deny' };
  if (type === 'interaction_waiting') return { kind: 'permission', decision: 'interaction' };
  if (type === 'permission_denial_loop_stopped') {
    return {
      kind: 'denial_loop',
      occurrence: typeof record.occurrence === 'number' ? record.occurrence : 0,
      stopped: true,
    };
  }
  if (type === 'command_timeout') {
    return {
      kind: 'command',
      outcome: 'timeout',
      durationMs: typeof record.timeoutSeconds === 'number' ? record.timeoutSeconds * 1_000 : 0,
    };
  }
  if (type === 'command_postflight_passed' || type === 'command_postflight_failed') {
    return {
      kind: 'command',
      outcome:
        type === 'command_postflight_failed'
          ? 'failed'
          : record.status === 'completed'
            ? 'completed'
            : 'failed',
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    };
  }
  if (type === 'source_collision_detected' || type === 'source_collision_cleared') {
    return {
      kind: 'collision',
      outcome: type === 'source_collision_detected' ? 'detected' : 'cleared',
      unavailable: record.unavailable === true,
      overlapCount: Array.isArray(record.overlappingPaths) ? record.overlappingPaths.length : 0,
    };
  }
  if (type === 'verification_finished') {
    const startedAt = typeof record.startedAt === 'string' ? record.startedAt : task.createdAt;
    const finishedAt = typeof record.finishedAt === 'string' ? record.finishedAt : startedAt;
    return {
      kind: 'verification',
      outcome: record.timedOut === true ? 'timeout' : record.passed === true ? 'passed' : 'failed',
      durationMs: duration(startedAt, finishedAt),
    };
  }
  if (
    type === 'task_completed' ||
    type === 'task_failed' ||
    type === 'task_cancel_requested' ||
    type === 'task_closed'
  ) {
    return {
      kind: 'lifecycle',
      status: task.status,
      durationMs: Math.max(0, Date.now() - Date.parse(task.createdAt)),
    };
  }
  if (
    type === 'reasonix_session_ready' ||
    type === 'reasonix_usage' ||
    type === 'prompt_finished'
  ) {
    return usageMetric(task.usage);
  }
  return undefined;
}
