import type { BridgeConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { CursorCodec, paginateText } from '../pagination.js';
import { redactString } from '../redaction.js';
import { changedFiles, diffStat, validateTaskId, workingDiff } from '../repository.js';
import type { StateStore } from '../state.js';
import type { InspectInput, InspectSection } from './api.js';
import { sha256, taskView } from './shared.js';

export interface InspectionDependencies {
  config: BridgeConfig;
  store: StateStore;
}

export interface InspectionAccess {
  initialize(): Promise<void>;
  inspect(input: InspectInput): Promise<Record<string, unknown>>;
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
      task = await this.dependencies.store.waitForChange(taskId, task.updatedAt, waitMs);
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
      'events',
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
}
