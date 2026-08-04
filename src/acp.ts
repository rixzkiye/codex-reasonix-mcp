import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import picomatch from 'picomatch';
import type {
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type { BridgeConfig } from './config.js';
import { configFingerprint } from './config.js';
import { BridgeError } from './errors.js';
import { redactString } from './redaction.js';
import {
  assertReasonixStatusCapability,
  REASONIX_STATUS_METHOD,
  REASONIX_STATUS_UPDATE_METHOD,
  REASONIX_STEER_METHOD,
  reasonixStatusSchema,
  reasonixStatusUpdateSchema,
  type ReasonixStatus,
  type ReasonixStatusUpdate,
} from './reasonix-status.js';
import {
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  type ReasoningEffort,
  type RepositoryIdentity,
  type WorkerLane,
} from './types.js';
import { VERSION } from './version.js';

export interface ReasonixCallbacks {
  onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onSessionUpdate(notification: SessionNotification): Promise<void> | void;
  onStatusUpdate(update: ReasonixStatusUpdate): Promise<void> | void;
  onPromptComplete(
    sessionId: string,
    response: PromptResponse | undefined,
    status: ReasonixStatus | undefined,
    error?: unknown,
  ): Promise<void> | void;
  onProcessError(sessionIds: string[], error: unknown): Promise<void> | void;
  onOperationalLog?(message: string): Promise<void> | void;
}

interface SessionRuntime {
  taskId: string;
  sessionId: string;
  worktree: string;
  activePrompt: boolean;
  lastSequence: number;
  requestedEffort: ReasoningEffort;
  workerLane: WorkerLane;
  executionTimeoutSeconds: number;
  deadline?: ReturnType<typeof setTimeout>;
  completionReported: boolean;
}

function extensionMeta(response: InitializeResponse): unknown {
  return response.agentCapabilities?._meta;
}

function flattenOptions(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== 'select') return [];
  const values: Array<{ value: string; name: string }> = [];
  for (const item of option.options) {
    if ('value' in item) values.push({ value: item.value, name: item.name });
    else values.push(...item.options.map((nested) => ({ value: nested.value, name: nested.name })));
  }
  return values;
}

function findOption(options: SessionConfigOption[], id: string): SessionConfigOption | undefined {
  return options.find((option) => option.id === id || option.category === id);
}

function desiredModel(options: SessionConfigOption[], model: string): string {
  const selector = findOption(options, 'model');
  if (!selector)
    throw new BridgeError('reasonix_incompatible', 'Reasonix did not advertise model selection');
  const values = flattenOptions(selector);
  const match = values.find(
    (option) =>
      option.value === model || option.value.endsWith(`/${model}`) || option.name === model,
  );
  if (!match) {
    throw new BridgeError(
      'reasonix_incompatible',
      `Required Reasonix model is unavailable: ${model}`,
      {
        available: values.map((item) => item.value),
      },
    );
  }
  return match.value;
}

export function desiredEffort(
  options: SessionConfigOption[],
  requested: ReasoningEffort,
): { configId: string; value: ReasoningEffort } {
  const selector = findOption(options, 'effort') ?? findOption(options, 'thought_level');
  if (!selector) {
    throw new BridgeError(
      'reasonix_incompatible',
      'Reasonix did not advertise reasoning effort selection',
    );
  }
  const values = flattenOptions(selector).map((item) => item.value);
  if (!values.includes(requested)) {
    throw new BridgeError(
      'reasonix_incompatible',
      `Requested Reasonix reasoning effort is unavailable: ${requested}`,
      { requested, available: values },
    );
  }
  return { configId: selector.id, value: requested };
}

// Environment baseline passed to the Reasonix ACP child: system paths,
// locale, temp, CA configuration, and the Codex home. Provider credentials
// are deliberately NOT part of the baseline.
const REASONIX_SYSTEM_ENV_KEYS = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
] as const;

