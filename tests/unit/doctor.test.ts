import { describe, expect, it } from 'vitest';

import { missingSupervisorFlags } from '../../src/doctor.js';

describe('missingSupervisorFlags', () => {
  it('accepts the single-dash format emitted by Go flag help', () => {
    const help = `Usage of acp:
  -planner string
        planner policy: auto | off
  -sandbox-bash string
        bash sandbox policy: auto | enforce
  -sandbox-network string
        sandbox network policy: auto | on | off
  -workspace-only
        confine writes to the session cwd
`;

    expect(missingSupervisorFlags(help)).toEqual([]);
  });

  it('continues to accept conventional double-dash help', () => {
    const help = [
      '--planner=off',
      '--sandbox-network off',
      '--workspace-only',
      '--sandbox-bash enforce',
    ].join('\n');

    expect(missingSupervisorFlags(help)).toEqual([]);
  });

  it('reports flags that are genuinely absent', () => {
    expect(missingSupervisorFlags('  -planner string\n')).toEqual([
      '--sandbox-network',
      '--workspace-only',
      '--sandbox-bash',
    ]);
  });
});
