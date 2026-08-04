/**
 * Runtime-metadata namespace policy.
 *
 * Untracked files under `.reasonix/**` are treated as Reasonix runtime
 * metadata: they never enter changed-file lists, diffs, review bundles,
 * security scans, staging, or commits, and they never require a `.gitignore`
 * entry. Tracked changes inside the namespace and structured worker writes
 * into it remain forbidden.
 */

export const RUNTIME_METADATA_NAMESPACE = '.reasonix';

export function isRuntimeMetadataPath(candidate: string): boolean {
  return (
    candidate === RUNTIME_METADATA_NAMESPACE ||
    candidate.startsWith(`${RUNTIME_METADATA_NAMESPACE}/`)
  );
}
