import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';

describe('subprocess lifecycle', () => {
  it('kills the entire POSIX process group on timeout', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'reasonix-command-tree-'));
    const marker = path.join(directory, 'descendant-survived');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'), 600)`;
    const parent = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref()`,
      'setInterval(() => {}, 1000)',
    ].join(';');

    const result = await runCommand({
      argv: [process.execPath, '-e', parent],
      cwd: directory,
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not leak descendants when the direct child exits successfully', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'reasonix-command-exit-tree-'));
    const marker = path.join(directory, 'background-descendant-survived');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'), 500)`;
    const parent = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref()`,
    ].join(';');

    const result = await runCommand({
      argv: [process.execPath, '-e', parent],
      cwd: directory,
      timeoutMs: 2_000,
    });
    expect(result.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
