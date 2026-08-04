import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BridgeError } from './errors.js';
import { WIRE_REASONING_EFFORTS, type ReasoningEffort } from './types.js';

export interface BridgeConfig {
  stateDir: string;
  reasonixCommand: string;
  reasonixArgs: string[];
  model: string;
  reasoningEffort: ReasoningEffort;
  profile: 'delivery';
  networkEnabled: boolean;
  externalSecretScanner?: readonly [string, ...string[]];
  maxInspectBytes: number;
  maxBinaryBytes: number;
  leaseStaleMs: number;
  leaseHeartbeatMs: number;
  /** Glob patterns (CODEX_REASONIX_ENV_ALLOWLIST) for env vars passed to the Reasonix child beyond the system baseline. */
  envAllowlist: string[];
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  const effort = value?.trim() || 'medium';
  if (!(WIRE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new BridgeError(
      'invalid_request',
      `CODEX_REASONIX_EFFORT must be one of: ${WIRE_REASONING_EFFORTS.join(', ')}`,
    );
  }
  return effort as ReasoningEffort;
}

function defaultStateDir(): string {
  const override = process.env.CODEX_REASONIX_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) return path.join(xdg, 'codex-reasonix-mcp');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'codex-reasonix-mcp');
  }
  return path.join(os.homedir(), '.local', 'state', 'codex-reasonix-mcp');
}

function parseScanner(value: string | undefined): readonly [string, ...string[]] | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BridgeError(
      'invalid_request',
      'CODEX_REASONIX_SECRET_SCANNER_ARGV must be a JSON argv array',
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new BridgeError(
      'invalid_request',
      'CODEX_REASONIX_SECRET_SCANNER_ARGV must be a non-empty JSON string array',
    );
  }
  return parsed as [string, ...string[]];
}

function parseEnvAllowlist(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    stateDir: defaultStateDir(),
    reasonixCommand: process.env.REASONIX_BIN?.trim() || 'reasonix',
    reasonixArgs: [],
    model: process.env.CODEX_REASONIX_MODEL?.trim() || 'deepseek-v4-flash',
    reasoningEffort: parseReasoningEffort(process.env.CODEX_REASONIX_EFFORT),
    profile: 'delivery',
    networkEnabled: process.env.CODEX_REASONIX_NETWORK === 'on',
    externalSecretScanner: parseScanner(process.env.CODEX_REASONIX_SECRET_SCANNER_ARGV),
    maxInspectBytes: 64 * 1024,
    maxBinaryBytes: 10 * 1024 * 1024,
    leaseStaleMs: 30_000,
    leaseHeartbeatMs: 5_000,
    envAllowlist: parseEnvAllowlist(process.env.CODEX_REASONIX_ENV_ALLOWLIST),
    ...overrides,
  };
}

export function configFingerprint(config: BridgeConfig): string {
  const stable = JSON.stringify({
    command: config.reasonixCommand,
    args: config.reasonixArgs,
    model: config.model,
    profile: config.profile,
    network: config.networkEnabled,
    envAllowlist: config.envAllowlist,
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}
