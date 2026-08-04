import { describe, expect, it } from 'vitest';

import {
  reasonixStatusSchema,
  reasonixStatusUpdateSchema,
  type ReasonixStatus,
} from '../../src/reasonix-status.js';

/**
 * Canonical v1.19.0 status payload shape (no `estimated` field anywhere).
 * Mirrors the producer in tests/fixtures/fake-reasonix.ts.
 */
function v1190Status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sequence: 3,
    sessionId: 'fake-1',
    state: 'idle',
    model: 'deepseek-v4-flash',
    effort: 'medium',
    mode: 'normal',
    workMode: 'balanced',
    plannerMode: 'off',
    goal: { status: 'complete', objective: 'fake offline goal' },
    phase: 'review_ready',
    turnOutcome: { kind: 'completed', reason: 'Goal is not review-ready' },
    finalReadiness: { readyForReview: true, summary: 'Created result.txt.', risks: [] },
    sandbox: {
      mode: 'enforce',
      engine: 'bubblewrap',
      available: true,
      workspaceRoot: '/tmp/worktree',
      writeRoots: ['/tmp/worktree'],
      networkEnabled: false,
    },
    usage: {
      turn: {
        promptTokens: 10,
        completionTokens: 5,
        reasoningTokens: 2,
        cacheHitTokens: 7,
        cacheMissTokens: 3,
        cacheHitRatio: 0.7,
        estimatedCost: 0.001,
        currency: 'USD',
        usageSource: 'executor',
      },
      cumulative: {
        promptTokens: 10,
        completionTokens: 5,
        reasoningTokens: 2,
        cacheHitTokens: 7,
        cacheMissTokens: 3,
        cacheHitRatio: 0.7,
        estimatedCost: 0.001,
        currency: 'USD',
        usageSource: 'executor',
      },
    },
    ...overrides,
  };
}

describe('Reasonix status payload compatibility (v1.19.0 vs >= 1.19.4)', () => {
  it('accepts the v1.19.0 payload without usage.estimated', () => {
    const parsed = reasonixStatusSchema.parse(v1190Status());
    expect(parsed.usage.turn).not.toHaveProperty('estimated');
    expect(parsed.usage).not.toHaveProperty('estimated');
  });

  it('accepts the >= 1.19.4 payload with usage.estimated on the shared usage object', () => {
    const baseUsage = v1190Status().usage as Record<string, unknown>;
    const payload = v1190Status({
      usage: {
        ...baseUsage,
        estimated: true,
      },
    });
    const parsed = reasonixStatusSchema.parse(payload);
    expect(parsed.usage.estimated).toBe(true);
  });

  it('accepts the >= 1.19.4 payload with estimated on turn and cumulative usage', () => {
    const usage = v1190Status().usage as Record<string, unknown>;
    const turn = usage.turn as Record<string, unknown>;
    const cumulative = usage.cumulative as Record<string, unknown>;
    const payload = v1190Status({
      usage: {
        turn: { ...turn, estimated: false },
        cumulative: { ...cumulative, estimated: true },
      },
    });
    const parsed = reasonixStatusSchema.parse(payload);
    expect(parsed.usage.turn.estimated).toBe(false);
    expect(parsed.usage.cumulative.estimated).toBe(true);
  });

  it('accepts estimated inside a status_update notification payload', () => {
    const baseUsage = v1190Status().usage as Record<string, unknown>;
    const status = v1190Status({
      usage: {
        ...baseUsage,
        estimated: true,
      },
    }) as ReasonixStatus;
    const parsed = reasonixStatusUpdateSchema.parse({
      schemaVersion: 1,
      sequence: 4,
      sessionId: 'fake-1',
      event: 'usage',
      status,
    });
    expect(parsed.status.usage.estimated).toBe(true);
  });

  it('rejects a non-boolean estimated value', () => {
    const usage = v1190Status().usage as Record<string, unknown>;
    const payload = v1190Status({
      usage: { ...usage, estimated: 'yes' },
    });
    expect(() => reasonixStatusSchema.parse(payload)).toThrow(/estimated/);
  });

  it('still rejects genuinely unknown keys (strictness preserved)', () => {
    const usage = v1190Status().usage as Record<string, unknown>;
    const payload = v1190Status({
      usage: { ...usage, frobnicate: 42 },
    });
    expect(() => reasonixStatusSchema.parse(payload)).toThrow(/frobnicate/);
  });

  it('still rejects unknown keys outside usage', () => {
    expect(() => reasonixStatusSchema.parse(v1190Status({ mystery: 1 }))).toThrow(/mystery/);
  });
});
