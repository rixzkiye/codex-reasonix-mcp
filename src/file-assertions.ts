import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertPathInsideWorktree, type TaskContractV1 } from './contracts.js';
import { BridgeError } from './errors.js';
import { isCredentialPath } from './sensitive-paths.js';

export interface FileAssertionEvidence {
  id: string;
  path: string;
  sha256: string;
  outputBytes: number;
  proves: string[];
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Verifies each contract file assertion byte-for-byte against the worktree.
 * `expected_utf8` is interpreted as exact UTF-8 bytes including any trailing
 * newline; a mismatch is a repairable verification failure. Evidence carries
 * only the hash and byte length of the expected content, never the content.
 */
export async function verifyFileAssertions(
  worktree: string,
  contract: TaskContractV1,
): Promise<FileAssertionEvidence[]> {
  const assertions = contract.file_assertions ?? [];
  const evidence: FileAssertionEvidence[] = [];
  for (const assertion of assertions) {
    if (isCredentialPath(assertion.path)) {
      throw new BridgeError(
        'secret_detected',
        `File assertion targets a sensitive path: ${assertion.path}`,
      );
    }
    const canonical = await assertPathInsideWorktree(worktree, assertion.path);
    const absolute = path.join(worktree, ...canonical.split('/'));
    let content: Buffer;
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) {
        throw new BridgeError(
          'verification_failed',
          `File assertion target is not a regular file: ${assertion.path}`,
        );
      }
      content = await readFile(absolute);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError(
          'verification_failed',
          `File assertion target is missing: ${assertion.path}`,
          { expectedBytes: Buffer.byteLength(assertion.expected_utf8) },
        );
      }
      throw error;
    }
    const expected = Buffer.from(assertion.expected_utf8, 'utf8');
    if (!expected.equals(content)) {
      throw new BridgeError(
        'verification_failed',
        `File assertion content mismatch: ${assertion.path}`,
        {
          expectedBytes: expected.length,
          actualBytes: content.length,
          differsOnlyInBytes: expected.length === content.length,
        },
      );
    }
    evidence.push({
      id: assertion.id,
      path: assertion.path,
      sha256: sha256(expected),
      outputBytes: expected.length,
      proves: [...assertion.proves],
    });
  }
  return evidence;
}

/** Aggregates file-assertion evidence for one acceptance criterion (hash and length only). */
export function fileAssertionEvidenceForCriterion(
  assertionEvidence: FileAssertionEvidence[],
  criterionId: string,
): { source: string; sha256: string; outputBytes: number } | undefined {
  const matches = assertionEvidence.filter((item) => item.proves.includes(criterionId));
  if (matches.length === 0) return undefined;
  return {
    source: matches.map((item) => `file_assertion:${item.id}`).join(','),
    sha256: sha256(Buffer.from(matches.map((item) => item.sha256).join('\n'))),
    outputBytes: matches.reduce((total, item) => total + item.outputBytes, 0),
  };
}
