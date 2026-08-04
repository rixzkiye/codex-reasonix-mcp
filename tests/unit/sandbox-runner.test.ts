import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBwrapArgv,
  buildSeatbeltProfile,
  detectSandbox,
  resolveCredentialOverlays,
  runSandboxed,
  type CredentialOverlay,
} from '../../src/sandbox-runner.js';

// Cached sandbox status for skipIf gating (top-level await is valid ESM).
const sandboxStatus = await detectSandbox();

const overlays: CredentialOverlay[] = [
  { path: '/home/user/.ssh', kind: 'dir' },
  { path: '/home/user/.npmrc', kind: 'file' },
];

describe('bwrap argv construction', () => {
  const base = {
    worktree: '/state/worktrees/r/task',
    argv: ['test', '-f', 'result.txt'] as [string, ...string[]],
    cwd: '/state/worktrees/r/task',
  };

  it('applies the fail-closed posture flags', () => {
    const argv = buildBwrapArgv(base, []);
    expect(argv).toContain('--die-with-parent');
    // explicit namespace isolation without --new-session (which would let
    // the pidns-resident inner process escape the launcher's process group)
    expect(argv).toEqual(expect.arrayContaining(['--unshare-user']));
    expect(argv).toEqual(expect.arrayContaining(['--unshare-ipc']));
    expect(argv).toEqual(expect.arrayContaining(['--unshare-net']));
    expect(argv).toEqual(expect.arrayContaining(['--unshare-uts']));
    expect(argv).toEqual(expect.arrayContaining(['--unshare-pid']));
    expect(argv).not.toContain('--new-session');
    expect(argv).toContain('--ro-bind');
    // read-only root, private tmp, proc, dev
    expect(argv).toEqual(expect.arrayContaining(['--ro-bind', '/', '/']));
    expect(argv).toEqual(expect.arrayContaining(['--tmpfs', '/tmp']));
    expect(argv).toEqual(expect.arrayContaining(['--proc', '/proc']));
    expect(argv).toEqual(expect.arrayContaining(['--dev', '/dev']));
    // writable worktree bind
    expect(argv).toEqual(
      expect.arrayContaining(['--bind', '/state/worktrees/r/task', '/state/worktrees/r/task']),
    );
    // chdir + argv terminator
    expect(argv).toEqual(
      expect.arrayContaining([
        '--chdir',
        '/state/worktrees/r/task',
        '--',
        'test',
        '-f',
        'result.txt',
      ]),
    );
    expect(argv[0]).toBe('bwrap');
  });

  it('hides credential dirs with tmpfs and files with /dev/null', () => {
    const argv = buildBwrapArgv(base, overlays);
    expect(argv).toEqual(expect.arrayContaining(['--tmpfs', '/home/user/.ssh']));
    expect(argv).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', '/home/user/.npmrc']));
  });

  it('binds the repository root and extra read-only paths', () => {
    const argv = buildBwrapArgv(
      { ...base, repositoryRoot: '/repo', readOnlyPaths: ['/tmp/commit-x'] },
      [],
    );
    expect(argv).toEqual(expect.arrayContaining(['--ro-bind', '/repo', '/repo']));
    expect(argv).toEqual(expect.arrayContaining(['--ro-bind', '/tmp/commit-x', '/tmp/commit-x']));
    // writable worktree bind comes after the read-only binds
    expect(argv.indexOf('--bind')).toBeGreaterThan(argv.indexOf('--ro-bind'));
  });
});

describe('seatbelt profile construction', () => {
  const base = {
    worktree: '/Users/user/state/worktrees/r/task',
    argv: ['test', '-f', 'result.txt'] as [string, ...string[]],
    cwd: '/Users/user/state/worktrees/r/task',
  };

  it('denies network and filesystem writes outside the worktree', () => {
    const profile = buildSeatbeltProfile(base, overlays);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-write* (subpath "/"))');
    expect(profile).toContain('(deny file-link)');
    expect(profile).toContain('(allow file-write* (subpath "/Users/user/state/worktrees/r/task"))');
    // host temp stays writable as the sandbox scratch space
    expect(profile).toContain(`(allow file-write* (subpath "${os.tmpdir()}"))`);
  });

  it('denies reads of credential overlays and allows read-only binds', () => {
    const profile = buildSeatbeltProfile(
      { ...base, repositoryRoot: '/repo', readOnlyPaths: ['/tmp/commit-x'] },
      overlays,
    );
    expect(profile).toContain('(deny file-read* (subpath "/home/user/.ssh"))');
    expect(profile).toContain('(deny file-read* (subpath "/home/user/.npmrc"))');
    expect(profile).toContain('(allow file-read* (subpath "/repo"))');
    expect(profile).toContain('(allow file-read* (subpath "/tmp/commit-x"))');
  });

  it('escapes quotes in paths', () => {
    const profile = buildSeatbeltProfile({ ...base, worktree: '/Users/u "x"/wt' }, [
      { path: '/Users/u "x"/.ssh', kind: 'dir' },
    ]);
    expect(profile).toContain('(allow file-write* (subpath "/Users/u \\"x\\"/wt"))');
  });
});

