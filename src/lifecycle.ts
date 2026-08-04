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
