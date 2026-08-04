import { describe, expect, it } from 'vitest';

import {
  BRIDGE_ERROR_CODES,
  BridgeError,
  errorEnvelope,
  NEXT_ACTIONS,
  type BridgeErrorCode,
  type NextAction,
} from '../../src/errors.js';

const expected = {
  invalid_contract: [false, 'fix_request'],
  invalid_request: [false, 'fix_request'],
  missing_sandbox_metadata: [false, 'install_or_upgrade'],
  read_only_sandbox: [false, 'fix_request'],
  unsupported_platform: [false, 'install_or_upgrade'],
  not_git_repository: [false, 'fix_request'],
  dirty_repository: [false, 'fix_request'],
  task_conflict: [false, 'create_new_task'],
  task_not_found: [false, 'create_new_task'],
  invalid_state: [false, 'inspect_task'],
  scope_violation: [false, 'resolve_source_collision'],
  ownership_ambiguous: [false, 'resolve_source_collision'],
  reasonix_incompatible: [false, 'install_or_upgrade'],
  reasonix_unavailable: [true, 'retry'],
  interaction_not_found: [false, 'inspect_task'],
  repair_limit_reached: [false, 'repair_and_finalize'],
  verification_failed: [false, 'repair_and_finalize'],
  secret_detected: [false, 'repair_and_finalize'],
  commit_failed: [false, 'repair_and_finalize'],
  lease_conflict: [true, 'retry'],
  output_limit_exceeded: [false, 'inspect_task'],
  sandbox_unavailable: [false, 'install_or_upgrade'],
  internal_error: [false, 'none'],
} as const satisfies Record<BridgeErrorCode, readonly [boolean, NextAction]>;

describe('stable MCP error envelope', () => {
  it.each(BRIDGE_ERROR_CODES)('maps %s exhaustively', (code) => {
    const envelope = errorEnvelope(new BridgeError(code, `${code} message`));
    expect(envelope).toEqual({
      code,
      message: `${code} message`,
      retryable: expected[code][0],
      next_action: expected[code][1],
    });
    expect(NEXT_ACTIONS).toContain(envelope.next_action);
  });

  it('marks only temporary lease and provider-process failures retryable', () => {
    expect(
      BRIDGE_ERROR_CODES.filter((code) => errorEnvelope(new BridgeError(code, code)).retryable),
    ).toEqual(['reasonix_unavailable', 'lease_conflict']);
  });

  it('redacts optional details before returning them to an MCP client', () => {
    expect(
      errorEnvelope(
        new BridgeError('reasonix_unavailable', 'spawn failed', {
          authorization: 'Bearer secret-value',
          stderr: 'token sk-proj-abcdefghijklmnopqrstuvwxyz',
        }),
      ),
    ).toMatchObject({
      details: { authorization: '[REDACTED]', stderr: 'token [REDACTED]' },
    });
  });
});
