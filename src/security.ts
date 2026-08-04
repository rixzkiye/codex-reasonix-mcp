import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BridgeConfig } from './config.js';
import { BridgeError } from './errors.js';
import { containsSecret } from './redaction.js';
import { git } from './repository.js';
import { runSandboxed } from './sandbox-runner.js';
import { isCredentialPath } from './sensitive-paths.js';
const ASSIGNMENT =
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?([^\s"']{12,})/gi;

function assignmentLooksSecret(value: string): boolean {
  ASSIGNMENT.lastIndex = 0;
  for (;;) {
    const match = ASSIGNMENT.exec(value);
    if (!match) return false;
    const candidate = match[1]?.toLowerCase() ?? '';
    if (!/(example|placeholder|changeme|dummy|fake|test|redacted|your[_-])/.test(candidate))
      return true;
  }
}

function scanContent(file: string, content: Buffer): void {
  if (content.includes(0)) return;
  const text = content.toString('utf8');
  if (containsSecret(text) || assignmentLooksSecret(text)) {
    throw new BridgeError('secret_detected', `Potential credential detected in ${file}`);
  }
}

export async function scanWorkingFiles(
  worktree: string,
  files: string[],
  config: BridgeConfig,
  signal?: AbortSignal,
): Promise<void> {
  for (const file of files) {
    if (isCredentialPath(file)) {
      throw new BridgeError('secret_detected', `Sensitive filename is not allowed: ${file}`);
    }
    const absolute = path.join(worktree, ...file.split('/'));
    try {
      const info = await lstat(absolute);
      if (info.isFile()) scanContent(file, await readFile(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (config.externalSecretScanner) {
    const [command, ...args] = config.externalSecretScanner;
    const result = await runSandboxed(
      {
        worktree,
        argv: [command, ...args, ...files],
        cwd: worktree,
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 1024 * 1024,
        signal,
      },
      config.allowUnsandboxed,
    );
    if (result.exitCode !== 0) {
      throw new BridgeError(
        'secret_detected',
        'Configured external secret scanner rejected changes',
        {
          exitCode: result.exitCode,
          output: `${result.stdout}\n${result.stderr}`.slice(0, 16_384),
        },
      );
    }
  }
}

export async function scanStagedFiles(worktree: string, files: string[]): Promise<void> {
  for (const file of files) {
    if (isCredentialPath(file)) {
      throw new BridgeError('secret_detected', `Sensitive staged filename is not allowed: ${file}`);
    }
    const result = await git(worktree, ['show', `:${file}`], 60_000, 16 * 1024 * 1024);
    if (result.exitCode === 0) scanContent(file, Buffer.from(result.stdout));
  }
}

export function evidenceHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
