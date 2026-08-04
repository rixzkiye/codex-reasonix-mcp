import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import {
  CODEX_TOOL_TIMEOUT_REMEDIATION,
  DEEP_DOCTOR_EVENT_TYPE_TAIL_LIMIT,
  DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT,
  REQUIRED_CODEX_TOOL_TIMEOUT_SECONDS,
  codexToolTimeoutCheck,
  missingSupervisorFlags,
  runDeepDoctor,
  runDoctor,
} from '../../src/doctor.js';

describe('Codex MCP tool timeout', () => {
  it('accepts the required timeout in bare or quoted reasonix-worker sections', () => {
    for (const section of ['[mcp_servers.reasonix-worker]', '[mcp_servers."reasonix-worker"]']) {
      expect(
        codexToolTimeoutCheck(`${section}\ntool_timeout_sec = 900 # bridge policy\n`),
      ).toMatchObject({ ok: true, required: true });
    }
    expect(
      codexToolTimeoutCheck('[mcp_servers.reasonix-worker]\ntool_timeout_sec = 900.0\n'),
    ).toMatchObject({ ok: true, required: true });
  });

  it.each([
    ['unset', '[mcp_servers.reasonix-worker]\nenabled = true\n'],
    ['too low', '[mcp_servers.reasonix-worker]\ntool_timeout_sec = 300\n'],
  ])('reports exact remediation when the timeout is %s', (_case, config) => {
    const check = codexToolTimeoutCheck(config);
    expect(check).toMatchObject({
      name: 'codex_tool_timeout',
      ok: false,
      required: true,
    });
    expect(check.detail).toContain(CODEX_TOOL_TIMEOUT_REMEDIATION);
    expect(REQUIRED_CODEX_TOOL_TIMEOUT_SECONDS).toBe(900);
  });
});

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

describe('deep doctor offline conformance', () => {
  const fake = path.resolve('tests/fixtures/fake-reasonix.ts');
  const tsx = path.resolve('node_modules/.bin/tsx');

  it('runs exactly one fake Goal and proves the complete success path', async () => {
    const report = await runDeepDoctor(loadConfig({ reasonixCommand: tsx, reasonixArgs: [fake] }), {
      allowProviderCall: true,
      deepTimeoutMs: 20_000,
    });
    expect(report).toMatchObject({
      ok: true,
      status: 'passed',
      providerRuns: 1,
      proofs: {
        structuredEdit: true,
        staticCommand: true,
        exactVerification: true,
        finalCommit: true,
        sourceUnchanged: true,
      },
      cleanup: { attempted: true, ok: true },
      diagnostics: {
        termination: 'completed',
        providerTokenLimit: DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT,
        lastTaskStatus: 'completed',
      },
    });
    expect(report.usage?.promptTokens).toBeGreaterThan(0);
    expect(report.estimatedCost).toBe(0.001);
  });

  it('retains edit and command evidence and cleans temporary resources after provider failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-failed-deep-doctor-'));
    const report = await runDeepDoctor(
      loadConfig({ reasonixCommand: tsx, reasonixArgs: [fake, '--fake-mode=fail'] }),
      { allowProviderCall: true, deepTimeoutMs: 20_000 },
      { createTempRoot: () => Promise.resolve(root) },
    );
    expect(report).toMatchObject({
      ok: false,
      status: 'failed',
      providerRuns: 1,
      proofs: {
        structuredEdit: true,
        staticCommand: true,
        exactVerification: false,
        finalCommit: false,
        sourceUnchanged: true,
      },
      cleanup: { attempted: true, ok: true },
      diagnostics: {
        termination: 'failure',
        lastTaskStatus: 'failed',
        lastTaskPhase: 'reasonix_error',
      },
    });
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(report.diagnostics.eventCount).toBeGreaterThan(0);
    expect(report.diagnostics.eventTypeTail).toContain('prompt_finished');
  });

  it('retains accurate edit-only evidence when the provider fails before its static command', async () => {
    const report = await runDeepDoctor(
      loadConfig({
        reasonixCommand: tsx,
        reasonixArgs: [fake, '--fake-mode=fail-after-edit'],
      }),
      { allowProviderCall: true, deepTimeoutMs: 20_000 },
    );
    expect(report).toMatchObject({
      ok: false,
      status: 'failed',
      providerRuns: 1,
      proofs: {
        structuredEdit: true,
        staticCommand: false,
        exactVerification: false,
        finalCommit: false,
        sourceUnchanged: true,
      },
      cleanup: { attempted: true, ok: true },
    });
  });

  it('bounds one fake provider run and cleans up on timeout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-timeout-deep-doctor-'));
    const report = await runDeepDoctor(
      loadConfig({ reasonixCommand: tsx, reasonixArgs: [fake, '--fake-mode=timeout'] }),
      { allowProviderCall: true, deepTimeoutMs: 2_000 },
      { createTempRoot: () => Promise.resolve(root) },
    );
    expect(report).toMatchObject({
      ok: false,
      status: 'timed_out',
      providerRuns: 1,
      proofs: { sourceUnchanged: true },
      cleanup: { attempted: true, ok: true },
      diagnostics: {
        termination: 'timeout',
      },
    });
    expect(['provisioning', 'running']).toContain(report.diagnostics.lastTaskStatus);
    expect(['starting_reasonix', 'implementing']).toContain(report.diagnostics.lastTaskPhase);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops a single runaway provider Goal and reports only bounded privacy-safe diagnostics', async () => {
    const report = await runDeepDoctor(
      loadConfig({
        reasonixCommand: tsx,
        reasonixArgs: [fake, '--fake-mode=usage-limit'],
      }),
      {
        allowProviderCall: true,
        deepTimeoutMs: 20_000,
      },
    );
    expect(report).toMatchObject({
      ok: false,
      status: 'usage_limited',
      providerRuns: 1,
      usage: { promptTokens: 60_000, usageSource: 'redacted' },
      estimatedCost: 0.0045,
      currency: '$',
      proofs: {
        structuredEdit: true,
        staticCommand: true,
        exactVerification: false,
        finalCommit: false,
        sourceUnchanged: true,
      },
      cleanup: { attempted: true, ok: true },
      diagnostics: {
        termination: 'provider_usage_limit',
        providerTokenLimit: DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT,
        observedProviderTokens: 60_000,
      },
    });
    expect(report.detail).toContain('Provider usage limit reached');
    expect(['paused', 'failed']).toContain(report.diagnostics.lastTaskStatus);
    expect(['other', 'prompt_failed']).toContain(report.diagnostics.lastTaskPhase);
    expect(['redacted', 'output_limit_exceeded']).toContain(report.diagnostics.lastTaskReason);
    expect(report.diagnostics.eventTypeTail.length).toBeLessThanOrEqual(
      DEEP_DOCTOR_EVENT_TYPE_TAIL_LIMIT,
    );
    const serialized = JSON.stringify(report);
    for (const raw of [
      'hunter2',
      '/private/',
      'offline result',
      'model-supplied shell text',
      'result.txt',
      '"argv"',
    ]) {
      expect(serialized).not.toContain(raw);
    }
  });

  it('makes zero calls unless provider authority is explicit', async () => {
    await expect(runDeepDoctor(loadConfig(), { allowProviderCall: false })).resolves.toMatchObject({
      status: 'skipped',
      providerRuns: 0,
      cleanup: { attempted: false, ok: true },
      diagnostics: {
        termination: 'skipped',
        providerTokenLimit: DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT,
      },
    });
  });
});

