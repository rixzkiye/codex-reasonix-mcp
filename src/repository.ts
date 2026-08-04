import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { BridgeConfig } from './config.js';
import { assertPathInsideWorktree, isWriteAllowed, type TaskContractV1 } from './contracts.js';
import { BridgeError } from './errors.js';
import { containsSecret } from './redaction.js';
import { isRuntimeMetadataPath } from './runtime-metadata.js';
import { runChecked, runCommand, type CommandResult } from './command.js';
import { isCredentialPath, isGitControlPath } from './sensitive-paths.js';
import { runSandboxed } from './sandbox-runner.js';
import type { RepositoryIdentity } from './types.js';

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
  maxOutputBytes = 8 * 1024 * 1024,
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return await runCommand({
    argv: ['git', ...args],
    cwd,
    timeoutMs,
    maxOutputBytes,
    ...(env ? { env } : {}),
  });
}

async function gitChecked(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return await runChecked({
    argv: ['git', ...args],
    cwd,
    timeoutMs,
    maxOutputBytes: 16 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
}

export async function discoverRepository(cwd: string): Promise<RepositoryIdentity> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    throw new BridgeError('not_git_repository', `Sandbox cwd does not exist: ${cwd}`);
  }
  const rootResult = await git(canonicalCwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.exitCode !== 0) {
    throw new BridgeError('not_git_repository', 'Sandbox cwd is not inside a Git repository');
  }
  const root = await realpath(rootResult.stdout.trim());
  const commonResult = await gitChecked(root, ['rev-parse', '--git-common-dir']);
  const commonCandidate = commonResult.stdout.trim();
  const commonDir = await realpath(
    path.isAbsolute(commonCandidate) ? commonCandidate : path.resolve(root, commonCandidate),
  );
  const headResult = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (headResult.exitCode !== 0) {
    throw new BridgeError('not_git_repository', 'Repository must have an initial commit');
  }
  const head = headResult.stdout.trim();
  const id = createHash('sha256').update(`${root}\0${commonDir}`).digest('hex').slice(0, 24);
  return { id, root, commonDir, head };
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** Resolves a commit identity at any source or isolated-worktree cwd. */
export async function resolveGitIdentityAt(
  cwd: string,
  bridgeEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GitIdentity> {
  const environmentName = bridgeEnvironment.GIT_AUTHOR_NAME?.trim();
  const environmentEmail = bridgeEnvironment.GIT_AUTHOR_EMAIL?.trim();
  const configEnvironment = Object.fromEntries(
    ['HOME', 'XDG_CONFIG_HOME'].flatMap((key) => {
      const value = bridgeEnvironment[key]?.trim();
      return value ? [[key, value]] : [];
    }),
  );
  const [configuredName, configuredEmail] = await Promise.all([
    environmentName
      ? undefined
      : git(cwd, ['config', '--get', 'user.name'], 10_000, 8 * 1024 * 1024, configEnvironment),
    environmentEmail
      ? undefined
      : git(cwd, ['config', '--get', 'user.email'], 10_000, 8 * 1024 * 1024, configEnvironment),
  ]);
  const name = environmentName || configuredName?.stdout.trim();
  const email = environmentEmail || configuredEmail?.stdout.trim();
  if (!name || !email) {
    throw new BridgeError(
      'invalid_request',
      'Git author identity is required before delegation; set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL or configure user.name and user.email',
      { missing: [...(!name ? ['name'] : []), ...(!email ? ['email'] : [])] },
    );
  }
  return { name, email };
}

/** Resolves the commit author before any provider process is started. */
export async function resolveGitIdentity(
  repository: RepositoryIdentity,
  bridgeEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GitIdentity> {
  return await resolveGitIdentityAt(repository.root, bridgeEnvironment);
}

export async function assertSourceClean(repository: RepositoryIdentity): Promise<void> {
  const result = await gitChecked(repository.root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (result.stdout.length > 0) {
    const paths = parsePorcelainPaths(result.stdout).slice(0, 50);
    throw new BridgeError('dirty_repository', 'Main worktree must be clean before delegation', {
      paths,
    });
  }
}

export function validateTaskId(taskId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId) ||
    taskId.includes('..') ||
    taskId.endsWith('.lock') ||
    taskId === '.'
  ) {
    throw new BridgeError('invalid_request', 'task_id is not safe for state and branch names');
  }
  return taskId;
}

export async function resolveBaseCommit(
  repository: RepositoryIdentity,
  baseRef: string,
): Promise<string> {
  if (!baseRef.trim() || baseRef.includes('\0') || baseRef.length > 1_024) {
    throw new BridgeError('invalid_request', 'Invalid base_ref');
  }
  const result = await git(repository.root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${baseRef}^{commit}`,
  ]);
  if (result.exitCode !== 0) {
    throw new BridgeError('invalid_request', `base_ref does not resolve to a commit: ${baseRef}`);
  }
  return result.stdout.trim();
}

export async function createIsolatedWorktree(
  repository: RepositoryIdentity,
  stateWorktreesDir: string,
  taskId: string,
  baseCommit: string,
): Promise<{ branch: string; worktree: string }> {
  const branch = `reasonix/${validateTaskId(taskId)}`;
  const parent = path.join(stateWorktreesDir, repository.id);
  const worktree = path.join(parent, taskId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await stat(worktree);
    throw new BridgeError('ownership_ambiguous', `Worktree path already exists: ${worktree}`);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const branchCheck = await git(repository.root, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (branchCheck.exitCode === 0) {
    throw new BridgeError('ownership_ambiguous', `Worker branch already exists: ${branch}`);
  }
  const result = await git(
    repository.root,
    ['worktree', 'add', '-b', branch, worktree, baseCommit],
    5 * 60_000,
  );
  if (result.exitCode !== 0) {
    throw new BridgeError('ownership_ambiguous', 'Failed to create isolated worker worktree', {
      stderr: result.stderr.slice(0, 4_096),
    });
  }
  return { branch, worktree: await realpath(worktree) };
}

function nulList(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function parsePorcelainPaths(value: string): string[] {
  const fields = nulList(value);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const statusCode = field.slice(0, 2);
    paths.push(field.slice(3));
    if (statusCode.includes('R') || statusCode.includes('C')) index += 1;
  }
  return paths;
}

function parsePorcelainAllPaths(value: string): string[] {
  const fields = nulList(value);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const statusCode = field.slice(0, 2);
    paths.push(field.slice(3));
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const original = fields[index + 1];
      if (original) paths.push(original);
      index += 1;
    }
  }
  return paths;
}

function parseNameStatusPaths(value: string): string[] {
  const fields = nulList(value);
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const statusCode = fields[index++];
    if (!statusCode) continue;
    const first = fields[index++];
    if (first) paths.push(first);
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      const second = fields[index++];
      if (second) paths.push(second);
    }
  }
  return paths;
}

export interface SourceRepositoryChanges {
  sourceHead: string;
  dirtyPaths: string[];
  committedPaths: string[];
}

/**
 * Reads source-repository path movement without changing the index, worktree,
 * refs, or user files. Rename/copy deltas include both the old and new path.
 */
export async function sourceRepositoryChanges(
  repository: RepositoryIdentity,
  baseCommit: string,
): Promise<SourceRepositoryChanges> {
  const readGit = async (args: string[]): Promise<CommandResult> =>
    await gitChecked(repository.root, args, 60_000, { GIT_OPTIONAL_LOCKS: '0' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const head = (await readGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    const [dirty, committed] = await Promise.all([
      readGit(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      readGit([
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--find-copies',
        `${baseCommit}..${head}`,
      ]),
    ]);
    const headAfter = (await readGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (headAfter !== head) continue;
    return {
      sourceHead: head,
      dirtyPaths: [...new Set(parsePorcelainAllPaths(dirty.stdout))].sort(),
      committedPaths: [...new Set(parseNameStatusPaths(committed.stdout))].sort(),
    };
  }
  throw new BridgeError(
    'ownership_ambiguous',
    'Source HEAD moved repeatedly during collision scan',
  );
}

export async function changedFiles(worktree: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitChecked(worktree, ['diff', '--no-renames', '--name-only', '-z', 'HEAD']),
    gitChecked(worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  // Untracked .reasonix/** entries are runtime metadata and never task changes.
  return [
    ...new Set([
      ...nulList(tracked.stdout),
      ...nulList(untracked.stdout).filter((file) => !isRuntimeMetadataPath(file)),
    ]),
  ].sort();
}

export async function assertNoWorkerCommits(worktree: string, baseCommit: string): Promise<void> {
  const count = Number.parseInt(
    (await gitChecked(worktree, ['rev-list', '--count', `${baseCommit}..HEAD`])).stdout.trim(),
    10,
  );
  if (count !== 0) {
    throw new BridgeError('ownership_ambiguous', 'Reasonix or another writer created commits', {
      count,
    });
  }
}

export async function assertChangedFilesInScope(
  worktree: string,
  contract: TaskContractV1,
  files: string[],
): Promise<void> {
  const violations: string[] = [];
  for (const file of files) {
    const canonical = await assertPathInsideWorktree(worktree, file);
    // Untracked runtime metadata never reaches this list; a .reasonix path here
    // is a tracked change and is forbidden regardless of write_scope.
    if (isRuntimeMetadataPath(file) || isRuntimeMetadataPath(canonical)) {
      violations.push(file);
      continue;
    }
    if (
      !isWriteAllowed(contract, file) ||
      !isWriteAllowed(contract, canonical) ||
      isGitControlPath(file) ||
      isGitControlPath(canonical) ||
      isCredentialPath(file) ||
      isCredentialPath(canonical)
    ) {
      violations.push(file);
    }
  }
  if (violations.length > 0) {
    throw new BridgeError('scope_violation', 'Changed files fall outside write_scope', {
      violations,
    });
  }
  const raw = await gitChecked(worktree, ['diff', '--raw', '--no-renames', 'HEAD']);
  if (/(?:^|\n):[0-7]{6} 160000 |(?:^|\n):160000 [0-7]{6} /.test(raw.stdout)) {
    throw new BridgeError('scope_violation', 'Submodule drift is forbidden');
  }
}

export async function assertFileSizes(
  worktree: string,
  files: string[],
  config: BridgeConfig,
): Promise<void> {
  for (const file of files) {
    const absolute = path.join(worktree, ...file.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isFile() && info.size > config.maxBinaryBytes) {
      throw new BridgeError('scope_violation', `Changed file exceeds size limit: ${file}`, {
        bytes: info.size,
        limit: config.maxBinaryBytes,
      });
    }
  }
}

/**
 * Builds a canonical snapshot of the worktree against a base commit using a
 * temporary index (never the real index): tracked edits, untracked additions,
 * deletions, and mode changes all appear in one deterministic tree/diff.
 * Untracked `.reasonix/**` runtime metadata is excluded from the snapshot.
 */
export interface CanonicalWorktreeSnapshot {
  tree: string;
  diff: string;
  stat: string;
  files: string[];
}

async function untrackedRuntimeMetadata(worktree: string): Promise<string[]> {
  const result = await gitChecked(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  return nulList(result.stdout).filter((file) => isRuntimeMetadataPath(file));
}

export async function canonicalWorktreeSnapshot(
  worktree: string,
  baseRef = 'HEAD',
): Promise<CanonicalWorktreeSnapshot> {
  const transactionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-index-'));
  const temporaryIndex = path.join(transactionDir, 'index');
  const environment = { GIT_INDEX_FILE: temporaryIndex, GIT_OPTIONAL_LOCKS: '0' };
  try {
    await gitChecked(worktree, ['read-tree', baseRef], 60_000, environment);
    await gitChecked(worktree, ['add', '-A', '--', '.'], 5 * 60_000, environment);
    const runtimeMetadata = await untrackedRuntimeMetadata(worktree);
    if (runtimeMetadata.length > 0) {
      await gitChecked(
        worktree,
        ['update-index', '--force-remove', '--', ...runtimeMetadata],
        60_000,
        environment,
      );
    }
    const [tree, diff, stat, files] = await Promise.all([
      gitChecked(worktree, ['write-tree'], 60_000, environment),
      gitChecked(worktree, ['diff', '--cached', '--no-ext-diff', '--binary'], 60_000, environment),
      gitChecked(worktree, ['diff', '--cached', '--stat'], 60_000, environment),
      gitChecked(worktree, ['diff', '--cached', '--name-only', '-z'], 60_000, environment),
    ]);
    return {
      tree: tree.stdout.trim(),
      diff: diff.stdout,
      stat: stat.stdout,
      files: [...new Set(nulList(files.stdout))].sort(),
    };
  } finally {
    await rm(transactionDir, { recursive: true, force: true });
  }
}

/** Canonical worktree tree hash (runtime metadata excluded), used as the review snapshot. */
export async function canonicalWorktreeTree(worktree: string, baseRef = 'HEAD'): Promise<string> {
  return (await canonicalWorktreeSnapshot(worktree, baseRef)).tree;
}

/** Canonical reviewed/staged tree hash from the real index after explicit staging. */
export async function stagedTree(worktree: string): Promise<string> {
  return (await gitChecked(worktree, ['write-tree'])).stdout.trim();
}

export async function workingDiff(worktree: string): Promise<string> {
  return (await canonicalWorktreeSnapshot(worktree)).diff;
}

export async function diffStat(worktree: string): Promise<string> {
  return (await canonicalWorktreeSnapshot(worktree)).stat;
}

export interface CheckIgnoreOptions {
  quiet?: boolean;
  verbose?: boolean;
}

/**
 * Read-only `git check-ignore` with explicit repository-relative paths and only
 * the safe quiet/verbose flags. Stdin, path escapes, and unknown options are
 * rejected by construction; exit code 1 (nothing ignored) is not an error.
 */
export async function checkIgnore(
  worktree: string,
  paths: string[],
  options: CheckIgnoreOptions = {},
): Promise<string[]> {
  if (paths.length === 0) {
    throw new BridgeError('invalid_request', 'check-ignore requires at least one explicit path');
  }
  for (const candidate of paths) {
    if (
      !candidate ||
      candidate.includes('\0') ||
      candidate.startsWith('-') ||
      path.posix.isAbsolute(candidate) ||
      path.win32.isAbsolute(candidate) ||
      /^[A-Za-z]:/.test(candidate) ||
      candidate.split('/').includes('..')
    ) {
      throw new BridgeError(
        'invalid_request',
        `check-ignore path is not a safe repository-relative path: ${candidate}`,
      );
    }
  }
  const args = ['check-ignore'];
  if (options.quiet) args.push('--quiet');
  if (options.verbose) args.push('--verbose');
  const result = await git(worktree, [...args, '--', ...paths], 30_000, 8 * 1024 * 1024);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new BridgeError('invalid_state', 'git check-ignore failed', {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 4_096),
    });
  }
  return result.stdout.split('\n').filter(Boolean);
}

export async function stageExplicitFiles(worktree: string, files: string[]): Promise<void> {
  if (files.length === 0)
    throw new BridgeError('invalid_state', 'Nothing changed; refusing empty commit');
  const alreadyStaged = nulList(
    (await gitChecked(worktree, ['diff', '--cached', '--name-only', '-z'])).stdout,
  );
  if (alreadyStaged.length > 0) {
    throw new BridgeError(
      'ownership_ambiguous',
      'Index was modified before bridge-owned explicit staging',
      { staged: alreadyStaged },
    );
  }
  try {
    await gitChecked(worktree, ['add', '--', ...files], 5 * 60_000);
    const staged = nulList(
      (await gitChecked(worktree, ['diff', '--cached', '--name-only', '-z'])).stdout,
    ).sort();
    const expected = [...new Set(files)].sort();
    if (JSON.stringify(staged) !== JSON.stringify(expected)) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Staged file list differs from explicit task file list',
        {
          staged,
          expected,
        },
      );
    }
  } catch (error) {
    try {
      await unstageExplicitFiles(worktree, files);
    } catch (recoveryError) {
      const cause = error instanceof BridgeError ? error : undefined;
      const recovery = recoveryError instanceof BridgeError ? recoveryError : undefined;
      throw new BridgeError(
        'ownership_ambiguous',
        'Explicit staging failed and the bridge-owned index could not be restored',
        {
          causeCode: cause?.code ?? 'internal_error',
          causeMessage: error instanceof Error ? error.message : String(error),
          recoveryCode: recovery?.code ?? 'internal_error',
          recoveryMessage:
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          indexRecoveryFailed: true,
        },
      );
    }
    throw error;
  }
}

/** Restores the bridge-owned index to HEAD without changing working-tree edits. */
export async function unstageExplicitFiles(worktree: string, files: string[]): Promise<void> {
  const staged = nulList(
    (await gitChecked(worktree, ['diff', '--cached', '--name-only', '-z'])).stdout,
  );
  if (staged.length === 0) return;
  const owned = new Set(files);
  const bridgeOwned = staged.filter((file) => owned.has(file));
  if (bridgeOwned.length > 0) {
    await gitChecked(worktree, ['reset', '--quiet', 'HEAD', '--', ...bridgeOwned], 60_000);
  }
  const remaining = nulList(
    (await gitChecked(worktree, ['diff', '--cached', '--name-only', '-z'])).stdout,
  );
  const remainingOwned = remaining.filter((file) => owned.has(file));
  const unexpected = remaining.filter((file) => !owned.has(file));
  if (remainingOwned.length > 0 || unexpected.length > 0) {
    throw new BridgeError(
      'ownership_ambiguous',
      remainingOwned.length > 0
        ? 'Unable to restore the bridge-owned index'
        : 'Index contains unowned paths after bridge staging recovery',
      { remaining, remainingOwned, unexpected },
    );
  }
}

export async function stagedDiff(worktree: string): Promise<string> {
  return (await gitChecked(worktree, ['diff', '--cached', '--no-ext-diff', '--binary'])).stdout;
}

export async function assertStagedChecks(worktree: string): Promise<void> {
  const whitespace = await git(worktree, ['diff', '--cached', '--check']);
  if (whitespace.exitCode !== 0) {
    throw new BridgeError('verification_failed', 'Staged diff contains whitespace errors', {
      errors: whitespace.stdout.slice(0, 8_192),
    });
  }
}

export interface AtomicCommitOptions {
  /** Run repository Git hooks (pre-commit/prepare-commit-msg/commit-msg). Default: off. */
  runGitHooks?: boolean;
  /** Source repository root, bound read-only into the hook sandbox. */
  repositoryRoot?: string;
  /** Escape hatch: run hooks without an OS sandbox when none is available. */
  allowUnsandboxed?: boolean;
}

export async function createAtomicCommit(
  worktree: string,
  baseCommit: string,
  message: string,
  identity: GitIdentity,
  options: AtomicCommitOptions = {},
): Promise<string> {
  const before = (await gitChecked(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  if (before !== baseCommit) {
    throw new BridgeError('ownership_ambiguous', 'Worker HEAD moved before bridge commit');
  }
  const branch = (await gitChecked(worktree, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  if (!branch.startsWith('refs/heads/reasonix/')) {
    throw new BridgeError('ownership_ambiguous', 'Worker HEAD is not on a Reasonix task branch');
  }
  const untracked = nulList(
    (await gitChecked(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout,
  ).filter((file) => !isRuntimeMetadataPath(file));
  const unstaged = await git(worktree, ['diff', '--quiet', '--no-ext-diff']);
  if (unstaged.exitCode !== 0 || untracked.length > 0) {
    throw new BridgeError('ownership_ambiguous', 'Worktree changed after staged-diff review', {
      untracked,
    });
  }

  const transactionDir = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-commit-'));
  const temporaryIndex = path.join(transactionDir, 'index');
  const messagePath = path.join(transactionDir, 'COMMIT_EDITMSG');
  const emptyHooks = path.join(transactionDir, 'empty-hooks');
  try {
    await mkdir(emptyHooks, { mode: 0o700 });
    const indexValue = (
      await gitChecked(worktree, ['rev-parse', '--git-path', 'index'])
    ).stdout.trim();
    const indexPath = path.isAbsolute(indexValue) ? indexValue : path.resolve(worktree, indexValue);
    await copyFile(indexPath, temporaryIndex);
    await writeFile(messagePath, `${validateCommitMessage(message)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const hookEnvironment = {
      GIT_INDEX_FILE: temporaryIndex,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    const reviewedTree = (
      await gitChecked(worktree, ['write-tree'], 60_000, hookEnvironment)
    ).stdout.trim();
    const realTree = (await gitChecked(worktree, ['write-tree'])).stdout.trim();
    if (realTree !== reviewedTree) {
      throw new BridgeError('ownership_ambiguous', 'Temporary and reviewed indexes differ');
    }

    if (options.runGitHooks) {
      for (const hook of [
        { name: 'pre-commit', args: [] },
        { name: 'prepare-commit-msg', args: [messagePath, 'message'] },
        { name: 'commit-msg', args: [messagePath] },
      ]) {
        const result = await runSandboxed(
          {
            worktree,
            repositoryRoot: options.repositoryRoot,
            readOnlyPaths: [transactionDir],
            argv: ['git', 'hook', 'run', '--ignore-missing', hook.name, '--', ...hook.args],
            cwd: worktree,
            timeoutMs: 5 * 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
            env: hookEnvironment,
          },
          options.allowUnsandboxed ?? false,
        );
        if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
          throw new BridgeError('commit_failed', `Git ${hook.name} hook failed`, {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout.slice(0, 16_384),
            stderr: result.stderr.slice(0, 16_384),
          });
        }
      }
    }

    const [headAfterHooks, realTreeAfterHooks, hookTreeAfterHooks, untrackedAfterHooks] =
      await Promise.all([
        gitChecked(worktree, ['rev-parse', 'HEAD']),
        gitChecked(worktree, ['write-tree']),
        gitChecked(worktree, ['write-tree'], 60_000, hookEnvironment),
        gitChecked(worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
      ]);
    const unstagedAfterHooks = await git(worktree, ['diff', '--quiet', '--no-ext-diff']);
    const untrackedAfterHooksList = nulList(untrackedAfterHooks.stdout).filter(
      (file) => !isRuntimeMetadataPath(file),
    );
    if (
      headAfterHooks.stdout.trim() !== baseCommit ||
      realTreeAfterHooks.stdout.trim() !== reviewedTree ||
      hookTreeAfterHooks.stdout.trim() !== reviewedTree ||
      unstagedAfterHooks.exitCode !== 0 ||
      untrackedAfterHooksList.length > 0
    ) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Commit hook mutated the reviewed index, worktree, or worker ref',
      );
    }

    const finalMessage = validateCommitMessage(await readFile(messagePath, 'utf8'));
    await writeFile(messagePath, `${finalMessage}\n`, { encoding: 'utf8', mode: 0o600 });
    const object = await git(
      worktree,
      ['commit-tree', reviewedTree, '-p', baseCommit, '-F', messagePath],
      60_000,
      2 * 1024 * 1024,
      hookEnvironment,
    );
    const commitHash = object.stdout.trim();
    if (object.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commitHash)) {
      throw new BridgeError('commit_failed', 'git commit-tree failed', {
        exitCode: object.exitCode,
        stdout: object.stdout.slice(0, 16_384),
        stderr: object.stderr.slice(0, 16_384),
      });
    }
    await gitChecked(worktree, [
      '-c',
      `core.hooksPath=${emptyHooks}`,
      'update-ref',
      branch,
      commitHash,
      baseCommit,
    ]);

    const [after, tree, parents, countResult, status] = await Promise.all([
      gitChecked(worktree, ['rev-parse', 'HEAD']),
      gitChecked(worktree, ['show', '-s', '--format=%T', commitHash]),
      gitChecked(worktree, ['show', '-s', '--format=%P', commitHash]),
      gitChecked(worktree, ['rev-list', '--count', `${baseCommit}..HEAD`]),
      gitChecked(worktree, ['status', '--porcelain=v1', '-z']),
    ]);
    const count = Number.parseInt(countResult.stdout.trim(), 10);
    const statusWithoutRuntimeMetadata = nulList(status.stdout).filter((entry) => {
      if (!entry.startsWith('?? ')) return true;
      return !isRuntimeMetadataPath(entry.slice(3));
    });
    if (
      after.stdout.trim() !== commitHash ||
      tree.stdout.trim() !== reviewedTree ||
      parents.stdout.trim() !== baseCommit ||
      count !== 1 ||
      statusWithoutRuntimeMetadata.length > 0
    ) {
      throw new BridgeError('commit_failed', 'Atomic commit postconditions failed', {
        count,
      });
    }
    return commitHash;
  } catch (error) {
    const current = await git(worktree, ['rev-parse', '--verify', branch]);
    const currentHash = current.exitCode === 0 ? current.stdout.trim() : '';
    if (currentHash && currentHash !== baseCommit) {
      const rollback = await git(
        worktree,
        ['-c', `core.hooksPath=${emptyHooks}`, 'update-ref', branch, baseCommit, currentHash],
        60_000,
      );
      if (rollback.exitCode !== 0) {
        throw new BridgeError(
          'commit_failed',
          'Commit transaction failed and ref rollback failed',
          {
            cause: error instanceof Error ? error.message : String(error),
            rollbackStderr: rollback.stderr.slice(0, 16_384),
          },
        );
      }
    }
    throw error;
  } finally {
    await rm(transactionDir, { recursive: true, force: true });
  }
}

export function defaultCommitMessage(taskId: string, objective: string): string {
  const prefix = `${taskId}: `;
  const oneLine = objective.replaceAll(/\s+/g, ' ').trim();
  return `${prefix}${oneLine.slice(0, Math.max(1, 72 - prefix.length))}`;
}

export function validateCommitMessage(message: string): string {
  const trimmed = message.trim();
  const hasInvalidControlCharacter = [...trimmed].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
  });
  if (!trimmed || trimmed.length > 5_000 || hasInvalidControlCharacter) {
    throw new BridgeError('invalid_request', 'Invalid commit message');
  }
  if (containsSecret(trimmed)) {
    throw new BridgeError('secret_detected', 'Commit message appears to contain a credential');
  }
  if ((trimmed.split('\n')[0]?.length ?? 0) > 100) {
    throw new BridgeError('invalid_request', 'Commit subject must be at most 100 characters');
  }
  return trimmed;
}

export { git, gitChecked };
