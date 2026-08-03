# Security model

## Authority boundaries

The MCP caller cannot supply an arbitrary repository path. Delegate and
finalize derive cwd/network permission from `codex/sandbox-state-meta`,
canonicalize the Git repository, and require a writable profile. Native Windows
is rejected; use WSL.

The source worktree must be clean at task creation. The bridge never stashes,
resets, or absorbs user changes. Each task owns a separate worker branch and
worktree below private state.

## Structured edits and shell commands

Structured edits are allowed only when every resolved path is inside
`write_scope`, outside `forbidden_scope`, and not a Git-control or credential
path. Symlink escapes fail closed.

Shell approval requires trusted private `_meta.reasonix.io` static argv v1
metadata whose argv/cwd agree with the ACP subject and whose cwd resolves inside
the worker worktree. Policy precedence is:

1. Audited filesystem reads and sanitized Git reads receive `allow_once`.
2. Test/build/format/package/project commands and restricted `env` wrappers
   require exact argv plus normalized cwd in verification or
   `allowed_commands`.
3. Git mutations or ref/history rewrites, `gh`, publish/release, remote/network access,
   credentials, privilege escalation, destructive filesystem commands,
   shell/eval, inline-code interpreters, cwd escape, and metadata mismatch are
   immutable one-time denials. Contracts cannot override them.
4. Unknown executables are denied with a structured recovery hint.

Immutable denials never become `waiting_permission`. One recovery steer is sent
per fingerprint; the third identical denial within one prompt cancels the turn
and pauses the task. Every allowed command has a watchdog, and completion,
failure, or timeout is followed by immediate repository postflight. Timeout
cancels the session and pauses the task.

## Source-collision authority

At resume, before/after mutation, review readiness, finalize start, after
verification, before staging, and before commit, the bridge compares source
dirty paths and committed movement since base with task `write_scope`. Overlap
or unavailable source ownership records bounded evidence, releases the lease,
and pauses/blocks instead of changing user data.

The optional user Codex hook blocks overlapping `apply_patch` and
unknown/write-capable Bash while an active task sentinel exists. A corrupt
active sentinel/state fails closed for those tools; no active state allows. The
hook is only an early guardrail. Core collision scans remain authoritative, and
manual `/hooks` review/trust remains required.

## Data handling and metrics

Snapshots, journals, evidence, archives, hook runtime, and metrics are private.
Journals recursively redact credential-shaped keys/token patterns; thought
chunks are dropped. Inspection omits raw diff/full terminal output by default
and caps responses at 64 KiB with signed opaque cursors.

Verification/scanner subprocesses inherit a small ordinary-system allowlist,
never provider credentials. POSIX process groups ensure timeout, cancellation,
or child exit cannot leave descendants mutating the worktree.

Metrics store only closed decisions/outcomes, counts, durations, task hashes,
and numeric provider usage. They never store prompts, argv, outputs, secrets, or
file contents and are never transmitted.

## State, archive, and commit integrity

Persisted task records are version-gated and validate canonical identity and
contract fields. Valid v1 records migrate atomically to v2; corrupt and unknown
future versions fail closed. Archive
accepts only terminal records whose worker worktree is clean or missing and
whose repository identity/ref/head still match. It preserves branch/ref/commit.
Prune replaces eligible archives with integrity-bound tombstones and recovers
interrupted staging idempotently.

Before commit, the bridge repeats source collision, scope, symlink, submodule,
size, and secret checks around exact contract verification. Only verification
can approve automated acceptance criteria. Explicit staging must match the
reviewed diff.

`pre-commit`, `prepare-commit-msg`, and `commit-msg` run against a disposable
reviewed index. Hook mutation aborts. The final commit uses the reviewed tree,
and the worker ref advances only through an atomic old-OID check. The bridge
never pushes or merges.

## Known limits

- Reasonix/provider supply-chain trust and billing remain user responsibilities.
- An external secret scanner is recommended for sensitive repositories.
- Disk encryption, host access control, and privileged-process trust are out of
  scope.
- The user Codex hook cannot replace core authority and does not bypass Codex
  hook trust.

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