describe('standard doctor', () => {
  it('checks the local binary, supervisor flags, state permissions, and network posture without a Goal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-standard-doctor-'));
    const executable = path.join(root, 'reasonix.mjs');
    await writeFile(
      executable,
      `const args = process.argv.slice(2);
if (args.includes('--version')) process.stdout.write('reasonix 1.2.3\\n');
else if (args.includes('--help')) process.stdout.write('--planner --sandbox-network --workspace-only --sandbox-bash\\n');
else process.exitCode = 2;
`,
    );
    const codexConfigPath = path.join(root, 'config.toml');
    await writeFile(codexConfigPath, '[mcp_servers.reasonix-worker]\ntool_timeout_sec = 900\n');
    const report = await runDoctor(
      loadConfig({
        stateDir: path.join(root, 'state'),
        reasonixCommand: process.execPath,
        reasonixArgs: [executable],
        networkEnabled: true,
      }),
      { codexConfigPath },
    );
    expect(report.checks.find((check) => check.name === 'reasonix_binary')).toMatchObject({
      ok: true,
    });
    expect(report.checks.find((check) => check.name === 'supervisor_flags')).toMatchObject({
      ok: true,
    });
    expect(report.checks.find((check) => check.name === 'state_permissions')).toMatchObject({
      ok: true,
    });
    expect(report.checks.find((check) => check.name === 'codex_tool_timeout')).toMatchObject({
      ok: true,
    });
    expect(report.checks.find((check) => check.name === 'provider_call')?.detail).toContain(
      'No ACP session',
    );
    expect(report.checks.find((check) => check.name === 'network_default')).toMatchObject({
      ok: false,
    });
    expect(report.deep).toBeUndefined();
  });

  it('reports missing binaries/flags and attaches an explicitly skipped deep report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-standard-doctor-'));
    const report = await runDoctor(
      loadConfig({
        stateDir: path.join(root, 'state'),
        reasonixCommand: path.join(root, 'missing-reasonix'),
      }),
      { deep: true, allowProviderCall: false, codexConfigPath: path.join(root, 'missing.toml') },
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'reasonix_binary')).toMatchObject({
      ok: false,
    });
    expect(report.checks.find((check) => check.name === 'supervisor_flags')?.detail).toContain(
      'Missing flags',
    );
    expect(report.checks.find((check) => check.name === 'provider_call')?.detail).toContain(
      'explicit deep lane',
    );
    const timeoutCheck = report.checks.find((check) => check.name === 'codex_tool_timeout');
    expect(timeoutCheck?.ok).toBe(false);
    expect(timeoutCheck?.detail).toContain(CODEX_TOOL_TIMEOUT_REMEDIATION);
    expect(report.deep).toMatchObject({ status: 'skipped', providerRuns: 0 });
  });
});
