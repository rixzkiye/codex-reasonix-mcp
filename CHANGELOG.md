# Changelog

All notable changes are documented here. Versions follow Semantic Versioning.

## [0.2.0-rc.3] - 2026-08-03

### Added

- Add `worker_lane: "fast" | "deep"` to `reasonix_delegate`; new tasks default
  to `fast` (Reasonix economy + normal session, direct-edit prompt with no
  plan/todo or worker-owned acceptance checks). The lane is persisted in the
  task execution profile and does not affect the TaskContractV1 hash.
- Add per-lane execution deadlines: fast 600 seconds, deep 3,600 seconds,
  override 60–14,400 seconds; resumes always use the stored value and the wait
  timeout never cancels a worker.
- Add byte-exact `file_assertions` to TaskContractV1 (exact UTF-8 content
  including newline, at most 64 KiB); evidence records only hash and byte
  length, never raw content.
- Add review metadata to the bounded review bundle and task view:
  `required_review_criteria`, `review_revision`, `review_diff_sha256`,
  `worker_lane`, and effective Reasonix work/session modes.
- Add read-only `git check-ignore` support with explicit repository-relative
  paths and only the safe quiet/verbose flags; stdin, path escapes, and unknown
  options are rejected.
- Migrate TaskRecord atomically to schemaVersion 4: v1/v2 records keep their
  historical `max` effort and 600-second deadline on the deep lane; v3 records
  keep stored effort/deadline and gain the deep lane; legacy `minimal` effort
  records remain readable.

### Changed

- Remove `minimal` from the wire `reasoning_effort` enum and from new
  configuration; effort default precedence stays task field, then environment,
  then `medium`.
- Run one ACP process per repository and lane; the pool key and status
  verification cover the lane on create, resume, repair, and finalize.
- Fail fast on the fast lane when status or session events show Goal,
  AutoResearch, review/task skills, or subagents; the deep lane keeps Goal
  continuation while the bridge still owns scope scanning, verification,
  staging, commit, and final review.
- Treat untracked `.reasonix/**` as runtime metadata: excluded from changed
  files, diffs, review bundles, security scans, staging, and commits without
  any `.gitignore`; tracked changes or structured worker writes in the
  namespace stay forbidden.
- Replace `git diff --no-index` synthesis with a temporary index built from the
  base commit, producing one canonical tree/diff for tracked, untracked,
  deleted, and mode changes.
- Save the canonical review tree before `review_required`; finalize compares
  that snapshot before and after verification and then compares the staged
  tree — never `git add -N`.
- Accept every valid acceptance id in finalize approval, ignore automated ids
  for approval, and require all review-evidence criteria; foreign or missing
  review ids are rejected with the required list.
- Keep `commit_failed` for commit/ref failures only; verification failures
  without a commit return to repairable `review_required` and rollback only
  bridge-owned staging.

### Fixed

- Prevent post-terminal status updates from overwriting a failed fast-lane
  task's phase.
- Keep exactly three tools; instructions and descriptions now steer Codex to
  the fast lane unless the task is genuinely long-horizon, to `low` as the
  lowest effort, and to copying `required_review_criteria` into finalize.

## [0.2.0-rc.2] - 2026-08-03

This source tree prepares a second release candidate after the first local live
conformance run reached its ten-minute deadline and was not published.

### Fixed

- Stop deep-doctor provider runaway at 50,000 cumulative input, completion, and
  reasoning tokens while retaining the absolute ten-minute deadline.
- Capture privacy-safe partial proofs, task-state classes, and a bounded event
  type tail after state drain but before mandatory temporary-state cleanup.
- Redact raw failure details, phase/reason values, provider usage source, and
  unsupported currency values without hiding safe usage/cost totals.

## [0.2.0-rc.1] - 2026-08-03

The first local `0.2.0` candidate failed live conformance and was not published
to npm.

### Added

- Add shell-first command supervision based on private static argv v1 metadata,
  audited read-only commands, exact contract command matching, immutable hard
  denials, per-command watchdogs, and bounded denial-loop recovery.
- Add optional `allowed_commands` to `TaskContractV1`, contract linting from a
  file or stdin, and exact argv plus repository-relative cwd matching while
  retaining verification as the sole automated acceptance-evidence source.
- Add source-collision authority across resume, mutation, review readiness, and
  finalization, plus an optional user-level Codex hook guardrail that preserves
  third-party hooks and still requires manual trust through `/hooks`.
- Add `task list`, terminal-task archive, age-gated prune, permanent tombstones,
  crash recovery, and dry-run-by-default mutation commands.
- Add privacy-safe local metrics for permission classes, denial loops, command
  outcomes, source collisions, lifecycle duration, verification, and provider
  usage without storing prompt, argv, output, secret, or file contents.
