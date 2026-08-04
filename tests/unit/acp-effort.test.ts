import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import {
  assertReasonixEffort,
  cancelBestEffortThenComplete,
  desiredEffort,
  supervisedWorkerPrompt,
} from '../../src/acp.js';
import { DEFAULT_EXECUTION_TIMEOUT_SECONDS, REASONING_EFFORTS } from '../../src/types.js';
import type { ReasonixStatus } from '../../src/reasonix-status.js';

function effortOption(values: string[], id = 'reasoning'): SessionConfigOption {
  return {
    id,
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: values[0] ?? 'medium',
    options: values.map((value) => ({ value, name: value })),
  };
}

describe('Reasonix ACP effort selection', () => {
  it.each(REASONING_EFFORTS)('selects exactly requested effort %s', (effort) => {
    expect(desiredEffort([effortOption([...REASONING_EFFORTS])], effort)).toEqual({
      configId: 'reasoning',
      value: effort,
    });
  });

  it('fails closed when the requested effort is not advertised', () => {
    expect(() => desiredEffort([effortOption(['medium', 'high'])], 'low')).toThrow(
      'Requested Reasonix reasoning effort is unavailable: low',
    );
  });

  it('fails closed when Reasonix omits effort selection', () => {
    expect(() => desiredEffort([], 'medium')).toThrow(
      'Reasonix did not advertise reasoning effort selection',
    );
  });

  it('fails closed when effective effort drifts after session setup', () => {
    expect(() => assertReasonixEffort({ effort: 'high' } as ReasonixStatus, 'low')).toThrow(
      'Reasonix effective reasoning effort changed unexpectedly',
    );
  });
});

describe('Reasonix worker supervision prompt', () => {
  it('assigns edits to the worker and bridge-owned delivery to the bridge', () => {
    const prompt = supervisedWorkerPrompt('Implement the contract.');
    expect(prompt).toContain('You are the edit worker');
    expect(prompt).toContain('Before the first edit, create a concise task plan or todo');
    expect(prompt).toContain('acceptance verification, staging, ref updates, and commit creation');
    expect(prompt).toContain(`before ${String(DEFAULT_EXECUTION_TIMEOUT_SECONDS)} seconds`);
    expect(prompt).not.toContain('provider tokens');
    expect(prompt).toContain('After 2 identical immutable-policy denials');
  });

  it('renders the persisted per-task execution deadline without a token ceiling', () => {
    const prompt = supervisedWorkerPrompt('Implement a larger contract.', 14_400);
    expect(prompt).toContain('before 14400 seconds');
    expect(prompt).not.toContain('token');
  });

  it('always reports completion when best-effort cancellation fails', async () => {
    let completed = false;
    await cancelBestEffortThenComplete(
      () => Promise.reject(new Error('connection closed')),
      () => {
        completed = true;
      },
    );
    expect(completed).toBe(true);
  });
});
