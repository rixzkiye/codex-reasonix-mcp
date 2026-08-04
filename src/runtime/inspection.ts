import type { BridgeConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { CursorCodec, paginateText } from '../pagination.js';
import { redact, redactString } from '../redaction.js';
import { changedFiles, diffStat, validateTaskId, workingDiff } from '../repository.js';
import type { StateStore } from '../state.js';
import { TERMINAL_STATUSES, type TaskRecord } from '../types.js';
import type { InspectInput, InspectSection } from './api.js';
import { hasPendingInteraction, sha256, taskView, waitForTask } from './shared.js';

export interface InspectionDependencies {
  config: BridgeConfig;
  store: StateStore;
}

export interface InspectionAccess {
  initialize(): Promise<void>;
  inspect(input: InspectInput): Promise<Record<string, unknown>>;
  reviewBundle(taskId: string, maxBytes?: number): Promise<Record<string, unknown>>;
}

export class InspectionController implements InspectionAccess {
  private cursor!: CursorCodec;

  constructor(private readonly dependencies: InspectionDependencies) {}

  async initialize(): Promise<void> {
    this.cursor = await CursorCodec.create(this.dependencies.store.root);
  }

  async inspect(input: InspectInput): Promise<Record<string, unknown>> {
    const taskId = validateTaskId(input.task_id);
    let task = await this.dependencies.store.loadTask(taskId);
    const waitMs = Math.min(Math.max(input.wait_ms ?? 0, 0), 30_000);
    if (task.status === 'paused' && !task.inspectedAfterPause) {
      task = await this.dependencies.store.updateTask(taskId, (record) => {
        record.inspectedAfterPause = true;
      });
    }
    if (waitMs > 0 && !input.cursor) {
      const waitUntil = input.wait_until ?? 'change';
      if (waitUntil === 'change') {
        task = await this.dependencies.store.waitForChange(taskId, task.updatedAt, waitMs);
      } else {
        const waited = await waitForTask(this.dependencies.store, taskId, task, waitMs, (record) =>
          this.matchesWaitUntil(record, waitUntil),
        );
        task = waited.task;
      }
    }
    const include = input.include ?? [
      'status',
      'summary',
      'changed_files',
      'diff_stat',
      'verification',
      'acceptance_evidence',
      'risks',
      'usage',
      'interactions',
    ];
    const maxBytes = Math.min(
      Math.max(input.max_bytes ?? this.dependencies.config.maxInspectBytes, 1_024),
      64 * 1024,
    );
    const cursorPayload = input.cursor ? this.cursor.decode(input.cursor) : undefined;
    if (cursorPayload && !include.includes(cursorPayload.section as InspectSection)) {
      throw new BridgeError('invalid_request', 'Cursor section is not requested in include');
    }

    const values = new Map<InspectSection, unknown>();
    for (const section of include) {
      if (cursorPayload && cursorPayload.section !== section) continue;
      switch (section) {
        case 'status':
          values.set(section, taskView(task));
          break;
        case 'summary':
          values.set(section, task.summary);
          break;
        case 'changed_files':
          values.set(section, await changedFiles(task.worktree).catch(() => task.changedFiles));
          break;
        case 'diff_stat':
          values.set(section, await diffStat(task.worktree).catch(() => ''));
          break;
        case 'diff':
          values.set(section, redactString(await workingDiff(task.worktree), 16 * 1024 * 1024));
          break;
        case 'verification':
          values.set(section, task.verification);
          break;
        case 'acceptance_evidence':
          values.set(section, task.acceptanceEvidence);
          break;
        case 'risks':
          values.set(section, task.risks);
          break;
        case 'usage':
          values.set(section, task.usage);
          break;
        case 'interactions':
          values.set(section, task.interactions);
          break;
        case 'events':
          values.set(section, await this.dependencies.store.readEvents(taskId));
          break;
      }
    }

    const sections: Record<string, unknown> = {};
    let budget = maxBytes - 512;
    let nextCursor: string | undefined;
    let truncated = false;
    for (const section of include) {
      if (!values.has(section)) continue;
      const value = values.get(section);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const bytes = Buffer.byteLength(text);
      if (bytes <= budget && !cursorPayload) {
        sections[section] = value;
        budget -= bytes;
        continue;
      }
      const digest = sha256(text);
      const page = paginateText(
        this.cursor,
        taskId,
        section,
        text,
        digest,
        Math.max(1, budget),
        input.cursor,
      );
      sections[section] = page.value;
      nextCursor = page.nextCursor;
      truncated = page.truncated;
      break;
    }
    return {
      task_id: taskId,
      sections,
      truncated,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      updated_at: task.updatedAt,
    };
  }

  async reviewBundle(taskId: string, maxBytes = 12 * 1024): Promise<Record<string, unknown>> {
    const task = await this.dependencies.store.loadTask(taskId);
    const files = await changedFiles(task.worktree).catch(() => task.changedFiles);
    const stat = await diffStat(task.worktree).catch(() => '');
    const rawDiff = await workingDiff(task.worktree).catch(() => '');
    const interaction = task.interactions.find((item) => item.status === 'pending');
    const bundle: Record<string, unknown> = {
      summary: '',
      changed_files: [],
      diff_stat: '',
      diff: '',
      risks: [],
      required_review_criteria: task.contract.acceptance_criteria
        .filter((criterion) => criterion.evidence === 'review')
        .map((criterion) => criterion.id)
        .sort(),
      review_revision: task.reviewRevision ?? 0,
      review_diff_sha256: sha256(rawDiff),
      usage: {
        ...task.usage,
        usageSource: redactString(task.usage.usageSource, 128),
        currency: task.usage.currency ? redactString(task.usage.currency, 32) : null,
      },
      ...(interaction
        ? {
            active_interaction: {
              id: redactString(interaction.id, 240),
              kind: interaction.kind,
              status: interaction.status,
              createdAt: redactString(interaction.createdAt, 64),
              ...(interaction.resolvedAt
                ? { resolvedAt: redactString(interaction.resolvedAt, 64) }
                : {}),
              request: this.boundedRecord(interaction.request, 2_048),
              ...(interaction.response
                ? { response: this.boundedRecord(interaction.response, 1_024) }
                : {}),
            },
          }
        : {}),
    };
    const budget = Math.max(1_024, Math.min(maxBytes, 12 * 1024));
    this.compactFixedFields(bundle, budget);
    this.fitString(bundle, 'summary', redactString(task.summary, 2_048), budget);
    this.fitString(bundle, 'diff_stat', redactString(stat, 2_048), budget);
    this.fitStringArray(
      bundle,
      'changed_files',
      files.slice(0, 100).map((file) => redactString(file, 1_000)),
      budget,
    );
    this.fitStringArray(
      bundle,
      'required_review_criteria',
      (bundle.required_review_criteria as string[]).slice(0, 100),
      budget,
    );
    this.fitStringArray(
      bundle,
      'risks',
      task.risks.slice(0, 20).map((risk) => redactString(risk, 300)),
      budget,
    );
    this.fitString(bundle, 'diff', redactString(rawDiff, 12 * 1_024), budget);
    return bundle;
  }

  private serializedBytes(value: Record<string, unknown>): number {
    return Buffer.byteLength(JSON.stringify(value));
  }

  private compactFixedFields(bundle: Record<string, unknown>, budget: number): void {
    if (this.serializedBytes(bundle) <= budget) return;
    const interaction = bundle.active_interaction;
    if (interaction && typeof interaction === 'object' && !Array.isArray(interaction)) {
      const record = interaction as Record<string, unknown>;
      delete record.response;
      record.request = { truncated: true };
    }
    if (this.serializedBytes(bundle) <= budget) return;
    const usage = bundle.usage;
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
      (usage as Record<string, unknown>).usageSource = 'bounded';
      (usage as Record<string, unknown>).currency = null;
    }
  }

  private fitString(
    bundle: Record<string, unknown>,
    field: string,
    value: string,
    budget: number,
  ): void {
    bundle[field] = value;
    if (this.serializedBytes(bundle) <= budget) return;
    let low = 0;
    let high = Buffer.byteLength(value);
    let fitted = '';
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const candidate = this.truncateUtf8(value, midpoint);
      bundle[field] = candidate;
      if (this.serializedBytes(bundle) <= budget) {
        fitted = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    bundle[field] = fitted;
  }

  private fitStringArray(
    bundle: Record<string, unknown>,
    field: string,
    values: string[],
    budget: number,
  ): void {
    const fitted: string[] = [];
    bundle[field] = fitted;
    for (const value of values) {
      fitted.push(value);
      if (this.serializedBytes(bundle) <= budget) continue;
      fitted.pop();
      const before = this.serializedBytes(bundle);
      const available = Math.max(0, budget - before - 4);
      const truncated = this.truncateUtf8(value, available);
      if (truncated) {
        fitted.push(truncated);
        if (this.serializedBytes(bundle) > budget) fitted.pop();
      }
      break;
    }
  }

  private boundedRecord(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
    const redacted = redact(value);
    if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) return {};
    const record = redacted as Record<string, unknown>;
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) <= maxBytes) return record;
    return {
      truncated: true,
      preview: this.truncateUtf8(serialized, Math.max(0, maxBytes - 32)),
    };
  }

  private matchesWaitUntil(
    task: TaskRecord,
    waitUntil: NonNullable<InspectInput['wait_until']>,
  ): boolean {
    if (waitUntil === 'review_required') return task.status === 'review_required';
    if (waitUntil === 'interaction') return hasPendingInteraction(task);
    if (waitUntil === 'terminal') return TERMINAL_STATUSES.has(task.status);
    return true;
  }

  private truncateUtf8(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    const buffer = Buffer.from(value);
    if (buffer.length <= maxBytes) return value;
    return `${buffer.subarray(0, Math.max(0, maxBytes - 16)).toString('utf8')}\n[truncated]`;
  }
}
