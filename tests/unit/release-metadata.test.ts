import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCommand } from '../../src/command.js';
import { VERSION } from '../../src/version.js';

async function releaseMetadata(version: string): Promise<Record<string, unknown>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-release-metadata-'));
  const scripts = path.join(root, 'scripts');
  await mkdir(scripts);
  await Promise.all([
    copyFile(
      path.resolve('scripts/release-metadata.mjs'),
      path.join(scripts, 'release-metadata.mjs'),
    ),
    writeFile(path.join(root, 'package.json'), `${JSON.stringify({ version })}\n`),
  ]);
  try {
    const result = await runCommand({
      argv: [process.execPath, 'scripts/release-metadata.mjs', `v${version}`],
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('release metadata', () => {
  it('keeps the package and runtime versions aligned', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version?: unknown };
    expect(manifest.version).toBe(VERSION);
  });

  it.each([
    ['0.2.0-rc.3', 'next'],
    ['0.2.0', 'latest'],
  ])('maps %s to the %s npm dist-tag', async (version, distTag) => {
    await expect(releaseMetadata(version)).resolves.toEqual({
      version,
      release_tag: `v${version}`,
      dist_tag: distTag,
    });
  });
});
