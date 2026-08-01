import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeRuntime } from '../../src/runtime.js';
import { createMcpServer } from '../../src/server.js';

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
      const instructionPrefix = client.getInstructions()?.slice(0, 512);
      expect(instructionPrefix).toContain('reasonix_delegate');
      expect(instructionPrefix).toContain('reasonix_control');
      expect(instructionPrefix).toContain('reasonix_inspect');
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

      const control = result.tools.find((tool) => tool.name === 'reasonix_control');
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
          error: { code: 'invalid_request' },
        });
      }
      expect(control).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('detects tuple-form array items as incompatible with Codex 0.146.0', () => {
    expect(() => assertCodex0146JsonSchema({ type: 'array', items: [{ type: 'string' }] })).toThrow(
      /items must be a JSON Schema object/,
    );
  });
});
