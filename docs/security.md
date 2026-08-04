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

## Command sandboxing and trust boundaries

Every bridge subprocess that executes repository-controlled content runs
inside an OS-level command sandbox (`SandboxedCommandRunner`,
[`src/sandbox-runner.ts`](../src/sandbox-runner.ts)):

- **verification commands** (from the task contract);
- the **external secret scanner** (when configured);
- **Git hooks** (only when explicitly enabled, see below).

Posture (fail closed):

- **network disabled** (network namespace isolation);
- filesystem **read-only outside the worktree**, with per-user credential
  stores hidden from the sandbox (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`,
  `~/.codex`, `~/.netrc`, `~/.npmrc`, `~/.yarnrc`, `~/.gitconfig`, `/root`);
- the **worktree is writable**; `/tmp` is private and writable;
- a **minimal sanitized environment** (see next section);
- if no sandbox engine is available (bubblewrap on Linux, seatbelt on macOS),
  execution is **refused** (`sandbox_unavailable`) unless the explicit
  `CODEX_REASONIX_ALLOW_UNSANDBOXED=true` escape hatch is set (documented
  unsafe; hooks are never allowed unsandboxed).

Descendants cannot outlive a command: process-group kill plus the pid
namespace of the sandbox reap background children on abort, timeout, or exit.

**Git hooks are disabled by default.** `pre-commit`, `prepare-commit-msg`, and
`commit-msg` only run when `CODEX_REASONIX_RUN_GIT_HOOKS=true` is set, and then
strictly inside the sandbox against a disposable reviewed index; any hook
mutation aborts the commit. The default posture is that repository hooks never
execute on the host.

## Environment allowlist

The Reasonix ACP child receives an explicitly built environment
([`buildReasonixEnvironment`](../src/acp.ts)), never a copy of the host
environment:

- **system baseline**: `PATH`, `HOME`, `CODEX_HOME`, locale (`LANG`/`LC_*`),
  temp (`TMPDIR`/`TMP`/`TEMP`), `XDG_*`, and CA variables;
- **`REASONIX_*`** pass-through;
- anything else — provider credentials included — only via
  `CODEX_REASONIX_ENV_ALLOWLIST` (comma-separated globs, e.g.
  `ANTHROPIC_*`);
- **hard-denied even when allowlisted**: `NODE_OPTIONS`, `LD_PRELOAD`,
  `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV`, `BASHOPTS`,
  `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `PAGER`, `NPM_CONFIG_*`/`npm_config_*`
  (the worker's read-only git commands must never execute inherited helper
  drivers).

Verification/scanner subprocesses use the smaller command allowlist
(`SAFE_ENV_KEYS` in `src/command.ts`) and never receive `HOME` or credentials.
Secret names and values never appear in journals, logs, or doctor output.

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

## Approval and pause binding

Finalize is bound to the exact reviewed snapshot: the client must echo
`expected_review_revision` and `expected_review_tree_hash` (both exposed on the
delegate/inspect output). They are validated at finalize start, after
verification, and immediately before staging; an approval captured before a
repair that re-captured the tree is always rejected with the fresh snapshot in
the error details.

Pause acknowledgment is token-bound: every pause entry bumps a monotonic
`pauseRevision` and binds a `pauseReasonHash` (sha256 of the canonical pause
reason). `reasonix_inspect` is strictly read-only; resuming a paused task
requires echoing the current `pause_revision`/`pause_reason_hash` from the
inspect output. Stale acknowledgments are rejected with the fresh tokens.

## Data handling and metrics

Snapshots, journals, evidence, archives, hook runtime, and metrics are private.
Journals recursively redact credential-shaped keys/token patterns; thought
chunks are dropped. Inspection omits raw diff/full terminal output by default
and caps responses at 64 KiB with signed opaque cursors.

Metrics store only closed decisions/outcomes, counts, durations, task hashes,
and numeric provider usage. They never store prompts, argv, outputs, secrets, or
file contents and are never transmitted.

## Journal durability

Every journal append is a bounded crash-consistent transaction
(`pending-event.json` envelope -> journal append -> state write -> envelope
removal). A crash at any step is reconciled deterministically at startup:

- journal behind (or a partial trailing write provable from the envelope) is
  re-appended from the envelope;
- state behind is rewritten from the envelope;
- completed transactions just drop the envelope;
- sequence gaps, malformed envelopes, or state ahead of the envelope fail
  closed (`invalid_state`).

A sequence can never be duplicated and a state mutation can never be lost.
`atomicWrite` fsyncs the file and the parent directory after rename.

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

### Exact Git ownership

The bridge commit requires the worker to be on the **exact** task branch
(`refs/heads/reasonix/<taskId>`, compare-and-swap against the reviewed base
commit). A branch with a valid `reasonix/` prefix but a different identity is
rejected before any ref or index write, and the same exact ref drives the
forward update and the rollback. Bridge-owned diff checks run with
`--no-ext-diff` so repository-configured textconv/external diff drivers never
execute. If the commit succeeds but completion state cannot be persisted, the
task ref is rolled back to the base commit instead of leaving a dangling
branch.

The bridge never pushes or merges.

## Threat model and proof matrix

Threats considered: malicious verification sources, malicious package scripts,
malicious Git hooks, environment exfiltration, network access from
repository-controlled content, filesystem escape, crash inconsistency, stale
review/pause tokens, and wrong-branch commits.

| #   | Row                                                                                  | Gate                                          |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| R1  | Malicious verification source (credential read, sibling write, network, descendants) | sandbox + process-group/pid-namespace cleanup |
| R2  | Malicious package script used as a verification command                              | sandbox                                       |
| R3  | Malicious Git hook                                                                   | hooks off by default; sandboxed when enabled  |
| R4  | Environment exfiltration                                                             | env allowlist + sanitized command env         |
| R5  | Network access from verification/hook                                                | network namespace disabled                    |
| R6  | Filesystem escape (write outside worktree)                                           | read-only fs + writable worktree only         |
| R7  | Crash recovery (kill mid-transaction)                                                | pending-envelope journal transactions         |
| R8  | Stale review / pause token                                                           | snapshot-bound approvals + pause tokens       |
| R9  | Wrong Reasonix branch (prefix-valid)                                                 | exact task-branch ownership                   |

Rows R1-R6 are exercised in `tests/e2e/sandbox-gates.test.ts` and
`tests/e2e/security-matrix.test.ts`; R7 in `tests/unit/crash-recovery.test.ts`;
R8 in `tests/e2e/approval-binding.test.ts`; R9 in
`tests/integration/git.test.ts`. CI runs the adversarial suite on Linux
(bubblewrap) and macOS (seatbelt); the matrix gates must pass on both before
any "hardened for untrusted repositories" claim is made.

## Known limits

- Reasonix/provider supply-chain trust and billing remain user responsibilities.
- An external secret scanner is recommended for sensitive repositories.
- Disk encryption, host access control, and privileged-process trust are out of
  scope.
- The user Codex hook cannot replace core authority and does not bypass Codex
  hook trust.
- `CODEX_REASONIX_ALLOW_UNSANDBOXED=true` knowingly disables the command
  sandbox and must never be set for untrusted repositories.
- seatbelt (`sandbox-exec`) is deprecated by Apple; macOS sandboxing relies on
  it until a maintained replacement is available.

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
