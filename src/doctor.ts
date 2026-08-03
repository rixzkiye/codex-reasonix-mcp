import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { BridgeConfig } from './config.js';
import { runChecked, runCommand } from './command.js';
import { BridgeRuntime } from './runtime.js';
import { StateStore } from './state.js';
import type { TaskRecord, UsageTotals } from './types.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface DeepDoctorProofs {
  structuredEdit: boolean;
  staticCommand: boolean;
  exactVerification: boolean;
  finalCommit: boolean;
  sourceUnchanged: boolean;
}

export interface DeepDoctorReport {
  requested: boolean;
  allowed: boolean;
  ok: boolean;
  status: 'skipped' | 'passed' | 'failed' | 'timed_out';
  providerRuns: number;
  durationMs: number;
  usage: UsageTotals | null;
  estimatedCost: number | null;
  currency: string | null;
  proofs: DeepDoctorProofs;
  cleanup: { attempted: boolean; ok: boolean; detail: string };
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  wsl: boolean;
  checks: DoctorCheck[];
  deep?: DeepDoctorReport;
}

export interface DoctorOptions {
  deep?: boolean;
  allowProviderCall?: boolean;
  deepTimeoutMs?: number;
  deepDependencies?: DeepDoctorDependencies;
}

export interface DeepDoctorDependencies {
  createRuntime?(config: BridgeConfig): BridgeRuntime;
  createTempRoot?(): Promise<string>;
  removeTempRoot?(root: string): Promise<void>;
  now?(): number;
}

const supervisorFlags = ['--planner', '--sandbox-network', '--workspace-only', '--sandbox-bash'];
const DEEP_TIMEOUT_MAX_MS = 10 * 60_000;

class DeepDoctorTimeout extends Error {}

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

function sandboxMeta(repository: string): Record<string, unknown> {
  return {
    'codex/sandbox-state-meta': {
      permissionProfile: {
        type: 'managed',
        file_system: {
          type: 'restricted',
          entries: [
            { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
            {
              path: { type: 'special', value: { kind: 'project_roots' } },
              access: 'write',
            },
          ],
        },
        network: 'restricted',
      },
      sandboxCwd: repository,
      codexLinuxSandboxExe: null,
      useLegacyLandlock: false,
    },
  };
}

async function createDeepRepository(root: string): Promise<{ repository: string; head: string }> {
  const repository = path.join(root, 'source');
  await mkdir(repository, { recursive: true, mode: 0o700 });
  for (const argv of [
    ['git', 'init', '-b', 'main'],
    ['git', 'config', 'user.name', 'Reasonix Doctor'],
    ['git', 'config', 'user.email', 'doctor@example.invalid'],
  ] as Array<[string, ...string[]]>) {
    await runChecked({ argv, cwd: repository, timeoutMs: 30_000 });
  }
  await writeFile(path.join(repository, 'README.md'), '# Deep doctor fixture\n', 'utf8');
  await runChecked({ argv: ['git', 'add', '--', 'README.md'], cwd: repository });
  await runChecked({ argv: ['git', 'commit', '-m', 'doctor: fixture'], cwd: repository });
  const head = (
    await runChecked({ argv: ['git', 'rev-parse', 'HEAD'], cwd: repository })
  ).stdout.trim();
  return { repository, head };
}

async function waitForTask(
  runtime: BridgeRuntime,
  taskId: string,
  deadline: number,
  accept: (task: TaskRecord) => boolean,
): Promise<TaskRecord> {
  for (;;) {
    const task = await runtime.store.loadTask(taskId);
    if (accept(task)) return task;
    if (Date.now() >= deadline) throw new DeepDoctorTimeout('Deep doctor exceeded its deadline');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref();
    });
  }
}

function emptyProofs(): DeepDoctorProofs {
  return {
    structuredEdit: false,
    staticCommand: false,
    exactVerification: false,
    finalCommit: false,
    sourceUnchanged: false,
  };
}

