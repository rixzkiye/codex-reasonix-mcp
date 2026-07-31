import { describe, expect, it } from 'vitest';

import { parseSandboxContext } from '../../src/sandbox.js';
import { sandboxMeta } from '../helpers.js';

describe('Codex sandbox metadata', () => {
  it('derives the repository cwd and write/network intersection only from metadata', () => {
    const parsed = parseSandboxContext(sandboxMeta('/tmp/repository', true));
    expect(parsed.cwd).toBe('/tmp/repository');
    expect(parsed.writable).toBe(true);
    expect(parsed.networkEnabled).toBe(true);
  });

  it('rejects missing and read-only permission profiles', () => {
    expect(() => parseSandboxContext({})).toThrow(/Missing|Invalid/);
    const meta = sandboxMeta('/tmp/repository') as {
      'codex/sandbox-state-meta': {
        permissionProfile: {
          file_system: { entries: Array<{ access: string }> };
        };
      };
    };
    for (const entry of meta['codex/sandbox-state-meta'].permissionProfile.file_system.entries) {
      entry.access = 'read';
    }
    expect(() => parseSandboxContext(meta)).toThrow(/writable/);
  });
});
