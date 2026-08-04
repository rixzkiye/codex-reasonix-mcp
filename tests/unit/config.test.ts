import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configFingerprint, loadConfig } from '../../src/config.js';

const original = {
  state: process.env.CODEX_REASONIX_STATE_DIR,
  xdg: process.env.XDG_STATE_HOME,
  scanner: process.env.CODEX_REASONIX_SECRET_SCANNER_ARGV,
  network: process.env.CODEX_REASONIX_NETWORK,
  effort: process.env.CODEX_REASONIX_EFFORT,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    CODEX_REASONIX_STATE_DIR: original.state,
    XDG_STATE_HOME: original.xdg,
    CODEX_REASONIX_SECRET_SCANNER_ARGV: original.scanner,
    CODEX_REASONIX_NETWORK: original.network,
    CODEX_REASONIX_EFFORT: original.effort,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('configuration parsing', () => {
  it('honors explicit state, network, and strict scanner argv environment values', () => {
    process.env.CODEX_REASONIX_STATE_DIR = './relative-state';
    process.env.CODEX_REASONIX_NETWORK = 'on';
    process.env.CODEX_REASONIX_SECRET_SCANNER_ARGV = '["scanner","--json"]';
    const config = loadConfig();
    expect(config.stateDir).toBe(path.resolve('relative-state'));
    expect(config.networkEnabled).toBe(true);
    expect(config.externalSecretScanner).toEqual(['scanner', '--json']);
  });

  it('uses XDG state when the direct override is blank and accepts an absent scanner', () => {
    process.env.CODEX_REASONIX_STATE_DIR = ' ';
    process.env.XDG_STATE_HOME = '/tmp/reasonix-xdg';
    delete process.env.CODEX_REASONIX_SECRET_SCANNER_ARGV;
    expect(loadConfig()).toMatchObject({
      stateDir: '/tmp/reasonix-xdg/codex-reasonix-mcp',
      externalSecretScanner: undefined,
    });
  });

  it.each(['low', 'medium', 'high', 'max'] as const)(
    'accepts supported Reasonix effort %s',
    (effort) => {
      process.env.CODEX_REASONIX_EFFORT = effort;
      expect(loadConfig().reasoningEffort).toBe(effort);
    },
  );

  it('rejects legacy minimal effort in new configuration', () => {
    process.env.CODEX_REASONIX_EFFORT = 'minimal';
    expect(() => loadConfig()).toThrow(
      /CODEX_REASONIX_EFFORT must be one of: low, medium, high, max/,
    );
  });

  it('defaults Reasonix effort to medium and lets explicit config override the environment', () => {
    delete process.env.CODEX_REASONIX_EFFORT;
    expect(loadConfig().reasoningEffort).toBe('medium');
    process.env.CODEX_REASONIX_EFFORT = 'high';
    expect(loadConfig({ reasoningEffort: 'low' }).reasoningEffort).toBe('low');
  });

  it.each(['tiny', 'MAX', 'medium-high'])('rejects unsupported Reasonix effort %s', (effort) => {
    process.env.CODEX_REASONIX_EFFORT = effort;
    expect(() => loadConfig()).toThrow(/CODEX_REASONIX_EFFORT must be one of/);
  });

  it.each(['not json', '[]', '[""]', '{"command":"scanner"}'])(
    'rejects unsafe scanner input %s',
    (value) => {
      process.env.CODEX_REASONIX_SECRET_SCANNER_ARGV = value;
      expect(() => loadConfig()).toThrow(/JSON|non-empty JSON string array/);
    },
  );

  it('fingerprints only provider posture and changes when that posture changes', () => {
    const base = loadConfig({ stateDir: '/tmp/a' });
    expect(configFingerprint(base)).toBe(configFingerprint({ ...base, stateDir: '/tmp/b' }));
    expect(configFingerprint(base)).toBe(configFingerprint({ ...base, reasoningEffort: 'high' }));
    expect(configFingerprint(base)).not.toBe(configFingerprint({ ...base, model: 'different' }));
  });
});
