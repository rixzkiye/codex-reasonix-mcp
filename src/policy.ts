import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

import {
  assertPathInsideWorktree,
  contractAllowedCommands,
  isForbiddenPath,
  isWriteAllowed,
  normalizeRepositoryCwd,
  normalizeRepositoryPath,
  type TaskContractV1,
} from './contracts.js';
import { isCredentialPath, isGitControlPath } from './sensitive-paths.js';

export interface StaticCommand {
  argv: [string, ...string[]];
  cwd: string;
  absoluteCwd: string;
}

export type PolicyDecision =
  | { action: 'allow'; optionId: string; reason: string; timeoutSeconds?: number }
  | {
      action: 'deny';
      optionId?: string;
      reason: string;
      fingerprint: string;
      recoveryHint: string;
    }
  | { action: 'ask'; interactionKind: 'input'; canAllow: true; reason: string };

export type CommandClassification =
  | { action: 'allow'; reason: string; timeoutSeconds: number }
  | { action: 'deny'; code: string; reason: string; recoveryHint: string };
type CommandDenial = Extract<CommandClassification, { action: 'deny' }>;

const NETWORK_EXECUTABLES = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'telnet',
  'rsync',
]);
const PRIVILEGED_EXECUTABLES = new Set(['sudo', 'doas', 'su', 'pkexec']);
const DESTRUCTIVE_EXECUTABLES = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'ln',
  'tee',
  'dd',
  'mkfs',
  'shred',
  'diskutil',
  'format',
  'unlink',
  'truncate',
]);
const SHELL_EXECUTABLES = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'cmd.exe',
  'eval',
  'exec',
  'source',
  'command',
  'builtin',
  'nohup',
]);
const INLINE_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'lua',
  'deno',
  'bun',
]);
const PACKAGE_MANAGERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'corepack',
  'cargo',
  'go',
  'make',
  'cmake',
  'gradle',
  'gradlew',
  'mvn',
]);
const PACKAGE_NETWORK_ACTIONS = new Set([
  'add',
  'install',
  'i',
  'update',
  'upgrade',
  'up',
  'outdated',
  'search',
  'view',
  'info',
  'dlx',
  'create',
  'init',
  'login',
  'logout',
  'whoami',
]);
const PUBLISH_ACTIONS = new Set([
  'publish',
  'release',
  'deploy',
  'dist-tag',
  'tag',
  'unpublish',
  'deprecate',
  'owner',
  'access',
]);
const READ_EXECUTABLES = new Set([
  'cat',
  'ls',
  'rg',
  'sed',
  'find',
  'head',
  'tail',
  'wc',
  'cut',
  'sort',
  'uniq',
  'stat',
  'file',
  'pwd',
  'tree',
  'du',
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'show',
  'log',
  'rev-parse',
  'rev-list',
  'diff-tree',
  'diff-index',
  'ls-files',
  'ls-tree',
  'cat-file',
  'name-rev',
  'describe',
  'merge-base',
  'show-ref',
  'symbolic-ref',
  'grep',
]);
const UNSAFE_GIT_OPTIONS = [
  /^-c$/,
  /^--config-env(?:=|$)/,
  /^--exec-path(?:=|$)/,
  /^--git-dir(?:=|$)/,
  /^--work-tree(?:=|$)/,
  /^--namespace(?:=|$)/,
  /^--output(?:=|$)/,
  /^--ext-diff$/,
  /^--textconv$/,
  /^--no-index$/,
  /^--notes(?:=|$)/,
];
const SAFE_ENV_NAME = /^(?:CI|NO_COLOR|FORCE_COLOR|NODE_ENV|TZ|LANG|LANGUAGE|LC_[A-Z0-9_]+)$/;

function basename(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.exe$/i, '');
}

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
    if (typeof value === 'string' && /^(?:path|file|target|source|destination|cwd)$/i.test(key)) {
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

function repositoryPath(value: string, worktree: string): string | undefined {
  if (path.isAbsolute(value)) {
    const relative = path.relative(worktree, value).replaceAll('\\', '/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    if (relative === '') return '.';
    try {
      return normalizeRepositoryPath(relative);
    } catch {
      return undefined;
    }
  }
  try {
    return normalizeRepositoryPath(value.replaceAll('\\', '/'));
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
          paths
            .filter((candidate) => candidate !== '.')
            .map(async (candidate) => await assertPathInsideWorktree(worktree, candidate)),
        ),
      ),
    ];
  } catch {
    return undefined;
  }
}