/**
 * Executes the explicit live conformance lane. The normal doctor never calls
 * this function. Tests inject the fake ACP executable through BridgeConfig;
 * there is no alternate path that can accidentally start a second Goal.
 */
export async function runDeepDoctor(
  config: BridgeConfig,
  options: Pick<DoctorOptions, 'allowProviderCall' | 'deepTimeoutMs'> = {},
  dependencies: DeepDoctorDependencies = {},
): Promise<DeepDoctorReport> {
  const started = (dependencies.now ?? Date.now)();
  if (!options.allowProviderCall) {
    return {
      requested: true,
      allowed: false,
      ok: false,
      status: 'skipped',
      providerRuns: 0,
      durationMs: 0,
      usage: null,
      estimatedCost: null,
      currency: null,
      proofs: emptyProofs(),
      cleanup: { attempted: false, ok: true, detail: 'No temporary resources created' },
      detail: 'Skipped: --allow-provider-call is required for deep doctor',
    };
  }

  const timeoutMs = Math.min(
    Math.max(options.deepTimeoutMs ?? DEEP_TIMEOUT_MAX_MS, 1),
    DEEP_TIMEOUT_MAX_MS,
  );
  const deadline = Date.now() + timeoutMs;
  let root: string | undefined;
  let runtime: BridgeRuntime | undefined;
  let providerRuns = 0;
  let usage: UsageTotals | null = null;
  const proofs = emptyProofs();
  let status: DeepDoctorReport['status'];
  let detail: string;
  let cleanup = { attempted: false, ok: true, detail: 'No temporary resources created' };

  try {
    root = await (
      dependencies.createTempRoot ??
      (async () => await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-deep-doctor-')))
    )();
    const fixture = await createDeepRepository(root);
    const deepConfig: BridgeConfig = {
      ...config,
      stateDir: path.join(root, 'state'),
      networkEnabled: false,
    };
    runtime = (dependencies.createRuntime ?? ((value) => new BridgeRuntime(value)))(deepConfig);
    await runtime.initialize();
    const contract = {
      schema_version: 1 as const,
      objective: 'Create result.txt containing a short deep-doctor success marker',
      user_outcome: 'The isolated worker commit contains result.txt while source main is unchanged',
      verified_context: [{ path: 'README.md', reason: 'Temporary deep doctor fixture' }],
      write_scope: ['result.txt'],
      forbidden_scope: ['.git/**', '**/.env*'],
      invariants: ['Do not modify README.md', 'Do not use network access'],
      non_goals: ['No dependency changes', 'No repair round'],
      acceptance_criteria: [
        {
          id: 'result_exists',
          requirement: 'result.txt exists in the worker worktree',
          evidence: 'automated' as const,
        },
      ],
      verification: [
        {
          id: 'verify_result',
          argv: ['test', '-f', 'result.txt'] as [string, ...string[]],
          cwd: '.',
          timeout_seconds: 30,
          proves: ['result_exists'],
        },
      ],
      pause_conditions: ['Any immutable policy denial or scope expansion'],
    };
    await runtime.delegate({ task_id: 'deep-doctor', contract }, sandboxMeta(fixture.repository));
    providerRuns = 1;
    const review = await waitForTask(
      runtime,
      'deep-doctor',
      deadline,
      (task) =>
        task.status === 'review_required' || task.status === 'paused' || task.status === 'failed',
    );
    if (review.status !== 'review_required') {
      throw new Error(`Goal stopped in ${review.status}: ${review.reason ?? review.phase}`);
    }
    const events = await runtime.store.readEvents('deep-doctor');
    proofs.structuredEdit = events.some(
      (event) =>
        event.type === 'permission_auto_allowed' &&
        (event.data as { reason?: unknown }).reason === 'Structured edit is inside write_scope',
    );
    const staticPermission = events.some(
      (event) =>
        event.type === 'permission_auto_allowed' &&
        (event.data as { reason?: unknown }).reason === 'Exact contract verification command',
    );
    proofs.staticCommand =
      staticPermission && events.some((event) => event.type === 'command_postflight_passed');
    await runtime.control(
      {
        task_id: 'deep-doctor',
        action: 'finalize',
        review_summary: 'Deep doctor reviewed the bounded isolated diff.',
        approved_review_criteria: [],
      },
      sandboxMeta(fixture.repository),
    );
    const completed = await waitForTask(
      runtime,
      'deep-doctor',
      deadline,
      (task) =>
        task.status === 'completed' || task.status === 'commit_failed' || task.status === 'failed',
    );
    usage = completed.usage;
    proofs.exactVerification =
      completed.verification.length === 1 &&
      completed.verification[0]?.id === 'verify_result' &&
      completed.verification[0].passed;
    proofs.finalCommit =
      completed.status === 'completed' && /^[0-9a-f]{40}$/.test(completed.commitHash ?? '');
    const sourceStatus = await runChecked({
      argv: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
      cwd: fixture.repository,
    });
    const sourceHead = await runChecked({
      argv: ['git', 'rev-parse', 'HEAD'],
      cwd: fixture.repository,
    });
    proofs.sourceUnchanged =
      sourceStatus.stdout.length === 0 && sourceHead.stdout.trim() === fixture.head;
    if (providerRuns !== 1 || Object.values(proofs).some((value) => !value)) {
      throw new Error('Deep doctor conformance proof is incomplete');
    }
    status = 'passed';
    detail = 'One bounded Goal produced a reviewed commit with complete conformance evidence';
  } catch (error) {
    status = error instanceof DeepDoctorTimeout ? 'timed_out' : 'failed';
    detail = error instanceof Error ? error.message : String(error);
    if (runtime) {
      const task = await runtime.store.loadTask('deep-doctor').catch(() => undefined);
      if (
        task &&
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled'
      ) {
        await runtime
          .control({ task_id: task.taskId, action: 'cancel' }, {})
          .catch(() => undefined);
      }
      usage = task?.usage ?? usage;
    }
  } finally {
    await runtime?.shutdown().catch(() => undefined);
    if (root) {
      cleanup = { attempted: true, ok: true, detail: 'Temporary repo and state removed' };
      try {
        await (
          dependencies.removeTempRoot ??
          (async (value) => await rm(value, { recursive: true, force: true }))
        )(root);
      } catch (error) {
        cleanup = {
          attempted: true,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const durationMs = Math.max(0, (dependencies.now ?? Date.now)() - started);
  return {
    requested: true,
    allowed: true,
    ok: status === 'passed' && cleanup.ok,
    status,
    providerRuns,
    durationMs,
    usage,
    estimatedCost: usage?.estimatedCost ?? null,
    currency: usage?.currency ?? null,
    proofs,
    cleanup,
    detail,
  };
}

/** Standard doctor performs only local executable/configuration checks. */
export async function runDoctor(
  config: BridgeConfig,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
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
  const missingFlags = missingSupervisorFlags(`${help.stdout}\n${help.stderr}`);
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

  checks.push({
    name: 'provider_call',
    ok: true,
    detail: options.deep
      ? 'Provider call is confined to the explicit deep lane'
      : 'No ACP session or provider Goal was started by standard doctor',
    required: false,
  });
  checks.push({
    name: 'network_default',
    ok: !config.networkEnabled,
    detail: config.networkEnabled ? 'Network explicitly enabled' : 'Network disabled',
    required: false,
  });

  const report: DoctorReport = {
    ok: checks.every((check) => !check.required || check.ok),
    platform: process.platform,
    wsl,
    checks,
  };
  if (options.deep) {
    report.deep = await runDeepDoctor(
      config,
      {
        allowProviderCall: options.allowProviderCall,
        deepTimeoutMs: options.deepTimeoutMs,
      },
      options.deepDependencies,
    );
    report.ok = report.ok && report.deep.ok;
  }
  return report;
}
