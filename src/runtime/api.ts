import type { WireReasoningEffort, WorkerLane } from '../types.js';

export interface RuntimeCallContext {
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface DelegateInput {
  task_id: string;
  contract: unknown;
  base_ref?: string;
  resume?: boolean;
  worker_lane?: WorkerLane;
  reasoning_effort?: WireReasoningEffort;
  execution_timeout_seconds?: number;
  wait_mode?: 'review' | 'background';
  wait_timeout_seconds?: number;
  pause_revision?: number;
  pause_reason_hash?: string;
  path_base?: 'cwd' | 'repository';
}

export type ControlInput =
  | { task_id: string; action: 'steer'; message: string }
  | {
      task_id: string;
      action: 'respond';
      interaction_id: string;
      decision: 'allow' | 'deny';
      option_id?: string;
      answer?: string;
    }
  | { task_id: string; action: 'cancel' }
  | {
      task_id: string;
      action: 'finalize';
      review_summary: string;
      approved_review_criteria: string[];
      expected_review_revision: number;
      expected_review_tree_hash: string;
      commit_message?: string;
      wait_timeout_seconds?: number;
    }
  | { task_id: string; action: 'close' };

export const INSPECT_SECTIONS = [
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
] as const;

export type InspectSection = (typeof INSPECT_SECTIONS)[number];

export interface InspectInput {
  task_id: string;
  include?: InspectSection[];
  wait_ms?: number;
  cursor?: string;
  max_bytes?: number;
  wait_until?: 'change' | 'review_required' | 'interaction' | 'terminal';
}
