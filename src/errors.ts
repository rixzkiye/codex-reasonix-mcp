import { redact, redactString } from './redaction.js';

export const BRIDGE_ERROR_CODES = [
  'invalid_contract',
  'invalid_request',
  'missing_sandbox_metadata',
  'read_only_sandbox',
  'unsupported_platform',
  'not_git_repository',
  'dirty_repository',
  'task_conflict',
  'task_not_found',
  'invalid_state',
  'scope_violation',
  'ownership_ambiguous',
  'reasonix_incompatible',
  'reasonix_unavailable',
  'interaction_not_found',
  'repair_limit_reached',
  'verification_failed',
  'secret_detected',
  'commit_failed',
  'lease_conflict',
  'output_limit_exceeded',
  'sandbox_unavailable',
  'internal_error',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export const NEXT_ACTIONS = [
  'fix_request',
  'inspect_task',
  'respond_to_interaction',
  'resolve_source_collision',
  'resume_task',
  'repair_and_finalize',
  'retry',
  'create_new_task',
  'install_or_upgrade',
  'none',
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface ErrorEnvelope {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
  next_action: NextAction;
  details?: Record<string, unknown>;
}

const ERROR_BEHAVIOR = {
  invalid_contract: { retryable: false, next_action: 'fix_request' },
  invalid_request: { retryable: false, next_action: 'fix_request' },
  missing_sandbox_metadata: { retryable: false, next_action: 'install_or_upgrade' },
  read_only_sandbox: { retryable: false, next_action: 'fix_request' },
  unsupported_platform: { retryable: false, next_action: 'install_or_upgrade' },
  not_git_repository: { retryable: false, next_action: 'fix_request' },
  dirty_repository: { retryable: false, next_action: 'fix_request' },
  task_conflict: { retryable: false, next_action: 'create_new_task' },
  task_not_found: { retryable: false, next_action: 'create_new_task' },
  invalid_state: { retryable: false, next_action: 'inspect_task' },
  scope_violation: { retryable: false, next_action: 'resolve_source_collision' },
  ownership_ambiguous: { retryable: false, next_action: 'resolve_source_collision' },
  reasonix_incompatible: { retryable: false, next_action: 'install_or_upgrade' },
  reasonix_unavailable: { retryable: true, next_action: 'retry' },
  interaction_not_found: { retryable: false, next_action: 'inspect_task' },
  repair_limit_reached: { retryable: false, next_action: 'repair_and_finalize' },
  verification_failed: { retryable: false, next_action: 'repair_and_finalize' },
  secret_detected: { retryable: false, next_action: 'repair_and_finalize' },
  commit_failed: { retryable: false, next_action: 'repair_and_finalize' },
  lease_conflict: { retryable: true, next_action: 'retry' },
  output_limit_exceeded: { retryable: false, next_action: 'inspect_task' },
  sandbox_unavailable: { retryable: false, next_action: 'install_or_upgrade' },
  internal_error: { retryable: false, next_action: 'none' },
} as const satisfies Record<BridgeErrorCode, { retryable: boolean; next_action: NextAction }>;

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

export function errorEnvelope(error: unknown): ErrorEnvelope {
  const bridgeError = asBridgeError(error);
  const behavior = ERROR_BEHAVIOR[bridgeError.code];
  const details = bridgeError.details ? redact(bridgeError.details) : undefined;
  return {
    code: bridgeError.code,
    message: redactString(bridgeError.message),
    retryable: behavior.retryable,
    next_action: behavior.next_action,
    ...(details && typeof details === 'object' && !Array.isArray(details)
      ? { details: details as Record<string, unknown> }
      : {}),
  };
}
