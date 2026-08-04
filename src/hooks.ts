import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const HOOK_RUNTIME_VERSION = 1 as const;
export const ACTIVE_HOOK_SENTINEL_SCHEMA_VERSION = 1 as const;

const HOOK_STATUS_MESSAGE = '[codex-reasonix-mcp] Guard source collisions';
const HOOK_MATCHER = '^(?:Bash|apply_patch)$';
const TRUST_NOTICE =
  'Review and trust the installed hook with /hooks; installation does not bypass Codex trust.';

export interface ActiveHookSentinelV1 {
  schemaVersion: typeof ACTIVE_HOOK_SENTINEL_SCHEMA_VERSION;
  taskId: string;
  repositoryId: string;
}

export interface HookPaths {
  hooksConfigPath: string;
  runtimeDirectory: string;
  runtimePath: string;
  activeDirectory: string;
}

export interface HookCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type AtomicWriter = (file: string, contents: string, mode: number) => Promise<void>;

export interface HookCliOptions {
  homeDir?: string;
  stateDir?: string;
  nodePath?: string;
  atomicWrite?: AtomicWriter;
  removeFile?: (file: string) => Promise<void>;
}

export interface HookGuardOptions {
  stateDir: string;
  readTextFile?: (file: string) => Promise<string>;
}

interface ActiveGuardState {
  root: string;
  writeScope: string[];
}

type LoadedGuardState = ActiveGuardState[] | 'corrupt' | undefined;

interface PathApi {
  basename(value: string): string;
  isAbsolute(value: string): boolean;
  normalize(value: string): string;
  relative(from: string, to: string): string;
  resolve(...values: string[]): string;
  sep: string;
}

export interface PreToolUseDenial {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

function defaultStateDir(homeDir: string): string {
  const override = process.env.CODEX_REASONIX_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), 'codex-reasonix-mcp');
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'codex-reasonix-mcp');
  }
  return path.join(homeDir, '.local', 'state', 'codex-reasonix-mcp');
}

export function resolveHookPaths(
  options: Pick<HookCliOptions, 'homeDir' | 'stateDir'> = {},
): HookPaths {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir(homeDir));
  const runtimeDirectory = path.join(stateDir, 'hooks', `v${String(HOOK_RUNTIME_VERSION)}`);
  return {
    hooksConfigPath: path.join(homeDir, '.codex', 'hooks.json'),
    runtimeDirectory,
    runtimePath: path.join(runtimeDirectory, 'pre-tool-use.mjs'),
    activeDirectory: path.join(stateDir, 'active'),
  };
}

function safeIdentity(value: string, name: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ||
    value.includes('..') ||
    value.endsWith('.lock') ||
    value === '.'
  ) {
    throw new Error(`${name} is not a safe state identity`);
  }
  return value;
}

