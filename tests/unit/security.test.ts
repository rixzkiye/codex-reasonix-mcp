import { describe, expect, it } from 'vitest';

import { containsSecret, redact, redactString } from '../../src/redaction.js';

describe('redaction and secret detection', () => {
  it('redacts credential keys and known token patterns without persisting reasoning', () => {
    expect(redact({ api_key: 'secret', nested: { password: 'hunter2' } })).toEqual({
      api_key: '[REDACTED]',
      nested: { password: '[REDACTED]' },
    });
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).not.toContain(
      'abcdefghijklmnop',
    );
  });

  it('detects common provider and private-key secrets', () => {
    expect(containsSecret('sk-proj-abcdefghijklmnop')).toBe(true);
    expect(containsSecret('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe(
      true,
    );
    expect(containsSecret('ordinary test output')).toBe(false);
  });
});