describe('credential overlay resolution', () => {
  it('covers credential stores including kube/docker/password stores and macOS keychains', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'reasonix-overlay-home-'));
    try {
      await mkdir(path.join(home, '.ssh'));
      await mkdir(path.join(home, '.kube'));
      await mkdir(path.join(home, '.docker'));
      await mkdir(path.join(home, '.password-store'));
      await mkdir(path.join(home, 'Library', 'Keychains'), { recursive: true });
      await writeFile(path.join(home, '.git-credentials'), 'https://user:pass@example.com\n');
      const overlays = await resolveCredentialOverlays(home);
      for (const name of ['.ssh', '.kube', '.docker', '.password-store', 'Library/Keychains']) {
        expect(overlays).toEqual(
          expect.arrayContaining([{ path: path.join(home, name), kind: 'dir' }]),
        );
      }
      expect(overlays).toEqual(
        expect.arrayContaining([{ path: path.join(home, '.git-credentials'), kind: 'file' }]),
      );
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true }));
    }
  });

  it('only includes paths that exist and match their expected kind', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'reasonix-overlay-home-'));
    try {
      await mkdir(path.join(home, '.ssh'));
      await writeFile(path.join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
      const overlays = await resolveCredentialOverlays(home);
      expect(overlays).toEqual(
        expect.arrayContaining([
          { path: path.join(home, '.ssh'), kind: 'dir' },
          { path: path.join(home, '.npmrc'), kind: 'file' },
        ]),
      );
      expect(overlays).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: path.join(home, '.aws') })]),
      );
      if (process.platform === 'linux') {
        expect(overlays).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: '/root' })]),
        );
      }
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true }));
    }
  });
});

describe('runSandboxed', () => {
  it('fails closed when no sandbox engine is available', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-fail-'));
    await expect(
      runSandboxed({ worktree, argv: ['/bin/true'], cwd: worktree }, false, () => ({
        available: false,
        engine: null,
        reason: 'no engine for test',
      })),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  });

  it('runs the command unsandboxed when the explicit escape hatch is set', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-hatch-'));
    const result = await runSandboxed(
      { worktree, argv: ['/bin/echo', 'plain'], cwd: worktree },
      true,
      () => ({ available: false, engine: null, reason: 'no engine for test' }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('plain');
    expect(result.argv[0]).toBe('/bin/echo');
  });

  it.skipIf(!sandboxStatus.available)('runs a benign command inside the sandbox', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-run-'));
    const result = await runSandboxed(
      {
        worktree,
        argv: ['/bin/sh', '-c', 'echo sandboxed && pwd'],
        cwd: worktree,
      },
      false,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sandboxed');
    // cwd is preserved inside the sandbox
    expect(result.stdout).toContain(worktree);
  });

  it.skipIf(!sandboxStatus.available)('writes in the worktree but not outside it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-write-'));
    const worktree = path.join(root, 'worktree');
    await mkdir(worktree);
    const result = await runSandboxed(
      {
        worktree,
        argv: [
          '/bin/sh',
          '-c',
          `echo ok > inside.txt; touch ${path.join(root, 'escaped.txt')} 2>/dev/null; echo done`,
        ],
        cwd: worktree,
      },
      false,
    );
    expect(result.exitCode).toBe(0);
    const { readFile, stat } = await import('node:fs/promises');
    expect((await readFile(path.join(worktree, 'inside.txt'), 'utf8')).trim()).toBe('ok');
    await expect(stat(path.join(root, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!sandboxStatus.available || process.platform !== 'linux')(
    'has no network inside the sandbox',
    async () => {
      const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-net-'));
      const result = await runSandboxed(
        {
          worktree,
          argv: ['/bin/sh', '-c', 'cat /proc/net/dev'],
          cwd: worktree,
        },
        false,
      );
      expect(result.exitCode).toBe(0);
      const interfaces = result.stdout
        .split('\n')
        .slice(2) // skip the two /proc/net/dev header lines
        .map((line) => line.trim().split(':')[0])
        .filter((name) => name);
      expect(interfaces).toEqual(['lo']);
    },
  );

  it.skipIf(!sandboxStatus.available)('leaves no descendant processes behind', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-desc-'));
    const marker = `reasonix-gate-sleep-${process.pid}`;
    const result = await runSandboxed(
      {
        worktree,
        argv: ['/bin/bash', '-c', `exec -a ${marker} sleep 45 & echo launched`],
        cwd: worktree,
      },
      false,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('launched');
    // Give any escaped process a moment to surface, then verify none remains.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { execFile } = await import('node:child_process');
    const ps = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-eo', 'args='], (error, stdout) => {
        if (error) reject(new Error(error.message));
        else resolve(stdout);
      });
    });
    expect(ps.split('\n').filter((line) => line.includes(marker))).toEqual([]);
  });

  it.skipIf(!sandboxStatus.available)('pins a writable TMPDIR inside the sandbox', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-tmp-'));
    const result = await runSandboxed(
      {
        worktree,
        argv: [
          '/bin/sh',
          '-c',
          'echo TMPDIR=$TMPDIR; touch $TMPDIR/probe-$$.tmp && echo TMP_WRITABLE',
        ],
        cwd: worktree,
      },
      false,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TMPDIR=/tmp');
    expect(result.stdout).toContain('TMP_WRITABLE');
  });

  it.skipIf(!sandboxStatus.available)('resolves symlinked worktrees before binding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-sandbox-link-'));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    await mkdir(real);
    await symlink(real, link);
    const result = await runSandboxed(
      {
        worktree: link,
        argv: ['/bin/pwd'],
        cwd: link,
      },
      false,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(real);
  });
});
