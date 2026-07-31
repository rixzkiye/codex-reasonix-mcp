# Security model

## Boundaries

The MCP caller is not allowed to supply an arbitrary repository path. Delegate
and finalize derive the cwd and effective network permission from
`codex/sandbox-state-meta`, canonicalize the Git repository, and require a
writable profile. Native Windows is rejected because Reasonix shell execution
does not have a native OS sandbox in v1.

The source worktree must be clean. The bridge never stashes user changes. Each
task owns a separate worker branch and worktree below the private state root.

## Permission decisions

The bridge automatically permits only:

- structured read-only operations;
- structured file edits whose resolved paths are within `write_scope` and not
  within `forbidden_scope`; and
- exact argv operations already named by contract verification.

Ambiguous raw input, credentials, new network access, out-of-scope paths, and
destructive actions require or deny interaction. Git staging/history commands
and `commit`, `reset`, `clean`, `checkout`, `merge`, `rebase`, `cherry-pick`,
`push`, and `tag` are never auto-approved. Contract scope cannot be overridden
through an interaction.

## Data handling

State snapshots and logs are private. Journals are append-only and recursively
redact credential-shaped keys and token patterns. Agent thought chunks are
dropped. Inspection excludes raw diff and full terminal output by default and
caps each response at 64 KiB with opaque pagination cursors.

Verification and scanner subprocesses inherit only an allowlist of ordinary
system variables. Provider keys, tokens, cookies, authorization headers, and
credential variables are not forwarded. They run in dedicated POSIX process
groups so timeout, cancellation, or direct-child exit cannot leave descendants
mutating the worktree. A paused task may resume only when its stored Reasonix
process/config fingerprint exactly matches the current effective posture.

## Commit gate

Before committing, the bridge recomputes changed/untracked files, resolves
symlinks, rejects submodule drift and oversized files, scans working content,
runs all verification, and repeats those checks before staging. `.git` control
paths and common credential paths are never auto-approved for worker reads or
edits. The bridge stages explicit names, checks staged names/diff/whitespace,
and scans staged content again.

`pre-commit`, `prepare-commit-msg`, and `commit-msg` hooks run against a private
copy of the reviewed index. A hook that changes the index, worktree, or worker
ref aborts the transaction. The final commit is built from the reviewed tree and
the worker ref is advanced only with an atomic old-OID check. The bridge then
requires exactly one commit and a clean worktree. It never pushes or merges.

## Known limits

- Reasonix and provider supply-chain trust remain the user's responsibility.
- An external secret scanner is strongly recommended for sensitive projects.
- State retention is intentional; disk encryption and host access control are
  outside the bridge.
- Filesystem checks cannot make an unrelated privileged process trustworthy.
  Repository leases and repeated Git checks detect ordinary concurrent writers,
  but host compromise is out of scope.

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
