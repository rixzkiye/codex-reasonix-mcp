import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { parseTaskContract } from '../../src/contracts.js';
import { BridgeRuntime, makeTaskRecordForTest } from '../../src/runtime.js';
import { createMcpServer } from '../../src/server.js';
import { contractFixture } from '../helpers.js';

// Pinned compatibility target: Codex CLI 0.146.0 (commit e363b08c), whose
// JsonSchema.items field accepts one boxed schema rather than tuple-form arrays.
// https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/tools/src/json_schema.rs
const CODEX_0146_JSON_SCHEMA_SOURCE =
  'https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/tools/src/json_schema.rs';

const EXPECTED_SERVER_INSTRUCTIONS =
  'Use reasonix_delegate only after explicit user request or approval for Reasonix implementation. It creates an immutable TaskContractV1, isolated worktree/session, async execution, and supervised finalization; never substitute native Codex subagents for that work. Use native subagents for bounded parallel exploration, tests, triage, or summaries. reasonix_control manages a Reasonix task; reasonix_inspect reads bounded status/evidence. Delegate/finalize require codex/sandbox-state-meta. Never push or merge.';

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
  repair_rounds: 0,
  updated_at: '2026-08-03T00:00:00.000Z',
};

const SOURCE_COLLISION = {
  checkpoint: 'review_readiness',
  baseCommit: 'b'.repeat(40),
  sourceHead: 'c'.repeat(40),
  dirtyPaths: ['src/index.ts'],
  committedPaths: [],
  overlappingPaths: ['src/index.ts'],
  unavailable: false,
  detectedAt: '2026-08-03T00:00:01.000Z',
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
      expect(instructions).toBe(EXPECTED_SERVER_INSTRUCTIONS);
      expect(instructions).toHaveLength(510);
      expect(instructions?.slice(0, 512)).toContain('reasonix_delegate');
      expect(instructions?.slice(0, 512)).toContain('reasonix_control');
      expect(instructions?.slice(0, 512)).toContain('reasonix_inspect');
      expect(instructions).toContain('explicit user request or approval');
      expect(instructions).toContain('never substitute native Codex subagents');
      expect(instructions).toContain('Use native subagents for bounded parallel');
      expect(instructions).toContain('codex/sandbox-state-meta');
      expect(instructions).toContain('Never push or merge');
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
      expect(delegate?.description).toContain('explicit user request or approval');
      expect(delegate?.description).toContain(
        'Never substitute native Codex subagents for approved Reasonix work',
      );
      expect(delegate?.description).toContain('bounded parallel exploration');
      const delegateProperties = schemaObject(delegate?.inputSchema.properties, 'delegate');
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
      expect(schemaObject(delegate?.outputSchema, 'delegate.outputSchema').required).toEqual(
        expect.arrayContaining([
          'task_id',
          'state',
          'phase',
          'contract_hash',
          'repository_id',
          'branch',
          'worktree',
          'repair_rounds',
          'updated_at',
        ]),
      );

      const control = result.tools.find((tool) => tool.name === 'reasonix_control');
      expect(control?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(control?.description).toContain('created by reasonix_delegate');
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
      const inspect = result.tools.find((tool) => tool.name === 'reasonix_inspect');
      expect(inspect?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(inspect?.description).toContain('Use for a Reasonix task');
      expect(inspect?.description).toContain('bounded status, evidence');
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

  it('returns schema-conforming structured content for every successful tool', async () => {
    const runtime = {
      delegate: () => Promise.resolve({ ...TASK_VIEW, resume_required: true }),
      control: () =>
        Promise.resolve({
          ...TASK_VIEW,
          state: 'cancelled',
          phase: 'cancelled',
          source_collision: SOURCE_COLLISION,
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
      expect(delegate.structuredContent).toEqual({ ...TASK_VIEW, resume_required: true });
      expect(control.isError).not.toBe(true);
      expect(control.structuredContent).toEqual({
        ...TASK_VIEW,
        state: 'cancelled',
        phase: 'cancelled',
        source_collision: SOURCE_COLLISION,
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
