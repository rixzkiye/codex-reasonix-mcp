import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
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
import type { RepositoryIdentity } from './types.js';

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
      'reasonix_unavailable',
      `Required Reasonix model is unavailable: ${model}`,
      {
        available: values.map((item) => item.value),
      },
    );
  }
  return match.value;
}

function desiredEffort(options: SessionConfigOption[]): string | undefined {
  const selector = findOption(options, 'effort') ?? findOption(options, 'thought_level');
  if (!selector) return undefined;
  const values = flattenOptions(selector).map((item) => item.value);
  for (const candidate of ['max', 'high', 'medium', 'low', 'minimal', 'auto']) {
    if (values.includes(candidate)) return candidate;
  }
  return values.includes('auto') ? 'auto' : undefined;
}

function inheritedReasonixEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NPM_CONFIG_USERCONFIG;
  return env;
}

export class ReasonixProcess {
  readonly fingerprint: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: acp.ClientConnection;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly initializeResponse: InitializeResponse;
  private closed = false;
  private failureReported = false;

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
        env: inheritedReasonixEnvironment(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new BridgeError('reasonix_unavailable', 'Unable to spawn Reasonix ACP process', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
        clientInfo: { name: 'codex-reasonix-mcp', version: '0.1.0-rc.1' },
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
    return new ReasonixProcess(config, repository, callbacks, child, connection, initialized);
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
    void this.callbacks.onProcessError([...this.sessions.keys()], error);
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

  private async configureSession(response: NewSessionResponse): Promise<void> {
    let options = response.configOptions ?? [];
    const model = desiredModel(options, this.config.model);
    options = await this.setSelect(response.sessionId, 'model', model);
    const effort = desiredEffort(options);
    if (effort) await this.setSelect(response.sessionId, 'effort', effort);
    options = await this.setSelect(response.sessionId, 'work_mode', 'delivery');
    const approval = findOption(options, 'tool_approval');
    if (!approval || !flattenOptions(approval).some((item) => item.value === 'ask')) {
      throw new BridgeError('reasonix_incompatible', 'Reasonix tool_approval=ask is unavailable');
    }
    await this.setSelect(response.sessionId, 'tool_approval', 'ask');
    if (!response.modes?.availableModes.some((mode) => mode.id === 'goal')) {
      throw new BridgeError('reasonix_incompatible', 'Reasonix Goal mode is unavailable');
    }
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: response.sessionId,
      modeId: 'goal',
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
  ): Promise<void> {
    const canonicalWorktree = await realpath(worktree);
    const canonicalStatusRoot = await realpath(status.sandbox.workspaceRoot);
    const roots = await Promise.all(
      status.sandbox.writeRoots.map(async (root) => await realpath(root)),
    );
    const modelMatches =
      status.model === this.config.model || status.model.endsWith(`/${this.config.model}`);
    const expectedEngine = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
    if (
      status.plannerMode !== 'off' ||
      status.workMode !== 'delivery' ||
      status.mode !== 'goal' ||
      !modelMatches ||
      canonicalStatusRoot !== canonicalWorktree ||
      roots.length !== 1 ||
      roots[0] !== canonicalWorktree ||
      status.sandbox.mode !== 'enforce' ||
      status.sandbox.engine !== expectedEngine ||
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
          workspaceRoot: status.sandbox.workspaceRoot,
          writeRoots: status.sandbox.writeRoots,
          sandboxEngine: status.sandbox.engine,
          networkEnabled: status.sandbox.networkEnabled,
        },
      );
    }
  }

  async createSession(
    taskId: string,
    worktree: string,
    networkEnabled: boolean,
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
    };
    this.sessions.set(response.sessionId, runtime);
    await this.configureSession(response);
    const status = await this.status(response.sessionId);
    await this.verifyEffectiveStatus(status, worktree, networkEnabled);
    return { sessionId: response.sessionId, status };
  }

  async resumeSession(
    taskId: string,
    sessionId: string,
    worktree: string,
    networkEnabled: boolean,
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
    });
    const status = await this.status(sessionId);
    await this.verifyEffectiveStatus(status, worktree, networkEnabled);
    return status;
  }

  private startPrompt(sessionId: string, prompt: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new BridgeError('invalid_state', `Unknown ACP session: ${sessionId}`);
    runtime.activePrompt = true;
    void this.connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      .then(async (response) => {
        runtime.activePrompt = false;
        let status: ReasonixStatus | undefined;
        try {
          status = await this.status(sessionId);
        } catch {
          // Prompt completion still needs to be surfaced; malformed status fails closed upstream.
        }
        await this.callbacks.onPromptComplete(sessionId, response, status);
      })
      .catch(async (error: unknown) => {
        runtime.activePrompt = false;
        await this.callbacks.onPromptComplete(sessionId, undefined, undefined, error);
      });
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
      modeId: 'goal',
    });
    this.startPrompt(sessionId, prompt);
    return 'prompted';
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.connection.agent.request(acp.methods.agent.session.close, { sessionId });
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.connection.close();
    this.child.kill('SIGTERM');
    await Promise.race([
      this.connection.closed.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
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

  private key(repository: RepositoryIdentity, networkEnabled: boolean): string {
    return `${repository.id}:${configFingerprint({ ...this.config, networkEnabled })}`;
  }

  async forRepository(
    repository: RepositoryIdentity,
    networkEnabled = this.config.networkEnabled,
  ): Promise<ReasonixProcess> {
    const effectiveConfig = { ...this.config, networkEnabled };
    const key = this.key(repository, networkEnabled);
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
