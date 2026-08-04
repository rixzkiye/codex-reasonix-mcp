import { describe, expect, it } from 'vitest';

import { buildReasonixEnvironment } from '../../src/acp.js';
import { loadConfig } from '../../src/config.js';

function withEnv(entries: Record<string, string>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('buildReasonixEnvironment', () => {
  it('passes the system baseline and drops ambient provider credentials by default', () => {
    withEnv(
      {
        PATH: '/usr/bin:/bin',
        HOME: '/home/user',
        CODEX_HOME: '/home/user/.codex',
        LANG: 'en_US.UTF-8',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-open-secret',
        DEEPSEEK_API_KEY: 'sk-deep-secret',
        SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
      },
      () => {
        const env = buildReasonixEnvironment(loadConfig({}));
        expect(env.PATH).toBe('/usr/bin:/bin');
        expect(env.HOME).toBe('/home/user');
        expect(env.CODEX_HOME).toBe('/home/user/.codex');
        expect(env.LANG).toBe('en_US.UTF-8');
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.DEEPSEEK_API_KEY).toBeUndefined();
        expect(env.SSH_AUTH_SOCK).toBeUndefined();
        expect(env.CI).toBeUndefined();
      },
    );
  });

  it('passes allowlisted provider credentials and REASONIX_* vars', () => {
    withEnv(
      {
        ANTHROPIC_API_KEY: 'sk-ant-allowed',
        OPENAI_API_KEY: 'sk-open-denied',
        REASONIX_FOO: 'bar',
      },
      () => {
        const env = buildReasonixEnvironment(loadConfig({ envAllowlist: ['ANTHROPIC_*'] }));
        expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-allowed');
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.REASONIX_FOO).toBe('bar');
      },
    );
  });

  it('supports exact-name and dot-inclusive glob allowlist entries', () => {
    withEnv({ FOO: '1', FOO_BAR: '2', 'dot.secret': '3' }, () => {
      const env = buildReasonixEnvironment(loadConfig({ envAllowlist: ['FOO', 'dot.*'] }));
      expect(env.FOO).toBe('1');
      expect(env.FOO_BAR).toBeUndefined();
      expect(env['dot.secret']).toBe('3');
    });
  });

  it('hard-denies injection variables even when allowlisted', () => {
    withEnv(
      {
        NODE_OPTIONS: '--require evil',
        LD_PRELOAD: '/tmp/evil.so',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        BASH_ENV: '/tmp/evil.sh',
        GIT_EXTERNAL_DIFF: '/tmp/evil-diff',
        GIT_PAGER: '/tmp/evil-pager',
        NPM_CONFIG_USERCONFIG: '/tmp/evil-npmrc',
        npm_config_registry: 'https://evil.example',
      },
      () => {
        const env = buildReasonixEnvironment(
          loadConfig({
            envAllowlist: [
              'NODE_OPTIONS',
              'LD_PRELOAD',
              'GIT_*',
              'NPM_CONFIG_*',
              'npm_config_*',
              'DYLD_*',
            ],
          }),
        );
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(env.LD_PRELOAD).toBeUndefined();
        expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
        expect(env.BASH_ENV).toBeUndefined();
        expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
        expect(env.GIT_PAGER).toBeUndefined();
        expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
        expect(env.npm_config_registry).toBeUndefined();
      },
    );
  });

  it('passes locale vars beyond the fixed baseline', () => {
    withEnv({ LC_MESSAGES: 'id_ID.UTF-8' }, () => {
      const env = buildReasonixEnvironment(loadConfig({}));
      expect(env.LC_MESSAGES).toBe('id_ID.UTF-8');
    });
  });
});
