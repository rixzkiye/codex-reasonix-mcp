import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { BridgeRuntime } from '../../src/runtime.js';
import { createMcpServer } from '../../src/server.js';

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
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual([
        'reasonix_delegate',
        'reasonix_control',
        'reasonix_inspect',
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
});
