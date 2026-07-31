import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { asBridgeError } from './errors.js';
import type { BridgeRuntime } from './runtime.js';
import { SANDBOX_META_KEY } from './sandbox.js';
import {
  controlInputSchema,
  delegateInputSchema,
  inspectInputSchema,
  toolOutputSchema,
} from './tool-schemas.js';
import { VERSION } from './version.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const bridgeError = asBridgeError(error);
  const value = {
    error: {
      code: bridgeError.code,
      message: bridgeError.message,
      ...(bridgeError.details ? { details: bridgeError.details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export function createMcpServer(runtime: BridgeRuntime): McpServer {
  const server = new McpServer(
    { name: 'reasonix_worker', version: VERSION },
    {
      capabilities: {
        experimental: { [SANDBOX_META_KEY]: {} },
      },
      instructions:
        'Codex supervises Reasonix through exactly three tools. Delegate and finalize require codex/sandbox-state-meta. The bridge never pushes or merges.',
    },
  );

  server.registerTool(
    'reasonix_delegate',
    {
      title: 'Delegate a contract to Reasonix',
      description:
        'Validate an immutable TaskContractV1, create an isolated worktree/session, and start Goal work asynchronously.',
      inputSchema: delegateInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra: Extra) => {
      try {
        return success(await runtime.delegate(args, extra._meta));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'reasonix_control',
    {
      title: 'Control a Reasonix task',
      description:
        'Steer, resolve an interaction, cancel, asynchronously finalize, or close one delegated task.',
      inputSchema: controlInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, extra: Extra) => {
      try {
        return success(await runtime.control(args, extra._meta));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'reasonix_inspect',
    {
      title: 'Inspect a Reasonix task',
      description:
        'Read bounded status, evidence, interactions, events, and optionally paginated diff output.',
      inputSchema: inspectInputSchema,
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return success(await runtime.inspect(args));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function serveStdio(runtime: BridgeRuntime): Promise<void> {
  await runtime.initialize();
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
