import { createHash } from 'node:crypto';
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

export const taskContractSchema = z
  .object({
    schema_version: z.literal(1),
    objective: textSchema,
    user_outcome: textSchema,
    verified_context: z
      .array(z.object({ path: z.string().min(1).max(1_024), reason: textSchema }).strict())
      .max(1_000),
    write_scope: z.array(z.string().min(1).max(1_024)).min(1).max(1_000),
    forbidden_scope: z.array(z.string().min(1).max(1_024)).max(1_000),
    invariants: z.array(textSchema).max(1_000),
    non_goals: z.array(textSchema).max(1_000),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1).max(1_000),
    verification: z.array(verificationCommandSchema).max(256),
    pause_conditions: z.array(textSchema).max(1_000),
  })
  .strict();

export type TaskContractV1 = z.infer<typeof taskContractSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

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

export function normalizeRepositoryCwd(value = '.'): string {
  return normalizeRelative(value, true, 'verification.cwd');
}

function uniqueIds(values: Array<{ id: string }>, field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new BridgeError('invalid_contract', `${field} contains duplicate id: ${value.id}`);
    }
    seen.add(value.id);
  }
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

  const contract: TaskContractV1 = {
    ...parsed.data,
    verified_context: parsed.data.verified_context.map((item) => ({
      ...item,
      path: normalizeRepositoryPath(item.path, 'verified_context.path'),
    })),
    write_scope: parsed.data.write_scope.map((item) =>
      normalizeRepositoryPath(item, 'write_scope'),
    ),
    forbidden_scope: parsed.data.forbidden_scope.map((item) =>
      normalizeRepositoryPath(item, 'forbidden_scope'),
    ),
    verification: parsed.data.verification.map((item) => ({
      ...item,
      cwd: normalizeRepositoryCwd(item.cwd),
      timeout_seconds: item.timeout_seconds ?? 600,
    })),
  };

  uniqueIds(contract.acceptance_criteria, 'acceptance_criteria');
  uniqueIds(contract.verification, 'verification');
  const automated = new Set(
    contract.acceptance_criteria
      .filter((item) => item.evidence === 'automated')
      .map((item) => item.id),
  );
  const allCriteria = new Set(contract.acceptance_criteria.map((item) => item.id));
  const proved = new Set<string>();
  for (const verification of contract.verification) {
    for (const criterion of verification.proves) {
      if (!allCriteria.has(criterion)) {
        throw new BridgeError(
          'invalid_contract',
          `Verification ${verification.id} proves unknown criterion ${criterion}`,
        );
      }
      proved.add(criterion);
    }
  }
  const missing = [...automated].filter((criterion) => !proved.has(criterion));
  if (missing.length > 0) {
    throw new BridgeError('invalid_contract', 'Automated acceptance criteria lack verification', {
      missing,
    });
  }
  return contract;
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
    'Pause conditions:',
    ...contract.pause_conditions.map((item) => `- ${item}`),
    '',
    'When implementation and your local checks are done, stop and provide a concise delivery summary.',
  ];
  return `${lines.join('\n')}\n`;
}
