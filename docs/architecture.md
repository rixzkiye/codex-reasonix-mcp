# Architecture

## Trust split

Codex is the only supervisor and user-facing harness. It authors the immutable
task contract, reviews changes, approves review-only criteria, and requests
finalization. Reasonix is the only implementation worker: it may edit only its
isolated worktree and cannot stage, commit, push, merge, or expand scope.

The bridge has no model/router layer. It translates three MCP supervision tools
into ACP v1 session control and enforces local policy around both sides.

## Protocol surface

`src/server.ts` exposes exactly `reasonix_delegate`, `reasonix_control`, and
`reasonix_inspect`. Each tool has a concrete success output schema and every
successful handler returns matching `structuredContent`. Error results use a
stable redacted envelope containing `code`, `message`, `retryable`, a closed
`next_action`, and optional safe details.

Delegate/control are annotated mutating, destructive, non-idempotent, and
open-world. Inspect is read-only, non-destructive, idempotent, and closed-world.
Delegate and finalize derive repository authority from
`codex/sandbox-state-meta`.

The default supervision path is one delegate call held until review (or an
interaction/failure/timeout), followed by one finalize call held until a
terminal result. Lifecycle waiters ignore ordinary progress events. Inspect is
available for recovery and explicit observation; event history is opt-in.

## Runtime components

`src/runtime.ts` is a thin façade over these components:

- `runtime/session-supervision.ts` owns process/session lifecycle, restart,
  prompt completion, and provider failure handling.
- `runtime/permissions.ts` applies structured-edit and shell decisions,
  watchdog postflight, one recovery steer per denial fingerprint, and the
  repeated-denial stop rule.
- `runtime/collision.ts` owns source-movement scans and repository leases.
- `runtime/finalization.ts` owns review approval, verification, staging, hooks,
  commit creation, and final collision checkpoints.
- `runtime/inspection.ts` owns bounded sections and opaque pagination.
- `runtime/operations.ts` owns delegate/control lifecycle transitions.

Supporting authority remains separated:

- `contracts.ts` validates/canonicalizes `TaskContractV1`, command defaults,
  exact command matching, and deterministic prompts.
- `policy.ts` validates private static command metadata and classifies commands.
- `repository.ts` owns isolated worktrees, source-delta reads, scope checks,
  staging, and atomic commit mechanics.
- `state.ts` validates state, serializes atomic migration/update, writes audit
  events, and projects events into local metrics.
- `hooks.ts` installs and runs the optional user guardrail.
- `task-operations.ts` implements list/archive/prune and crash recovery.

## Shell command supervision

ACP execution must carry `_meta.reasonix.io` with `commandSchemaVersion: 1`,
`tool: "bash"`, a nonempty static argv array, and the exact absolute worktree
cwd. Metadata mismatch or disagreement with the ACP command subject fails
closed.

After metadata validation, audited reads and sanitized Git reads are allowed
once. Test/build/format/package/project commands and restricted `env` wrappers
must exactly match contract argv and normalized cwd. Verification commands are
implicitly in that command set; `allowed_commands` adds execution permission
without acceptance-evidence authority.

Hard denials run before contract matching, so a contract cannot permit Git
mutations or ref/history rewrites, remotes, `gh`, network, publish/release, credentials,
privilege escalation, destructive filesystem commands, shell/eval, inline
code, metadata spoofing, or cwd escape. Unknown executables are denied with a
recovery hint.

Each allowed command has a watchdog. Completion/failure clears the timer and
immediately runs scope, symlink, size, secret, and source-collision postflight.
Timeout cancels the session and pauses the task. Immutable denials do not create
permission interactions: the bridge sends one recovery steer per fingerprint,
then stops the turn and pauses on the third identical denial in one prompt.

## Process, state, and restart model

A canonical repository identity hashes the real repository root and Git common
directory. A process-pool key adds the effective configuration/network
fingerprint and the task `worker_lane`; fast and deep tasks of one repository
never share a Reasonix process. Tasks may share a process but never a branch,
worktree, session, contract hash, or state.

