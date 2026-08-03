export interface DelegateInput {
  task_id: string;
  contract: unknown;
  base_ref?: string;
  resume?: boolean;
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
      commit_message?: string;
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
}
