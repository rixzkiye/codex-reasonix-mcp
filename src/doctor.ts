import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { BridgeConfig } from './config.js';
import { runChecked, runCommand } from './command.js';
import { BRIDGE_ERROR_CODES } from './errors.js';
import { BridgeRuntime } from './runtime.js';
import { StateStore } from './state.js';
import type { JournalEvent, TaskRecord, TaskStatus, UsageTotals } from './types.js';

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
  status: 'skipped' | 'passed' | 'failed' | 'timed_out' | 'usage_limited';
  providerRuns: number;
  durationMs: number;
  usage: UsageTotals | null;
  estimatedCost: number | null;
  currency: string | null;
  proofs: DeepDoctorProofs;
  cleanup: { attempted: boolean; ok: boolean; detail: string };
  diagnostics: DeepDoctorDiagnostics;
  detail: string;
}

export interface DeepDoctorDiagnostics {
  termination: 'skipped' | 'completed' | 'failure' | 'timeout' | 'provider_usage_limit';
  providerTokenLimit: number;
  observedProviderTokens: number;
  lastTaskStatus: TaskStatus | null;
  lastTaskPhase: string | null;
  lastTaskReason: string | null;
  eventCount: number;
  eventTypeTail: string[];
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
  deepProviderTokenLimit?: number;
  deepDependencies?: DeepDoctorDependencies;
  codexConfigPath?: string;
}

export interface DeepDoctorDependencies {
  createRuntime?(config: BridgeConfig): BridgeRuntime;
  createTempRoot?(): Promise<string>;
  removeTempRoot?(root: string): Promise<void>;
  now?(): number;
}

const supervisorFlags = ['--planner', '--sandbox-network', '--workspace-only', '--sandbox-bash'];
const DEEP_TIMEOUT_MAX_MS = 10 * 60_000;
export const DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT = 50_000;
export const DEEP_DOCTOR_EVENT_TYPE_TAIL_LIMIT = 12;
export const REQUIRED_CODEX_TOOL_TIMEOUT_SECONDS = 900;
export const CODEX_TOOL_TIMEOUT_REMEDIATION =
  '[mcp_servers.reasonix-worker]\ntool_timeout_sec = 900';

class DeepDoctorTimeout extends Error {}

class DeepDoctorUsageLimit extends Error {
  constructor(
    readonly observedTokens: number,
    readonly limitTokens: number,
  ) {
    super('Deep doctor provider usage limit reached');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function missingSupervisorFlags(helpText: string): string[] {
  return supervisorFlags.filter((flag) => {
    const name = escapeRegExp(flag.replace(/^-+/, ''));
    return !new RegExp(`(?:^|\\s)-{1,2}${name}(?=\\s|=|$)`, 'm').test(helpText);
  });
}

function stripTomlComment(line: string): string {
  let quoted = false;
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== '\\') {
      if (!quoted) {
        quoted = true;
        quote = character;
      } else if (quote === character) {
        quoted = false;
      }
    }
    if (character === '#' && !quoted) return line.slice(0, index);
  }
  return line;
}

export function codexToolTimeoutCheck(configText: string | undefined): DoctorCheck {
  let inReasonixWorker = false;
  let configured: number | undefined;
  for (const rawLine of (configText ?? '').split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    const section = /^\[\s*(.+?)\s*\]$/u.exec(line);
    if (section) {
      const normalized = section[1]?.replace(/\s+/gu, '').replace(/["']/gu, '');
      inReasonixWorker = normalized === 'mcp_servers.reasonix-worker';
      continue;
    }
    if (!inReasonixWorker) continue;
    const timeout = /^tool_timeout_sec\s*=\s*(\d+(?:\.\d+)?)\s*$/u.exec(line);
    if (timeout) configured = Number(timeout[1]);
  }

  const ok = configured !== undefined && configured >= REQUIRED_CODEX_TOOL_TIMEOUT_SECONDS;
  const current = configured === undefined ? 'unset' : `${String(configured)} seconds`;
  return {
    name: 'codex_tool_timeout',
    ok,
    detail: ok
      ? `reasonix-worker tool_timeout_sec is ${current}`
      : `reasonix-worker tool_timeout_sec is ${current}; set:\n${CODEX_TOOL_TIMEOUT_REMEDIATION}`,
    required: true,
  };
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

function providerTokenCount(usage: UsageTotals): number {
  const inputTokens = Math.max(usage.promptTokens, usage.cacheHitTokens + usage.cacheMissTokens);
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    inputTokens + usage.completionTokens + usage.reasoningTokens,
  );
}

function providerTokenLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_DEEP_DOCTOR_PROVIDER_TOKEN_LIMIT;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

async function waitForTask(
  runtime: BridgeRuntime,
  taskId: string,
  deadline: number,
  tokenLimit: number,
  accept: (task: TaskRecord) => boolean,
): Promise<TaskRecord> {
  for (;;) {
    const task = await runtime.store.loadTask(taskId);
    const observedTokens = providerTokenCount(task.usage);
    if (observedTokens >= tokenLimit) {
      throw new DeepDoctorUsageLimit(observedTokens, tokenLimit);
    }
    if (accept(task)) return task;
    if (Date.now() >= deadline) throw new DeepDoctorTimeout('Deep doctor exceeded its deadline');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref();
    });
  }
}

