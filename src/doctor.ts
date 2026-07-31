import { access, chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { ReasonixProcess } from './acp.js';
import type { BridgeConfig } from './config.js';
import { runCommand } from './command.js';
import { StateStore } from './state.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface DoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  wsl: boolean;
  checks: DoctorCheck[];
}

const supervisorFlags = ['--planner', '--sandbox-network', '--workspace-only', '--sandbox-bash'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function missingSupervisorFlags(helpText: string): string[] {
  return supervisorFlags.filter((flag) => {
    const name = escapeRegExp(flag.replace(/^-+/, ''));
    return !new RegExp(`(?:^|\\s)-{1,2}${name}(?=\\s|=|$)`, 'm').test(helpText);
  });
}

async function isWsl(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const version = await import('node:fs/promises').then(
      async ({ readFile }) => await readFile('/proc/version', 'utf8'),
    );
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

async function executableOnPath(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const result = await runCommand({
    argv: ['which', command],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  return result.exitCode === 0;
}

export async function runDoctor(config: BridgeConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const wsl = await isWsl();
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'node',
    ok: nodeMajor >= 22,
    detail: `Node ${process.versions.node}; requires >=22`,
    required: true,
  });
  checks.push({
    name: 'platform',
    ok: process.platform === 'linux' || process.platform === 'darwin',
    detail:
      process.platform === 'win32'
        ? 'Native Windows is unsupported; use WSL'
        : `${process.platform}${wsl ? ' (WSL)' : ''}`,
    required: true,
  });

  const git = await runCommand({
    argv: ['git', '--version'],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  const gitVersionText = (git.stdout || git.stderr).trim();
  const gitVersion = /git version (\d+)\.(\d+)/i.exec(gitVersionText);
  const gitSupportsHookRun =
    git.exitCode === 0 &&
    gitVersion !== null &&
    (Number(gitVersion[1]) > 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) >= 36));
  checks.push({
    name: 'git',
    ok: gitSupportsHookRun,
    detail: `${gitVersionText}; requires >=2.36 for transactional hook execution`,
    required: true,
  });

  const reasonixVersion = await runCommand({
    argv: [config.reasonixCommand, ...config.reasonixArgs, '--version'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  }).catch((error: unknown) => ({ exitCode: null, stdout: '', stderr: String(error) }));
  checks.push({
    name: 'reasonix_binary',
    ok: reasonixVersion.exitCode === 0,
    detail: (reasonixVersion.stdout || reasonixVersion.stderr).trim().slice(0, 1_024),
    required: true,
  });

  const help = await runCommand({
    argv: [config.reasonixCommand, ...config.reasonixArgs, 'acp', '--help'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  }).catch((error: unknown) => ({ exitCode: null, stdout: '', stderr: String(error) }));
  const helpText = `${help.stdout}\n${help.stderr}`;
  const missingFlags = missingSupervisorFlags(helpText);
  checks.push({
    name: 'supervisor_flags',
    ok: missingFlags.length === 0,
    detail:
      missingFlags.length === 0
        ? `reasonix acp advertises ${supervisorFlags.join(', ')}`
        : `Missing flags: ${missingFlags.join(', ')}`,
    required: true,
  });

  const sandboxCommand = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap';
  checks.push({
    name: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap',
    ok: await executableOnPath(sandboxCommand),
    detail: `Sandbox executable: ${sandboxCommand}`,
    required: true,
  });

  const state = new StateStore(config.stateDir);
  try {
    await state.initialize();
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await chmod(config.stateDir, 0o700);
    const mode = (await stat(config.stateDir)).mode & 0o777;
    checks.push({
      name: 'state_permissions',
      ok: process.platform === 'win32' || mode === 0o700,
      detail: `${config.stateDir} mode ${mode.toString(8)}`,
      required: true,
    });
  } catch (error) {
    checks.push({ name: 'state_permissions', ok: false, detail: String(error), required: true });
  }

  if (reasonixVersion.exitCode === 0 && missingFlags.length === 0) {
    let probe: ReasonixProcess | undefined;
    try {
      probe = await ReasonixProcess.launch(
        config,
        {
          id: 'doctor',
          root: process.cwd(),
          commonDir: process.cwd(),
          head: 'doctor',
        },
        {
          onPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
          onSessionUpdate: () => undefined,
          onStatusUpdate: () => undefined,
          onPromptComplete: () => undefined,
          onProcessError: () => undefined,
        },
      );
      checks.push({
        name: 'acp_status_extension',
        ok: true,
        detail: `ACP v1 capability available from ${probe.agentInfo?.name ?? 'reasonix'}`,
        required: true,
      });
      const session = await probe.createSession('doctor', process.cwd(), config.networkEnabled);
      checks.push({
        name: 'model_configuration',
        ok: true,
        detail: `Model ${session.status.model}; effort ${session.status.effort}`,
        required: true,
      });
      checks.push({
        name: 'effective_sandbox',
        ok: true,
        detail: `${session.status.sandbox.engine}/${session.status.sandbox.mode}; network=${String(session.status.sandbox.networkEnabled)}; one workspace write root`,
        required: true,
      });
      await probe.closeSession(session.sessionId).catch(() => undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!checks.some((check) => check.name === 'acp_status_extension')) {
        checks.push({ name: 'acp_status_extension', ok: false, detail, required: true });
      } else {
        checks.push({ name: 'model_configuration', ok: false, detail, required: true });
        checks.push({ name: 'effective_sandbox', ok: false, detail, required: true });
      }
    } finally {
      await probe?.shutdown().catch(() => undefined);
    }
  } else {
    const detail = 'Skipped because the Reasonix binary or required ACP flags are unavailable';
    checks.push({ name: 'acp_status_extension', ok: false, detail, required: true });
    checks.push({ name: 'model_configuration', ok: false, detail, required: true });
    checks.push({ name: 'effective_sandbox', ok: false, detail, required: true });
  }

  checks.push({
    name: 'network_default',
    ok: !config.networkEnabled,
    detail: config.networkEnabled
      ? 'Network explicitly enabled; still intersected with Codex permission metadata'
      : 'Network disabled',
    required: false,
  });
  return {
    ok: checks.every((check) => !check.required || check.ok),
    platform: process.platform,
    wsl,
    checks,
  };
}
