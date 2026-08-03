import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';

interface FakeSession {
  cwd: string;
  mode: string;
  options: Record<string, string>;
  running: boolean;
  complete: boolean;
  sequence: number;
  cancelled: boolean;
  failed: boolean;
  verification?: { argv: [string, ...string[]]; cwd: string };
}

const sessions = new Map<string, FakeSession>();
let nextSession = 0;
const networkFlag = process.argv.lastIndexOf('--sandbox-network');
const configuredNetwork = networkFlag >= 0 && process.argv[networkFlag + 1] === 'on';
const fakeMode = process.argv.find((argument) => argument.startsWith('--fake-mode='))?.slice(12);

const statusRequest = z.object({ sessionId: z.string() });

function configOptions(session: FakeSession) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: session.options.model ?? 'deepseek-v4-flash',
      options: [{ value: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: session.options.effort ?? 'auto',
      options: [
        { value: 'auto', name: 'Auto' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'work_mode',
      name: 'Work Mode',
      category: 'work_mode',
      type: 'select' as const,
      currentValue: session.options.work_mode ?? 'balanced',
      options: [
        { value: 'balanced', name: 'Balanced' },
        { value: 'delivery', name: 'Delivery' },
      ],
    },
    {
      id: 'tool_approval',
      name: 'Tool Approval',
      category: 'tool_approval',
      type: 'select' as const,
      currentValue: session.options.tool_approval ?? 'ask',
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'auto', name: 'Auto' },
      ],
    },
  ];
}

function status(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const hit = session.complete ? 7 : 0;
  const miss = session.complete ? 3 : 0;
  const usage = {
    promptTokens: session.complete ? 10 : 0,
    completionTokens: session.complete ? 5 : 0,
    reasoningTokens: session.complete ? 2 : 0,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    cacheHitRatio: hit + miss > 0 ? hit / (hit + miss) : null,
    estimatedCost: session.complete ? 0.001 : null,
    currency: session.complete ? 'USD' : null,
    usageSource: 'executor',
  };
  return {
    schemaVersion: 1 as const,
    sequence: session.sequence,
    sessionId,
    state: session.running ? ('running' as const) : ('idle' as const),
    model: session.options.model ?? 'deepseek-v4-flash',
    effort: session.options.effort ?? 'auto',
    mode: session.mode as 'normal' | 'plan' | 'goal',
    workMode: (session.options.work_mode ?? 'balanced') as 'economy' | 'balanced' | 'delivery',
    plannerMode: 'off' as const,
    goal: {
      status: session.cancelled
        ? ('cancelled' as const)
        : session.failed
          ? ('failed' as const)
          : session.complete
            ? ('complete' as const)
            : session.running
              ? ('running' as const)
              : ('none' as const),
      objective: 'fake offline goal',
    },
    phase: session.running ? 'implementing' : session.complete ? 'review_ready' : 'idle',
    turnOutcome: {
      kind: session.cancelled
        ? ('cancelled' as const)
        : session.failed
          ? ('error' as const)
          : session.complete
            ? ('completed' as const)
            : ('none' as const),
    },
    finalReadiness: {
      readyForReview: session.complete,
      summary: session.complete ? 'Created result.txt using the fake offline Reasonix agent.' : '',
      risks: [],
    },
    sandbox: {
      mode: 'enforce' as const,
      engine: process.platform === 'darwin' ? ('seatbelt' as const) : ('bubblewrap' as const),
      available: true,
      workspaceRoot: session.cwd,
      writeRoots: [session.cwd],
      networkEnabled: configuredNetwork,
    },
    usage: { turn: usage, cumulative: usage },
  };
}

