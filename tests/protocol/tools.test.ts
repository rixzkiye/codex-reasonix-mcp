import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import {
  BridgeRuntime,
  makeTaskRecordForTest,
  type RuntimeCallContext,
} from '../../src/runtime.js';
import { createMcpServer } from '../../src/server.js';
import { contractFixture } from '../helpers.js';

// Pinned compatibility target: Codex CLI 0.146.0 (commit e363b08c), whose
// JsonSchema.items field accepts one boxed schema rather than tuple-form arrays.
// https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/tools/src/json_schema.rs
const CODEX_0146_JSON_SCHEMA_SOURCE =
  'https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/tools/src/json_schema.rs';

const CODEX_0146_PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'integer',
  'object',
  'array',
  'null',
]);

const TASK_VIEW = {
  task_id: 'task-1',
  state: 'running',
  phase: 'goal_running',
  contract_hash: 'a'.repeat(64),
  repository_id: 'repository-1',
  branch: 'reasonix/task-1',
  worktree: '/tmp/reasonix/task-1',
  worker_lane: 'fast',
  requested_reasoning_effort: 'low',
  effective_reasoning_effort: 'low',
  execution_timeout_seconds: 3_600,
  source_checkout_integrated: false,
  repair_rounds: 0,
  updated_at: '2026-08-03T00:00:00.000Z',
};

function schemaObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON Schema object`);
  }
  return value as Record<string, unknown>;
}

function assertCodex0146JsonSchema(value: unknown, path = '$'): void {
  const schema = schemaObject(value, path);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      types.length === 0 ||
      types.some((type) => typeof type !== 'string' || !CODEX_0146_PRIMITIVE_TYPES.has(type))
    ) {
      throw new Error(`${path}.type is outside the Codex 0.146.0 JsonSchema subset`);
    }
  }
  if (schema.items !== undefined) {
    assertCodex0146JsonSchema(schema.items, `${path}.items`);
  }
  if (schema.properties !== undefined) {
    for (const [name, property] of Object.entries(
      schemaObject(schema.properties, `${path}.properties`),
    )) {
      assertCodex0146JsonSchema(property, `${path}.properties.${name}`);
    }
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((item) => typeof item !== 'string')
    ) {
      throw new Error(`${path}.required must be a string array`);
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    assertCodex0146JsonSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[keyword];
    if (variants === undefined) continue;
    if (!Array.isArray(variants)) throw new Error(`${path}.${keyword} must be an array`);
    variants.forEach((variant, index) =>
      assertCodex0146JsonSchema(variant, `${path}.${keyword}[${index}]`),
    );
  }
  for (const keyword of ['$defs', 'definitions'] as const) {
    const definitions = schema[keyword];
    if (definitions === undefined) continue;
    for (const [name, definition] of Object.entries(
      schemaObject(definitions, `${path}.${keyword}`),
    )) {
      assertCodex0146JsonSchema(definition, `${path}.${keyword}.${name}`);
    }
  }
}

describe('stable MCP surface', () => {
  it('advertises codex sandbox metadata and exactly three snapshotted tools', async () => {
    const runtime = {
      delegate: () => Promise.resolve({}),
      control: () => Promise.resolve({}),
      inspect: () => Promise.resolve({}),
    } as unknown as BridgeRuntime;
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'protocol-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.experimental).toHaveProperty('codex/sandbox-state-meta');
      const instructions = client.getInstructions();
      expect(instructions?.slice(0, 512)).toContain('reasonix_delegate');
      expect(instructions?.slice(0, 512)).toContain('reasonix_control');
      expect(instructions?.slice(0, 512)).toContain('reasonix_inspect');
      expect(instructions).toContain('explicit user approval');
      expect(instructions).toContain('lowest adequate reasoning_effort');
      expect(instructions).toContain('worker_lane=fast');
      expect(instructions).toContain('required_review_criteria');
      expect(instructions).toContain('cherry-pick it explicitly after review');
      expect(instructions).toContain('codex/sandbox-state-meta');
      expect(instructions).toContain('Never push, merge, or publish');
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual([
        'reasonix_delegate',
        'reasonix_control',
        'reasonix_inspect',
      ]);
      expect(CODEX_0146_JSON_SCHEMA_SOURCE).toContain('e363b08c9175ac1cbe5893615dd2cb9ddf95043b');
      for (const tool of result.tools) {
        expect(() => assertCodex0146JsonSchema(tool.inputSchema)).not.toThrow();
        expect(() => assertCodex0146JsonSchema(tool.outputSchema)).not.toThrow();
      }

      const delegate = result.tools.find((tool) => tool.name === 'reasonix_delegate');
      expect(delegate?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(delegate?.description).toContain('explicit user approval');
      expect(delegate?.description).toContain('wait_mode=review');
      expect(delegate?.description).toContain('lowest reasoning_effort adequate');
      const delegateProperties = schemaObject(delegate?.inputSchema.properties, 'delegate');
      expect(
        schemaObject(delegateProperties.reasoning_effort, 'delegate.reasoning_effort'),
      ).toMatchObject({
        enum: ['low', 'medium', 'high', 'max'],
      });
      expect(schemaObject(delegateProperties.worker_lane, 'delegate.worker_lane')).toMatchObject({
        enum: ['fast', 'deep'],
      });
      expect(
        schemaObject(
          delegateProperties.execution_timeout_seconds,
          'delegate.execution_timeout_seconds',
        ),
      ).toMatchObject({ minimum: 60, maximum: 14_400 });
      expect(schemaObject(delegateProperties.wait_mode, 'delegate.wait_mode')).toMatchObject({
        enum: ['review', 'background'],
        default: 'review',
      });
      expect(
        schemaObject(delegateProperties.wait_timeout_seconds, 'delegate.wait_timeout_seconds'),
      ).toMatchObject({ minimum: 0, maximum: 600, default: 600 });
      const pathBase = schemaObject(delegateProperties.path_base, 'delegate.path_base');
      expect(pathBase).toMatchObject({
        enum: ['cwd', 'repository'],
      });
      expect(pathBase.description).toContain('Defaults to cwd');
      const contract = schemaObject(delegateProperties.contract, 'delegate.contract');
      const contractProperties = schemaObject(contract.properties, 'delegate.contract.properties');
      const verification = schemaObject(
        contractProperties.verification,
        'delegate.contract.verification',
      );
      const verificationItem = schemaObject(
        verification.items,
        'delegate.contract.verification.items',
      );
      const verificationProperties = schemaObject(
        verificationItem.properties,
        'delegate.contract.verification.items.properties',
      );
      const argv = schemaObject(verificationProperties.argv, 'delegate.contract.verification.argv');
      expect(argv).toMatchObject({
        type: 'array',
        minItems: 1,
        maxItems: 128,
        items: { type: 'string', maxLength: 4096 },
      });
      expect(Array.isArray(argv.items)).toBe(false);
      const allowedCommands = schemaObject(
        contractProperties.allowed_commands,
        'delegate.contract.allowed_commands',
      );
      const allowedItem = schemaObject(
        allowedCommands.items,
        'delegate.contract.allowed_commands.items',
      );
      const allowedArgv = schemaObject(
        schemaObject(allowedItem.properties, 'delegate.contract.allowed_commands.items.properties')
          .argv,
        'delegate.contract.allowed_commands.argv',
      );
      expect(allowedArgv).toMatchObject({
        type: 'array',
        minItems: 1,
        maxItems: 128,
        items: { type: 'string', maxLength: 4096 },
      });
      const delegateOutput = schemaObject(delegate?.outputSchema, 'delegate.outputSchema');
      expect(delegateOutput.required).toEqual(
        expect.arrayContaining([
          'task_id',
          'state',
          'phase',
          'contract_hash',
          'repository_id',
          'branch',
          'worktree',
          'requested_reasoning_effort',
          'effective_reasoning_effort',
          'execution_timeout_seconds',
          'source_checkout_integrated',
          'repair_rounds',
          'updated_at',
        ]),
      );
      const delegateOutputProperties = schemaObject(
        delegateOutput.properties,
        'delegate.outputSchema.properties',
      );
      expect(Object.keys(delegateOutputProperties)).toEqual(
        expect.arrayContaining([
          'summary',
          'changed_files',
          'diff_stat',
          'diff',
          'risks',
          'usage',
          'active_interaction',
        ]),
      );
      expect(schemaObject(delegateOutputProperties.diff, 'delegate.output.diff')).toMatchObject({
        maxLength: 12 * 1024,
      });
      expect(
        schemaObject(
          delegateOutputProperties.source_checkout_integrated,
          'delegate.output.source_checkout_integrated',
        ),
      ).toMatchObject({ const: false });

      const control = result.tools.find((tool) => tool.name === 'reasonix_control');
      expect(control?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(control?.description).toContain('created by reasonix_delegate');
      expect(control?.description).toContain('finalize waits for a committed terminal result');
      const controlProperties = schemaObject(control?.inputSchema.properties, 'control');
      expect(Object.keys(controlProperties).sort()).toEqual(
        [
          'action',
          'answer',
          'approved_review_criteria',
          'commit_message',
          'decision',
          'interaction_id',
          'message',
          'option_id',
          'review_summary',
          'task_id',
          'wait_timeout_seconds',
        ].sort(),
      );
      expect(control?.inputSchema.required).toEqual(['task_id', 'action']);
      expect(schemaObject(controlProperties.action, 'control.action').enum).toEqual([
        'steer',
        'respond',
        'cancel',
        'finalize',
        'close',
      ]);
      expect(
        schemaObject(controlProperties.wait_timeout_seconds, 'control.wait_timeout_seconds'),
      ).toMatchObject({ minimum: 0, maximum: 600 });
      const controlOutputProperties = schemaObject(
        schemaObject(control?.outputSchema, 'control.outputSchema').properties,
        'control.outputSchema.properties',
      );
      expect(
        schemaObject(controlOutputProperties.commit_hash, 'control.output.commit_hash'),
      ).toMatchObject({
        pattern: '^[0-9a-f]{40,64}$',
      });
      expect(controlOutputProperties).toHaveProperty('integration_command');
      const inspect = result.tools.find((tool) => tool.name === 'reasonix_inspect');
      expect(inspect?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(inspect?.description).toContain('Recovery-only bounded inspection');
      expect(inspect?.description).toContain('Events are opt-in');
      const inspectProperties = schemaObject(inspect?.inputSchema.properties, 'inspect');
      expect(schemaObject(inspectProperties.wait_until, 'inspect.wait_until')).toMatchObject({
        enum: ['change', 'review_required', 'interaction', 'terminal'],
        default: 'change',
      });
      expect(schemaObject(inspectProperties.include, 'inspect.include')).not.toHaveProperty(
        'default',
      );
      expect(
        result.tools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        })),
      ).toMatchSnapshot();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects invalid action-specific control fields before invoking the runtime', async () => {
    const control = vi.fn(() => Promise.resolve({ reached: true }));
    const runtime = {
      delegate: () => Promise.resolve({}),
      control,
      inspect: () => Promise.resolve({}),
    } as unknown as BridgeRuntime;
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'protocol-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const invalidInputs = [
        { task_id: 'task-1', action: 'steer' },
        { task_id: 'task-1', action: 'respond', interaction_id: 'interaction-1' },
        { task_id: 'task-1', action: 'finalize', review_summary: 'Reviewed' },
        { task_id: 'task-1', action: 'cancel', message: 'not valid for cancel' },
      ];

      for (const args of invalidInputs) {
        const rawResult: unknown = await client.callTool({
          name: 'reasonix_control',
          arguments: args,
        });
        const result = schemaObject(rawResult, 'callTool result');
        expect(result.isError).toBe(true);
        if (!Array.isArray(result.content)) throw new Error('Expected tool result content');
        const content = schemaObject(result.content[0], 'callTool result content');
        expect(content.type).toBe('text');
        if (typeof content.text !== 'string') throw new Error('Expected text error content');
        expect(JSON.parse(content.text) as unknown).toMatchObject({
          error: {
            code: 'invalid_request',
            retryable: false,
            next_action: 'fix_request',
          },
        });
        expect(result.structuredContent).toBeUndefined();
      }
      expect(control).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('forwards bounded runtime heartbeats as MCP progress notifications', async () => {
    const delegate = vi.fn(async (_args: unknown, _meta: unknown, context?: RuntimeCallContext) => {
      await context?.onProgress?.('Reasonix is working; waiting for review');
      return { ...TASK_VIEW, timed_out: false };
    });
    const runtime = {
      delegate,
      control: () => Promise.resolve({}),
      inspect: () => Promise.resolve({}),
    } as unknown as BridgeRuntime;
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'protocol-progress-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const progress: Array<{ progress: number; message?: string }> = [];
    try {
      const result = await client.callTool(
        {
          name: 'reasonix_delegate',
          arguments: { task_id: 'task-1', contract: contractFixture() },
        },
        undefined,
        {
          onprogress: (update) => progress.push(update),
          resetTimeoutOnProgress: true,
        },
      );
      expect(result.isError).not.toBe(true);
      expect(progress).toEqual([
        { progress: 1, message: 'Reasonix is working; waiting for review' },
      ]);
      expect(delegate).toHaveBeenCalledTimes(1);
      const forwardedContext = delegate.mock.calls[0]?.[2];
      expect(forwardedContext?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns schema-conforming structured content for every successful tool', async () => {
    const reviewBundle = {
      summary: 'Implementation is ready for review.',
      changed_files: ['src/index.ts'],
      diff_stat: ' src/index.ts | 1 +',
      diff: 'diff --git a/src/index.ts b/src/index.ts\n+export {};',
      risks: ['No known risks.'],
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheHitTokens: 10,
        cacheMissTokens: 90,
        cacheHitRatio: 0.1,
        estimatedCost: null,
        currency: null,
        usageSource: 'provider',
      },
      active_interaction: {
        id: 'interaction-1',
        kind: 'input',
        status: 'pending',
        createdAt: '2026-08-03T00:00:00.000Z',
        request: { prompt: 'Choose an option' },
      },
    } as const;
    const runtime = {
      delegate: () =>
        Promise.resolve({
          ...TASK_VIEW,
          state: 'review_required',
          phase: 'awaiting_review',
          ...reviewBundle,
        }),
      control: () =>
        Promise.resolve({
          ...TASK_VIEW,
          state: 'completed',
          phase: 'completed',
          commit_hash: 'd'.repeat(40),
          integration_command: `git cherry-pick ${'d'.repeat(40)}`,
        }),
      inspect: () =>
        Promise.resolve({
          task_id: 'task-1',
          sections: { summary: 'done', changed_files: ['src/index.ts'] },
          truncated: false,
          updated_at: TASK_VIEW.updated_at,
        }),
    } as unknown as BridgeRuntime;
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'protocol-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const delegate = await client.callTool({
        name: 'reasonix_delegate',
        arguments: { task_id: 'task-1', contract: contractFixture() },
      });
      const control = await client.callTool({
        name: 'reasonix_control',
        arguments: { task_id: 'task-1', action: 'cancel' },
      });
      const inspect = await client.callTool({
        name: 'reasonix_inspect',
        arguments: { task_id: 'task-1', include: ['summary', 'changed_files'] },
      });

      expect(delegate.isError).not.toBe(true);
      expect(delegate.structuredContent).toEqual({
        ...TASK_VIEW,
        state: 'review_required',
        phase: 'awaiting_review',
        ...reviewBundle,
      });
      expect(Buffer.byteLength(JSON.stringify(reviewBundle), 'utf8')).toBeLessThanOrEqual(
        12 * 1024,
      );
      expect(control.isError).not.toBe(true);
      expect(control.structuredContent).toEqual({
        ...TASK_VIEW,
        state: 'completed',
        phase: 'completed',
        commit_hash: 'd'.repeat(40),
        integration_command: `git cherry-pick ${'d'.repeat(40)}`,
      });
      expect(inspect.isError).not.toBe(true);
      expect(inspect.structuredContent).toEqual({
        task_id: 'task-1',
        sections: { summary: 'done', changed_files: ['src/index.ts'] },
        truncated: false,
        updated_at: TASK_VIEW.updated_at,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('accepts a normal taskView returned by the real runtime', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'reasonix-protocol-runtime-'));
    const runtime = new BridgeRuntime(loadConfig({ stateDir }));
    await runtime.initialize();
    const task = makeTaskRecordForTest(
      'real-task-view',
      parseTaskContract(contractFixture()),
      {
        id: 'real-repository',
        root: path.join(stateDir, 'repository'),
        commonDir: path.join(stateDir, 'repository', '.git'),
        head: 'a'.repeat(40),
      },
      path.join(stateDir, 'worker'),
    );
    task.status = 'running';
    task.phase = 'goal_running';
    await runtime.store.createTask(task);

    const server = createMcpServer(runtime);
    const client = new Client({ name: 'protocol-real-runtime', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'reasonix_control',
        arguments: { task_id: task.taskId, action: 'cancel' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        task_id: task.taskId,
        state: 'cancelled',
        phase: 'cancelled',
      });
      expect(result.structuredContent).toHaveProperty('source_collision', undefined);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  });

  it('detects tuple-form array items as incompatible with Codex 0.146.0', () => {
    expect(() => assertCodex0146JsonSchema({ type: 'array', items: [{ type: 'string' }] })).toThrow(
      /items must be a JSON Schema object/,
    );
  });
});
