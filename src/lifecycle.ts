import { createHash } from 'node:crypto';

import { BridgeError } from './errors.js';
import { TERMINAL_STATUSES, type TaskRecord, type TaskStatus } from './types.js';

const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  provisioning: new Set(['running', 'paused', 'failed', 'cancelled', 'closed']),
  running: new Set([
    'waiting_permission',
    'waiting_input',
    'paused',
    'review_required',
    'failed',
    'cancelled',
    'closed',
  ]),
  waiting_permission: new Set(['running', 'paused', 'failed', 'cancelled', 'closed']),
  waiting_input: new Set(['running', 'paused', 'failed', 'cancelled', 'closed']),
  paused: new Set(['running', 'failed', 'cancelled', 'closed']),
  review_required: new Set(['running', 'paused', 'verifying', 'failed', 'cancelled', 'closed']),
  verifying: new Set([
    'paused',
    'review_required',
    'completed',
    'commit_failed',
    'failed',
    'cancelled',
  ]),
  completed: new Set(),
  commit_failed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  closed: new Set(),
};

export function transitionTask(
  task: TaskRecord,
  next: TaskStatus,
  phase: string,
  reason?: string,
): void {
  if (task.status === next) {
    task.phase = phase;
    if (reason !== undefined) task.reason = reason;
    return;
  }
  if (TERMINAL_STATUSES.has(task.status) || !TRANSITIONS[task.status].has(next)) {
    throw new BridgeError('invalid_state', `Invalid task transition ${task.status} -> ${next}`);
  }
  task.status = next;
  task.phase = phase;
  task.statusSequence += 1;
  if (reason === undefined) delete task.reason;
  else task.reason = reason;
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

/**
 * Canonical hash of a pause reason. Clients echo it back when resuming so a
 * stale pause acknowledgment can never be mistaken for a current one.
 */
export function pauseReasonHash(reason: string | undefined): string {
  return createHash('sha256')
    .update(reason ?? 'unspecified')
    .digest('hex');
}

/**
 * Enter the paused state, bumping the monotonic pause revision and binding
 * the pause to a hash of its reason. Every pause entry point must use this
 * helper so resume can reject stale acknowledgments.
 */
export function enterPaused(record: TaskRecord, phase: string, reason?: string): void {
  transitionTask(record, 'paused', phase, reason);
  record.pauseRevision = (record.pauseRevision ?? 0) + 1;
  record.pauseReasonHash = pauseReasonHash(reason);
  record.inspectedAfterPause = false;
}