function denial(
  params: RequestPermissionRequest,
  code: string,
  reason: string,
  recoveryHint: string,
): PolicyDecision {
  const reject = optionId(params, 'reject');
  const reasonix = record(record(params.toolCall._meta)?.['reasonix.io']);
  const subject = createHash('sha256')
    .update(
      JSON.stringify({
        kind: params.toolCall.kind ?? 'unknown',
        code,
        argv: Array.isArray(reasonix?.argv) ? reasonix.argv : undefined,
        cwd: typeof reasonix?.cwd === 'string' ? reasonix.cwd : undefined,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    action: 'deny',
    ...(reject ? { optionId: reject } : {}),
    reason,
    fingerprint: `${code}:${subject}`,
    recoveryHint,
  };
}

function invalidMetadata(reason: string): CommandDenial {
  return {
    action: 'deny',
    code: 'metadata_invalid',
    reason,
    recoveryHint:
      'Retry using Reasonix bash permission metadata with commandSchemaVersion=1, tool=bash, a non-empty static argv array, and the exact absolute worktree cwd.',
  };
}

/** Parses only the private, non-model-controlled static command extension. */
export async function parseStaticCommand(
  params: RequestPermissionRequest,
  worktree: string,
): Promise<StaticCommand | CommandDenial> {
  const toolMeta = record(params.toolCall._meta);
  const reasonix = record(toolMeta?.['reasonix.io']);
  if (!reasonix) return invalidMetadata('Execute request lacks _meta.reasonix.io');
  if (reasonix.commandSchemaVersion !== 1 || reasonix.tool !== 'bash') {
    return invalidMetadata('Execute metadata is not the supported static argv v1 bash schema');
  }
  if (
    !Array.isArray(reasonix.argv) ||
    reasonix.argv.length === 0 ||
    reasonix.argv.length > 128 ||
    !reasonix.argv.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= 4_096 && !item.includes('\0'),
    ) ||
    typeof reasonix.cwd !== 'string' ||
    !path.isAbsolute(reasonix.cwd)
  ) {
    return invalidMetadata('Execute metadata has malformed argv or cwd');
  }
  if (reasonix.approvalId !== undefined && reasonix.approvalId !== params.toolCall.toolCallId) {
    return invalidMetadata('Execute metadata approvalId does not match the ACP toolCallId');
  }
  const raw = record(params.toolCall.rawInput);
  if (
    raw?.cwd !== undefined &&
    (typeof raw.cwd !== 'string' || path.resolve(raw.cwd) !== path.resolve(reasonix.cwd))
  ) {
    return invalidMetadata('Execute metadata cwd does not match the ACP command subject');
  }
  if (
    raw?.argv !== undefined &&
    (!Array.isArray(raw.argv) || JSON.stringify(raw.argv) !== JSON.stringify(reasonix.argv))
  ) {
    return invalidMetadata('Execute metadata argv does not match the ACP command subject');
  }
  let canonicalWorktree: string;
  let canonicalCwd: string;
  try {
    [canonicalWorktree, canonicalCwd] = await Promise.all([
      realpath(worktree),
      realpath(reasonix.cwd),
    ]);
  } catch {
    return invalidMetadata('Execute metadata cwd does not resolve to an existing directory');
  }
  const relative = path.relative(canonicalWorktree, canonicalCwd).replaceAll('\\', '/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      action: 'deny',
      code: 'cwd_escape',
      reason: 'Command cwd escapes the isolated worktree',
      recoveryHint: 'Run the command from a cwd inside the task worktree.',
    };
  }
  return {
    argv: reasonix.argv as [string, ...string[]],
    cwd: normalizeRepositoryCwd(relative || '.', 'command.cwd'),
    absoluteCwd: canonicalCwd,
  };
}

function hasUnsafePathArgument(argv: readonly string[]): boolean {
  return argv.slice(1).some((argument) => {
    if (argument.includes('\0')) return true;
    const equals = argument.indexOf('=');
    const candidate = equals > 0 ? argument.slice(equals + 1) : argument;
    if (isCredentialPath(candidate.replaceAll('\\', '/'))) return true;
    if (!path.isAbsolute(candidate)) return candidate.split(/[\\/]/).includes('..');
    return true;
  });
}

