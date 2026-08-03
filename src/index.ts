#!/usr/bin/env node

import process from 'node:process';

import { isCliEntrypoint } from './cli-entrypoint.js';
import { loadConfig } from './config.js';
import { runContractLintCli } from './contract-lint.js';
import { runDoctor } from './doctor.js';
import { runHooksCli } from './hooks.js';
import { runTaskCli } from './task-operations.js';
import { BridgeRuntime } from './runtime.js';
import { serveStdio } from './server.js';
import { VERSION } from './version.js';

export * from './config.js';
export * from './contract-lint.js';
export * from './contracts.js';
export * from './hooks.js';
export * from './metrics.js';
export * from './runtime.js';
export * from './server.js';
export * from './types.js';
export * from './task-operations.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  const command = argv[2] ?? 'serve';
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === 'doctor') {
    const args = argv.slice(3);
    const deep = args.includes('--deep');
    const allowProviderCall = args.includes('--allow-provider-call');
    if (
      args.some((arg) => arg !== '--deep' && arg !== '--allow-provider-call') ||
      (allowProviderCall && !deep)
    ) {
      process.stderr.write('Usage: codex-reasonix-mcp doctor [--deep --allow-provider-call]\n');
      process.exitCode = 2;
      return;
    }
    const report = await runDoctor(loadConfig(), { deep, allowProviderCall });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'contract') {
    const result = await runContractLintCli(argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === 'hooks') {
    const result = await runHooksCli(argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === 'task') {
    const result = await runTaskCli(argv.slice(3), { stateDir: loadConfig().stateDir });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }
  if (command !== 'serve') {
    process.stderr.write(
      'Usage: codex-reasonix-mcp [serve|doctor [--deep --allow-provider-call]|version|contract lint|hooks install|status|uninstall|task list|archive|prune]\n',
    );
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

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
