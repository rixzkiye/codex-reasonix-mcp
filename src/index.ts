#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { BridgeRuntime } from './runtime.js';
import { serveStdio } from './server.js';
import { VERSION } from './version.js';

export * from './config.js';
export * from './contracts.js';
export * from './runtime.js';
export * from './server.js';
export * from './types.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === 'doctor') {
    const report = await runDoctor(loadConfig());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command !== 'serve') {
    process.stderr.write('Usage: codex-reasonix-mcp [serve|doctor|version]\n');
    process.exitCode = 2;
    return;
  }

  const runtime = new BridgeRuntime(loadConfig());
  const shutdown = (): void => {
    void runtime.shutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await serveStdio(runtime);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
