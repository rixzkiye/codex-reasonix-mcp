import path from 'node:path';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

import {
  assertPathInsideWorktree,
  isForbiddenPath,
  isWriteAllowed,
  normalizeRepositoryCwd,
  normalizeRepositoryPath,
  type TaskContractV1,
} from './contracts.js';
import { isCredentialPath, isGitControlPath } from './sensitive-paths.js';

export type PolicyDecision =
  | { action: 'allow'; optionId: string; reason: string }
  | { action: 'deny'; optionId?: string; reason: string }
  | { action: 'ask'; interactionKind: 'permission' | 'input'; canAllow: boolean; reason: string };

const GIT_COMMAND = /(?:^|[\\/])git(?:\.exe)?$/i;
const NETWORK_COMMAND = /^(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet)$/i;
const DESTRUCTIVE_COMMAND = /^(?:rm|rmdir|dd|mkfs(?:\..+)?|shred|diskutil|format)$/i;
const OPAQUE_COMMAND =
  /^(?:command|builtin|exec|eval|source|env|nohup|sudo|doas|sh|bash|dash|zsh|ksh|fish|pwsh|powershell|cmd(?:\.exe)?)$/i;

function optionId(params: RequestPermissionRequest, kind: 'allow' | 'reject'): string | undefined {
  const desired =
    kind === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  return params.options.find((option) => desired.includes(option.kind))?.optionId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawPaths(rawInput: unknown): string[] {
  const result: string[] = [];
  const visit = (value: unknown, key = '', depth = 0): void => {
    if (depth > 5) return;
    if (typeof value === 'string' && /^(?:path|file|target|source|destination)$/i.test(key)) {
      result.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
    }
  };
  visit(rawInput);
  return result;
}

function repositoryCwd(value: string, worktree: string): string | undefined {
  if (!path.isAbsolute(value)) return undefined;
  const relative = path.relative(worktree, value).replaceAll('\\', '/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  try {
    return normalizeRepositoryCwd(relative || '.');
  } catch {
    return undefined;
  }
}

function trustedReasonixCommand(
  params: RequestPermissionRequest,
  worktree: string,
): { argv: string[]; cwd: string } | undefined {
  const toolMeta = record(params.toolCall._meta);
  const reasonix = record(toolMeta?.['reasonix.io']);
  if (
    reasonix?.commandSchemaVersion !== 1 ||
    reasonix.tool !== 'bash' ||
    !Array.isArray(reasonix.argv) ||
    reasonix.argv.length === 0 ||
    !reasonix.argv.every((item) => typeof item === 'string') ||
    typeof reasonix.cwd !== 'string'
  ) {
    return undefined;
  }
  const cwd = repositoryCwd(reasonix.cwd, worktree);
  return cwd ? { argv: reasonix.argv, cwd } : undefined;
}

function repositoryPath(value: string, worktree: string): string | undefined {
  const candidate = value.replaceAll('\\', '/');
  if (path.isAbsolute(value)) {
    const relative = path.relative(worktree, value).replaceAll('\\', '/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return normalizeRepositoryPath(relative);
  }
  try {
    return normalizeRepositoryPath(candidate);
  } catch {
    return undefined;
  }
}

function permissionPaths(params: RequestPermissionRequest, worktree: string): string[] | undefined {
  const values = [
    ...(params.toolCall.locations ?? []).map((location) => location.path),
    ...rawPaths(params.toolCall.rawInput),
  ];
  if (values.length === 0) return [];
  const normalized = values.map((value) => repositoryPath(value, worktree));
  return normalized.some((value) => value === undefined)
    ? undefined
    : ([...new Set(normalized)] as string[]);
}

async function canonicalPermissionPaths(
  paths: string[],
  worktree: string,
): Promise<string[] | undefined> {
  try {
    return [
      ...new Set(
        await Promise.all(
          paths.map(async (candidate) => await assertPathInsideWorktree(worktree, candidate)),
        ),
      ),
    ];
  } catch {
    return undefined;
  }
}

function exactCommandAllowed(
  contract: TaskContractV1,
  command: { argv: string[]; cwd: string },
): boolean {
  let cwd: string;
  try {
    cwd = normalizeRepositoryCwd(command.cwd);
  } catch {
    return false;
  }
  return contract.verification.some(
    (verification) =>
      (verification.cwd ?? '.') === cwd &&
      JSON.stringify(verification.argv) === JSON.stringify(command.argv),
  );
}

export async function decidePermission(
  params: RequestPermissionRequest,
  contract: TaskContractV1,
  worktree: string,
): Promise<PolicyDecision> {
  const reject = optionId(params, 'reject');
  const allow = optionId(params, 'allow');
  if (params.toolCall.toolCallId.startsWith('ask-')) {
    return {
      action: 'ask',
      interactionKind: 'input',
      canAllow: true,
      reason: 'Reasonix requested user input',
    };
  }

  const kind = params.toolCall.kind;
  const paths = permissionPaths(params, worktree);
  if (paths === undefined) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Tool path escapes the isolated worktree',
    };
  }
  if (paths.some((candidate) => isGitControlPath(candidate))) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Git control paths are reserved for the supervisor',
    };
  }
  if (paths.some((candidate) => isCredentialPath(candidate))) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Credential paths are unavailable to delegated workers',
    };
  }
  const canonicalPaths = await canonicalPermissionPaths(paths, worktree);
  if (canonicalPaths === undefined) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Tool path cannot be resolved safely inside the isolated worktree',
    };
  }
  if (canonicalPaths.some((candidate) => isGitControlPath(candidate))) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Git control paths are reserved for the supervisor',
    };
  }
  if (canonicalPaths.some((candidate) => isCredentialPath(candidate))) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Credential paths are unavailable to delegated workers',
    };
  }
  if (canonicalPaths.some((candidate) => isForbiddenPath(contract, candidate))) {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Tool touches forbidden_scope; contract expansion requires a new task',
    };
  }

  if (kind === 'think') {
    return allow
      ? { action: 'allow', optionId: allow, reason: 'Non-side-effecting thought operation' }
      : { action: 'deny', ...(reject ? { optionId: reject } : {}), reason: 'No allow option' };
  }
  if (kind === 'read' || kind === 'search') {
    if (params.toolCall.rawInput === undefined && canonicalPaths.length === 0) {
      return {
        action: 'ask',
        interactionKind: 'permission',
        canAllow: false,
        reason: 'Read-only request lacks structured rawInput and locations',
      };
    }
    return allow
      ? { action: 'allow', optionId: allow, reason: 'Structured read-only operation in repository' }
      : { action: 'deny', ...(reject ? { optionId: reject } : {}), reason: 'No allow option' };
  }
  if (kind === 'edit') {
    if (
      params.toolCall.rawInput !== undefined &&
      canonicalPaths.length > 0 &&
      canonicalPaths.every((item) => isWriteAllowed(contract, item))
    ) {
      return allow
        ? { action: 'allow', optionId: allow, reason: 'Structured edit is inside write_scope' }
        : { action: 'deny', ...(reject ? { optionId: reject } : {}), reason: 'No allow option' };
    }
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Edit is ambiguous or outside write_scope',
    };
  }
  if (kind === 'delete' || kind === 'move') {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Destructive or move operations require Codex review and cannot expand the contract',
    };
  }
  if (kind === 'fetch') {
    return {
      action: 'ask',
      interactionKind: 'permission',
      canAllow: false,
      reason: 'Network access is never enabled by a task interaction',
    };
  }
  if (kind === 'execute') {
    const command = trustedReasonixCommand(params, worktree);
    if (!command) {
      return {
        action: 'ask',
        interactionKind: 'permission',
        canAllow: false,
        reason: 'Execute request lacks trusted static argv metadata from Reasonix',
      };
    }
    const executable = path.basename(command.argv[0] ?? '');
    if (
      GIT_COMMAND.test(command.argv[0] ?? '') ||
      NETWORK_COMMAND.test(executable) ||
      DESTRUCTIVE_COMMAND.test(executable) ||
      OPAQUE_COMMAND.test(executable)
    ) {
      return {
        action: 'ask',
        interactionKind: 'permission',
        canAllow: false,
        reason:
          'Git, network, destructive, and opaque wrapper commands are reserved for the supervisor',
      };
    }
    if (!exactCommandAllowed(contract, command)) {
      return {
        action: 'ask',
        interactionKind: 'permission',
        canAllow: false,
        reason: 'Command argv/cwd is not listed in contract verification',
      };
    }
    return allow
      ? { action: 'allow', optionId: allow, reason: 'Exact contract verification command' }
      : { action: 'deny', ...(reject ? { optionId: reject } : {}), reason: 'No allow option' };
  }
  return {
    action: 'ask',
    interactionKind: 'permission',
    canAllow: false,
    reason: `Unsupported or ambiguous tool kind: ${kind ?? 'unknown'}`,
  };
}
