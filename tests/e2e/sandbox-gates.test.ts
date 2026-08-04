import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';
import { buildBwrapArgv, detectSandbox, runSandboxed } from '../../src/sandbox-runner.js';

/**
 * Adversarial sandbox gates (PR 1 exit gates). These execute real malicious
 * payloads inside the OS sandbox and assert they cannot:
 *   1. read credential files,
 *   2. write sibling directories outside the worktree,
 *   3. reach the network,
 *   4. leave descendant processes behind.
 * Skipped on platforms without a usable sandbox engine (fail-closed posture
 * means the bridge itself would refuse to run repository content there).
 */
const status = await detectSandbox();
const sandboxed = status.available;

// Fake home under the cache dir (writable even when the real home is mounted
// read-only by an outer sandbox) for the overlay-mechanics gate.
const fakeHome = path.join(os.homedir(), '.cache', `codex-reasonix-gate-home-${process.pid}`);
const fakeMarker = path.join(fakeHome, '.ssh', 'id_rsa');

// Marker inside the real ~/.ssh for the default-overlay gate (CI runs this;
// skipped when the home is read-only).
const markerName = `.codex-reasonix-sandbox-marker-${process.pid}`;
const credentialMarker = path.join(os.homedir(), '.ssh', markerName);

let realHomeReady = false;
try {
  await mkdir(path.dirname(credentialMarker), { recursive: true, mode: 0o700 });
  await writeFile(credentialMarker, 'credential-material\n', { mode: 0o600 });
  realHomeReady = true;
} catch {
  // Read-only home (e.g. nested sandbox) — the real-home gate cannot run.
}

afterAll(async () => {
  await rm(fakeHome, { recursive: true, force: true });
  await rm(credentialMarker, { force: true });
});

describe.skipIf(!sandboxed)('command sandbox adversarial gates', () => {
  it.skipIf(process.platform !== 'linux')(
    'bwrap credential overlays hide files inside the hidden directory',
    async () => {
      await mkdir(path.dirname(fakeMarker), { recursive: true, mode: 0o700 });
      await writeFile(fakeMarker, 'credential-material\n', { mode: 0o600 });
      const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-gate-cred-'));
      const argv = buildBwrapArgv(
        {
          worktree,
          argv: ['/bin/sh', '-c', `cat ${fakeMarker} 2>/dev/null && echo READ || echo BLOCKED`],
          cwd: worktree,
        },
        [{ path: path.dirname(fakeMarker), kind: 'dir' }],
      );
      const result = await runCommand({ argv, cwd: worktree });
      expect(result.stdout).toContain('BLOCKED');
      expect(result.stdout).not.toContain('credential-material');
      expect((await stat(fakeMarker)).isFile()).toBe(true);
    },
  );

  it.skipIf(!realHomeReady)('blocks reads of the real user credential dirs', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-gate-cred-real-'));
    const result = await runSandboxed(
      {
        worktree,
        argv: ['/bin/sh', '-c', `cat ${credentialMarker} 2>/dev/null && echo READ || echo BLOCKED`],
        cwd: worktree,
      },
      false,
    );
    expect(result.stdout).toContain('BLOCKED');
    expect(result.stdout).not.toContain('credential-material');
    expect((await stat(credentialMarker)).isFile()).toBe(true);
  });

  it('blocks writes to sibling directories outside the worktree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-gate-write-'));
    const worktree = path.join(root, 'worktree');
    await mkdir(worktree);
    const target = path.join(root, 'escaped.txt');
    const result = await runSandboxed(
      {
        worktree,
        argv: ['/bin/sh', '-c', `echo pwned > ${target} 2>/dev/null; echo attempted`],
        cwd: worktree,
      },
      false,
    );
    expect(result.stdout).toContain('attempted');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks network access', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-gate-net-'));
    const result = await runSandboxed(
      {
        worktree,
        argv: [
          '/bin/sh',
          '-c',
          'if command -v curl >/dev/null 2>&1; then curl -s -m 2 https://example.com >/dev/null 2>&1 && echo OPEN || echo BLOCKED; elif command -v getent >/dev/null 2>&1; then timeout 3 getent ahostsv4 1.1.1.1 >/dev/null 2>&1 && echo OPEN || echo BLOCKED; else echo BLOCKED; fi',
        ],
        cwd: worktree,
      },
      false,
    );
    expect(result.stdout).toContain('BLOCKED');
  });

  it.skipIf(process.platform !== 'linux')(
    'kills background descendants when the command exits',
    async () => {
      const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-gate-desc-'));
      const marker = `reasonix-gate-sleep-${process.pid}`;
      const result = await runSandboxed(
        {
          worktree,
          argv: ['/bin/bash', '-c', `exec -a ${marker} sleep 60 & echo launched`],
          cwd: worktree,
        },
        false,
      );
      expect(result.stdout).toContain('launched');
      await new Promise((resolve) => setTimeout(resolve, 750));
      const { execFile } = await import('node:child_process');
      const ps = await new Promise<string>((resolve, reject) => {
        execFile('ps', ['-eo', 'args='], (error, stdout) => {
          if (error) reject(new Error(error.message));
          else resolve(stdout);
        });
      });
      expect(ps.split('\n').filter((line) => line.includes(marker))).toEqual([]);
    },
  );

  it('lets benign verification commands succeed inside the sandbox', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-gate-benign-'));
    await writeFile(path.join(worktree, 'result.txt'), 'offline result\n', 'utf8');
    const result = await runSandboxed(
      {
        worktree,
        argv: ['/usr/bin/test', '-f', 'result.txt'],
        cwd: worktree,
      },
      false,
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