- Add an explicit deep-doctor conformance lane that permits exactly one bounded
  provider Goal only with `--deep --allow-provider-call`, reports usage/cost and
  proof results, and always attempts temporary-resource cleanup.

### Changed

- Replace generic MCP outputs with concrete success schemas for the existing
  three tools. Successful calls return matching `structuredContent`; errors use
  a stable redacted envelope with `code`, `message`, `retryable`, and a closed
  `next_action` value.
- Correct MCP annotations: delegate/control are mutating, destructive,
  non-idempotent, open-world operations; inspect is read-only, non-destructive,
  idempotent, and closed-world.
- Split the runtime into supervision, permission, collision, finalization,
  inspection, and operation modules behind a thin façade.
- Validate persisted task records field-by-field, migrate v1 records atomically
  to v2, and reject corrupt or unknown future state versions before mutation.
- Make standard `doctor` local-only: it checks executables, flags, platform,
  sandbox availability, and private state permissions without creating an ACP
  session or calling a provider.
- Gate `pnpm check` on V8 coverage of at least 80% lines, statements, and
  functions plus 75% branches.

### Security

- Treat Git mutations or ref/history rewrites, remotes, publish/release, network access,
  credentials, privilege escalation, destructive filesystem operations,
  shell/eval, inline interpreters, metadata mismatch, and cwd escape as
  immutable denials that contracts cannot override.
- Compare source dirty paths and committed movement since the task base against
  `write_scope`; collisions pause or block work without resetting, stashing, or
  deleting user changes.
- Require archive ownership and cleanliness checks, preserve worker refs and
  commits, and reduce eligible old archives only to integrity-bound tombstones.

## [0.1.1] - 2026-08-02

### Changed

- Route explicitly approved Reasonix implementation through `reasonix_delegate`
  instead of substituting native Codex subagents, while retaining native
  subagents for bounded parallel exploration, tests, triage, and summaries.
- Publish the complete routing boundary, all three tool names, sandbox metadata
  requirement, and no-push/no-merge constraint within the first 512 server
  instruction characters.

## [0.1.0] - 2026-08-02

### Added

- Publish the first stable bridge release after all release-candidate protocol,
  lifecycle, sandbox, packaging, and Codex visibility gates passed.

### Changed

- Set official Reasonix v1.19.0 as the supported compatibility baseline now
  that it ships the required ACP v1 supervisor and status capabilities.
- Remove the obsolete bundled Reasonix source patch while retaining strict,
  capability-based fail-closed validation.

## [0.1.0-rc.4] - 2026-08-02

### Fixed

- Advertise homogeneous verification argv arrays so Codex 0.146.0 can parse and
  expose `reasonix_delegate` without relaxing `TaskContractV1` validation.
- Publish `reasonix_control` as a flat object schema and revalidate its
  action-specific fields through the strict domain discriminated union.
- Name and explain all three MCP tools at the start of the server instructions.

## [0.1.0-rc.3] - 2026-08-01

### Fixed

- Accept the single-dash option spelling emitted by Go's standard flag help
  while retaining support for conventional double-dash help output.
- Align the strict Reasonix ACP status schema with the upstream sandbox
  `available` field and fail closed when the effective sandbox is unavailable.

## [0.1.0-rc.2] - 2026-07-31

### Fixed

- Resolve the installed npm bin symlink before detecting CLI invocation, so
  `serve`, `doctor`, and `version` execute correctly through `npx` and
  `node_modules/.bin`.

## [0.1.0-rc.1] - 2026-07-31

### Added

- Standalone TypeScript ESM MCP server for Node.js 22+.
- Immutable `TaskContractV1` validation and deterministic Goal rendering.
- Isolated Git worktrees, private state, leases, redacted journals, and restart
  recovery.
- ACP v1 Reasonix process/session supervision with mandatory status extension.
- Three stable MCP tools for delegate, control, and bounded inspection.
- Scoped permission policy, secret scanning, argv-only verification, explicit
  staging, and a single atomic worker commit.
- Offline fake-agent, protocol, unit, Git integration, and end-to-end tests.
- Upstream Reasonix `main-v2` compatibility patch.
- Linux/macOS CI, package-content validation, release artifacts, and npm OIDC
  trusted publishing with provenance.

### Security

- Network defaults off, native Windows is rejected, provider credentials are
  excluded from verification subprocesses, and the bridge never pushes or
  merges.
- Trusted Reasonix static-command metadata prevents model-supplied argv spoofing;
  Git-control and credential paths are denied to workers.
- Verification descendants are terminated as a process group, resume requires
  an unchanged effective sandbox fingerprint, and finalization repeats scope,
  size, symlink, submodule, and secret gates after tests.
- Commit hooks run on a disposable index; hook mutation cannot alter the exact
  reviewed tree committed by the bridge.
