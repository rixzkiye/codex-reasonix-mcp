#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(manifest.version ?? '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`);
}
const releaseTag =
  process.env.RELEASE_TAG?.trim() || process.argv.find((arg) => arg.startsWith('v'));
if (!releaseTag || releaseTag !== `v${version}`) {
  throw new Error(
    `Release tag must exactly match package version v${version}; got ${releaseTag ?? '<none>'}`,
  );
}
const distTag = version.includes('-') ? 'next' : 'latest';
const output = { version, release_tag: releaseTag, dist_tag: distTag };

if (process.argv.includes('--github-output')) {
  const destination = process.env.GITHUB_OUTPUT;
  if (!destination) throw new Error('GITHUB_OUTPUT is required with --github-output');
  appendFileSync(
    destination,
    Object.entries(output)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    'utf8',
  );
} else {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
