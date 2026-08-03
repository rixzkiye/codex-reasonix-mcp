import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCliEntrypoint } from '../../src/cli-entrypoint.js';
import { runContractLintCli } from '../../src/contract-lint.js';
import { main } from '../../src/index.js';
import { contractFixture } from '../helpers.js';

const originalStateDir = process.env.CODEX_REASONIX_STATE_DIR;
const originalReasonixBin = process.env.REASONIX_BIN;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (originalStateDir === undefined) delete process.env.CODEX_REASONIX_STATE_DIR;
  else process.env.CODEX_REASONIX_STATE_DIR = originalStateDir;
  if (originalReasonixBin === undefined) delete process.env.REASONIX_BIN;
  else process.env.REASONIX_BIN = originalReasonixBin;
});

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

describe('contract lint CLI', () => {
  it('lints a contract from a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-contract-lint-'));
    const file = path.join(root, 'contract.json');
    await writeFile(file, `${JSON.stringify(contractFixture())}\n`);

    const result = await runContractLintCli(['lint', '--file', file]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${file}: valid TaskContractV1`);
    expect(result.stdout).toMatch(/sha256 [0-9a-f]{64}/);
    expect(result.stderr).toBe('');
  });

  it('reports every lint issue from stdin in one response', async () => {
    const fixture = contractFixture();
    const result = await runContractLintCli(['lint', '--stdin'], {
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            ...fixture,
            verified_context: [{ path: '/absolute', reason: 'invalid' }],
            write_scope: ['../escape'],
            verification: [{ ...fixture.verification[0], cwd: '../escape', proves: ['missing'] }],
          }),
        ),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('<stdin>: invalid TaskContractV1 (5 issues)');
    expect(result.stderr).toContain('- verified_context.0.path:');
    expect(result.stderr).toContain('- write_scope.0:');
    expect(result.stderr).toContain('- verification.0.cwd:');
    expect(result.stderr).toContain('- verification.0.proves.0:');
    expect(result.stderr).toContain('- verification:');
  });

  it.each([
    ['requires a source', ['lint']],
    ['rejects both sources', ['lint', '--stdin', '--file', 'contract.json']],
    ['rejects unknown flags', ['lint', '--wat']],
  ])('%s', async (_name, args) => {
    const result = await runContractLintCli(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Usage: codex-reasonix-mcp contract lint');
  });
});

describe('package CLI dispatch', () => {
  function captureProcessOutput(): { stdout: string[]; stderr: string[] } {
    const output = { stdout: [] as string[], stderr: [] as string[] };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.stderr.push(String(chunk));
      return true;
    });
    return output;
  }

  it.each(['version', '--version', '-v'])('prints the version for %s', async (command) => {
    const output = captureProcessOutput();
    await main(['node', 'codex-reasonix-mcp', command]);
    expect(output.stdout.join('')).toMatch(/^0\.1\.1/);
    expect(output.stderr).toEqual([]);
  });

  it('dispatches contract, hooks, and task commands through the package entrypoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-main-cli-'));
    const contract = path.join(root, 'contract.json');
    await writeFile(contract, `${JSON.stringify(contractFixture())}\n`);
    process.env.CODEX_REASONIX_STATE_DIR = path.join(root, 'state');
    const output = captureProcessOutput();

    await main(['node', 'codex-reasonix-mcp', 'contract', 'lint', '--file', contract]);
    await main(['node', 'codex-reasonix-mcp', 'hooks', 'unknown']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await main(['node', 'codex-reasonix-mcp', 'task', 'list', '--json']);

    expect(output.stdout.join('')).toContain('valid TaskContractV1');
    expect(output.stdout.join('')).toContain('[]');
    expect(output.stderr.join('')).toContain('codex-reasonix-mcp hooks install');
  });

  it('rejects invalid doctor and top-level command grammars without provider calls', async () => {
    const output = captureProcessOutput();
    await main(['node', 'codex-reasonix-mcp', 'doctor', '--allow-provider-call']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await main(['node', 'codex-reasonix-mcp', 'unknown']);
    expect(process.exitCode).toBe(2);
    expect(output.stderr.join('')).toContain('doctor [--deep --allow-provider-call]');
    expect(output.stderr.join('')).toContain('codex-reasonix-mcp [serve|doctor');
  });

  it('runs the standard doctor lane without opening a provider session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-main-doctor-'));
    process.env.CODEX_REASONIX_STATE_DIR = path.join(root, 'state');
    process.env.REASONIX_BIN = process.execPath;
    const output = captureProcessOutput();

    await main(['node', 'codex-reasonix-mcp', 'doctor']);

    expect(process.exitCode).toBe(1);
    const report = JSON.parse(output.stdout.join('')) as {
      ok: boolean;
      checks: Array<{ name: string; detail: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'provider_call')?.detail).toContain(
      'No ACP session',
    );
  });
});
