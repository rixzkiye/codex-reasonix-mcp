import { describe, expect, it } from 'vitest';

import {
  reasonixStatusSchema,
  reasonixStatusUpdateSchema,
} from '../../src/reasonix-status.js';
import { statusToUsage } from '../../src/runtime/shared.js';

function v1190Status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const totals = {
    promptTokens: 10,
    completionTokens: 5,
    reasoningTokens: 2,
    cacheHitTokens: 7,
    cacheMissTokens: 3,
    cacheHitRatio: 0.7,
    estimatedCost: 0.001,
    currency: 'USD',
    usageSource: 'executor',
  };
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
    turnOutcome: { kind: 'completed' },
    finalReadiness: { readyForReview: true, summary: 'Created result.txt.', risks: [] },
    sandbox: {
      mode: 'enforce',
      engine: 'bubblewrap',
      available: true,
      workspaceRoot: '/tmp/worktree',
      writeRoots: ['/tmp/worktree'],
      networkEnabled: false,
    },
    usage: { turn: { ...totals }, cumulative: { ...totals } },
    ...overrides,
  };
}

function withEstimatedUsage(): Record<string, unknown> {
  const status = v1190Status();
  const usage = status.usage as Record<string, Record<string, unknown>>;
  return v1190Status({
    usage: {
      turn: { ...usage.turn, estimated: false },
      cumulative: { ...usage.cumulative, estimated: true },
    },
  });
}

describe('Reasonix status usage compatibility', () => {
  it('accepts the Reasonix v1.19.0 payload without estimated metadata', () => {
    const parsed = reasonixStatusSchema.parse(v1190Status());
    expect(parsed.usage.turn).not.toHaveProperty('estimated');
    expect(parsed.usage.cumulative).not.toHaveProperty('estimated');
  });

  it('accepts Reasonix >= 1.19.4 estimated booleans only on turn and cumulative', () => {
    const parsed = reasonixStatusSchema.parse(withEstimatedUsage());
    expect(parsed.usage.turn.estimated).toBe(false);
    expect(parsed.usage.cumulative.estimated).toBe(true);

    const update = reasonixStatusUpdateSchema.parse({
      schemaVersion: 1,
      sequence: 4,
      sessionId: 'fake-1',
      event: 'usage',
      status: parsed,
    });
    expect(update.status.usage.cumulative.estimated).toBe(true);
  });

  it('projects compatibility metadata back to canonical UsageTotals', () => {
    const parsed = reasonixStatusSchema.parse(withEstimatedUsage());
    expect(statusToUsage(parsed)).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 2,
      cacheHitTokens: 7,
      cacheMissTokens: 3,
      cacheHitRatio: 0.7,
      estimatedCost: 0.001,
      currency: 'USD',
      usageSource: 'executor',
    });
    expect(statusToUsage(parsed)).not.toHaveProperty('estimated');
  });

  it.each([
    ['turn', 'yes'],
    ['cumulative', 1],
  ])('rejects non-boolean usage.%s.estimated', (location, estimated) => {
    const status = v1190Status();
    const usage = status.usage as Record<string, Record<string, unknown>>;
    expect(() =>
      reasonixStatusSchema.parse(
        v1190Status({
          usage: {
            turn: { ...usage.turn, ...(location === 'turn' ? { estimated } : {}) },
            cumulative: {
              ...usage.cumulative,
              ...(location === 'cumulative' ? { estimated } : {}),
            },
          },
        }),
      ),
    ).toThrow(/estimated/);
  });

  it('rejects estimated on the shared usage object', () => {
    const usage = v1190Status().usage as Record<string, unknown>;
    expect(() =>
      reasonixStatusSchema.parse(v1190Status({ usage: { ...usage, estimated: true } })),
    ).toThrow(/estimated/);
  });

  it('preserves strict rejection of unknown fields', () => {
    const status = withEstimatedUsage();
    const usage = status.usage as Record<string, Record<string, unknown>>;
    expect(() =>
      reasonixStatusSchema.parse(
        v1190Status({
          usage: {
            ...usage,
            turn: { ...usage.turn, unknownCounter: 1 },
          },
        }),
      ),
    ).toThrow(/unknownCounter/);
    expect(() => reasonixStatusSchema.parse(v1190Status({ unknownStatus: true }))).toThrow(
      /unknownStatus/,
    );
  });
});
