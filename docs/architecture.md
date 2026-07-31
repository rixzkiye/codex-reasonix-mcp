# Architecture

## Trust split

Codex is the only supervisor and user-facing harness. It authors the immutable
task contract, reviews changes, approves review-only criteria, and requests
finalization. Reasonix is an executor: it may edit only its isolated worktree
and cannot stage, commit, push, merge, or expand scope.

The bridge has no model or routing layer. It translates MCP supervision into ACP
v1 session control and enforces local policy around both sides.

## Runtime components

- `src/server.ts` exposes exactly three MCP tools and advertises support for
  `codex/sandbox-state-meta`.
- `src/runtime.ts` owns task lifecycle, asynchronous provisioning/finalization,
  interaction resolution, repair limits, and bounded inspection.
- `src/acp.ts` pools one Reasonix process per canonical repository/config
  fingerprint and one ACP session per task.
- `src/contracts.ts` validates and canonicalizes `TaskContractV1`, applies
  forbidden-scope precedence, and renders the deterministic Goal prompt.
- `src/repository.ts` creates isolated worktrees and implements Git ownership,
  scope, staging, staged-diff, and single-commit gates.
- `src/state.ts` and `src/lease.ts` provide private atomic snapshots,
  append-only redacted journals, and cross-process heartbeat leases.
- `src/policy.ts`, `src/security.ts`, and `src/verification.ts` enforce
  permission, secret, and argv-only verification policy.

## Process and session model

A canonical repository identity hashes the real repository root and Git common
directory. A process pool key combines that identity with the bridge
configuration fingerprint, including the effective network intersection. Tasks
with the same effective posture may share the process but never a branch,
worktree, ACP session, contract hash, or task state. A dead ACP process is
evicted so an inspected task can reconnect without reusing a stale transport.
Resume recomputes the effective fingerprint from current Codex sandbox metadata
and refuses a task created under a different network/config posture.

Reasonix is launched with Delivery profile, planner off, workspace-only writes,
an enforced OS sandbox, and explicit sandbox network posture. The client does
not advertise ACP filesystem or terminal capabilities, so Reasonix uses its own
sandboxed tools. After session setup, the bridge requests a signed-by-protocol
effective status snapshot and rejects any mismatch.

## Crash and restart behavior

State snapshots are written atomically and operational events are appended as
redacted JSONL. On bridge restart, any nonterminal in-flight task becomes
`paused`; its worktree and evidence are preserved. Inspection is required before
resume so automatic side effects are never replayed blindly.

The Reasonix extension emits monotonic status sequences. Duplicate or stale
updates are ignored, while `_reasonix.io/session/status` provides a recovery
snapshot after reconnect or resume.

## Finalization transaction

Finalization is asynchronous. It checks an idle review state, recomputes Git
changes, rejects out-of-scope paths/submodules/symlink escapes, scans secrets,
runs every contract verification command, repeats the scope/symlink/submodule/
size/secret gates, and rejects any verification-time diff mutation. It then
builds per-criterion evidence, stages an explicit path list, and compares the
reviewed and staged diffs. Commit hooks run against a disposable copy of the
reviewed index. The bridge rejects hook mutations, creates a commit object for
the exact reviewed tree, and advances the worker ref with an old-OID
compare-and-swap. A failing gate never reports completion.
Cancellation aborts verification before staging. Once the final atomic commit
has started, cancellation is rejected so task state cannot race a successful
commit.

Verification and scanner subprocesses inherit only a sanitized environment and
own a POSIX process group. Timeout, cancellation, normal direct-child exit, and
bridge shutdown terminate residual descendants before the repository lease is
released.