/** Canonical sentinel path used by core lifecycle integration. */
export function activeHookSentinelPath(
  stateDir: string,
  repositoryId: string,
  taskId: string,
): string {
  return path.join(
    path.resolve(stateDir),
    'active',
    safeIdentity(repositoryId, 'repositoryId'),
    `${safeIdentity(taskId, 'taskId')}.json`,
  );
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWriteFile(file: string, contents: string, mode: number): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await chmod(file, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hookCommand(paths: HookPaths, nodePath: string, stateDir: string): string {
  return [
    shellQuote(path.resolve(nodePath)),
    shellQuote(paths.runtimePath),
    '--state-dir',
    shellQuote(path.resolve(stateDir)),
  ].join(' ');
}

function ownHandler(command: string): Record<string, unknown> {
  return {
    type: 'command',
    command,
    timeout: 5,
    statusMessage: HOOK_STATUS_MESSAGE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOwnedHandler(value: unknown, stateDir: string): boolean {
  if (!isRecord(value)) return false;
  if (
    value.type !== 'command' ||
    value.statusMessage !== HOOK_STATUS_MESSAGE ||
    typeof value.command !== 'string'
  ) {
    return false;
  }
  const runtimeRoot = path.join(path.resolve(stateDir), 'hooks');
  return value.command.includes(runtimeRoot) && value.command.includes('pre-tool-use.mjs');
}

function parseHooksConfig(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON; refusing to overwrite it`);
  }
  if (!isRecord(parsed)) throw new Error(`${source} must contain a JSON object`);
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    throw new Error(`${source}.hooks must be a JSON object`);
  }
  const preToolUse = isRecord(parsed.hooks) ? parsed.hooks.PreToolUse : undefined;
  if (preToolUse !== undefined && !Array.isArray(preToolUse)) {
    throw new Error(`${source}.hooks.PreToolUse must be an array`);
  }
  return parsed;
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    return parseHooksConfig(await readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function withoutOwnedHandlers(
  config: Record<string, unknown>,
  stateDir: string,
): { config: Record<string, unknown>; removed: number } {
  const hooks = isRecord(config.hooks) ? config.hooks : undefined;
  const preToolUse = hooks?.PreToolUse;
  if (!Array.isArray(preToolUse)) return { config, removed: 0 };

  let removed = 0;
  const nextGroups: unknown[] = [];
  for (const groupValue of preToolUse) {
    if (!isRecord(groupValue) || !Array.isArray(groupValue.hooks)) {
      nextGroups.push(groupValue);
      continue;
    }
    const remaining = groupValue.hooks.filter((handler) => {
      const owned = isOwnedHandler(handler, stateDir);
      if (owned) removed += 1;
      return !owned;
    });
    if (remaining.length > 0) nextGroups.push({ ...groupValue, hooks: remaining });
  }
  if (removed === 0) return { config, removed };

  const nextHooks: Record<string, unknown> = { ...hooks };
  if (nextGroups.length > 0) nextHooks.PreToolUse = nextGroups;
  else delete nextHooks.PreToolUse;
  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(nextHooks).length > 0) nextConfig.hooks = nextHooks;
  else delete nextConfig.hooks;
  return { config: nextConfig, removed };
}

function mergedConfig(
  config: Record<string, unknown>,
  command: string,
  stateDir: string,
): Record<string, unknown> {
  const stripped = withoutOwnedHandlers(config, stateDir).config;
  const hooks: Record<string, unknown> = isRecord(stripped.hooks) ? { ...stripped.hooks } : {};
  const existingPreToolUse: unknown = hooks.PreToolUse;
  const preToolUse: unknown[] = Array.isArray(existingPreToolUse)
    ? (existingPreToolUse.slice() as unknown[])
    : [];
  preToolUse.push({ matcher: HOOK_MATCHER, hooks: [ownHandler(command)] });
  hooks.PreToolUse = preToolUse;
  return { ...stripped, hooks };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseArgs(args: readonly string[]): {
  action: 'install' | 'status' | 'uninstall';
  apply: boolean;
} {
  const action = args[0];
  if (action !== 'install' && action !== 'status' && action !== 'uninstall') {
    throw new Error('usage');
  }
  const flags = args.slice(1);
  const userCount = flags.filter((flag) => flag === '--user').length;
  const applyCount = flags.filter((flag) => flag === '--apply').length;
  const unknown = flags.some((flag) => flag !== '--user' && flag !== '--apply');
  if (unknown || userCount !== 1 || applyCount > 1 || (action === 'status' && applyCount !== 0)) {
    throw new Error('usage');
  }
  return { action, apply: applyCount === 1 };
}

function usage(): string {
  return [
    'Usage:',
    '  codex-reasonix-mcp hooks install --user [--apply]',
    '  codex-reasonix-mcp hooks status --user',
    '  codex-reasonix-mcp hooks uninstall --user [--apply]',
  ].join('\n');
}

export async function runHooksCli(
  args: readonly string[],
  options: HookCliOptions = {},
): Promise<HookCliResult> {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch {
    return { exitCode: 2, stdout: '', stderr: `${usage()}\n` };
  }

  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir(homeDir));
  const paths = resolveHookPaths({ homeDir, stateDir });
  const command = hookCommand(paths, options.nodePath ?? process.execPath, stateDir);
  const writeAtomic = options.atomicWrite ?? atomicWriteFile;
  const removeFile = options.removeFile ?? unlink;

  try {
    const current = await readConfig(paths.hooksConfigPath);
    const stripped = withoutOwnedHandlers(current, stateDir);
    const installedHandlers = stripped.removed;
    const runtimeSource = hookRuntimeSource();

    if (parsed.action === 'status') {
      const runtime = await readIfPresent(paths.runtimePath);
      const healthy = installedHandlers === 1 && runtime === runtimeSource;
      if (healthy) {
        return {
          exitCode: 0,
          stdout: `Reasonix user hook is installed and current.\n${TRUST_NOTICE}\n`,
          stderr: '',
        };
      }
      const state = installedHandlers > 0 ? 'incomplete or outdated' : 'not installed';
      return {
        exitCode: 1,
        stdout: `Reasonix user hook is ${state}.\n${TRUST_NOTICE}\n`,
        stderr: '',
      };
    }

    if (parsed.action === 'install') {
      const next = mergedConfig(current, command, stateDir);
      if (!parsed.apply) {
        return {
          exitCode: 0,
          stdout: `Dry run: would install the Reasonix user hook at ${paths.hooksConfigPath}.\nRe-run with --apply to write changes.\n${TRUST_NOTICE}\n`,
          stderr: '',
        };
      }
      if ((await readIfPresent(paths.runtimePath)) !== runtimeSource) {
        await writeAtomic(paths.runtimePath, runtimeSource, 0o600);
      }
      if (!sameJson(current, next)) {
        await writeAtomic(paths.hooksConfigPath, stableJson(next), 0o600);
      }
      return {
        exitCode: 0,
        stdout: `Installed the Reasonix user hook at ${paths.hooksConfigPath}.\n${TRUST_NOTICE}\n`,
        stderr: '',
      };
    }

    if (!parsed.apply) {
      return {
        exitCode: 0,
        stdout: `Dry run: would uninstall ${String(installedHandlers)} Reasonix user hook handler(s).\nRe-run with --apply to write changes.\n`,
        stderr: '',
      };
    }
    if (installedHandlers > 0) {
      await writeAtomic(paths.hooksConfigPath, stableJson(stripped.config), 0o600);
    }
    await removeFile(paths.runtimePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    return {
      exitCode: 0,
      stdout: `Uninstalled ${String(installedHandlers)} Reasonix user hook handler(s); third-party hooks were preserved.\n`,
      stderr: '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: '', stderr: `hooks: ${message}\n` };
  }
}

function parseActiveStateValue(
  sentinelValue: unknown,
  stateValue: unknown,
): ActiveGuardState | 'corrupt' {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const sentinel = record(sentinelValue);
  if (
    sentinel?.schemaVersion !== 1 ||
    typeof sentinel.taskId !== 'string' ||
    typeof sentinel.repositoryId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sentinel.taskId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sentinel.repositoryId) ||
    sentinel.taskId.includes('..') ||
    sentinel.repositoryId.includes('..')
  ) {
    return 'corrupt';
  }
  const state = record(stateValue);
  const repository = record(state?.repository);
  const contract = record(state?.contract);
  if (
    (state?.schemaVersion !== 1 && state?.schemaVersion !== 2) ||
    state.taskId !== sentinel.taskId ||
    repository?.id !== sentinel.repositoryId ||
    typeof repository?.root !== 'string' ||
    !repository.root.startsWith('/') ||
    !Array.isArray(contract?.write_scope) ||
    !contract.write_scope.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        !entry.startsWith('/') &&
        !entry.split('/').includes('..'),
    )
  ) {
    return 'corrupt';
  }
  return { root: repository.root, writeScope: contract.write_scope as string[] };
}

function hookGuardDecision(
  input: unknown,
  active: LoadedGuardState,
  pathApi: PathApi,
): PreToolUseDenial | undefined {
  const deny = (reason: string): PreToolUseDenial => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  if (active === undefined) return undefined;

  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const event = record(input);
  const toolName = event?.tool_name;
  if (toolName !== 'Bash' && toolName !== 'apply_patch') return undefined;
  if (active === 'corrupt') {
    return deny('Reasonix has an active-task sentinel but its task state is missing or corrupt.');
  }
  if (event?.hook_event_name !== 'PreToolUse' || typeof event.cwd !== 'string') {
    return deny('Reasonix could not validate the PreToolUse hook input.');
  }

  const cwd = pathApi.resolve(event.cwd);
  let selected: ActiveGuardState | undefined;
  for (const candidate of active) {
    const candidateRoot = pathApi.resolve(candidate.root);
    const relative = pathApi.relative(candidateRoot, cwd);
    if (
      relative !== '..' &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative)
    ) {
      selected = candidate;
      break;
    }
  }
  const toolInput = record(event.tool_input);
  const command = toolInput?.command;
  if (typeof command !== 'string') {
    return selected ? deny('Reasonix could not validate the tool command.') : undefined;
  }

  const lexStaticCommand = (source: string): string[] | undefined => {
    if (source.length === 0 || source.includes('\n') || source.includes('\r')) return undefined;
    const result: string[] = [];
    let token = '';
    let quote: "'" | '"' | undefined;
    let escaped = false;
    let started = false;
    for (const character of source) {
      if (escaped) {
        token += character;
        escaped = false;
        started = true;
        continue;
      }
      if (character === '\\' && quote !== "'") {
        escaped = true;
        started = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = undefined;
        else {
          if (character === '$' || character === '`') return undefined;
          token += character;
        }
        started = true;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        started = true;
        continue;
      }
      if ('|&;<>`(){}$'.includes(character)) return undefined;
      if (/\s/.test(character)) {
        if (started) {
          result.push(token);
          token = '';
          started = false;
        }
        continue;
      }
      token += character;
      started = true;
    }
    if (quote || escaped) return undefined;
    if (started) result.push(token);
    return result.length > 0 ? result : undefined;
  };

  const isSimpleReadCommand = (source: string): boolean => {
    const argv = lexStaticCommand(source);
    if (!argv) return false;
    const executable = argv[0];
    if (!executable) return false;
    if (executable.includes('/')) {
      if (!executable.startsWith('/usr/bin/') && !executable.startsWith('/bin/')) return false;
    }
    const name = pathApi.basename(executable);
    const args = argv.slice(1);
    if (
      ['pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'readlink', 'du', 'df'].includes(name)
    ) {
      return true;
    }
    if (name === 'ls') return !args.some((arg) => arg === '--hyperlink');
    if (name === 'realpath') return !args.some((arg) => arg.startsWith('--relative-to='));
    if (name === 'rg' || name === 'grep') {
      return !args.some(
        (arg) => arg === '--pre' || arg.startsWith('--pre=') || arg === '--pre-glob',
      );
    }
    if (name === 'sort') {
      return !args.some((arg) => arg === '-o' || arg === '--output' || arg.startsWith('--output='));
    }
    if (name === 'sed') {
      if (
        args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg.startsWith('--in-place'))
      ) {
        return false;
      }
      const scripts: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg) continue;
        if (arg === '-n' || arg === '--quiet' || arg === '--silent') continue;
        if (arg === '-e' || arg === '--expression') {
          const script = args[index + 1];
          if (!script) return false;
          scripts.push(script);
          index += 1;
        } else if (arg.startsWith('--expression=')) scripts.push(arg.slice('--expression='.length));
        else if (!arg.startsWith('-') && scripts.length === 0) scripts.push(arg);
      }
      return (
        scripts.length > 0 &&
        scripts.every((script) => /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(script))
      );
    }
    if (name === 'find') {
      const denied = new Set([
        '-delete',
        '-exec',
        '-execdir',
        '-ok',
        '-okdir',
        '-fprint',
        '-fprint0',
        '-fprintf',
        '-fls',
      ]);
      return !args.some((arg) => denied.has(arg));
    }
    if (name === 'git') {
      let index = 0;
      while (args[index] === '--no-pager' || args[index] === '--literal-pathspecs') index += 1;
      const subcommand = args[index];
      if (!subcommand) return false;
      const subcommandArgs = args.slice(index + 1);
      if (
        subcommandArgs.some(
          (arg) =>
            arg === '-o' ||
            arg === '--output' ||
            arg.startsWith('--output=') ||
            arg === '--ext-diff' ||
            arg === '--textconv' ||
            arg === '--filters',
        )
      ) {
        return false;
      }
      if (
        [
          'status',
          'diff',
          'log',
          'show',
          'rev-parse',
          'ls-files',
          'ls-tree',
          'cat-file',
          'merge-base',
          'name-rev',
          'describe',
        ].includes(subcommand)
      ) {
        return true;
      }
      if (subcommand === 'remote') {
        const remoteArgs = args.slice(index + 1);
        return remoteArgs.length === 1 && remoteArgs[0] === '-v';
      }
      if (subcommand === 'config') {
        const configArgs = args.slice(index + 1);
        return (
          configArgs.length > 0 &&
          ['--get', '--get-all', '--get-regexp', '--list'].includes(configArgs[0] ?? '')
        );
      }
    }
    return false;
  };

  if (toolName === 'Bash') {
    if (!selected) return undefined;
    return isSimpleReadCommand(command)
      ? undefined
      : deny('Reasonix source supervision permits only a single simple read-only Bash command.');
  }

  const parsePatchPaths = (source: string): string[] | undefined => {
    const lines = source.replaceAll('\r\n', '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return undefined;
    const prefixes = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '];
    const files: string[] = [];
    for (let index = 1; index < lines.length - 1; index += 1) {
      const line = lines[index] ?? '';
      const prefix = prefixes.find((candidate) => line.startsWith(candidate));
      if (prefix) {
        const encoded = line.slice(prefix.length);
        let file = encoded;
        if (encoded.startsWith('"') || encoded.endsWith('"')) {
          if (!(encoded.startsWith('"') && encoded.endsWith('"'))) return undefined;
          try {
            const decoded = JSON.parse(encoded) as unknown;
            if (typeof decoded !== 'string') return undefined;
            file = decoded;
          } catch {
            return undefined;
          }
        }
        if (
          file.length === 0 ||
          file.trim() !== file ||
          /[\0\n\r]/.test(file) ||
          file.startsWith("'") ||
          file.endsWith("'")
        ) {
          return undefined;
        }
        files.push(file);
      } else if (line.startsWith('*** ')) return undefined;
    }
    return files.length > 0 ? files : undefined;
  };

  const patchPaths = parsePatchPaths(command);
  if (!patchPaths) {
    return selected
      ? deny('Reasonix could not precisely parse the apply_patch file headers.')
      : undefined;
  }

  const globMatch = (patternValue: string, fileValue: string): boolean | undefined => {
    const pattern = patternValue.replace(/^\.\//, '').replaceAll('\\', '/');
    const file = fileValue.replaceAll('\\', '/');
    if (/[{}()[\]!+@]/.test(pattern)) return undefined;
    if (!/[*?]/.test(pattern)) return file === pattern || file.startsWith(`${pattern}/`);
    let expression = '^';
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index] ?? '';
      if (character === '*') {
        if (pattern[index + 1] === '*') {
          index += 1;
          if (pattern[index + 1] === '/') {
            index += 1;
            expression += '(?:.*/)?';
          } else expression += '.*';
        } else expression += '[^/]*';
      } else if (character === '?') expression += '[^/]';
      else expression += character.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
    }
    expression += '$';
    return new RegExp(expression).test(file);
  };

  for (const patchPath of patchPaths) {
    if (pathApi.isAbsolute(patchPath)) {
      const absolute = pathApi.resolve(patchPath);
      if (selected) {
        const selectedRoot = pathApi.resolve(selected.root);
        const selectedRelative = pathApi.relative(selectedRoot, absolute);
        if (
          selectedRelative === '..' ||
          selectedRelative.startsWith(`..${pathApi.sep}`) ||
          pathApi.isAbsolute(selectedRelative)
        ) {
          return deny('Reasonix blocked an apply_patch path outside the supervised repository.');
        }
      }
      for (const candidate of active) {
        const candidateRoot = pathApi.resolve(candidate.root);
        const relative = pathApi.relative(candidateRoot, absolute);
        if (
          relative === '..' ||
          relative.startsWith(`..${pathApi.sep}`) ||
          pathApi.isAbsolute(relative)
        ) {
          continue;
        }
        const normalized = pathApi.normalize(relative).replaceAll(pathApi.sep, '/');
        for (const scope of candidate.writeScope) {
          const matches = globMatch(scope, normalized);
          if (matches !== false) {
            return deny(`Reasonix blocked a source collision on ${normalized}.`);
          }
        }
      }
      continue;
    }
    if (!selected) continue;
    const root = pathApi.resolve(selected.root);
    const absolute = pathApi.resolve(cwd, patchPath);
    const relative = pathApi.relative(root, absolute);
    if (
      relative === '..' ||
      relative.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relative)
    ) {
      return deny('Reasonix blocked an apply_patch path outside the supervised repository.');
    }
    const normalized = pathApi.normalize(relative).replaceAll(pathApi.sep, '/');
    for (const scope of selected.writeScope) {
      const matches = globMatch(scope, normalized);
      if (matches !== false) {
        return deny(`Reasonix blocked a source collision on ${normalized}.`);
      }
    }
  }
  return undefined;
}