// Injection vectors that must never reach the worker, even if explicitly
// allowlisted: Node/binary preloaders, shell startup files, and Git helper
// drivers that the worker's read-only git commands could execute.
const DENIED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'BASHOPTS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'PAGER',
  'NPM_CONFIG_USERCONFIG',
]);
const DENIED_ENV_PREFIXES = ['DYLD_', 'NPM_CONFIG_', 'npm_config_'];

/**
 * Build the environment handed to the Reasonix ACP child from an explicit
 * baseline instead of inheriting the full host environment:
 * - system baseline (paths, locale, temp, CA);
 * - REASONIX_* pass-through;
 * - provider credentials and anything else ONLY via config.envAllowlist
 *   (CODEX_REASONIX_ENV_ALLOWLIST, comma-separated globs);
 * - hard-deny list wins over the allowlist.
 */
export function buildReasonixEnvironment(config: BridgeConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of REASONIX_SYSTEM_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (DENIED_ENV_KEYS.has(key) || DENIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    if (key.startsWith('REASONIX_') || key.startsWith('LC_')) {
      env[key] = value;
      continue;
    }
    if (config.envAllowlist.some((pattern) => picomatch(pattern, { dot: true })(key))) {
      env[key] = value;
    }
  }
  return env;
}

export const REASONIX_IDENTICAL_DENIAL_LIMIT = 3;

export function assertReasonixEffort(
  status: ReasonixStatus,
  requestedEffort: ReasoningEffort,
): void {
  if (status.effort !== requestedEffort) {
    throw new BridgeError(
      'reasonix_incompatible',
      'Reasonix effective reasoning effort changed unexpectedly',
      { requestedEffort, effectiveEffort: status.effort },
    );
  }
}

export function laneWorkMode(
  workMode: ReasonixStatus['workMode'],
  workerLane: WorkerLane,
): boolean {
  return workerLane === 'fast' ? workMode === 'economy' : workMode === 'delivery';
}

export function laneSessionMode(mode: ReasonixStatus['mode'], workerLane: WorkerLane): boolean {
  return workerLane === 'fast' ? mode === 'normal' : mode === 'goal';
}

/**
 * Lightweight lane/effort posture check for statuses observed outside session
 * creation/resume (repair steering and finalization).
 */
export function assertLaneCompatible(
  status: ReasonixStatus,
  workerLane: WorkerLane,
  requestedEffort: ReasoningEffort,
): void {
  assertReasonixEffort(status, requestedEffort);
  if (!laneWorkMode(status.workMode, workerLane) || !laneSessionMode(status.mode, workerLane)) {
    throw new BridgeError(
      'reasonix_incompatible',
      'Reasonix effective session mode violates the task worker lane',
      {
        workerLane,
        mode: status.mode,
        workMode: status.workMode,
        requestedEffort,
        effectiveEffort: status.effort,
      },
    );
  }
}

export async function cancelBestEffortThenComplete(
  cancel: () => Promise<void>,
  complete: () => Promise<void> | void,
): Promise<void> {
  await cancel().catch(() => undefined);
  await complete();
}

export function supervisedWorkerPrompt(
  prompt: string,
  executionTimeoutSeconds = DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  workerLane: WorkerLane = 'deep',
): string {
  if (workerLane === 'fast') {
    return `${prompt}\n\n## Bridge supervision boundary\nYou are the edit worker. Make only the contract-scoped file edits needed for the task. Do not create plans, todos, goal sessions, AutoResearch runs, review or task skills, or subagents. Do not run acceptance checks. The bridge, not the worker, owns repository scope scanning, acceptance verification, staging, ref updates, and commit creation. Do not stage, commit, merge, push, or publish. Do not run acceptance commands unless the bridge explicitly sends a later repair instruction that names one.\nStop and report the current edit state before ${String(executionTimeoutSeconds)} seconds. After ${String(REASONIX_IDENTICAL_DENIAL_LIMIT - 1)} identical immutable-policy denials, do not retry the denied operation; stop and report the blocker.`;
  }
  return `${prompt}\n\n## Bridge supervision boundary\nYou are the edit worker. Make only the contract-scoped file edits needed for the task. Before the first edit, create a concise task plan or todo so Delivery mode can track acceptance. The bridge, not the worker, owns repository scope scanning, acceptance verification, staging, ref updates, and commit creation. Do not stage, commit, merge, push, or publish. Do not run acceptance commands unless the bridge explicitly sends a later repair instruction that names one.\nStop and report the current edit state before ${String(executionTimeoutSeconds)} seconds. After ${String(REASONIX_IDENTICAL_DENIAL_LIMIT - 1)} identical immutable-policy denials, do not retry the denied operation; stop and report the blocker.`;
}