function readCommandSafe(argv: readonly [string, ...string[]]): boolean {
  const executable = basename(argv[0]);
  if (hasUnsafePathArgument(argv)) return false;
  if (executable === 'sed') {
    if (argv.some((arg) => arg === '-i' || arg.startsWith('--in-place') || /^-i.+/.test(arg))) {
      return false;
    }
    const scripts: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
      const item = argv[index]!;
      if (item === '-n' || item === '--quiet' || item === '--silent') continue;
      if (item === '-e' || item === '--expression') {
        const script = argv[++index];
        if (!script) return false;
        scripts.push(script);
        continue;
      }
      if (!item.startsWith('-') && scripts.length === 0) scripts.push(item);
    }
    return (
      scripts.length > 0 &&
      scripts.every((script) => /^\s*(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*p?\s*$/.test(script))
    );
  }
  if (executable === 'find') {
    return !argv.some((arg) =>
      /^(?:-delete|-exec|-execdir|-ok|-okdir|-fls|-fprint|-fprint0|-fprintf)$/.test(arg),
    );
  }
  if (executable === 'rg') {
    return !argv.some((arg) =>
      /^(?:--pre|--pre-glob|--hostname-bin|--hyperlink-format)(?:=|$)/.test(arg),
    );
  }
  if (executable === 'sort') {
    return !argv.some((arg) => arg === '-o' || arg.startsWith('--output='));
  }
  if (executable === 'tail') return !argv.includes('-F') && !argv.includes('--follow=name');
  return READ_EXECUTABLES.has(executable);
}

function gitCommandSafe(argv: readonly [string, ...string[]]): boolean {
  let index = 1;
  if (argv[index] === '--no-pager') index += 1;
  const subcommand = argv[index];
  if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
  const rest = argv.slice(index + 1);
  if (rest.some((arg) => UNSAFE_GIT_OPTIONS.some((pattern) => pattern.test(arg)))) return false;
  if (subcommand === 'symbolic-ref') {
    if (rest.includes('--delete')) return false;
    if (rest.filter((arg) => !arg.startsWith('-')).length !== 1) return false;
  }
  if (subcommand === 'cat-file' && rest.some((arg) => arg.startsWith('--filters'))) return false;
  return !hasUnsafePathArgument([argv[0], ...rest]);
}

function unwrapRestrictedEnv(
  argv: readonly [string, ...string[]],
): readonly [string, ...string[]] | undefined {
  const command: string[] = [];
  let commandStarted = false;
  for (const item of argv.slice(1)) {
    if (!commandStarted && item === '--') {
      commandStarted = true;
      continue;
    }
    if (!commandStarted && item.includes('=')) {
      const equals = item.indexOf('=');
      const name = item.slice(0, equals);
      const value = item.slice(equals + 1);
      if (!SAFE_ENV_NAME.test(name) || value.length > 1_024 || value.includes('\0'))
        return undefined;
      continue;
    }
    if (!commandStarted && item.startsWith('-')) return undefined;
    commandStarted = true;
    command.push(item);
  }
  return command.length > 0 ? (command as [string, ...string[]]) : undefined;
}

function exactContractCommand(
  contract: TaskContractV1,
  argv: readonly string[],
  cwd: string,
): { timeoutSeconds: number; verification: boolean } | undefined {
  const verificationIds = new Set(contract.verification.map((command) => command.id));
  const match = contractAllowedCommands(contract).find(
    (command) =>
      (command.cwd ?? '.') === cwd && JSON.stringify(command.argv) === JSON.stringify(argv),
  );
  return match
    ? {
        timeoutSeconds: match.timeout_seconds ?? 120,
        verification: verificationIds.has(match.id),
      }
    : undefined;
}

