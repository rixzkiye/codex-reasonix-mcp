import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { missingSupervisorFlags, runDeepDoctor, runDoctor } from '../../src/doctor.js';

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
    });
    expect(report.usage?.promptTokens).toBeGreaterThan(0);
    expect(report.estimatedCost).toBe(0.001);
  });

  it('always cleans temporary resources after a one-run fake provider failure', async () => {
    const report = await runDeepDoctor(
      loadConfig({ reasonixCommand: tsx, reasonixArgs: [fake, '--fake-mode=fail'] }),
      { allowProviderCall: true, deepTimeoutMs: 20_000 },
    );
    expect(report).toMatchObject({
      ok: false,
      status: 'failed',
      providerRuns: 1,
      cleanup: { attempted: true, ok: true },
    });
  });

  it('bounds one fake provider run and cleans up on timeout', async () => {
    const report = await runDeepDoctor(
      loadConfig({ reasonixCommand: tsx, reasonixArgs: [fake, '--fake-mode=timeout'] }),
      { allowProviderCall: true, deepTimeoutMs: 2_000 },
    );
    expect(report).toMatchObject({
      ok: false,
      status: 'timed_out',
      providerRuns: 1,
      cleanup: { attempted: true, ok: true },
    });
  });

  it('makes zero calls unless provider authority is explicit', async () => {
    await expect(runDeepDoctor(loadConfig(), { allowProviderCall: false })).resolves.toMatchObject({
      status: 'skipped',
      providerRuns: 0,
      cleanup: { attempted: false, ok: true },
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
    const report = await runDoctor(
      loadConfig({
        stateDir: path.join(root, 'state'),
        reasonixCommand: process.execPath,
        reasonixArgs: [executable],
        networkEnabled: true,
      }),
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
      { deep: true, allowProviderCall: false },
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
    expect(report.deep).toMatchObject({ status: 'skipped', providerRuns: 0 });
  });
});