export class ReasonixProcess {
  readonly fingerprint: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: acp.ClientConnection;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly promptTasks = new Set<Promise<void>>();
  private readonly initializeResponse: InitializeResponse;
  private closed = false;
  private failureReported = false;
  private readonly callbackTasks = new Set<Promise<void>>();

  private constructor(
    private readonly config: BridgeConfig,
    private readonly repository: RepositoryIdentity,
    private readonly callbacks: ReasonixCallbacks,
    child: ChildProcessWithoutNullStreams,
    connection: acp.ClientConnection,
    initializeResponse: InitializeResponse,
  ) {
    this.child = child;
    this.connection = connection;
    this.initializeResponse = initializeResponse;
    this.fingerprint = configFingerprint(config);
    this.observeChild();
  }

  static async launch(
    config: BridgeConfig,
    repository: RepositoryIdentity,
    callbacks: ReasonixCallbacks,
  ): Promise<ReasonixProcess> {
    const args = [
      ...config.reasonixArgs,
      'acp',
      '--profile',
      config.profile,
      '--planner=off',
      '--sandbox-network',
      config.networkEnabled ? 'on' : 'off',
      '--workspace-only',
      '--sandbox-bash',
      'enforce',
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.reasonixCommand, args, {
        cwd: repository.root,
        env: buildReasonixEnvironment(config),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new BridgeError('reasonix_unavailable', 'Unable to spawn Reasonix ACP process', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const launched = { process: undefined as ReasonixProcess | undefined };
    const app = acp
      .client({ name: 'codex-reasonix-mcp' })
      .onRequest(
        acp.methods.client.session.requestPermission,
        async ({ params }) => await callbacks.onPermission(params),
      )
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        await callbacks.onSessionUpdate(params);
      })
      .onNotification(
        REASONIX_STATUS_UPDATE_METHOD,
        reasonixStatusUpdateSchema,
        async ({ params }) => {
          if (await launched.process?.rejectEffortDrift(params)) return;
          await callbacks.onStatusUpdate(params);
        },
      );

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const connection = app.connect(acp.ndJsonStream(input, output));
    const stderrChunks: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      const safe = redactString(chunk.toString('utf8'), 8_192);
      stderrChunks.push(safe);
      if (stderrChunks.length > 64) stderrChunks.shift();
      void callbacks.onOperationalLog?.(safe);
    });