async function loadGuardState(
  stateDir: string,
  readTextFile: (file: string) => Promise<string>,
): Promise<LoadedGuardState> {
  const activeDirectory = path.join(stateDir, 'active');
  let repositoryEntries;
  try {
    repositoryEntries = await readdir(activeDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'corrupt';
  }
  const active: ActiveGuardState[] = [];
  for (const repositoryEntry of repositoryEntries) {
    if (!repositoryEntry.isDirectory()) return 'corrupt';
    let taskEntries;
    try {
      taskEntries = await readdir(path.join(activeDirectory, repositoryEntry.name), {
        withFileTypes: true,
      });
    } catch {
      return 'corrupt';
    }
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isFile() || !taskEntry.name.endsWith('.json')) return 'corrupt';
      let sentinel: unknown;
      let state: unknown;
      try {
        sentinel = JSON.parse(
          await readTextFile(path.join(activeDirectory, repositoryEntry.name, taskEntry.name)),
        );
        const taskId =
          isRecord(sentinel) && typeof sentinel.taskId === 'string' ? sentinel.taskId : '';
        state = JSON.parse(await readTextFile(path.join(stateDir, 'tasks', taskId, 'state.json')));
      } catch {
        return 'corrupt';
      }
      if (
        !isRecord(sentinel) ||
        sentinel.repositoryId !== repositoryEntry.name ||
        `${String(sentinel.taskId)}.json` !== taskEntry.name
      ) {
        return 'corrupt';
      }
      const parsed = parseActiveStateValue(sentinel, state);
      if (parsed === 'corrupt') return parsed;
      active.push(parsed);
    }
  }
  return active.length > 0 ? active : undefined;
}

