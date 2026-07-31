import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { z } from 'zod';

import { BridgeError } from './errors.js';

export const SANDBOX_META_KEY = 'codex/sandbox-state-meta';

const fileSystemEntrySchema = z
  .object({
    access: z.enum(['read', 'write', 'deny']),
    path: z
      .object({
        type: z.enum(['path', 'glob_pattern', 'special']),
        path: z.string().optional(),
        pattern: z.string().optional(),
        value: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const permissionProfileSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('managed'),
      file_system: z.discriminatedUnion('type', [
        z.object({ type: z.literal('unrestricted') }).passthrough(),
        z
          .object({
            type: z.literal('restricted'),
            entries: z.array(fileSystemEntrySchema),
          })
          .passthrough(),
      ]),
      network: z.enum(['restricted', 'enabled']),
    })
    .passthrough(),
  z.object({ type: z.literal('disabled') }).passthrough(),
  z
    .object({ type: z.literal('external'), network: z.enum(['restricted', 'enabled']) })
    .passthrough(),
]);

const sandboxStateSchema = z
  .object({
    permissionProfile: permissionProfileSchema,
    sandboxCwd: z.string().min(1),
    codexLinuxSandboxExe: z.string().nullable().optional(),
    useLegacyLandlock: z.boolean().optional(),
  })
  .passthrough();

export interface SandboxContext {
  cwd: string;
  writable: boolean;
  networkEnabled: boolean;
  raw: z.infer<typeof sandboxStateSchema>;
}

function cwdFromUri(value: string): string {
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value);
    } catch {
      throw new BridgeError('missing_sandbox_metadata', 'sandboxCwd is not a valid local file URI');
    }
  }
  if (!path.isAbsolute(value)) {
    throw new BridgeError('missing_sandbox_metadata', 'sandboxCwd must be absolute');
  }
  return value;
}

function specialName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'kind' in value) {
    const kind = (value as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : undefined;
  }
  return undefined;
}

function profileCanWrite(profile: z.infer<typeof permissionProfileSchema>, cwd: string): boolean {
  if (profile.type === 'disabled' || profile.type === 'external') return true;
  if (profile.file_system.type === 'unrestricted') return true;
  return profile.file_system.entries.some((entry) => {
    if (entry.access !== 'write') return false;
    if (entry.path.type === 'special') {
      const special = specialName(entry.path.value);
      return special === 'project_roots' || special === 'current_working_directory';
    }
    if (entry.path.type !== 'path' || !entry.path.path) return false;
    const relative = path.relative(entry.path.path, cwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function parseSandboxContext(meta: unknown): SandboxContext {
  if (!meta || typeof meta !== 'object') {
    throw new BridgeError(
      'missing_sandbox_metadata',
      `Missing ${SANDBOX_META_KEY} request metadata`,
    );
  }
  const rawMeta = meta as Record<string, unknown>;
  const parsed = sandboxStateSchema.safeParse(rawMeta[SANDBOX_META_KEY]);
  if (!parsed.success) {
    throw new BridgeError(
      'missing_sandbox_metadata',
      `Invalid ${SANDBOX_META_KEY} request metadata`,
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
  }
  const cwd = path.resolve(cwdFromUri(parsed.data.sandboxCwd));
  const writable = profileCanWrite(parsed.data.permissionProfile, cwd);
  if (!writable) {
    throw new BridgeError(
      'read_only_sandbox',
      'Delegation requires a writable Codex permission profile',
    );
  }
  const networkEnabled =
    parsed.data.permissionProfile.type !== 'disabled' &&
    parsed.data.permissionProfile.network === 'enabled';
  return { cwd, writable, networkEnabled, raw: parsed.data };
}