async function waitForEvents(
  runtime: BridgeRuntime,
  taskId: string,
  deadline: number,
  tokenLimit: number,
  accept: (events: JournalEvent[]) => boolean,
): Promise<JournalEvent[]> {
  for (;;) {
    const [events, task] = await Promise.all([
      runtime.store.readEvents(taskId),
      runtime.store.loadTask(taskId),
    ]);
    const observedTokens = providerTokenCount(task.usage);
    if (observedTokens >= tokenLimit) {
      throw new DeepDoctorUsageLimit(observedTokens, tokenLimit);
    }
    if (accept(events)) return events;
    if (Date.now() >= deadline) throw new DeepDoctorTimeout('Deep doctor exceeded its deadline');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
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

const SAFE_DEEP_PHASES = new Set([
  'queued',
  'creating_worktree',
  'starting_reasonix',
  'goal_running',
  'goal_resuming',
  'implementing',
  'review_ready',
  'codex_review',
  'preflight',
  'verification',
  'staging',
  'committing',
  'completed',
  'cancelled',
  'closed',
  'prompt_failed',
  'reasonix_error',
  'command_timeout',
  'repeated_policy_denial',
  'command_postflight_failed',
  'source_collision',
  'restart_recovery',
  'interaction_waiting',
  'worker_crashed',
]);

function safeTaskPhase(phase: string): string {
  return SAFE_DEEP_PHASES.has(phase) || /^repair_[12]$/.test(phase) ? phase : 'other';
}

function safeTaskReason(reason: string | undefined): string | null {
  if (!reason) return null;
  const code = BRIDGE_ERROR_CODES.find(
    (candidate) => reason === candidate || reason.startsWith(`${candidate}:`),
  );
  return code ?? 'redacted';
}

function safeEventType(type: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(type) ? type : 'other';
}

function privacySafeUsage(usage: UsageTotals): UsageTotals {
  const safeInteger = (value: number): number =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const safeNumber = (value: number | null): number | null =>
    value !== null && Number.isFinite(value) && value >= 0
      ? Math.min(value, Number.MAX_SAFE_INTEGER)
      : null;
  const source = /^(?:reasonix|executor|provider)$/.test(usage.usageSource)
    ? usage.usageSource
    : 'redacted';
  return {
    promptTokens: safeInteger(usage.promptTokens),
    completionTokens: safeInteger(usage.completionTokens),
    reasoningTokens: safeInteger(usage.reasoningTokens),
    cacheHitTokens: safeInteger(usage.cacheHitTokens),
    cacheMissTokens: safeInteger(usage.cacheMissTokens),
    cacheHitRatio:
      usage.cacheHitRatio !== null &&
      Number.isFinite(usage.cacheHitRatio) &&
      usage.cacheHitRatio >= 0 &&
      usage.cacheHitRatio <= 1
        ? usage.cacheHitRatio
        : null,
    estimatedCost: safeNumber(usage.estimatedCost),
    currency:
      usage.currency && ['USD', 'EUR', 'GBP', '$', '€', '£'].includes(usage.currency)
        ? usage.currency
        : null,
    usageSource: source,
  };
}

function initialDiagnostics(tokenLimit: number): DeepDoctorDiagnostics {
  return {
    termination: 'failure',
    providerTokenLimit: tokenLimit,
    observedProviderTokens: 0,
    lastTaskStatus: null,
    lastTaskPhase: null,
    lastTaskReason: null,
    eventCount: 0,
    eventTypeTail: [],
  };
}

async function sourceIsUnchanged(repository: string, expectedHead: string): Promise<boolean> {
  try {
    const [sourceStatus, sourceHead] = await Promise.all([
      runChecked({
        argv: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        cwd: repository,
      }),
      runChecked({ argv: ['git', 'rev-parse', 'HEAD'], cwd: repository }),
    ]);
    return sourceStatus.stdout.length === 0 && sourceHead.stdout.trim() === expectedHead;
  } catch {
    return false;
  }
}

async function collectDeepEvidence(
  runtime: BridgeRuntime,
  fixture: { repository: string; head: string },
  proofs: DeepDoctorProofs,
  diagnostics: DeepDoctorDiagnostics,
  preserveTaskState: boolean,
): Promise<UsageTotals | null> {
  const task = await runtime.store.loadTask('deep-doctor').catch(() => undefined);
  const events = await runtime.store.readEvents('deep-doctor').catch(() => [] as JournalEvent[]);
  const structuredPermission = events.some(
    (event) =>
      event.type === 'permission_auto_allowed' &&
      (event.data as { reason?: unknown }).reason === 'Structured edit is inside write_scope',
  );
  let structuredFile = false;
  if (task) {
    try {
      structuredFile = (await stat(path.join(task.worktree, 'result.txt'))).isFile();
    } catch {
      structuredFile = false;
    }
  }
  proofs.structuredEdit ||= structuredPermission && structuredFile;
  const staticPermission = events.some(
    (event) =>
      event.type === 'permission_auto_allowed' &&
      (event.data as { reason?: unknown }).reason === 'Exact contract verification command',
  );
  proofs.staticCommand ||=
    staticPermission && events.some((event) => event.type === 'command_postflight_passed');
  if (task) {
    proofs.exactVerification ||=
      task.verification.length === 1 &&
      task.verification[0]?.id === 'verify_result' &&
      task.verification[0].passed;
    proofs.finalCommit ||=
      task.status === 'completed' && /^[0-9a-f]{40}$/.test(task.commitHash ?? '');
    diagnostics.observedProviderTokens = Math.max(
      diagnostics.observedProviderTokens,
      providerTokenCount(task.usage),
    );
    if (!preserveTaskState || diagnostics.lastTaskStatus === null) {
      diagnostics.lastTaskStatus = task.status;
      diagnostics.lastTaskPhase = safeTaskPhase(task.phase);
      diagnostics.lastTaskReason = safeTaskReason(task.reason);
    }
  }
  proofs.sourceUnchanged = await sourceIsUnchanged(fixture.repository, fixture.head);
  diagnostics.eventCount = Math.max(diagnostics.eventCount, events.length);
  diagnostics.eventTypeTail = events
    .slice(-DEEP_DOCTOR_EVENT_TYPE_TAIL_LIMIT)
    .map((event) => safeEventType(event.type));
  return task ? privacySafeUsage(task.usage) : null;
}

/**
 * Executes the explicit live conformance lane. The normal doctor never calls
 * this function. Tests inject the fake ACP executable through BridgeConfig;
 * there is no alternate path that can accidentally start a second Goal.
 */
export async function runDeepDoctor(
  config: BridgeConfig,
  options: Pick<
    DoctorOptions,
    'allowProviderCall' | 'deepTimeoutMs' | 'deepProviderTokenLimit'
  > = {},
  dependencies: DeepDoctorDependencies = {},
): Promise<DeepDoctorReport> {
  const started = (dependencies.now ?? Date.now)();
  const tokenLimit = providerTokenLimit(options.deepProviderTokenLimit);
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
      diagnostics: { ...initialDiagnostics(tokenLimit), termination: 'skipped' },
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
  let fixture: { repository: string; head: string } | undefined;
  let providerRuns = 0;
  let usage: UsageTotals | null = null;
  const proofs = emptyProofs();
  const diagnostics = initialDiagnostics(tokenLimit);
  let status: DeepDoctorReport['status'];
  let detail: string;
  let preserveFailureTaskState = false;
  let cleanup = { attempted: false, ok: true, detail: 'No temporary resources created' };

  try {
    root = await (
      dependencies.createTempRoot ??
      (async () => await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-deep-doctor-')))
    )();
    fixture = await createDeepRepository(root);
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
    await runtime.delegate(
      {
        task_id: 'deep-doctor',
        contract,
        worker_lane: 'deep',
        wait_timeout_seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
      },
      sandboxMeta(fixture.repository),
    );
    providerRuns = 1;
    const review = await waitForTask(
      runtime,
      'deep-doctor',
      deadline,
      tokenLimit,
      (task) =>
        task.status === 'review_required' || task.status === 'paused' || task.status === 'failed',
    );
    if (review.status !== 'review_required') {
      throw new Error('Deep doctor Goal stopped before review readiness');
    }
    await waitForEvents(
      runtime,
      'deep-doctor',
      deadline,
      tokenLimit,
      (items) =>
        items.some((event) => event.type === 'command_postflight_passed') ||
        items.some((event) => event.type === 'command_postflight_failed'),
    );
    usage = (await collectDeepEvidence(runtime, fixture, proofs, diagnostics, false)) ?? usage;
    const doctorTask = await runtime.store.loadTask('deep-doctor');
    await runtime.control(
      {
        task_id: 'deep-doctor',
        action: 'finalize',
        review_summary: 'Deep doctor reviewed the bounded isolated diff.',
        approved_review_criteria: [],
        expected_review_revision: doctorTask.reviewRevision ?? 0,
        expected_review_tree_hash: doctorTask.reviewTreeHash ?? '',
      },
      sandboxMeta(fixture.repository),
    );
    const completed = await waitForTask(
      runtime,
      'deep-doctor',
      deadline,
      tokenLimit,
      (task) =>
        task.status === 'completed' || task.status === 'commit_failed' || task.status === 'failed',
    );
    usage = privacySafeUsage(completed.usage);
    usage = (await collectDeepEvidence(runtime, fixture, proofs, diagnostics, false)) ?? usage;
    if (providerRuns !== 1 || Object.values(proofs).some((value) => !value)) {
      throw new Error('Deep doctor conformance proof is incomplete');
    }
    status = 'passed';
    diagnostics.termination = 'completed';
    detail = 'One bounded Goal produced a reviewed commit with complete conformance evidence';
  } catch (error) {
    if (error instanceof DeepDoctorUsageLimit) {
      status = 'usage_limited';
      diagnostics.termination = 'provider_usage_limit';
      diagnostics.observedProviderTokens = Math.max(
        diagnostics.observedProviderTokens,
        error.observedTokens,
      );
      detail = `Provider usage limit reached at ${String(error.observedTokens)} tokens (limit ${String(error.limitTokens)})`;
    } else if (error instanceof DeepDoctorTimeout) {
      status = 'timed_out';
      diagnostics.termination = 'timeout';
      detail = 'Deep doctor exceeded its absolute deadline';
    } else {
      status = 'failed';
      diagnostics.termination = 'failure';
      detail =
        error instanceof Error &&
        [
          'Deep doctor Goal stopped before review readiness',
          'Deep doctor conformance proof is incomplete',
        ].includes(error.message)
          ? error.message
          : 'Deep doctor failed before conformance completed';
    }
    if (runtime && fixture) {
      usage =
        (await collectDeepEvidence(runtime, fixture, proofs, diagnostics, false).catch(
          () => null,
        )) ?? usage;
      preserveFailureTaskState = diagnostics.lastTaskStatus !== null;
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
      usage = task ? privacySafeUsage(task.usage) : usage;
    }
  } finally {
    await runtime?.shutdown().catch(() => undefined);
    if (runtime && fixture) {
      usage =
        (await collectDeepEvidence(
          runtime,
          fixture,
          proofs,
          diagnostics,
          preserveFailureTaskState,
        ).catch(() => null)) ?? usage;
    }
    if (root) {
      cleanup = { attempted: true, ok: true, detail: 'Temporary repo and state removed' };
      try {
        await (
          dependencies.removeTempRoot ??
          (async (value) => await rm(value, { recursive: true, force: true }))
        )(root);
      } catch {
        cleanup = {
          attempted: true,
          ok: false,
          detail: 'Temporary cleanup failed',
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
    diagnostics,
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

  const codexConfigPath =
    options.codexConfigPath ??
    path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'config.toml');
  const codexConfig = await readFile(codexConfigPath, 'utf8').catch(() => undefined);
  checks.push(codexToolTimeoutCheck(codexConfig));

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
        deepProviderTokenLimit: options.deepProviderTokenLimit,
      },
      options.deepDependencies,
    );
    report.ok = report.ok && report.deep.ok;
  }
  return report;
}
