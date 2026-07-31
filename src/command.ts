import { spawn } from 'node:child_process';
import process from 'node:process';

import { BridgeError } from './errors.js';

export interface CommandOptions {
  argv: readonly [string, ...string[]];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface CommandResult {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]);

export function sanitizedEnvironment(
  additions: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (SAFE_ENV_KEYS.has(key) || key.startsWith('LC_'))) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(additions)) {
    if (/key|token|secret|password|credential|cookie|authorization/i.test(key)) {
      throw new BridgeError(
        'invalid_request',
        `Refusing sensitive subprocess environment key: ${key}`,
      );
    }
    env[key] = value;
  }
  return env;
}

export async function runCommand(options: CommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted) {
    throw new BridgeError('invalid_state', 'Command was cancelled before it started');
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const [command, ...args] = options.argv;
  const started = Date.now();

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: sanitizedEnvironment(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;

    const capture = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const current = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const room = Math.max(0, maxOutputBytes - current);
      if (room > 0) target.push(chunk.subarray(0, room));
      if (chunk.length > room) outputTruncated = true;
      if (stream === 'stdout') stdoutBytes += Math.min(chunk.length, room);
      else stderrBytes += Math.min(chunk.length, room);
    };

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk, 'stderr'));

    const signalTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
    };
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalTree('SIGTERM');
      killTimer = setTimeout(() => signalTree('SIGKILL'), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();

    const abort = (): void => terminate();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.once('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      // A foreground command is not allowed to leak background descendants.
      // The detached process-group ID remains addressable after its leader exits.
      signalTree('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        argv: [...options.argv],
        cwd: options.cwd,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        outputTruncated,
      });
    });
  });
}

export async function runChecked(options: CommandOptions): Promise<CommandResult> {
  const result = await runCommand(options);
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    throw new BridgeError('internal_error', `Command failed: ${options.argv.join(' ')}`, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      stderr: result.stderr.slice(0, 4_096),
    });
  }
  return result;
}
