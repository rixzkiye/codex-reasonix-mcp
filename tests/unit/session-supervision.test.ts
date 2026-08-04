import type { PromptResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import type { ReasonixStatus } from '../../src/reasonix-status.js';
import {
  fastLaneSessionViolation,
  laneViolation,
  reasonixCompletionDisposition,
} from '../../src/runtime/session-supervision.js';
import type { TaskRecord } from '../../src/types.js';

function status(overrides: Partial<ReasonixStatus> = {}): ReasonixStatus {
  return {
    goal: { status: 'complete' },
    turnOutcome: { kind: 'completed' },
    finalReadiness: { readyForReview: true, summary: '', risks: [] },
    ...overrides,
  } as ReasonixStatus;
}

function task(lane: 'fast' | 'deep'): TaskRecord {
  return {
    executionProfile: { workerLane: lane },
  } as unknown as TaskRecord;
}

describe('Reasonix completion disposition', () => {
  const ended = { stopReason: 'end_turn' } as PromptResponse;

  it('lets cancellation dominate contradictory readiness signals', () => {
    expect(reasonixCompletionDisposition(ended, status({ goal: { status: 'cancelled' } }))).toBe(
      'cancelled',
    );
  });

  it('lets failure dominate contradictory readiness signals', () => {
    expect(
      reasonixCompletionDisposition(
        ended,
        status({ goal: { status: 'failed' }, turnOutcome: { kind: 'error' } }),
      ),
    ).toBe('failed');
  });

  it('accepts a consistent review-ready completion', () => {
    expect(reasonixCompletionDisposition(ended, status())).toBe('review_required');
  });

  it('treats a fast-lane completion as review-ready without Goal', () => {
    expect(
      reasonixCompletionDisposition(
        ended,
        status({ goal: { status: 'none' }, mode: 'normal', workMode: 'economy' }),
      ),
    ).toBe('review_required');
  });
});

describe('worker lane posture', () => {
  it('requires economy + normal + no Goal on the fast lane', () => {
    const fast = task('fast');
    expect(
      laneViolation(
        fast,
        status({ goal: { status: 'none' }, mode: 'normal', workMode: 'economy' }),
      ),
    ).toBeUndefined();
    expect(
      laneViolation(fast, status({ goal: { status: 'none' }, mode: 'goal', workMode: 'economy' })),
    ).toMatch(/fast lane forbids session mode/);
    expect(
      laneViolation(
        fast,
        status({ goal: { status: 'running' }, mode: 'normal', workMode: 'economy' }),
      ),
    ).toMatch(/fast lane forbids Goal activity/);
    expect(
      laneViolation(
        fast,
        status({ goal: { status: 'none' }, mode: 'normal', workMode: 'delivery' }),
      ),
    ).toMatch(/fast lane requires economy work mode/);
  });

  it('requires delivery + Goal on the deep lane', () => {
    const deep = task('deep');
    expect(
      laneViolation(
        deep,
        status({ goal: { status: 'running' }, mode: 'goal', workMode: 'delivery' }),
      ),
    ).toBeUndefined();
    expect(
      laneViolation(
        deep,
        status({ goal: { status: 'none' }, mode: 'normal', workMode: 'economy' }),
      ),
    ).toMatch(/deep lane requires goal session mode/);
    expect(
      laneViolation(deep, status({ goal: { status: 'none' }, mode: 'goal', workMode: 'economy' })),
    ).toMatch(/deep lane requires delivery work mode/);
  });

  it('flags AutoResearch, review/task skills, and subagents on fast sessions only', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'AutoResearch agent',
      kind: 'edit',
      status: 'pending',
    };
    expect(fastLaneSessionViolation(task('fast'), update)).toMatch(/AutoResearch/);
    expect(
      fastLaneSessionViolation(task('fast'), { ...update, title: 'Review skill run' }),
    ).toMatch(/review\/task skills/);
    expect(
      fastLaneSessionViolation(task('fast'), { ...update, title: 'Task skill delegation' }),
    ).toMatch(/review\/task skills/);
    expect(fastLaneSessionViolation(task('fast'), { ...update, title: 'spawn subagent' })).toMatch(
      /subagents/,
    );
    expect(
      fastLaneSessionViolation(task('fast'), { ...update, title: 'write_file result.txt' }),
    ).toBeUndefined();
    expect(fastLaneSessionViolation(task('deep'), update)).toBeUndefined();
  });
});