const app = acp
  .agent({ name: 'fake-reasonix' })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentInfo: { name: 'fake-reasonix', version: '1.0.0-test' },
    agentCapabilities: {
      promptCapabilities: {},
      sessionCapabilities: { resume: {}, close: {} },
      _meta: {
        '_reasonix.io/session/status': { schemaVersion: 1 },
        '_reasonix.io/session/status_update': { schemaVersion: 1 },
      },
    },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-${++nextSession}`;
    const session: FakeSession = {
      cwd: params.cwd,
      mode: 'normal',
      options: {
        model: 'deepseek-v4-flash',
        effort: 'auto',
        work_mode: 'balanced',
        tool_approval: 'ask',
      },
      running: false,
      complete: false,
      sequence: 1,
      cancelled: false,
      failed: false,
    };
    sessions.set(sessionId, session);
    return {
      sessionId,
      modes: {
        currentModeId: 'normal',
        availableModes: [
          { id: 'normal', name: 'Normal' },
          { id: 'plan', name: 'Plan' },
          { id: 'goal', name: 'Goal' },
        ],
      },
      configOptions: configOptions(session),
    };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('unknown session');
    if ('value' in params) session.options[params.configId] = String(params.value);
    session.sequence += 1;
    return { configOptions: configOptions(session) };
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('unknown session');
    session.mode = params.modeId;
    session.sequence += 1;
    return {};
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('unknown session');
    session.cwd = params.cwd;
    return {
      modes: { currentModeId: session.mode, availableModes: [] },
      configOptions: configOptions(session),
    };
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) {
      session.cancelled = true;
      session.running = false;
      session.sequence += 1;
    }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('unknown session');
    session.running = true;
    session.complete = false;
    const promptText = params.prompt
      .filter(
        (block): block is Extract<(typeof params.prompt)[number], { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n');
    const verification = /^- \[[^\]]+\] cwd=(\S+) timeout=\d+s argv=(.+) proves=\S+$/m.exec(
      promptText,
    );
    if (verification?.[1] && verification[2]) {
      const argv = JSON.parse(verification[2]) as unknown;
      if (
        Array.isArray(argv) &&
        argv.length > 0 &&
        argv.every((item) => typeof item === 'string')
      ) {
        session.verification = { argv: argv as [string, ...string[]], cwd: verification[1] };
      }
    }
    session.sequence += 1;
    await client.notify('_reasonix.io/session/status_update', {
      schemaVersion: 1,
      sequence: session.sequence,
      sessionId: params.sessionId,
      event: 'phase',
      status: status(params.sessionId),
    });
    if (fakeMode === 'timeout') {
      await new Promise<void>(() => undefined);
    }
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: `edit-${session.sequence}`,
        title: 'write_file result.txt',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'result.txt', content: 'offline result\n' },
        locations: [{ path: `${session.cwd}/result.txt` }],
      },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId !== 'allow_once') {
      session.running = false;
      session.sequence += 1;
      return { stopReason: 'cancelled' };
    }
    await writeFile(`${session.cwd}/result.txt`, 'offline result\n', 'utf8');
    if (!session.verification) throw new Error('fake agent did not receive contract verification');
    const executePermission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: `execute-${session.sequence}`,
        title: 'bash contract verification',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'model-supplied shell text' },
        _meta: {
          'reasonix.io': {
            approvalId: `execute-${session.sequence}`,
            tool: 'bash',
            commandSchemaVersion: 1,
            argv: session.verification.argv,
            cwd: path.resolve(session.cwd, ...session.verification.cwd.split('/')),
          },
        },
      },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (
      executePermission.outcome.outcome !== 'selected' ||
      executePermission.outcome.optionId !== 'allow_once'
    ) {
      session.running = false;
      session.sequence += 1;
      return { stopReason: 'cancelled' };
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: `execute-${session.sequence}`,
        kind: 'execute',
        status: 'completed',
      },
    });
    if (fakeMode === 'fail') {
      session.running = false;
      session.failed = true;
      session.sequence += 1;
      return { stopReason: 'end_turn' };
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Created result.txt.' },
      },
    });
    session.running = false;
    session.complete = true;
    session.sequence += 1;
    await client.notify('_reasonix.io/session/status_update', {
      schemaVersion: 1,
      sequence: session.sequence,
      sessionId: params.sessionId,
      event: 'completion',
      status: status(params.sessionId),
    });
    return { stopReason: 'end_turn' };
  })
  .onRequest('_reasonix.io/session/status', statusRequest, ({ params }) => status(params.sessionId))
  .onRequest(
    '_reasonix.io/session/steer',
    z.object({ sessionId: z.string(), prompt: z.array(z.unknown()) }),
    () => ({}),
  );

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);
await connection.closed;
