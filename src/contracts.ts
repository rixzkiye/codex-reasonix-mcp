import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import picomatch from 'picomatch';
import { z } from 'zod';

import { BridgeError } from './errors.js';

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/);
const textSchema = z.string().trim().min(1).max(20_000);

export const acceptanceCriterionSchema = z
  .object({
    id: idSchema,
    requirement: textSchema,
    evidence: z.enum(['automated', 'review']),
  })
  .strict();

export const verificationCommandSchema = z
  .object({
    id: idSchema,
    argv: z
      .tuple([z.string().min(1).max(4_096)])
      .rest(z.string().max(4_096))
      .refine((v) => v.length <= 128),
    cwd: z.string().max(1_024).optional(),
    timeout_seconds: z.number().int().min(1).max(1_800).optional(),
    proves: z.array(idSchema).min(1).max(256),
  })
  .strict();

export const allowedCommandSchema = z
  .object({
    id: idSchema,
    argv: z
      .tuple([z.string().min(1).max(4_096)])
      .rest(z.string().max(4_096))
      .refine((value) => value.length <= 128),
    cwd: z.string().max(1_024).optional(),
    timeout_seconds: z.number().int().min(1).max(1_800).optional(),
  })
  .strict();

export const fileAssertionSchema = z
  .object({
    id: idSchema,
    path: z.string().min(1).max(1_024),
    // Meaning is exact UTF-8 bytes, including the trailing newline; never trimmed.
    expected_utf8: z.string().max(64 * 1024),
    proves: z.array(idSchema).min(1).max(256),
  })
  .strict();

export type FileAssertion = z.infer<typeof fileAssertionSchema>;

export const taskContractSchema = z
  .object({
    schema_version: z.literal(1),
    objective: textSchema,
    user_outcome: textSchema,
    verified_context: z
      .array(z.object({ path: z.string().min(1).max(1_024), reason: textSchema }).strict())
      .max(1_000)
      .default([]),
    write_scope: z
      .array(z.string().min(1).max(1_024))
      .min(1)
      .max(1_000)
      .describe(
        'Exclusive repository-relative write allowlist; every path not listed is already denied.',
      ),
    forbidden_scope: z
      .array(z.string().min(1).max(1_024))
      .max(1_000)
      .default([])
      .describe(
        'Optional sensitive carve-outs inside broader write scopes; never use a catch-all pattern that matches a concrete write_scope target.',
      ),
    invariants: z.array(textSchema).max(1_000).default([]),
    non_goals: z.array(textSchema).max(1_000).default([]),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1).max(1_000),
    verification: z.array(verificationCommandSchema).max(256),
    allowed_commands: z.array(allowedCommandSchema).max(256).optional(),
    file_assertions: z.array(fileAssertionSchema).max(256).optional(),
    pause_conditions: z.array(textSchema).max(1_000).default([]),
  })
  .strict();

export type TaskContractV1 = z.infer<typeof taskContractSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;
export type AllowedCommand = z.infer<typeof allowedCommandSchema>;

export interface ContractLintIssue {
  path: string;
  message: string;
}

export type ContractPathBase = 'cwd' | 'repository';

export interface ContractPathContext {
  invocationCwd: string;
  repositoryRoot: string;
  pathBase: ContractPathBase;
}

function normalizeRelative(value: string, allowDot: boolean, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new BridgeError(
      'invalid_contract',
      `${field} must be a non-empty repository-relative path`,
    );
  }
  if (
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    throw new BridgeError('invalid_contract', `${field} must not be absolute: ${value}`);
  }
  if (trimmed.startsWith('!')) {
    throw new BridgeError('invalid_contract', `${field} must not use negated globs: ${value}`);
  }
  const posix = trimmed.replaceAll('\\', '/');
  const segments = posix.split('/');
  if (segments.includes('..')) {
    throw new BridgeError('invalid_contract', `${field} must not contain '..': ${value}`);
  }
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (!normalized && !allowDot) {
    throw new BridgeError('invalid_contract', `${field} must not resolve to repository root`);
  }
  return normalized || '.';
}

export function normalizeRepositoryPath(value: string, field = 'path'): string {
  return normalizeRelative(value, false, field);
}

export function normalizeVerifiedContextPath(
  value: string,
  field = 'verified_context.path',
): string {
  return normalizeRelative(value, true, field);
}

export function normalizeRepositoryCwd(value = '.', field = 'verification.cwd'): string {
  return normalizeRelative(value, true, field);
}