export async function evaluatePreToolUse(
  input: unknown,
  options: HookGuardOptions,
): Promise<PreToolUseDenial | undefined> {
  const stateDir = path.resolve(options.stateDir);
  const active = await loadGuardState(
    stateDir,
    options.readTextFile ?? ((file) => readFile(file, 'utf8')),
  );
  return hookGuardDecision(input, active, path);
}

/** Generates the dependency-free runtime copied into the private state root. */
export function hookRuntimeSource(): string {
  const parseState = parseActiveStateValue.toString();
  const decide = hookGuardDecision.toString();
  return `#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const parseActiveStateValue = ${parseState};
const hookGuardDecision = ${decide};

function stateDirectory(argv) {
  const index = argv.indexOf('--state-dir');
  if (index === -1 || !argv[index + 1]) throw new Error('missing --state-dir');
  return path.resolve(argv[index + 1]);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function loadActive(stateDir) {
  const activeDirectory = path.join(stateDir, 'active');
  let repositoryEntries;
  try {
    repositoryEntries = await readdir(activeDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    return 'corrupt';
  }
  const active = [];
  for (const repositoryEntry of repositoryEntries) {
    if (!repositoryEntry.isDirectory()) return 'corrupt';
    let taskEntries;
    try {
      taskEntries = await readdir(path.join(activeDirectory, repositoryEntry.name), { withFileTypes: true });
    } catch {
      return 'corrupt';
    }
    for (const taskEntry of taskEntries) {
      if (!taskEntry.isFile() || !taskEntry.name.endsWith('.json')) return 'corrupt';
      let sentinel;
      let state;
      try {
        sentinel = JSON.parse(await readFile(path.join(activeDirectory, repositoryEntry.name, taskEntry.name), 'utf8'));
        const taskId = sentinel && typeof sentinel === 'object' && typeof sentinel.taskId === 'string'
          ? sentinel.taskId
          : '';
        state = JSON.parse(await readFile(path.join(stateDir, 'tasks', taskId, 'state.json'), 'utf8'));
      } catch {
        return 'corrupt';
      }
      if (
        !sentinel ||
        typeof sentinel !== 'object' ||
        sentinel.repositoryId !== repositoryEntry.name ||
        String(sentinel.taskId) + '.json' !== taskEntry.name
      ) return 'corrupt';
      const parsed = parseActiveStateValue(sentinel, state);
      if (parsed === 'corrupt') return parsed;
      active.push(parsed);
    }
  }
  return active.length > 0 ? active : undefined;
}

try {
  const stateDir = stateDirectory(process.argv.slice(2));
  const active = await loadActive(stateDir);
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    input = null;
  }
  const output = hookGuardDecision(input, active, path);
  if (output) process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Reasonix hook runtime failed closed.',
    },
  }));
}
`;
}
