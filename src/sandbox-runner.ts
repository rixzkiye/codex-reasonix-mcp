import { access, constants, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runCommand, type CommandOptions, type CommandResult } from './command.js';
import { BridgeError } from './errors.js';

/**
 * SandboxedCommandRunner — the single authority that wraps bridge subprocesses
 * which execute repository-controlled content (verification commands, the
 * external secret scanner, Git hooks) in an OS-level sandbox.
 *
 * Posture (fail closed):
 * - network disabled;
 * - filesystem read-only outside the worktree, with credential paths hidden;
 * - worktree writable; /tmp private and writable;
 * - minimal sanitized environment (inherited from src/command.ts);
 * - if no sandbox engine is available, execution is refused unless the
 *   explicit `allowUnsandboxed` escape hatch is set.
 */
export type SandboxEngine = 'bubblewrap' | 'seatbelt';

export interface SandboxStatus {
  available: boolean;
  engine: SandboxEngine | null;
  reason?: string;
}

export interface SandboxedCommandOptions {
  /** Writable inside the sandbox; commands run with this as the writable root. */
  worktree: string;
  /**
   * Read-only bind for the source repository (needed by git-ops profiles so
   * git can read objects/refs/hooks when the repo is hidden by an overlay).
   */
  repositoryRoot?: string;
  /** Additional read-only binds (e.g. the commit transaction dir for hooks). */
  readOnlyPaths?: readonly string[];
  argv: CommandOptions['argv'];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface CredentialOverlay {
  path: string;
  kind: 'dir' | 'file';
}

/**
 * Paths whose contents are hidden from sandboxed commands: per-user
 * credential stores and configuration that routinely holds tokens.
 */
const CREDENTIAL_HOME_ENTRIES: ReadonlyArray<readonly [string, 'dir' | 'file']> = [
  ['.ssh', 'dir'],
  ['.gnupg', 'dir'],
  ['.aws', 'dir'],
  ['.config', 'dir'],
  ['.codex', 'dir'],
  ['.kube', 'dir'],
  ['.docker', 'dir'],
  ['.password-store', 'dir'],
  ['.netrc', 'file'],
  ['.npmrc', 'file'],
  ['.yarnrc', 'file'],
  ['.gitconfig', 'file'],
  ['.git-credentials', 'file'],
  // macOS keychain stores live under ~/Library/Keychains.
  [path.join('Library', 'Keychains'), 'dir'],
];

export async function resolveCredentialOverlays(
  homeDir: string = os.homedir(),
): Promise<CredentialOverlay[]> {
  const overlays: CredentialOverlay[] = [];
  const candidates: Array<readonly [string, 'dir' | 'file']> = [
    ...CREDENTIAL_HOME_ENTRIES.map(([name, kind]) => [path.join(homeDir, name), kind] as const),
    ['/root', 'dir'],
  ];
  for (const [candidate, kind] of candidates) {
    try {
      const info = await stat(candidate);
      if ((kind === 'dir' && info.isDirectory()) || (kind === 'file' && info.isFile())) {
        overlays.push({ path: candidate, kind });
      }
    } catch {
      // Missing path — nothing to hide.
    }
  }
  return overlays;
}

/** Pure bwrap argv builder; `overlays` hide credential paths. */
export function buildBwrapArgv(
  options: SandboxedCommandOptions,
  overlays: readonly CredentialOverlay[],
): [string, ...string[]] {
  const argv: string[] = [
    'bwrap',
    '--die-with-parent',
    // --unshare-pid makes bwrap fork a pidns-resident inner process: the
    // outer launcher exits and the spawned child.pid no longer identifies
    // the sandboxed command. The inner process keeps the launcher's process
    // group (it must NOT --new-session, or it would escape group kills), so
    // runCommand's kill(-child.pid) still reaches it, and the pid namespace
    // guarantees descendants die with the command.
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-net',
    '--unshare-uts',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
  ];
  for (const overlay of overlays) {
    if (overlay.kind === 'dir') {
      argv.push('--tmpfs', overlay.path);
    } else {
      argv.push('--ro-bind', '/dev/null', overlay.path);
    }
  }
  argv.push('--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev');
  if (options.repositoryRoot) {
    argv.push('--ro-bind', options.repositoryRoot, options.repositoryRoot);
  }
  for (const readOnlyPath of options.readOnlyPaths ?? []) {
    argv.push('--ro-bind', readOnlyPath, readOnlyPath);
  }
  argv.push(
    '--bind',
    options.worktree,
    options.worktree,
    '--chdir',
    options.cwd,
    '--',
    ...options.argv,
  );
  return argv as [string, ...string[]];
}

function escapeProfilePath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Pure Seatbelt profile builder (macOS). */
export function buildSeatbeltProfile(
  options: SandboxedCommandOptions,
  overlays: readonly CredentialOverlay[],
): string {
  const lines = ['(version 1)', '(allow default)', '(deny network*)'];
  for (const overlay of overlays) {
    lines.push(`(deny file-read* (subpath "${escapeProfilePath(overlay.path)}"))`);
  }
  lines.push(`(deny file-write* (subpath "/"))`);
  // Hardlink exfiltration: a hardlink to a hidden credential file created
  // inside the writable worktree resolves to the worktree path, bypassing
  // path-based read denies. Deny link creation outright.
  lines.push('(deny file-link*)');
  lines.push(`(allow file-write* (subpath "${escapeProfilePath(options.worktree)}"))`);
  // Guaranteed writable scratch space: host temp stays writable so tools
  // honoring TMPDIR have a scratch dir (the rest of the filesystem is
  // read-only or denied).
  lines.push(`(allow file-write* (subpath "${escapeProfilePath(os.tmpdir())}"))`);
  if (options.repositoryRoot) {
    lines.push(`(allow file-read* (subpath "${escapeProfilePath(options.repositoryRoot)}"))`);
  }
  for (const readOnlyPath of options.readOnlyPaths ?? []) {
    lines.push(`(allow file-read* (subpath "${escapeProfilePath(readOnlyPath)}"))`);
  }
  return lines.join('\n');
}

let cachedSandbox: SandboxStatus | undefined;

/**
 * Detect and probe the platform sandbox engine. Results are cached for the
 * process lifetime; use {@link resetSandboxCache} in tests.
 */
export async function detectSandbox(): Promise<SandboxStatus> {
  if (cachedSandbox) return cachedSandbox;
  let status: SandboxStatus;
  if (process.platform === 'linux') {
    const probe = await runCommand({
      argv: [
        'bwrap',
        '--ro-bind',
        '/',
        '/',
        '--unshare-user',
        '--unshare-ipc',
        '--unshare-net',
        '--unshare-uts',
        '--unshare-pid',
        '--',
        '/bin/true',
      ],
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    });
    status =
      probe.exitCode === 0
        ? { available: true, engine: 'bubblewrap' }
        : {
            available: false,
            engine: 'bubblewrap',
            reason: `bwrap probe failed: ${probe.stderr.trim().slice(0, 512) || 'non-zero exit'}`,
          };
  } else if (process.platform === 'darwin') {
    try {
      await access('/usr/bin/sandbox-exec', constants.X_OK);
      status = { available: true, engine: 'seatbelt' };
    } catch {
      status = {
        available: false,
        engine: 'seatbelt',
        reason: '/usr/bin/sandbox-exec not found',
      };
    }
  } else {
    status = {
      available: false,
      engine: null,
      reason: `no sandbox engine for platform ${process.platform}`,
    };
  }
  cachedSandbox = status;
  return status;
}

export function resetSandboxCache(): void {
  cachedSandbox = undefined;
}

/**
 * Run a repository-content command inside the OS sandbox. Fails closed with
 * `sandbox_unavailable` when no engine is present, unless `allowUnsandboxed`
 * is explicitly set (documented unsafe escape hatch).
 */
export async function runSandboxed(
  options: SandboxedCommandOptions,
  allowUnsandboxed: boolean,
  detect: () => Promise<SandboxStatus> | SandboxStatus = detectSandbox,
): Promise<CommandResult> {
  const status = await detect();
  if (!status.available) {
    if (allowUnsandboxed) {
      return await runCommand({
        argv: options.argv,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        env: options.env,
        signal: options.signal,
      });
    }
    throw new BridgeError(
      'sandbox_unavailable',
      `Command sandbox is unavailable (${status.reason ?? status.engine ?? 'no engine'}); ` +
        'refusing to execute repository content unsandboxed',
    );
  }
  // Resolve symlinks (e.g. /tmp -> /private/tmp on macOS) so host-side paths
  // match the paths visible inside the sandbox mounts.
  const worktree = await realpath(options.worktree);
  const cwd = await realpath(options.cwd);
  const overlays = await resolveCredentialOverlays();
  // Pin temp so tools honoring TMPDIR always have a writable scratch space:
  // bubblewrap exposes a private tmpfs at /tmp; seatbelt allows writes to
  // the host temp directory (profile).
  const sandboxEnv: Record<string, string> = { ...(options.env ?? {}) };
  if (status.engine === 'bubblewrap') {
    sandboxEnv.TMPDIR = '/tmp';
    sandboxEnv.TMP = '/tmp';
    sandboxEnv.TEMP = '/tmp';
  }
  const argv: [string, ...string[]] =
    status.engine === 'bubblewrap'
      ? buildBwrapArgv({ ...options, worktree, cwd }, overlays)
      : [
          '/usr/bin/sandbox-exec',
          '-p',
          buildSeatbeltProfile({ ...options, worktree, cwd }, overlays),
          '--',
          ...options.argv,
        ];
  return await runCommand({
    argv,
    cwd,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    env: sandboxEnv,
    signal: options.signal,
  });
}
