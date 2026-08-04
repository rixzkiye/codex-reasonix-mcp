import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import { errorEnvelope } from './errors.js';
import type { BridgeRuntime, RuntimeCallContext } from './runtime.js';
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

function runtimeContext(extra: Extra): RuntimeCallContext {
  const progressToken = extra._meta?.progressToken;
  let progress = 0;
  return {
    signal: extra.signal,
    ...(progressToken === undefined
      ? {}
      : {
          onProgress: async (message: string) => {
            progress += 1;
            await extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress, message },
              })
              .catch(() => undefined);
          },
        }),
  };
}

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
        'Use Reasonix only after explicit user approval. Tools: reasonix_delegate creates or resumes work, reasonix_control finalizes or recovers it, and reasonix_inspect is recovery-only. Default happy path: one reasonix_delegate waits for review, then one reasonix_control(finalize) waits for the commit; do not poll or steer. For trivial edits with already-verified local context, use one focused preflight and do not perform exploratory docs or memory lookup solely to construct the contract. write_scope is already an exclusive allowlist; never add a catch-all forbidden_scope that overlaps its concrete target. New tasks default to worker_lane=fast (direct edits, no Goal/AutoResearch/subagents); use deep only for long-horizon work. Choose the lowest adequate reasoning_effort (low is lowest) and a proportionate execution_timeout_seconds. A delegate wait timeout does not cancel the worker. Copy required_review_criteria into approved_review_criteria, review_revision into expected_review_revision, and review_tree_hash into expected_review_tree_hash for finalize. Delegate/finalize require codex/sandbox-state-meta. If finalize fails, keep the task at review, inspect/repair there, and finalize again with the new snapshot; never copy the diff manually into the source checkout or close the task. A completed task returns an isolated commit; cherry-pick it explicitly after review. Never push, merge, or publish.',
    },
  );

  server.registerTool(
    'reasonix_delegate',
    {
      title: 'Delegate a contract to Reasonix',
      description:
        'After explicit user approval, delegate one immutable TaskContractV1 to an isolated Reasonix edit worker. For a trivial edit whose local context is already verified, do one focused preflight and delegate directly; do not browse docs or memory solely to construct the contract. write_scope is the exclusive write allowlist and already denies every other path. forbidden_scope is only for sensitive carve-outs inside broader write scopes; never use **/* or another catch-all that matches a concrete write_scope target. Default wait_mode=review holds this call until review, interaction, failure, or timeout; a wait timeout is recoverable and does not cancel the worker. New tasks default to worker_lane=fast (direct edits; no Goal, AutoResearch, review/task skills, or subagents); use worker_lane=deep only for explicitly long-horizon delivery/goal work. Select the lowest reasoning_effort adequate for the task (low is the lowest supported). Set execution_timeout_seconds proportionately (fast default 600, deep default 3600, maximum 14400); omitted resumes retain the stored deadline. Use background only when the caller intentionally wants asynchronous recovery flow. Contract verification and allowed_commands run as exact static argv with no shell: sh -c/bash -c/eval, pipes, redirection, and inline interpreters are rejected. For byte-exact file content, use file_assertions instead of shell comparison commands.',
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
        return success(
          delegateOutputSchema.parse(
            await runtime.delegate(args, extra._meta, runtimeContext(extra)),
          ),
        );
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
        'Control a task created by reasonix_delegate. On the default happy path, call finalize once after reviewing the returned bundle; finalize waits for a committed terminal result. For finalize, copy review_revision to expected_review_revision and review_tree_hash to expected_review_tree_hash. finalize accepts any valid acceptance id in approved_review_criteria; automated ids are ignored for approval but every review-evidence criterion from required_review_criteria must be approved. If finalize fails, preserve the task at review, inspect or repair it there, then retry with the new snapshot; never copy the diff manually into the source checkout or close the task. Use respond, cancel, close, or steer only for explicit recovery or interaction handling. The returned commit is isolated and must be cherry-picked explicitly; this tool never merges or pushes.',
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
          controlOutputSchema.parse(
            await runtime.control(parseControlInput(args), extra._meta, runtimeContext(extra)),
          ),
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
        'Recovery-only bounded inspection of status, evidence, interactions, and optional paginated diff or event output. Events are opt-in. The default two-call happy path uses no inspect polling.',
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