function hardDenial(argv: readonly [string, ...string[]]): CommandDenial | undefined {
  const executable = basename(argv[0]);
  const action = argv[1]?.toLowerCase();
  const deny = (code: string, reason: string, recoveryHint: string): CommandDenial => ({
    action: 'deny',
    code,
    reason,
    recoveryHint,
  });
  if (executable === 'gh') {
    return deny(
      'remote_access',
      'GitHub CLI and remote mutation are reserved for Codex',
      'Use a structured repository tool or ask Codex to perform the remote operation.',
    );
  }
  if (NETWORK_EXECUTABLES.has(executable)) {
    return deny(
      'network_access',
      'Network and remote-access commands are forbidden',
      'Continue with local repository evidence only.',
    );
  }
  if (PRIVILEGED_EXECUTABLES.has(executable)) {
    return deny(
      'privilege_escalation',
      'Privilege escalation is forbidden',
      'Use only unprivileged commands inside the task worktree.',
    );
  }
  if (DESTRUCTIVE_EXECUTABLES.has(executable)) {
    return deny(
      'destructive_filesystem',
      'Destructive filesystem commands are forbidden',
      'Use a structured edit inside write_scope.',
    );
  }
  if (SHELL_EXECUTABLES.has(executable)) {
    return deny(
      'shell_eval',
      'Shell, eval, and opaque command wrappers are forbidden',
      'Submit a direct static argv command without a shell.',
    );
  }
  if (
    INLINE_INTERPRETERS.has(executable) &&
    argv.some((arg) => /^(?:-e|-c)(?:$|[^-])|^--(?:eval|print)(?:=|$)/.test(arg))
  ) {
    return deny(
      'inline_code',
      'Inline-code interpreter execution is forbidden',
      'Use a checked-in project script listed exactly in the task contract.',
    );
  }
  if (PUBLISH_ACTIONS.has(action ?? '')) {
    return deny(
      'publish_release',
      'Publish, release, deploy, and registry mutation are forbidden',
      'Leave release and remote operations to Codex.',
    );
  }
  if (
    PACKAGE_MANAGERS.has(executable) &&
    (action === 'run' || action === 'run-script') &&
    PUBLISH_ACTIONS.has(argv[2]?.toLowerCase() ?? '')
  ) {
    return deny(
      'publish_release',
      'Publish, release, and deploy project scripts are forbidden',
      'Leave release and remote operations to Codex.',
    );
  }
  if (PACKAGE_MANAGERS.has(executable) && PACKAGE_NETWORK_ACTIONS.has(action ?? '')) {
    return deny(
      'network_access',
      'Dependency-changing or registry-reading package commands are forbidden',
      'Use the existing lockfile and local project scripts.',
    );
  }
  if (hasUnsafePathArgument(argv)) {
    return deny(
      'path_escape',
      'Command argv references a credential or path outside the worktree',
      'Use repository-relative, non-sensitive paths only.',
    );
  }
  return undefined;
}

/** Pure, table-friendly static argv classification after metadata/cwd validation. */
export function classifyStaticCommand(
  command: Pick<StaticCommand, 'argv' | 'cwd'>,
  contract: TaskContractV1,
): CommandClassification {
  const hard = hardDenial(command.argv);
  if (hard) return hard;
  const executable = basename(command.argv[0]);
  if (executable === 'git') {
    return gitCommandSafe(command.argv)
      ? { action: 'allow', reason: 'Sanitized Git read-only command', timeoutSeconds: 120 }
      : {
          action: 'deny',
          code: 'git_mutation',
          reason:
            'Git mutation, ref/history change, unsafe output, or unsanitized Git usage is forbidden',
          recoveryHint: 'Use a sanitized Git read-only subcommand or a structured repository tool.',
        };
  }
  if (READ_EXECUTABLES.has(executable)) {
    return readCommandSafe(command.argv)
      ? { action: 'allow', reason: 'Audited read-only command', timeoutSeconds: 120 }
      : {
          action: 'deny',
          code: 'unsafe_read_command',
          reason: 'Read command includes a write-capable, executable, or unsafe option',
          recoveryHint: 'Use the narrowly audited read-only form or a structured read/search tool.',
        };
  }
  if (executable === 'env') {
    const inner = unwrapRestrictedEnv(command.argv);
    if (!inner) {
      return {
        action: 'deny',
        code: 'env_injection',
        reason: 'env wrapper contains an unsafe option or environment assignment',
        recoveryHint:
          'Use only CI, color, locale, timezone, or NODE_ENV assignments and an exact contract command.',
      };
    }
    const innerHard = hardDenial(inner);
    if (innerHard) return innerHard;
  }
  const exact = exactContractCommand(contract, command.argv, command.cwd);
  if (exact) {
    return {
      action: 'allow',
      reason: exact.verification
        ? 'Exact contract verification command'
        : 'Exact contract allowed command',
      timeoutSeconds: exact.timeoutSeconds,
    };
  }
  return {
    action: 'deny',
    code: 'unknown_executable',
    reason: `Executable is not an audited read command or exact contract command: ${executable || '<empty>'}`,
    recoveryHint:
      'Use a structured tool, or ask Codex to create a new immutable contract with the exact argv and cwd.',
  };
}