Fast-lane tasks run Reasonix in economy + normal session mode with planner off:
the prompt is a direct edit instruction with no plan/todo and no worker-owned
acceptance checks, and Goal, AutoResearch, review/task skills, or subagent
signals fail the task fast. Deep-lane tasks keep Delivery + Goal continuation.
Both lanes enforce workspace-only writes, an enforced OS sandbox, explicit
network posture, and effective-status verification on create, resume, repair,
and finalize. The bridge validates the ACP status extension and effective
sandbox before work proceeds.

TaskRecord v4 is version-gated and validates canonical contract/hash, identity,
evidence, usage, collision state, and semantic timestamps. Valid v1/v2 state is
migrated directly to v4 under serialized stale-read protection, keeping the
historical effective `max` effort and 600-second deadline on the deep lane;
v3 records keep their stored effort/deadline and gain the deep lane. New tasks
use the exact requested/env/default effort and lane-based deadline. Corrupt,
unknown older, and future schema versions fail closed. On restart, interrupted
tasks pause with their worktree/evidence preserved; inspection is required
before resume.

Untracked `.reasonix/**` files are bridge runtime metadata: they are excluded
from changed-file lists, canonical diffs/trees, review bundles, secret scans,
staging, and commits, and never require a `.gitignore` entry. Tracked changes
in that namespace and structured worker writes into it are rejected.

## Source-collision authority

The core scanner compares both source dirty paths and committed delta since the
task base against `write_scope`. It runs on resume, before/after worker mutation,
at review readiness, and before/during finalization. Overlap records bounded
evidence, releases the lease, and pauses or blocks the task without reset,
stash, or deletion.

The optional user Codex hook reads active-task sentinels and blocks overlapping
`apply_patch` paths plus unknown/write-capable Bash. With no active state it
allows; with a corrupt active sentinel/state it fails closed for Bash and
`apply_patch`. It preserves third-party hooks and still requires manual `/hooks`
trust. It is an early guardrail only—the core scanner remains authoritative.

## Finalization transaction

Finalization requires an idle `review_required` task. Approval accepts any
valid acceptance id: automated ids are ignored for approval, but every
review-evidence criterion must be approved (missing or foreign ids are rejected
with the required list). It guards source ownership, recomputes worker changes,
rejects out-of-scope paths/submodules/symlink escapes, enforces size/secret
checks, runs every verification command, verifies byte-exact `file_assertions`,
then repeats collision and content checks.

The bridge captures a canonical worktree tree at review readiness (a temporary
index built from the base commit covers tracked, untracked, deleted, and mode
changes, excluding runtime metadata). Finalization compares that snapshot
before and after verification, then compares the staged tree after explicit
staging — no `git add -N` is ever used. Verification-time or post-review tree
mutation is rejected as ownership ambiguity; failures before commit return to
repairable `review_required`, where the canonical snapshot is re-captured so a
hand-repaired worktree stays finalizable, and only commit/ref failures use
`commit_failed`.

Automated criteria are approved by verification results or by file-assertion
hash/length evidence. The bridge stages an explicit path list, compares
reviewed and staged trees, and runs Git commit hooks against a disposable
reviewed index. Hook mutation aborts. The final commit object uses the exact
reviewed tree, and the worker ref advances through an old-OID compare-and-swap.
Completion does not integrate the source checkout; the supervisor may
explicitly cherry-pick the returned hash after review. Nothing pushes or merges.

## Retention and local metrics

Archive accepts only terminal tasks with a clean or missing verified worker
worktree. It moves the full audit atomically and may detach a clean worktree,
but preserves branch/ref/commit. Prune is age-gated and replaces eligible
archives with integrity-bound tombstones; interrupted prune staging is recovered
idempotently.

Metrics are local, bounded, atomic event files. Their closed schema stores
decision/outcome classes, durations/counts, task hashes, and provider usage
numbers. It never stores raw prompts, argv, output, secrets, or file contents,
and nothing is uploaded.
