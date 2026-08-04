import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { contractHash, lintTaskContract, parseTaskContract } from './contracts.js';

export interface ContractLintResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ContractLintDependencies {
  readFile?: (file: string) => Promise<string>;
  readStdin?: () => Promise<string>;
}

export const CONTRACT_LINT_USAGE =
  'Usage: codex-reasonix-mcp contract lint (--file <path> | --stdin)\n';

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function usageError(message: string): ContractLintResult {
  return { exitCode: 2, stdout: '', stderr: `${message}\n${CONTRACT_LINT_USAGE}` };
}

export async function runContractLintCli(
  args: readonly string[],
  dependencies: ContractLintDependencies = {},
): Promise<ContractLintResult> {
  if (args[0] !== 'lint') return usageError('Expected contract lint subcommand.');

  let file: string | undefined;
  let stdin = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--stdin') {
      if (stdin) return usageError('--stdin may be specified only once.');
      stdin = true;
      continue;
    }
    if (argument === '--file') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return usageError('--file requires a path.');
      if (file) return usageError('--file may be specified only once.');
      file = value;
      index += 1;
      continue;
    }
    return usageError(`Unknown contract lint argument: ${argument ?? ''}`);
  }
  if ((file ? 1 : 0) + (stdin ? 1 : 0) !== 1) {
    return usageError('Choose exactly one contract source: --file or --stdin.');
  }

  const source = file ?? '<stdin>';
  let raw: string;
  try {
    raw = file
      ? await (dependencies.readFile ?? (async (target) => await readFile(target, 'utf8')))(file)
      : await (dependencies.readStdin ?? readStandardInput)();
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${source}: unable to read contract: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${source}: invalid TaskContractV1 (1 issue)\n- $: invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  const issues = lintTaskContract(input);
  if (issues.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${source}: invalid TaskContractV1 (${issues.length} issues)\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join('\n')}\n`,
    };
  }

  const contract = parseTaskContract(input);
  return {
    exitCode: 0,
    stdout: `${source}: valid TaskContractV1\nsha256 ${contractHash(contract)}\n`,
    stderr: '',
  };
}
