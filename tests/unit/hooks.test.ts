import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_HOOK_SENTINEL_SCHEMA_VERSION,
  activeHookSentinelPath,
  evaluatePreToolUse,
  HOOK_RUNTIME_VERSION,
  hookRuntimeSource,
  resolveHookPaths,
  runHooksCli,
} from '../../src/hooks.js';

async function fixture(): Promise<{ homeDir: string; stateDir: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-hooks-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  await Promise.all([mkdir(homeDir, { recursive: true }), mkdir(stateDir, { recursive: true })]);
  return { homeDir, stateDir, root };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hookInput(
  root: string,
  toolName: 'Bash' | 'apply_patch',
  command: string,
): Record<string, unknown> {
  return {
    session_id: 'session-test',
    turn_id: 'turn-test',
    cwd: root,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'tool-test',
    tool_input: { command },
  };
}

async function activateTask(
  stateDir: string,
  repositoryRoot: string,
  writeScope = ['src/**', 'package.json'],
): Promise<void> {
  await writeJson(activeHookSentinelPath(stateDir, 'repository-one', 'task-one'), {
    schemaVersion: ACTIVE_HOOK_SENTINEL_SCHEMA_VERSION,
    taskId: 'task-one',
    repositoryId: 'repository-one',
  });
  await writeJson(path.join(stateDir, 'tasks', 'task-one', 'state.json'), {
    schemaVersion: 2,
    taskId: 'task-one',
    repository: { id: 'repository-one', root: repositoryRoot },
    contract: { write_scope: writeScope },
  });
}

async function runRuntime(
  runtimePath: string,
  stateDir: string,
  input: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtimePath, '--state-dir', stateDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('user hook CLI', () => {
  it('is a no-write dry run unless --apply is present', async () => {
    const { homeDir, stateDir } = await fixture();
    const paths = resolveHookPaths({ homeDir, stateDir });

    const result = await runHooksCli(['install', '--user'], { homeDir, stateDir });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Dry run');
    expect(result.stdout).toContain('/hooks');
    await expect(readFile(paths.hooksConfigPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.runtimePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('atomically merges with third-party hooks and installs a private versioned runtime', async () => {
    const { homeDir, stateDir } = await fixture();
    const paths = resolveHookPaths({ homeDir, stateDir });
    const thirdParty = {
      description: 'keep this metadata',
      vendor: { enabled: true },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/opt/vendor/start' }] }],
        PreToolUse: [
          {
            matcher: '^Bash$',
            hooks: [
              {
                type: 'command',
                command: '/opt/vendor/check',
                statusMessage: 'Vendor policy',
              },
            ],
          },
        ],
      },
    };
    await writeJson(paths.hooksConfigPath, thirdParty);

    const installed = await runHooksCli(['install', '--user', '--apply'], {
      homeDir,
      stateDir,
    });
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain('/hooks');

    const config = JSON.parse(await readFile(paths.hooksConfigPath, 'utf8')) as typeof thirdParty;
    expect(config.description).toBe(thirdParty.description);
    expect(config.vendor).toEqual(thirdParty.vendor);
    expect(config.hooks.SessionStart).toEqual(thirdParty.hooks.SessionStart);
    expect(config.hooks.PreToolUse[0]).toEqual(thirdParty.hooks.PreToolUse[0]);
    expect(config.hooks.PreToolUse).toHaveLength(2);
    expect(config.hooks.PreToolUse[1]).toMatchObject({ matcher: '^(?:Bash|apply_patch)$' });
    expect(await readFile(paths.runtimePath, 'utf8')).toBe(hookRuntimeSource());
    expect((await stat(paths.runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.runtimePath)).mode & 0o777).toBe(0o600);
    expect(paths.runtimePath).toContain(`/hooks/v${String(HOOK_RUNTIME_VERSION)}/`);

    const firstConfig = await readFile(paths.hooksConfigPath, 'utf8');
    const second = await runHooksCli(['install', '--user', '--apply'], { homeDir, stateDir });
    expect(second.exitCode).toBe(0);
    expect(await readFile(paths.hooksConfigPath, 'utf8')).toBe(firstConfig);
    const statusResult = await runHooksCli(['status', '--user'], { homeDir, stateDir });
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('installed and current');
  });

  it('uninstalls only its own handler, preserving third-party hooks and dry-run state', async () => {
    const { homeDir, stateDir } = await fixture();
    const paths = resolveHookPaths({ homeDir, stateDir });
    await writeJson(paths.hooksConfigPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: '/opt/vendor/check' }],
          },
        ],
      },
    });
    await runHooksCli(['install', '--user', '--apply'], { homeDir, stateDir });
    const installed = await readFile(paths.hooksConfigPath, 'utf8');

    const dryRun = await runHooksCli(['uninstall', '--user'], { homeDir, stateDir });
    expect(dryRun.stdout).toContain('Dry run');
    expect(await readFile(paths.hooksConfigPath, 'utf8')).toBe(installed);

    const removed = await runHooksCli(['uninstall', '--user', '--apply'], {
      homeDir,
      stateDir,
    });
    expect(removed.exitCode).toBe(0);
    const config = JSON.parse(await readFile(paths.hooksConfigPath, 'utf8')) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(config.hooks.PreToolUse).toEqual([
      { matcher: '^Bash$', hooks: [{ type: 'command', command: '/opt/vendor/check' }] },
    ]);
    await expect(readFile(paths.runtimePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const again = await runHooksCli(['uninstall', '--user', '--apply'], { homeDir, stateDir });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('0 Reasonix');
  });

  it('refuses corrupt hooks JSON and leaves the original bytes untouched', async () => {
    const { homeDir, stateDir } = await fixture();
    const paths = resolveHookPaths({ homeDir, stateDir });
    await mkdir(path.dirname(paths.hooksConfigPath), { recursive: true });
    await writeFile(paths.hooksConfigPath, '{not-json\n', 'utf8');

    const result = await runHooksCli(['install', '--user', '--apply'], { homeDir, stateDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('refusing to overwrite');
    expect(await readFile(paths.hooksConfigPath, 'utf8')).toBe('{not-json\n');
  });

  it('does not replace hooks.json when the atomic config write fails', async () => {
    const { homeDir, stateDir } = await fixture();
    const paths = resolveHookPaths({ homeDir, stateDir });
    const original = `${JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }, null, 2)}\n`;
    await writeJson(paths.hooksConfigPath, { hooks: { Stop: [{ hooks: [] }] } });
    await mkdir(path.dirname(paths.runtimePath), { recursive: true });
    await writeFile(paths.runtimePath, hookRuntimeSource(), 'utf8');

    const result = await runHooksCli(['install', '--user', '--apply'], {
      homeDir,
      stateDir,
      atomicWrite: () => Promise.reject(new Error('injected atomic failure')),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('injected atomic failure');
    expect(await readFile(paths.hooksConfigPath, 'utf8')).toBe(original);
  });

  it('validates the exact command grammar', async () => {
    const { homeDir, stateDir } = await fixture();
    await expect(
      runHooksCli(['status', '--user', '--apply'], { homeDir, stateDir }),
    ).resolves.toMatchObject({
      exitCode: 2,
    });
    await expect(runHooksCli(['install'], { homeDir, stateDir })).resolves.toMatchObject({
      exitCode: 2,
    });
    await expect(
      runHooksCli(['install', '--user', '--wat'], { homeDir, stateDir }),
    ).resolves.toMatchObject({
      exitCode: 2,
    });
  });
});

describe('PreToolUse guard', () => {
  it('allows when there is no active-task sentinel', async () => {
    const { stateDir, root } = await fixture();
    const decision = await evaluatePreToolUse(hookInput(root, 'Bash', 'pnpm test'), { stateDir });
    expect(decision).toBeUndefined();
  });

  it('does not apply a healthy sentinel to an unrelated repository cwd', async () => {
    const { stateDir, root } = await fixture();
    const otherRoot = path.join(path.dirname(root), 'unrelated-repository');
    await mkdir(otherRoot, { recursive: true });
    await activateTask(stateDir, root);

    await expect(
      evaluatePreToolUse(hookInput(otherRoot, 'Bash', 'pnpm test'), { stateDir }),
    ).resolves.toBeUndefined();
  });

  it('allows simple reads but denies unknown or write-capable Bash commands', async () => {
    const { stateDir, root } = await fixture();
    await activateTask(stateDir, root);

    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', "rg -n 'needle' src"), { stateDir }),
    ).resolves.toBeUndefined();
    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', 'git status --short'), { stateDir }),
    ).resolves.toBeUndefined();
    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', "sed -n '1,20p' src/a.ts"), { stateDir }),
    ).resolves.toBeUndefined();
    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', "sed -i 's/a/b/' src/a.ts"), { stateDir }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', 'pnpm test'), { stateDir }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', 'rg needle src > result.txt'), { stateDir }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', 'git diff --output=result.patch'), { stateDir }),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('precisely parses apply_patch paths and blocks write-scope overlap', async () => {
    const { stateDir, root } = await fixture();
    await activateTask(stateDir, root);
    const safePatch = [
      '*** Begin Patch',
      '*** Update File: docs/guide.md',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const collision = [
      '*** Begin Patch',
      '*** Update File: docs/guide.md',
      '*** Move to: src/guide.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const multiFileCollision = [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+new',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n');

    await expect(
      evaluatePreToolUse(hookInput(root, 'apply_patch', safePatch), { stateDir }),
    ).resolves.toBeUndefined();
    await expect(
      evaluatePreToolUse(hookInput(root, 'apply_patch', collision), { stateDir }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Reasonix blocked a source collision on src/guide.ts.',
      },
    });
    await expect(
      evaluatePreToolUse(hookInput(root, 'apply_patch', multiFileCollision), { stateDir }),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await activateTask(stateDir, root, ['src']);
    await expect(
      evaluatePreToolUse(
        hookInput(
          root,
          'apply_patch',
          '*** Begin Patch\n*** Add File: src/nested/file.ts\n+x\n*** End Patch',
        ),
        { stateDir },
      ),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await expect(
      evaluatePreToolUse(
        hookInput(
          root,
          'apply_patch',
          '*** Begin Patch\n*** Add File: "src/quoted file.ts"\n+x\n*** End Patch',
        ),
        { stateDir },
      ),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await expect(
      evaluatePreToolUse(hookInput(root, 'apply_patch', '*** Begin Patch\n*** End Patch'), {
        stateDir,
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(
      evaluatePreToolUse(
        hookInput(
          root,
          'apply_patch',
          '*** Begin Patch\n*** Add File: ../escape\n+x\n*** End Patch',
        ),
        { stateDir },
      ),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('checks absolute patch targets against active roots from an unrelated cwd', async () => {
    const { stateDir, root } = await fixture();
    await activateTask(stateDir, root);
    const unrelatedCwd = path.join(os.tmpdir(), 'reasonix-unrelated-repository');
    const absolutePatch = (target: string): string =>
      ['*** Begin Patch', `*** Add File: ${target}`, '+content', '*** End Patch'].join('\n');

    await expect(
      evaluatePreToolUse(
        hookInput(unrelatedCwd, 'apply_patch', absolutePatch(path.join(root, 'src', 'owned.ts'))),
        { stateDir },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Reasonix blocked a source collision on src/owned.ts.',
      },
    });
    await expect(
      evaluatePreToolUse(
        hookInput(
          unrelatedCwd,
          'apply_patch',
          absolutePatch(path.join(root, 'docs', 'unowned.md')),
        ),
        { stateDir },
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed for Bash and apply_patch when a sentinel or state is corrupt', async () => {
    const { stateDir, root } = await fixture();
    await writeJson(activeHookSentinelPath(stateDir, 'repository-one', 'missing-task'), {
      schemaVersion: 1,
      taskId: 'missing-task',
      repositoryId: 'repository-one',
    });

    for (const input of [
      hookInput(root, 'Bash', 'git status'),
      hookInput(root, 'apply_patch', '*** Begin Patch\n*** Add File: docs/a\n+x\n*** End Patch'),
    ]) {
      await expect(evaluatePreToolUse(input, { stateDir })).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        },
      });
    }
  });

  it('fails closed for a future task-state schema', async () => {
    const { stateDir, root } = await fixture();
    await activateTask(stateDir, root);
    const statePath = path.join(stateDir, 'tasks', 'task-one', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    await writeJson(statePath, { ...state, schemaVersion: 99 });

    await expect(
      evaluatePreToolUse(hookInput(root, 'Bash', 'git status'), { stateDir }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('runs the installed dependency-free runtime from the private state path', async () => {
    const { homeDir, stateDir, root } = await fixture();
    await activateTask(stateDir, root);
    const paths = resolveHookPaths({ homeDir, stateDir });
    const install = await runHooksCli(['install', '--user', '--apply'], { homeDir, stateDir });
    expect(install.exitCode).toBe(0);

    const result = await runRuntime(
      paths.runtimePath,
      stateDir,
      hookInput(root, 'Bash', 'pnpm test'),
    );

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
  });
});
