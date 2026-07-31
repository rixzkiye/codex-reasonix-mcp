export type BridgeErrorCode =
  | 'invalid_contract'
  | 'invalid_request'
  | 'missing_sandbox_metadata'
  | 'read_only_sandbox'
  | 'unsupported_platform'
  | 'not_git_repository'
  | 'dirty_repository'
  | 'task_conflict'
  | 'task_not_found'
  | 'invalid_state'
  | 'scope_violation'
  | 'ownership_ambiguous'
  | 'reasonix_incompatible'
  | 'reasonix_unavailable'
  | 'interaction_not_found'
  | 'repair_limit_reached'
  | 'verification_failed'
  | 'secret_detected'
  | 'commit_failed'
  | 'lease_conflict'
  | 'output_limit_exceeded'
  | 'internal_error';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof Error) {
    return new BridgeError('internal_error', error.message, { name: error.name });
  }
  return new BridgeError('internal_error', 'Unknown bridge error');
}
