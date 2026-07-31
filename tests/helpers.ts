import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { TaskContractV1 } from '../src/contracts.js';
import { runCommand } from '../src/command.js';

export async function createGitRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-reasonix-repo-'));
  for (const argv of [
    ['git', 'init', '-b', 'main'],
    ['git', 'config', 'user.name', 'Codex Reasonix Test'],
    ['git', 'config', 'user.email', 'codex-reasonix@example.invalid'],
  ] as Array<[string, ...string[]]>) {
    const result = await runCommand({ argv, cwd: directory });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  await writeFile(path.join(directory, 'README.md'), '# Fixture\n', 'utf8');
  for (const argv of [
    ['git', 'add', '--', 'README.md'],
    ['git', 'commit', '-m', 'fixture: initial'],
  ] as Array<[string, ...string[]]>) {
    const result = await runCommand({ argv, cwd: directory });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  return directory;
}

export function contractFixture(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  return {
    schema_version: 1,
    objective: 'Create an offline result file',
    user_outcome: 'The repository contains the expected result',
    verified_context: [{ path: 'README.md', reason: 'Repository fixture' }],
    write_scope: ['result.txt'],
    forbidden_scope: ['secrets/**'],
    invariants: ['Do not modify README.md'],
    non_goals: ['No network calls'],
    acceptance_criteria: [
      { id: 'ac_result', requirement: 'result.txt has expected content', evidence: 'automated' },
    ],
    verification: [
      {
        id: 'verify_result',
        argv: [
          process.execPath,
          '-e',
          "const fs=require('fs');if(fs.readFileSync('result.txt','utf8')!=='offline result\\n')process.exit(1)",
        ],
        cwd: '.',
        timeout_seconds: 30,
        proves: ['ac_result'],
      },
    ],
    pause_conditions: ['Any requested scope expansion'],
    ...overrides,
  };
}

export function sandboxMeta(repository: string, network = false): Record<string, unknown> {
  return {
    'codex/sandbox-state-meta': {
      permissionProfile: {
        type: 'managed',
        file_system: {
          type: 'restricted',
          entries: [
            { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
            {
              path: { type: 'special', value: { kind: 'project_roots' } },
              access: 'write',
            },
          ],
        },
        network: network ? 'enabled' : 'restricted',
      },
      codexLinuxSandboxExe: null,
      sandboxCwd: pathToFileURL(repository).href,
      useLegacyLandlock: false,
    },
  };
}

export async function waitUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
