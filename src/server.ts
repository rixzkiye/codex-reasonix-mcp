import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { errorEnvelope } from './errors.js';
import type { BridgeRuntime } from './runtime.js';
import { SANDBOX_META_KEY } from './sandbox.js';
import {
  controlInputSchema,
  controlOutputSchema,
  delegateInputSchema,
  delegateOutputSchema,
  inspectInputSchema,
  inspectOutputSchema,
  parseControlInput,
  toolErrorEnvelopeSchema,
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
  const value = toolErrorEnvelopeSchema.parse({
    error: errorEnvelope(error),
  });
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
        'Use reasonix_delegate only after explicit user request or approval for Reasonix implementation. It creates an immutable TaskContractV1, isolated worktree/session, async execution, and supervised finalization; never substitute native Codex subagents for that work. Use native subagents for bounded parallel exploration, tests, triage, or summaries. reasonix_control manages a Reasonix task; reasonix_inspect reads bounded status/evidence. Delegate/finalize require codex/sandbox-state-meta. Never push or merge.',
    },
  );

  server.registerTool(
    'reasonix_delegate',
    {
      title: 'Delegate a contract to Reasonix',
      description:
        'Use only after explicit user request or approval for Reasonix implementation requiring an immutable TaskContractV1, isolated worktree/session, asynchronous execution, and supervised finalization. Never substitute native Codex subagents for approved Reasonix work; use native subagents for bounded parallel exploration, tests, triage, or summaries.',
      inputSchema: delegateInputSchema,
      outputSchema: delegateOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra: Extra) => {
      try {
        return success(delegateOutputSchema.parse(await runtime.delegate(args, extra._meta)));
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
        'Use only for a Reasonix task created by reasonix_delegate: steer, resolve an interaction, cancel, asynchronously finalize, or close it.',
      inputSchema: controlInputSchema,
      outputSchema: controlOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra: Extra) => {
      try {
        return success(
          controlOutputSchema.parse(await runtime.control(parseControlInput(args), extra._meta)),
        );
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
        'Use for a Reasonix task to read bounded status, evidence, interactions, events, and optionally paginated diff output.',
      inputSchema: inspectInputSchema,
      outputSchema: inspectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        return success(inspectOutputSchema.parse(await runtime.inspect(args)));
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
