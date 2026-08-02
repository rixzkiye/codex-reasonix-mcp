#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.bundledDependencies || manifest.bundleDependencies) {
  throw new Error('Reasonix and other dependencies must not be bundled');
}

const raw = execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const report = JSON.parse(raw);
if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0]?.files)) {
  throw new Error('npm pack returned an unexpected JSON report');
}

const entries = report[0].files;
const paths = entries.map((entry) => String(entry.path).replaceAll('\\', '/'));
const allowedRoots = ['dist/', 'docs/', 'examples/'];
const allowedFiles = new Set([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
]);
const forbidden =
  /(?:^|\/)(?:\.git|\.github|\.tmp|node_modules|src|tests|scripts|coverage)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.tsbuildinfo$/i;
const unexpected = paths.filter(
  (file) =>
    forbidden.test(file) ||
    (!allowedFiles.has(file) && !allowedRoots.some((prefix) => file.startsWith(prefix))),
);
if (unexpected.length > 0) {
  throw new Error(`Unexpected npm package content: ${unexpected.join(', ')}`);
}

for (const required of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
  if (!paths.includes(required)) throw new Error(`Required package file is missing: ${required}`);
}

const unpackedSize = Number(report[0].unpackedSize ?? 0);
if (!Number.isSafeInteger(unpackedSize) || unpackedSize <= 0 || unpackedSize > 10 * 1024 * 1024) {
  throw new Error(`Unexpected unpacked npm package size: ${String(unpackedSize)}`);
}

const smokeRoot = mkdtempSync(path.join(os.tmpdir(), 'codex-reasonix-package-bin-'));
try {
  const binPath = path.join(smokeRoot, 'codex-reasonix-mcp');
  symlinkSync(path.join(root, 'dist', 'index.js'), binPath);
  const binVersion = execFileSync(process.execPath, [binPath, 'version'], {
    cwd: smokeRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  if (binVersion !== manifest.version) {
    throw new Error(
      `Packaged CLI bin reported ${binVersion || '<empty>'}; expected ${String(manifest.version)}`,
    );
  }
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Package content OK: ${String(paths.length)} files, ${String(unpackedSize)} unpacked bytes\n`,
);