export async function decidePermission(
  params: RequestPermissionRequest,
  contract: TaskContractV1,
  worktree: string,
): Promise<PolicyDecision> {
  const allow = optionId(params, 'allow');
  if (params.toolCall.toolCallId.startsWith('ask-') && params.toolCall.kind === 'other') {
    return {
      action: 'ask',
      interactionKind: 'input',
      canAllow: true,
      reason: 'Reasonix requested user input',
    };
  }

  const paths = permissionPaths(params, worktree);
  if (paths === undefined) {
    return denial(
      params,
      'path_escape',
      'Tool path escapes the isolated worktree',
      'Use only paths inside the task worktree.',
    );
  }
  if (paths.some((candidate) => isGitControlPath(candidate))) {
    return denial(
      params,
      'git_control_path',
      'Git control paths are reserved for the supervisor',
      'Use a sanitized Git read-only command instead.',
    );
  }
  if (paths.some((candidate) => isCredentialPath(candidate))) {
    return denial(
      params,
      'credential_path',
      'Credential paths are unavailable to delegated workers',
      'Continue without reading or writing credential material.',
    );
  }
  const canonicalPaths = await canonicalPermissionPaths(paths, worktree);
  if (canonicalPaths === undefined) {
    return denial(
      params,
      'path_resolution',
      'Tool path cannot be resolved safely inside the isolated worktree',
      'Use an existing repository-relative path without symlink escape.',
    );
  }
  if (canonicalPaths.some((candidate) => isGitControlPath(candidate))) {
    return denial(
      params,
      'git_control_path',
      'Git control paths are reserved for the supervisor',
      'Use a sanitized Git read-only command instead.',
    );
  }
  if (canonicalPaths.some((candidate) => isCredentialPath(candidate))) {
    return denial(
      params,
      'credential_path',
      'Credential paths are unavailable to delegated workers',
      'Continue without reading or writing credential material.',
    );
  }
  if (canonicalPaths.some((candidate) => isForbiddenPath(contract, candidate))) {
    return denial(
      params,
      'forbidden_scope',
      'Tool touches forbidden_scope; contract expansion requires a new task',
      'Stay inside the immutable contract or ask Codex to create a new task.',
    );
  }

  const kind = params.toolCall.kind;
  if (kind === 'think') {
    return allow
      ? { action: 'allow', optionId: allow, reason: 'Non-side-effecting thought operation' }
      : denial(
          params,
          'missing_allow_option',
          'No allow_once option was offered',
          'Retry with a standard ACP allow_once option.',
        );
  }
  if (kind === 'read' || kind === 'search') {
    if (params.toolCall.rawInput === undefined && canonicalPaths.length === 0) {
      return denial(
        params,
        'ambiguous_read',
        'Read-only request lacks structured rawInput and locations',
        'Use a structured read/search request with explicit repository paths.',
      );
    }
    return allow
      ? { action: 'allow', optionId: allow, reason: 'Structured read-only operation in repository' }
      : denial(
          params,
          'missing_allow_option',
          'No allow_once option was offered',
          'Retry with a standard ACP allow_once option.',
        );
  }
  if (kind === 'edit') {
    if (
      params.toolCall.rawInput !== undefined &&
      canonicalPaths.length > 0 &&
      canonicalPaths.every((item) => isWriteAllowed(contract, item))
    ) {
      return allow
        ? { action: 'allow', optionId: allow, reason: 'Structured edit is inside write_scope' }
        : denial(
            params,
            'missing_allow_option',
            'No allow_once option was offered',
            'Retry with a standard ACP allow_once option.',
          );
    }
    return denial(
      params,
      'write_scope',
      'Edit is ambiguous or outside write_scope',
      'Use a structured edit wholly inside write_scope.',
    );
  }
  if (kind === 'execute') {
    const parsed = await parseStaticCommand(params, worktree);
    if ('action' in parsed) {
      return denial(params, parsed.code, parsed.reason, parsed.recoveryHint);
    }
    const classified = classifyStaticCommand(parsed, contract);
    if (classified.action === 'deny') {
      return denial(params, classified.code, classified.reason, classified.recoveryHint);
    }
    return allow
      ? {
          action: 'allow',
          optionId: allow,
          reason: classified.reason,
          timeoutSeconds: classified.timeoutSeconds,
        }
      : denial(
          params,
          'missing_allow_option',
          'No allow_once option was offered',
          'Retry with a standard ACP allow_once option.',
        );
  }
  const reason =
    kind === 'fetch'
      ? 'Network access is forbidden'
      : kind === 'delete' || kind === 'move'
        ? 'Destructive and move operations are forbidden'
        : `Unsupported or ambiguous tool kind: ${kind ?? 'unknown'}`;
  return denial(
    params,
    `tool_kind_${kind ?? 'unknown'}`,
    reason,
    'Use a structured read/edit tool or an audited static command inside the immutable contract.',
  );
}