    let initialized: InitializeResponse;
    try {
      initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'codex-reasonix-mcp', version: VERSION },
        clientCapabilities: {},
      });
    } catch (error) {
      child.kill('SIGTERM');
      throw new BridgeError('reasonix_unavailable', 'Reasonix ACP initialize failed', {
        error: error instanceof Error ? error.message : String(error),
        stderr: stderrChunks.join('').slice(-16_384),
      });
    }
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      child.kill('SIGTERM');
      throw new BridgeError(
        'reasonix_incompatible',
        `Reasonix negotiated ACP ${initialized.protocolVersion}; stable v1 is required`,
      );
    }
    try {
      assertReasonixStatusCapability(extensionMeta(initialized));
    } catch (error) {
      child.kill('SIGTERM');
      throw new BridgeError('reasonix_incompatible', (error as Error).message);
    }
    launched.process = new ReasonixProcess(
      config,
      repository,
      callbacks,
      child,
      connection,
      initialized,
    );
    return launched.process;
  }

  private observeChild(): void {
    this.child.once('error', (error) => {
      this.reportProcessFailure(error);
    });
    this.child.once('exit', (code, signal) => {
      if (this.closed) return;
      this.reportProcessFailure(
        new Error(`Reasonix ACP exited code=${String(code)} signal=${String(signal)}`),
      );
    });
    void this.connection.closed.catch((error: unknown) => {
      this.reportProcessFailure(error);
    });
  }

  private reportProcessFailure(error: unknown): void {
    if (this.closed || this.failureReported) return;
    this.failureReported = true;
    const task = Promise.resolve(this.callbacks.onProcessError([...this.sessions.keys()], error))
      .catch(() => undefined)
      .then(() => undefined);
    this.callbackTasks.add(task);
    void task.finally(() => this.callbackTasks.delete(task));
  }

  private clearPromptDeadline(runtime: SessionRuntime): void {
    if (runtime.deadline) clearTimeout(runtime.deadline);
    runtime.deadline = undefined;
  }

  private async stopSupervisedPrompt(runtime: SessionRuntime, error: BridgeError): Promise<void> {
    if (!runtime.activePrompt || runtime.completionReported) return;
    runtime.activePrompt = false;
    runtime.completionReported = true;
    this.clearPromptDeadline(runtime);
    await cancelBestEffortThenComplete(
      async () =>
        await this.connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: runtime.sessionId,
        }),
      async () =>
        await this.callbacks.onPromptComplete(runtime.sessionId, undefined, undefined, error),
    );
  }

  private async rejectEffortDrift(update: ReasonixStatusUpdate): Promise<boolean> {
    const runtime = this.sessions.get(update.sessionId);
    if (!runtime || update.status.effort === runtime.requestedEffort) return false;
    const error = new BridgeError(
      'reasonix_incompatible',
      'Reasonix effective reasoning effort changed unexpectedly',
      {
        requestedEffort: runtime.requestedEffort,
        effectiveEffort: update.status.effort,
      },
    );
    if (runtime.activePrompt) await this.stopSupervisedPrompt(runtime, error);
    return true;
  }

  private async setSelect(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SessionConfigOption[]> {
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId,
        value,
      },
    );
    return response.configOptions;
  }

  private async configureSession(
    response: NewSessionResponse,
    requestedEffort: ReasoningEffort,
    workerLane: WorkerLane,
  ): Promise<void> {
    let options = response.configOptions ?? [];
    const model = desiredModel(options, this.config.model);
    options = await this.setSelect(response.sessionId, 'model', model);
    const effort = desiredEffort(options, requestedEffort);
    await this.setSelect(response.sessionId, effort.configId, effort.value);
    // fast lane: Reasonix economy + normal session; deep lane: delivery + Goal.
    const workMode = workerLane === 'fast' ? 'economy' : 'delivery';
    const modeId = workerLane === 'fast' ? 'normal' : 'goal';
    options = await this.setSelect(response.sessionId, 'work_mode', workMode);
    const approval = findOption(options, 'tool_approval');
    if (!approval || !flattenOptions(approval).some((item) => item.value === 'ask')) {
      throw new BridgeError('reasonix_incompatible', 'Reasonix tool_approval=ask is unavailable');
    }
    await this.setSelect(response.sessionId, 'tool_approval', 'ask');
    if (workerLane === 'deep') {
      if (!response.modes?.availableModes.some((mode) => mode.id === 'goal')) {
        throw new BridgeError('reasonix_incompatible', 'Reasonix Goal mode is unavailable');
      }
    }
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: response.sessionId,
      modeId,
    });
  }

  async status(sessionId: string): Promise<ReasonixStatus> {
    const raw = await this.connection.agent.request<unknown, { sessionId: string }>(
      REASONIX_STATUS_METHOD,
      { sessionId },
    );
    const parsed = reasonixStatusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BridgeError('reasonix_incompatible', 'Malformed Reasonix status snapshot', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  private async verifyEffectiveStatus(
    status: ReasonixStatus,
    worktree: string,
    networkEnabled: boolean,
    requestedEffort: ReasoningEffort,
    workerLane: WorkerLane,
  ): Promise<void> {
    const canonicalWorktree = await realpath(worktree);
    const canonicalStatusRoot = await realpath(status.sandbox.workspaceRoot);
    const roots = await Promise.all(
      status.sandbox.writeRoots.map(async (root) => await realpath(root)),
    );
    const modelMatches =
      status.model === this.config.model || status.model.endsWith(`/${this.config.model}`);
    assertReasonixEffort(status, requestedEffort);
    const expectedEngine = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
    if (
      status.plannerMode !== 'off' ||
      !laneWorkMode(status.workMode, workerLane) ||
      !laneSessionMode(status.mode, workerLane) ||
      !modelMatches ||
      canonicalStatusRoot !== canonicalWorktree ||
      roots.length !== 1 ||
      roots[0] !== canonicalWorktree ||
      status.sandbox.mode !== 'enforce' ||
      status.sandbox.engine !== expectedEngine ||
      !status.sandbox.available ||
      status.sandbox.networkEnabled !== networkEnabled
    ) {
      throw new BridgeError(
        'reasonix_incompatible',
        'Reasonix effective session status violates bridge policy',
        {
          plannerMode: status.plannerMode,
          workMode: status.workMode,
          mode: status.mode,
          model: status.model,
          requestedEffort,
          effectiveEffort: status.effort,
          workerLane,
          workspaceRoot: status.sandbox.workspaceRoot,
          writeRoots: status.sandbox.writeRoots,
          sandboxEngine: status.sandbox.engine,
          sandboxAvailable: status.sandbox.available,
          networkEnabled: status.sandbox.networkEnabled,
        },
      );
    }
  }

  async createSession(
    taskId: string,
    worktree: string,
    networkEnabled: boolean,
    requestedEffort: ReasoningEffort,
    executionTimeoutSeconds: number,
    workerLane: WorkerLane,
  ): Promise<{ sessionId: string; status: ReasonixStatus }> {
    const response = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: worktree,
      additionalDirectories: [],
      mcpServers: [],
    });
    const runtime: SessionRuntime = {
      taskId,
      sessionId: response.sessionId,
      worktree,
      activePrompt: false,
      lastSequence: 0,
      requestedEffort,
      workerLane,
      executionTimeoutSeconds,
      completionReported: false,
    };
    this.sessions.set(response.sessionId, runtime);
    await this.configureSession(response, requestedEffort, workerLane);
    const status = await this.status(response.sessionId);
    await this.verifyEffectiveStatus(status, worktree, networkEnabled, requestedEffort, workerLane);
    return { sessionId: response.sessionId, status };
  }

  async resumeSession(
    taskId: string,
    sessionId: string,
    worktree: string,
    networkEnabled: boolean,
    requestedEffort: ReasoningEffort,
    executionTimeoutSeconds: number,
    workerLane: WorkerLane,
  ): Promise<ReasonixStatus> {
    await this.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: worktree,
      additionalDirectories: [],
      mcpServers: [],
    });
    this.sessions.set(sessionId, {
      taskId,
      sessionId,
      worktree,
      activePrompt: false,
      lastSequence: 0,
      requestedEffort,
      workerLane,
      executionTimeoutSeconds,
      completionReported: false,
    });
    const status = await this.status(sessionId);
    await this.verifyEffectiveStatus(status, worktree, networkEnabled, requestedEffort, workerLane);
    return status;
  }

  private startPrompt(sessionId: string, prompt: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new BridgeError('invalid_state', `Unknown ACP session: ${sessionId}`);
    runtime.activePrompt = true;
    runtime.completionReported = false;
    this.clearPromptDeadline(runtime);
    runtime.deadline = setTimeout(() => {
      void this.stopSupervisedPrompt(
        runtime,
        new BridgeError('reasonix_unavailable', 'Reasonix turn exceeded its deadline', {
          timeoutSeconds: runtime.executionTimeoutSeconds,
        }),
      );
    }, runtime.executionTimeoutSeconds * 1_000);
    const task = (async (): Promise<void> => {
      try {
        const response = await this.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: supervisedWorkerPrompt(
                prompt,
                runtime.executionTimeoutSeconds,
                runtime.workerLane,
              ),
            },
          ],
        });
        this.clearPromptDeadline(runtime);
        runtime.activePrompt = false;
        if (runtime.completionReported) return;
        let status: ReasonixStatus | undefined;
        try {
          status = await this.status(sessionId);
        } catch {
          // Prompt completion still needs to be surfaced; malformed status fails closed upstream.
        }
        if (status) assertReasonixEffort(status, runtime.requestedEffort);
        runtime.completionReported = true;
        await this.callbacks.onPromptComplete(sessionId, response, status);
      } catch (error) {
        this.clearPromptDeadline(runtime);
        runtime.activePrompt = false;
        if (runtime.completionReported) return;
        runtime.completionReported = true;
        await this.callbacks.onPromptComplete(sessionId, undefined, undefined, error);
      }
    })().catch(() => undefined);
    this.promptTasks.add(task);
    void task.finally(() => this.promptTasks.delete(task));
  }

  prompt(sessionId: string, prompt: string): void {
    this.startPrompt(sessionId, prompt);
  }

  async steer(sessionId: string, prompt: string): Promise<'steered' | 'prompted'> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new BridgeError('invalid_state', `Unknown ACP session: ${sessionId}`);
    if (runtime.activePrompt) {
      await this.connection.agent.request(REASONIX_STEER_METHOD, {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      return 'steered';
    }
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId,
      modeId: runtime.workerLane === 'fast' ? 'normal' : 'goal',
    });
    this.startPrompt(sessionId, prompt);
    return 'prompted';
  }

  async cancel(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime) this.clearPromptDeadline(runtime);
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime) this.clearPromptDeadline(runtime);
    await this.connection.agent.request(acp.methods.agent.session.close, { sessionId });
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const runtime of this.sessions.values()) this.clearPromptDeadline(runtime);
    this.connection.close();
    this.child.kill('SIGTERM');
    await Promise.race([
      this.connection.closed.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await Promise.allSettled(this.promptTasks);
    await Promise.allSettled(this.callbackTasks);
  }

  get agentInfo(): InitializeResponse['agentInfo'] {
    return this.initializeResponse.agentInfo;
  }

  get isAlive(): boolean {
    return (
      !this.closed &&
      !this.failureReported &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }
}

export class ReasonixPool {
  private readonly processes = new Map<string, Promise<ReasonixProcess>>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly callbacks: ReasonixCallbacks,
  ) {}

  private key(
    repository: RepositoryIdentity,
    networkEnabled: boolean,
    workerLane: WorkerLane,
  ): string {
    return `${repository.id}:${configFingerprint({ ...this.config, networkEnabled })}:lane=${workerLane}`;
  }

  async forRepository(
    repository: RepositoryIdentity,
    networkEnabled: boolean,
    workerLane: WorkerLane,
  ): Promise<ReasonixProcess> {
    const effectiveConfig = { ...this.config, networkEnabled };
    const key = this.key(repository, networkEnabled, workerLane);
    for (;;) {
      let processPromise = this.processes.get(key);
      if (!processPromise) {
        processPromise = ReasonixProcess.launch(effectiveConfig, repository, this.callbacks);
        this.processes.set(key, processPromise);
      }
      let worker: ReasonixProcess;
      try {
        worker = await processPromise;
      } catch (error) {
        if (this.processes.get(key) === processPromise) this.processes.delete(key);
        throw error;
      }
      if (worker.isAlive) return worker;
      if (this.processes.get(key) === processPromise) this.processes.delete(key);
    }
  }

  async shutdown(): Promise<void> {
    const processes = await Promise.allSettled(this.processes.values());
    await Promise.all(
      processes
        .filter(
          (result): result is PromiseFulfilledResult<ReasonixProcess> =>
            result.status === 'fulfilled',
        )
        .map(async (result) => await result.value.shutdown()),
    );
    this.processes.clear();
  }
}