function commandKey(
  command: {
    argv: readonly string[];
    cwd?: string;
    timeout_seconds?: number;
  },
  defaultTimeout: number,
): string {
  return JSON.stringify([
    command.argv,
    normalizeRepositoryCwd(command.cwd),
    command.timeout_seconds ?? defaultTimeout,
  ]);
}

function crossCommandKey(command: {
  argv: readonly string[];
  cwd?: string;
  timeout_seconds?: number;
}): string {
  return JSON.stringify([
    command.argv,
    normalizeRepositoryCwd(command.cwd),
    command.timeout_seconds,
  ]);
}

function deduplicateCommands<T extends { id: string; argv: readonly string[]; cwd?: string }>(
  commands: readonly T[],
  defaultTimeout: number,
  includeEvidence = false,
): T[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.id}\0${commandKey(command, defaultTimeout)}${
      includeEvidence && 'proves' in command
        ? `\0${JSON.stringify((command as T & { proves: readonly string[] }).proves)}`
        : ''
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseTaskContract(input: unknown): TaskContractV1 {
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    throw new BridgeError('invalid_contract', 'TaskContractV1 validation failed', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const semanticIssues = lintRawTaskContract(parsed.data);
  if (semanticIssues.length > 0) {
    throw new BridgeError(
      'invalid_contract',
      `TaskContractV1 validation failed: ${semanticIssues.map((issue) => issue.message).join('; ')}`,
      {
        issues: semanticIssues,
      },
    );
  }

  const verification = deduplicateCommands(parsed.data.verification, 600, true).map((item) => ({
    ...item,
    cwd: normalizeRepositoryCwd(item.cwd),
    timeout_seconds: item.timeout_seconds ?? 600,
  }));
  const verificationInputKeys = new Set(
    parsed.data.verification.map((item) => `${item.id}\0${crossCommandKey(item)}`),
  );
  const allowedCommands = deduplicateCommands(parsed.data.allowed_commands ?? [], 120)
    .filter((item) => !verificationInputKeys.has(`${item.id}\0${crossCommandKey(item)}`))
    .map((item) => ({
      id: item.id,
      argv: item.argv,
      cwd: normalizeRepositoryCwd(item.cwd, 'allowed_commands.cwd'),
      timeout_seconds: item.timeout_seconds ?? 120,
    }));

  const fileAssertions = deduplicateFileAssertions(parsed.data.file_assertions ?? []).map(
    (item) => ({
      ...item,
      path: normalizeRepositoryPath(item.path, 'file_assertions.path'),
    }),
  );

  const contract: TaskContractV1 = {
    ...parsed.data,
    verified_context: parsed.data.verified_context.map((item) => ({
      ...item,
      path: normalizeVerifiedContextPath(item.path),
    })),
    write_scope: parsed.data.write_scope.map((item) =>
      normalizeRepositoryPath(item, 'write_scope'),
    ),
    forbidden_scope: parsed.data.forbidden_scope.map((item) =>
      normalizeRepositoryPath(item, 'forbidden_scope'),
    ),
    verification,
    ...(parsed.data.allowed_commands
      ? {
          allowed_commands: allowedCommands,
        }
      : {}),
    ...(parsed.data.file_assertions
      ? {
          file_assertions: fileAssertions,
        }
      : {}),
  };
  return contract;
}

function deduplicateFileAssertions(assertions: readonly FileAssertion[]): FileAssertion[] {
  const seen = new Set<string>();
  return assertions.filter((assertion) => {
    const key = `${assertion.id}\0${assertion.path}\0${Buffer.byteLength(assertion.expected_utf8)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prefixContractPath(
  value: string,
  prefix: string,
  allowDot: boolean,
  field: string,
): string {
  if (prefix === '.') return normalizeRelative(value, allowDot, field);
  const normalized = normalizeRelative(value, allowDot, field);
  return normalizeRelative(
    normalized === '.' ? prefix : `${prefix}/${normalized}`,
    allowDot,
    field,
  );
}

/**
 * Converts task paths from the MCP invocation cwd into repository-relative paths.
 * Omitting this step preserves the repository-root semantics of persisted v1/v2 tasks.
 */
export function normalizeContractPaths(
  contract: TaskContractV1,
  context: ContractPathContext,
): TaskContractV1 {
  if (context.pathBase === 'repository') return contract;
  let root: string;
  let invocation: string;
  try {
    root = realpathSync.native(context.repositoryRoot);
    invocation = realpathSync.native(context.invocationCwd);
  } catch {
    throw new BridgeError(
      'invalid_request',
      'Invocation cwd and repository root must resolve before path normalization',
    );
  }
  const relative = path.relative(root, invocation).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new BridgeError('invalid_request', 'Invocation cwd must be inside the repository root', {
      invocationCwd: context.invocationCwd,
      repositoryRoot: context.repositoryRoot,
    });
  }
  const prefix = normalizeRepositoryCwd(relative || '.', 'invocation cwd');
  return {
    ...contract,
    verified_context: contract.verified_context.map((item) => ({
      ...item,
      path: prefixContractPath(item.path, prefix, true, 'verified_context.path'),
    })),
    write_scope: contract.write_scope.map((item) =>
      prefixContractPath(item, prefix, false, 'write_scope'),
    ),
    forbidden_scope: contract.forbidden_scope.map((item) =>
      prefixContractPath(item, prefix, false, 'forbidden_scope'),
    ),
    verification: contract.verification.map((item) => ({
      ...item,
      cwd: prefixContractPath(item.cwd ?? '.', prefix, true, 'verification.cwd'),
    })),
    ...(contract.allowed_commands
      ? {
          allowed_commands: contract.allowed_commands.map((item) => ({
            ...item,
            cwd: prefixContractPath(item.cwd ?? '.', prefix, true, 'allowed_commands.cwd'),
          })),
        }
      : {}),
    ...(contract.file_assertions
      ? {
          file_assertions: contract.file_assertions.map((item) => ({
            ...item,
            path: prefixContractPath(item.path, prefix, false, 'file_assertions.path'),
          })),
        }
      : {}),
  };
}

export function parseTaskContractForInvocation(
  input: unknown,
  context: ContractPathContext,
): TaskContractV1 {
  return normalizeContractPaths(parseTaskContract(input), context);
}

function zodIssues(error: z.ZodError): ContractLintIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '$',
    message: issue.message,
  }));
}

function lintDuplicateIds(
  values: Array<{ id: string }>,
  field: string,
  issues: ContractLintIssue[],
  identity?: (value: { id: string }) => string,
): void {
  const seen = new Map<string, string>();
  values.forEach((value, index) => {
    const lintIndex = (value as { _lintIndex?: number })._lintIndex;
    const prior = seen.get(value.id);
    const current = identity?.(value) ?? JSON.stringify(index);
    if (prior !== undefined && (!identity || prior !== current)) {
      issues.push({
        path: `${field}.${typeof lintIndex === 'number' ? String(lintIndex) : String(index)}.id`,
        message: `${identity ? 'Conflicting' : 'Duplicate'} id: ${value.id}`,
      });
    }
    if (prior === undefined) seen.set(value.id, current);
  });
}

function lintPath(
  value: string | undefined,
  allowDot: boolean,
  field: string,
  issues: ContractLintIssue[],
): void {
  try {
    normalizeRelative(value ?? '.', allowDot, field);
  } catch (error) {
    issues.push({
      path: field,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Returns every schema and semantic contract problem that can be evaluated safely. */
export function lintTaskContract(input: unknown): ContractLintIssue[] {
  const parsed = taskContractSchema.safeParse(input);
  if (parsed.success) return lintRawTaskContract(parsed.data);

  return [...zodIssues(parsed.error), ...lintRawTaskContract(input)];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function idRecords(
  value: unknown,
): Array<Record<string, unknown> & { id: string; _lintIndex: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const item = objectRecord(candidate);
    return typeof item?.id === 'string' ? [{ ...item, id: item.id, _lintIndex: index }] : [];
  });
}

function lintCommandIdentity(
  value: Record<string, unknown>,
  defaultTimeout: number,
  includeEvidence: boolean,
): string {
  if (
    !Array.isArray(value.argv) ||
    !value.argv.every((argument) => typeof argument === 'string') ||
    (value.cwd !== undefined && typeof value.cwd !== 'string') ||
    (value.timeout_seconds !== undefined && typeof value.timeout_seconds !== 'number')
  ) {
    return JSON.stringify(value);
  }
  let key: string;
  try {
    key = commandKey(
      {
        argv: value.argv,
        ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
        ...(typeof value.timeout_seconds === 'number'
          ? { timeout_seconds: value.timeout_seconds }
          : {}),
      },
      defaultTimeout,
    );
  } catch {
    key = JSON.stringify(value);
  }
  return includeEvidence ? `${key}\0${JSON.stringify(value.proves)}` : key;
}

function lintCrossCommandIdentity(value: Record<string, unknown>): string {
  if (
    !Array.isArray(value.argv) ||
    !value.argv.every((argument) => typeof argument === 'string') ||
    (value.cwd !== undefined && typeof value.cwd !== 'string') ||
    (value.timeout_seconds !== undefined && typeof value.timeout_seconds !== 'number')
  ) {
    return JSON.stringify(value);
  }
  try {
    return crossCommandKey({
      argv: value.argv,
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
      ...(typeof value.timeout_seconds === 'number'
        ? { timeout_seconds: value.timeout_seconds }
        : {}),
    });
  } catch {
    return JSON.stringify(value);
  }
}

function lintRawTaskContract(input: unknown): ContractLintIssue[] {
  const contract = objectRecord(input);
  if (!contract) return [];
  const issues: ContractLintIssue[] = [];
  if (Array.isArray(contract.verified_context)) {
    contract.verified_context.forEach((value, index) => {
      const item = objectRecord(value);
      if (typeof item?.path === 'string') {
        lintPath(item.path, true, `verified_context.${index}.path`, issues);
      }
    });
  }
  for (const [field, allowDot] of [
    ['write_scope', false],
    ['forbidden_scope', false],
  ] as const) {
    if (!Array.isArray(contract[field])) continue;
    contract[field].forEach((value, index) => {
      if (typeof value === 'string') lintPath(value, allowDot, `${field}.${index}`, issues);
    });
  }
  const writeScope = Array.isArray(contract.write_scope) ? contract.write_scope : [];
  const forbiddenScope = Array.isArray(contract.forbidden_scope) ? contract.forbidden_scope : [];
  if (writeScope.length > 0 && forbiddenScope.length > 0) {
    writeScope.forEach((writeValue) => {
      if (typeof writeValue !== 'string' || hasGlob(writeValue)) return;
      let writePath: string;
      try {
        writePath = normalizeRepositoryPath(writeValue, 'write_scope');
      } catch {
        return;
      }
      forbiddenScope.forEach((forbiddenValue, forbiddenIndex) => {
        if (typeof forbiddenValue !== 'string') return;
        let forbiddenPattern: string;
        try {
          forbiddenPattern = normalizeRepositoryPath(forbiddenValue, 'forbidden_scope');
        } catch {
          return;
        }
        if (!patternMatches(forbiddenPattern, writePath)) return;
        issues.push({
          path: `forbidden_scope.${forbiddenIndex}`,
          message: `forbidden_scope matches concrete write_scope target ${writePath}; write_scope already denies every unlisted path`,
        });
      });
    });
  }
  for (const field of ['verification', 'allowed_commands'] as const) {
    if (!Array.isArray(contract[field])) continue;
    contract[field].forEach((value, index) => {
      const item = objectRecord(value);
      if (item?.cwd === undefined || typeof item.cwd === 'string') {
        lintPath(item?.cwd, true, `${field}.${index}.cwd`, issues);
      }
    });
  }

  const acceptance = idRecords(contract.acceptance_criteria);
  const verification = idRecords(contract.verification);
  const allowedCommands = idRecords(contract.allowed_commands);
  const fileAssertions = idRecords(contract.file_assertions);
  lintDuplicateIds(acceptance, 'acceptance_criteria', issues);
  lintDuplicateIds(fileAssertions, 'file_assertions', issues);
  lintDuplicateIds(verification, 'verification', issues, (value) =>
    lintCommandIdentity(value, 600, true),
  );
  if (Array.isArray(contract.allowed_commands)) {
    lintDuplicateIds(allowedCommands, 'allowed_commands', issues, (value) =>
      lintCommandIdentity(value, 120, false),
    );
    const verificationById = new Map(
      verification.map((command) => [command.id, lintCrossCommandIdentity(command)]),
    );
    allowedCommands.forEach((command) => {
      const verification = verificationById.get(command.id);
      if (verification !== undefined && verification !== lintCrossCommandIdentity(command)) {
        issues.push({
          path: `allowed_commands.${command._lintIndex}.id`,
          message: `Conflicting verification command id: ${command.id}`,
        });
      }
    });
  }

  const criteria = new Set(acceptance.map((item) => item.id));
  const automated = new Set(
    acceptance.filter((item) => item.evidence === 'automated').map((item) => item.id),
  );
  const proved = new Set<string>();
  verification.forEach((command) => {
    if (!Array.isArray(command.proves)) return;
    command.proves.forEach((criterion, provesIndex) => {
      if (typeof criterion !== 'string') return;
      if (!criteria.has(criterion)) {
        issues.push({
          path: `verification.${command._lintIndex}.proves.${provesIndex}`,
          message: `Unknown acceptance criterion: ${criterion}`,
        });
      } else {
        proved.add(criterion);
      }
    });
  });
  for (const assertion of fileAssertions) {
    if (typeof assertion.path !== 'string') continue;
    lintPath(assertion.path, false, `file_assertions.${assertion._lintIndex}.path`, issues);
    if (typeof assertion.expected_utf8 !== 'string') continue;
    const bytes = Buffer.byteLength(assertion.expected_utf8);
    if (bytes > 64 * 1024) {
      issues.push({
        path: `file_assertions.${assertion._lintIndex}.expected_utf8`,
        message: `expected_utf8 exceeds 64 KiB (${String(bytes)} bytes)`,
      });
    }
    if (!Array.isArray(assertion.proves)) continue;
    assertion.proves.forEach((criterion, provesIndex) => {
      if (typeof criterion !== 'string') return;
      if (!criteria.has(criterion)) {
        issues.push({
          path: `file_assertions.${assertion._lintIndex}.proves.${provesIndex}`,
          message: `Unknown acceptance criterion: ${criterion}`,
        });
        return;
      }
      if (!automated.has(criterion)) {
        issues.push({
          path: `file_assertions.${assertion._lintIndex}.proves.${provesIndex}`,
          message: `File assertions can only prove automated acceptance criteria: ${criterion}`,
        });
        return;
      }
      proved.add(criterion);
    });
  }
  for (const criterion of automated) {
    if (!proved.has(criterion)) {
      issues.push({
        path: 'verification',
        message: `Automated acceptance criteria lack verification: ${criterion}`,
      });
    }
  }
  return issues;
}

/** Verification commands are always allowed, but only they can prove automated acceptance. */
export function contractAllowedCommands(contract: TaskContractV1): AllowedCommand[] {
  const verification = contract.verification.map((command) => ({
    id: command.id,
    argv: command.argv,
    cwd: command.cwd,
    timeout_seconds: command.timeout_seconds,
  }));
  return [...verification, ...(contract.allowed_commands ?? [])];
}

export function isCommandAllowedByContract(
  contract: TaskContractV1,
  argv: readonly string[],
  cwd = '.',
): boolean {
  const normalizedCwd = normalizeRepositoryCwd(cwd, 'command.cwd');
  return contractAllowedCommands(contract).some(
    (command) =>
      command.cwd === normalizedCwd &&
      command.argv.length === argv.length &&
      command.argv.every((argument, index) => argument === argv[index]),
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalContractJson(contract: TaskContractV1): string {
  return `${JSON.stringify(canonicalize(contract), null, 2)}\n`;
}

export function contractHash(contract: TaskContractV1): string {
  return createHash('sha256').update(canonicalContractJson(contract)).digest('hex');
}

function hasGlob(pattern: string): boolean {
  return /[*?{}()[\]]/.test(pattern);
}

function patternMatches(pattern: string, candidate: string): boolean {
  if (!hasGlob(pattern)) return candidate === pattern || candidate.startsWith(`${pattern}/`);
  return picomatch(pattern, { dot: true, nonegate: true, noext: false })(candidate);
}

export function isForbiddenPath(contract: TaskContractV1, candidate: string): boolean {
  const normalized = normalizeRepositoryPath(candidate);
  return contract.forbidden_scope.some((pattern) => patternMatches(pattern, normalized));
}

export function isWriteAllowed(contract: TaskContractV1, candidate: string): boolean {
  const normalized = normalizeRepositoryPath(candidate);
  if (isForbiddenPath(contract, normalized)) return false;
  return contract.write_scope.some((pattern) => patternMatches(pattern, normalized));
}

export async function assertPathInsideWorktree(
  worktree: string,
  repositoryPath: string,
): Promise<string> {
  const root = await realpath(worktree);
  const normalized = normalizeRepositoryPath(repositoryPath);
  let prefix = root;
  for (const segment of normalized.split('/')) {
    prefix = path.join(prefix, segment);
    try {
      const info = await lstat(prefix);
      if (!info.isSymbolicLink()) continue;
      let resolved: string;
      try {
        resolved = await realpath(prefix);
      } catch {
        throw new BridgeError(
          'scope_violation',
          `Path contains a dangling or unresolved symlink: ${normalized}`,
        );
      }
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new BridgeError(
          'scope_violation',
          `Path escapes worktree through symlink: ${normalized}`,
        );
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  const target = path.resolve(root, ...normalized.split('/'));
  let probe = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(probe);
      const rebuilt = path.resolve(resolved, ...suffix.reverse());
      const relative = path.relative(root, rebuilt);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new BridgeError(
          'scope_violation',
          `Path escapes worktree through symlink: ${normalized}`,
        );
      }
      const canonical = relative.replaceAll('\\', '/');
      if (!canonical) {
        throw new BridgeError('scope_violation', `Path resolves to worktree root: ${normalized}`);
      }
      return normalizeRepositoryPath(canonical);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

export function renderFastPrompt(taskId: string, contract: TaskContractV1, hash: string): string {
  const lines = [
    `Edit task delegated by Codex supervisor (task ${taskId}, contract sha256 ${hash}).`,
    '',
    'Make exactly the contract-scoped file edits in this isolated worktree, then stop and report.',
    'Do not commit, stage, push, merge, rebase, change branches, access credentials, enable',
    'network, or expand scope. Do not create plans, todos, goal sessions, AutoResearch runs,',
    'review or task skills, or subagents. Do not run acceptance or verification checks; Codex',
    'will review, verify, stage, and create the only commit. Pause on any ambiguity listed by the',
    'contract.',
    '',
    `Objective: ${contract.objective}`,
    `User outcome: ${contract.user_outcome}`,
    '',
    'Verified context:',
    ...contract.verified_context.map((item) => `- ${item.path}: ${item.reason}`),
    '',
    'Write scope:',
    ...contract.write_scope.map((item) => `- ${item}`),
    '',
    'Forbidden scope (always wins):',
    ...contract.forbidden_scope.map((item) => `- ${item}`),
    '',
    'Invariants:',
    ...contract.invariants.map((item) => `- ${item}`),
    '',
    'Non-goals:',
    ...contract.non_goals.map((item) => `- ${item}`),
    '',
    'Pause conditions:',
    ...contract.pause_conditions.map((item) => `- ${item}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderGoalPrompt(taskId: string, contract: TaskContractV1, hash: string): string {
  const lines = [
    `Goal delegated by Codex supervisor (task ${taskId}, contract sha256 ${hash}).`,
    '',
    'Implement the contract in this isolated worktree. Do not commit, stage, push, merge, rebase,',
    'change branches, access credentials, enable network, or expand scope. Pause on any ambiguity',
    'listed by the contract. Codex will review, verify, stage, and create the only commit.',
    '',
    `Objective: ${contract.objective}`,
    `User outcome: ${contract.user_outcome}`,
    '',
    'Verified context:',
    ...contract.verified_context.map((item) => `- ${item.path}: ${item.reason}`),
    '',
    'Write scope:',
    ...contract.write_scope.map((item) => `- ${item}`),
    '',
    'Forbidden scope (always wins):',
    ...contract.forbidden_scope.map((item) => `- ${item}`),
    '',
    'Invariants:',
    ...contract.invariants.map((item) => `- ${item}`),
    '',
    'Non-goals:',
    ...contract.non_goals.map((item) => `- ${item}`),
    '',
    'Acceptance criteria:',
    ...contract.acceptance_criteria.map(
      (item) => `- [${item.id}] (${item.evidence}) ${item.requirement}`,
    ),
    '',
    'Allowed verification commands (exact argv):',
    ...contract.verification.map(
      (item) =>
        `- [${item.id}] cwd=${item.cwd ?? '.'} timeout=${item.timeout_seconds ?? 600}s argv=${JSON.stringify(item.argv)} proves=${item.proves.join(',')}`,
    ),
    '',
    'Other allowed commands (exact argv; never automated acceptance evidence):',
    ...(contract.allowed_commands ?? []).map(
      (item) =>
        `- [${item.id}] cwd=${item.cwd ?? '.'} timeout=${item.timeout_seconds ?? 120}s argv=${JSON.stringify(item.argv)}`,
    ),
    '',
    'Pause conditions:',
    ...contract.pause_conditions.map((item) => `- ${item}`),
    '',
    'When implementation and your local checks are done, stop and provide a concise delivery summary.',
  ];
  return `${lines.join('\n')}\n`;
}
