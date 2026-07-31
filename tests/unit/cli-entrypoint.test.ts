import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isCliEntrypoint } from '../../src/cli-entrypoint.js';

describe('CLI entrypoint detection', () => {
  it('recognizes direct and package-bin symlink invocation paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-cli-entrypoint-'));
    const modulePath = path.join(root, 'dist', 'index.js');
    const binPath = path.join(root, 'node_modules', '.bin', 'codex-reasonix-mcp');
    await Promise.all([
      mkdir(path.dirname(modulePath), { recursive: true }),
      mkdir(path.dirname(binPath), { recursive: true }),
    ]);
    await writeFile(modulePath, '');
    await symlink(modulePath, binPath);

    if ((await realpath(binPath)) !== (await realpath(modulePath))) {
      throw new Error('test fixture did not create a package-bin symlink');
    }

    const moduleUrl = pathToFileURL(modulePath).href;
    expect(isCliEntrypoint(moduleUrl, modulePath)).toBe(true);
    expect(isCliEntrypoint(moduleUrl, binPath)).toBe(true);
  });

  it('fails closed for missing or unrelated invocation paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-cli-entrypoint-'));
    const modulePath = path.join(root, 'index.js');
    const otherPath = path.join(root, 'other.js');
    await Promise.all([writeFile(modulePath, ''), writeFile(otherPath, '')]);
    const moduleUrl = pathToFileURL(modulePath).href;

    expect(isCliEntrypoint(moduleUrl, undefined)).toBe(false);
    expect(isCliEntrypoint(moduleUrl, otherPath)).toBe(false);
    expect(isCliEntrypoint(moduleUrl, path.join(root, 'missing.js'))).toBe(false);
  });
});
