# Security Hardening Plan — codex-reasonix-mcp

Status: **planning** (no code changed). Derived from a validated security review of the
untrusted-repository execution surface. All findings below were re-verified against the
current tree (branch `feat/v0.2-supervision-hardening`, v0.2.0-rc.3).

Execution rule: **one PR per milestone** (`fix/…` or `feat/…` branch per item), each
landing independently. Sequencing and exit gates follow the review.

---

## Threat summary (what the gates protect against)

| # | Finding | Where | Severity |
|---|---------|-------|----------|
| T1 | Verification commands, external scanner, and Git hooks execute repository-controlled content **without an OS sandbox** (only sanitized env, cwd confinement, timeout, output caps) | `src/verification.ts:33`, `src/security.ts:53`, `src/repository.ts:657-677` | High for untrusted repos/CI |
| T2 | The Reasonix worker inherits **almost the entire host environment** | `src/acp.ts:127-132` (single call site `:251`) | Medium/High |
| T3 | Journal can get ahead of persisted state (duplicate/lost sequence on crash) | `src/state.ts:733-781` vs `:711` | Medium |
| T4 | `reasonix_inspect` mutates state (`inspectedAfterPause`); pause acknowledgment is not bound to a monotonic token | `src/runtime/inspection.ts:35-39` | Medium |
| T5 | Finalize is not bound to a review revision/hash — `reviewTreeHash` optional, `reviewRevision` output-only, never validated | `src/runtime/finalization.ts:78-104, 240-251, 283-293, 360-370` | Medium |
| T6 | Branch ownership checked by prefix only; rollback re-resolves the ref | `src/repository.ts:613-616, 753-773` | Low |

Nuance already true today: bridge subprocesses run with a **sanitized allowlist env**
(`SAFE_ENV_KEYS`, `src/command.ts:27-46, 48-67`; secrets throw), so provider credentials
are not inherited by verification/git/hooks. The residual vectors are **filesystem and
network access** of the bridge user, plus the single full-env handoff at `acp.ts:251`.

---

## PR 0 — Compatibility hotfix: `usage.estimated` (Reasonix ≥ 1.19.4)

**Branch:** `fix/usage-estimated-compat` — deliberately split from hardening.

### Current state
- `src/reasonix-status.ts:10-22` — `usageSchema` is `.strict()` with exactly 10 fields;
  a v1.19.4+ payload carrying `usage.estimated` fails with zod "Unrecognized key(s)".
- Validation sites: `src/acp.ts:441-450` (`status()` → `reasonix_incompatible`,
  fail closed), `src/acp.ts:272-279` (push `status_update`; the ACP SDK **swallows**
  notification parse errors and only `console.error`s them — silent divergence risk),
  revalidation on load `src/state.ts:340-343`.

### Changes
- `src/reasonix-status.ts`: accept the new optional field(s) from the v1.19.4+ status
  shape while keeping `.strict()` for everything else (a genuinely unknown key must
  still be rejected — regression guard).
- No behavior change elsewhere; `statusToUsage` (`src/runtime/shared.ts:93`) is
  unaffected if `estimated` is metadata-only.

### Tests
- New `tests/unit/reasonix-status.test.ts` (or extend the fixture pattern of
  `tests/unit/session-supervision.test.ts:12-18`): payload matrix —
  v1.19.0 shape (no `estimated`) ✓, v1.19.5 shape (`estimated: true` / `false`) ✓,
  unknown extra key ✗.
- `tests/fixtures/fake-reasonix.ts:84-162` (status builder): add a `--fake-mode`
  variant emitting `estimated`; assert in `tests/e2e/offline.test.ts` (pattern
  `:477-521`) that the deep-lane flow still completes.

### Dependency follow-up (separate dependency PR, not part of the hotfix)
- `pnpm audit` confirms **1 moderate**: `hono <4.12.34` (GHSA-8j4g-w8fx-2239, ReDoS in
  CORS middleware via `Access-Control-Request-Headers`); current `hono@4.12.33` is
  transitive via `@modelcontextprotocol/sdk@1.30.0` (`pnpm-lock.yaml:886`).
- Runtime exposure is nil (stdio-only transport, `src/server.ts:156-161`), but the CI
  `dependency-audit` job should stay clean. Fix: `pnpm.overrides` `hono ^4.12.34` or an
  SDK bump; verify `pnpm audit` and `pnpm check`.

### Exit gate
- v1.19.0 and v1.19.5 status payloads are both accepted end-to-end; unknown keys are
  still rejected; `pnpm audit` clean; full `pnpm check` green.
- Release follows the dual-source version rule (`package.json` + `src/version.ts`,
  asserted by `tests/unit/release-metadata.test.ts:34-37`) and a dated CHANGELOG entry.

### Open question
- Exact location of `estimated` in the real v1.19.4+ payload (`usage.turn.estimated`?
  `usage.estimated`? top-level?). Capture a real status dump before finalizing the
  schema; default assumption: add it to `usageSchema` so both `turn` and `cumulative`
  accept it.

---

## PR 1 — Independent command sandbox (`SandboxedCommandRunner`)

**Branch:** `feat/command-sandbox`

### Current state
- `src/command.ts:69-165` (`runCommand`): no shell, `detached` spawn, timeout with
  process-group SIGTERM→SIGKILL (`:121-127`), group kill on close (`:148`), 4 MiB/stream
  caps, sanitized allowlist env — **no OS-level isolation**.
- Untrusted-content execution sites: verification (`src/verification.ts:33`), external
  secret scanner (`src/security.ts:51-70`), Git hooks (`src/repository.ts:657-677`),
  and repo-configured **filters/drivers** inside git: `git worktree add` smudge
  (`src/repository.ts:201-205`), `git add` clean (`:419` canonical snapshot, `:525`
  staging), `git diff --cached --check` textconv (`:595` — the only diff without
  `--no-ext-diff`).
- `bwrap`/`sandbox-exec` are only *checked for presence* (`src/doctor.ts:769-775`),
  never invoked.

### Design
- New `src/sandbox-runner.ts`: `SandboxedCommandRunner` — the single authority that
  wraps `runCommand` with an OS sandbox for the designated call sites. Two profiles:
  - **`untrusted-command`** (verification, scanner, hooks): writable = worktree +
    private writable temp slot; everything else read-only; network off; `/tmp` private.
  - **`git-ops`** (bridge-owned staging/commit git invocations that can run filters):
    writable = worktree + source git dir (objects/refs) + temp slot; network off.
- Linux: bubblewrap —
  `bwrap --die-with-parent --unshare-net --new-session --ro-bind / / --bind <worktree> <worktree> --bind <tmp-slot> <tmp-slot> --tmpfs /tmp --proc /proc --dev /dev --chdir <cwd> -- <argv>`.
  `--die-with-parent` + the existing group-kill ⇒ no lingering descendants. Env:
  `--unsetenv` all, then set only the sanitized allowlist.
- macOS: `sandbox-exec` profile (deny `network*`; `file-read*` allow; `file-write*`
  restricted to worktree + tmp slot; deny `file-write*` under `HOME`). **Note:**
  `sandbox-exec` is deprecated by Apple — accepted risk for now, documented; revisit
  if a maintained alternative is needed.
- **Fail closed**: missing `bwrap`/`sandbox-exec` at runtime (checked per invocation,
  not just in doctor) → verification and hooks are rejected (`sandbox_unavailable`).
  Explicit escape hatch `CODEX_REASONIX_ALLOW_UNSANDBOXED=true` (documented unsafe,
  denied for hooks by default). Windows: same fail-closed default.
- **Git hooks disabled by default**: `createAtomicCommit` skips the hook loop
  (`src/repository.ts:657-677`); new immutable config `run_git_hooks: true`
  (`CODEX_REASONIX_RUN_GIT_HOOKS` in `src/config.ts`) re-enables them **through the
  sandbox**. Ensure `git worktree add` also can't fire hooks
  (`-c core.hooksPath=<empty>` on creation).
- **Temp-path plumbing**: `canonicalWorktreeSnapshot` (`src/repository.ts:410-444`)
  and `createAtomicCommit` (`:627-641`) put `GIT_INDEX_FILE`/`COMMIT_EDITMSG` in
  `os.tmpdir()` — invisible inside a private sandbox `/tmp`. Move sandboxed-git temp
  files into a shared writable slot, e.g. `<stateDir>/sandbox/<taskId>/` (0700),
  bind-mounted writable, and point `GIT_INDEX_FILE` there.
- Env hygiene inside sandbox: keep `sanitizedEnvironment` (no secrets, no HOME) +
  `GIT_CONFIG_NOSYSTEM=1`.

### Tests (adversarial + benign)
- Fixture repo whose hook/verification command: (a) reads a credential file under
  `HOME`/`~/.ssh` → must fail; (b) writes a sibling directory outside the worktree →
  must fail; (c) `curl`s/`nc`s the network → must fail; (d) spawns a background
  `sleep 1000 &` → must be reaped (existing group-kill + `--die-with-parent`).
- Default posture: repo with a failing `pre-commit` hook → commit succeeds (hook not
  run); with `run_git_hooks: true` → the same malicious hook fails the commit but the
  ref/index stay untouched.
- Benign verification command (the `tests/fixtures/` and `tests/e2e/offline.test.ts`
  flows) passes on Linux **and** macOS.
- CI: extend `.github/workflows/ci.yml` matrix (currently ubuntu-22/24 × node 22/24 +
  macos-15, `:20-36`) with the adversarial e2e on both platforms.

### Exit gate
Malicious test/hook cannot read credential files, cannot write sibling directories,
cannot reach the network, cannot leave descendant processes; benign verification still
passes on Linux and macOS; hooks are off by default.

---

## PR 2 — Environment allowlist for the Reasonix child

**Branch:** `feat/env-allowlist`

### Current state
- `src/acp.ts:127-132` `inheritedReasonixEnvironment()`: shallow copy of **all of**
  `process.env` minus `NODE_OPTIONS` and `NPM_CONFIG_USERCONFIG`; single call site
  `src/acp.ts:251` (`ReasonixProcess.launch`, `cwd: repository.root`). This is the only
  spawn in `src/` that passes the full environment — provider credentials
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) reach the worker implicitly.
- The bridge never names or logs provider credentials today (journal `data` is redacted
  via `redaction.ts`; doctor reads only `CODEX_HOME`, `src/doctor.ts:719`).

### Changes
Replace with an explicit builder `buildReasonixEnvironment(config)`:
- **System baseline**: `PATH`, `HOME` (needed for `~/.codex`), `XDG_*` when set,
  `LANG`/`LC_*`, `TERM`, `TMPDIR`/`TMP`/`TEMP`, CA vars
  (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`),
  `CODEX_HOME`.
- **`REASONIX_*`** pass-through.
- **Provider credentials**: only keys named in the new
  `CODEX_REASONIX_ENV_ALLOWLIST` (comma-separated exact names or globs, e.g.
  `ANTHROPIC_*`, `OPENAI_*`). Default: empty (nothing credential-shaped passes).
- **Hard-deny even if allowlisted**: `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_*` (incl. `DYLD_INSERT_LIBRARIES`), `BASH_ENV`, `ENV`, `BASHOPTS`,
  `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `PAGER`, `NPM_CONFIG_*`/`npm_config_*` — the
  `GIT_*`/`PAGER` entries matter because the worker's policy-allowed read-only
  `git diff`/`git log` (`src/policy.ts:595-605`) would otherwise execute inherited
  helper/driver binaries.
- **Logging invariant**: journal (`src/state.ts:733-781`) and doctor never record env
  names or values; keep `redactString` on child stderr (`src/acp.ts:286`).
- Docs: new `docs/configuration.md` + `docs/security.md` sections.

### Tests
- Fake-worker env-dump mode (`tests/fixtures/fake-reasonix.ts`): with a credential
  ambient in the test env, assert the worker env contains no ambient secrets; that
  allowlisted names arrive; that every hard-deny var is absent.
- Unit tests for the builder (baseline/allowlist/deny precedence).
- Regression: `events.jsonl` and doctor JSON contain no `NAME=VALUE` env pair.

### Exit gate
Ambient secrets do not reach the Reasonix child; allowlisted credentials still work;
denied injection variables are absent; secret names/values never appear in
journal/log/doctor output.

---

## PR 3 — Snapshot-bound approvals + pause acknowledgment

**Branch:** `feat/snapshot-bound-approvals`

### Current state
- Finalize schema (`src/tool-schemas.ts:72-102`): `review_summary` + approved criteria
  only — **no revision/tree-hash inputs**; `.strict()` so unknown keys are rejected
  (adding fields is a schema change, not a silent pass).
- `reviewTreeHash` is optional in task state (`src/types.ts:159-162`); when set it is
  compared at `src/runtime/finalization.ts:242` (preflight), `:283` (post-verification),
  `:361` (staged). `reviewRevision` is output-only (`tool-schemas.ts:232, 314`) and
  **never validated** on finalize; bumped on new snapshot
  (`src/runtime/session-supervision.ts:485`) and on repair re-capture
  (`finalization.ts:158`).
- Pause acknowledgment: `reasonix_inspect` sets `inspectedAfterPause = true`
  (`src/runtime/inspection.ts:35-39`) — a **mutation** in an otherwise read-only tool;
  resume requires the flag (`src/runtime/operations.ts:151-154`). No
  `pause_revision`/`pause_reason_hash` identifiers exist anywhere.

### Changes
1. **Finalize binding** (`src/tool-schemas.ts:72-102` + `finalization.ts`): require
   `expected_review_revision` (int ≥ 0) and `expected_review_tree_hash` (sha hex) in
   the finalize payload; validate equality against `task.reviewRevision` /
   `task.reviewTreeHash` at all three checkpoints — before the `verifying` transition
   (`finalization.ts:101-104`), after verification (`:283`), and immediately before
   staging/commit (`:360-395`). Mismatch → `ownership_ambiguous`/stale-approval error;
   task returns to `review_required` with a re-captured tree + bumped revision
   (`finalization.ts:136-162`).
2. **Pause acknowledgment**:
   - Add monotonic `pause_revision` + `pause_reason_hash` (sha256 of the canonical
     pause reason) to task state (`src/types.ts`); bump at **all 7 pause entry sites**:
     `session-supervision.ts:363-365, 498-506, 525-532`, `collision.ts:145-157`,
     `permissions.ts:121-123`, `state.ts:803-813` (restart recovery), `finalization.ts:147`.
   - `reasonix_inspect` becomes **read-only**: remove the `updateTask` at
     `inspection.ts:35-39`; its output (taskView) includes the current
     `pause_revision`/`pause_reason_hash` so clients can echo them.
   - Resume (`src/runtime/operations.ts:151-190`): while `paused`, require the latest
     `pause_revision` + `pause_reason_hash`; stale/mismatched → rejected with fresh
     values in error details. Retire `inspectedAfterPause` (keep for compat during a
     state schemaVersion migration via `persistMigration`, `src/state.ts:680-703`).

### Tests
- Unit: finalize schema requires both fields; each of the 3 checkpoints rejects a
  stale revision (simulate a repair between approve and finalize → tree re-captured,
  revision bumped); stale pause ack rejected; `reasonix_inspect` leaves state bytes
  unchanged.
- E2E (`tests/e2e/offline.test.ts`): approve → mutate worktree → finalize fails and
  re-captures; resume with an old token → rejected.

### Exit gate
Approvals captured before a repair, and pause acknowledgments older than the current
pause, are **always rejected**.

---

## PR 4 — Crash-consistent journal transactions

**Branch:** `feat/journal-transactions`

### Current state
- `state.json` is authoritative; `events.jsonl` is an append-only audit trail
  (`src/state.ts:733-781`): `seq = state.eventSequence + 1` is appended+fsynced
  **before** `saveTask` persists the bumped `eventSequence` (`state.ts:748-749, 776`).
  A crash in between ⇒ next append reuses the seq (duplicate) or the event is orphaned.
- `atomicWrite` (`src/state.ts:52-66`): tmp file, fsync, chmod 0600 **before** rename
  (the recent chmod-race fix) — but **no parent-directory fsync after rename**
  (`:65`), so the rename itself can be lost on power loss.
- Startup: no journal replay; `recoverInterruptedTasks` (`src/state.ts:793-823`) flips
  non-terminal tasks to `paused`; `loadTask` fails closed on corruption
  (`src/state.ts:471-496`).
- Writes already serialize: file lease (`src/lease.ts:87-105`, held across
  create/resume/finalize) + in-process `updates` chain (`state.ts:680-731`).

### Changes (bounded pending transaction, executed under the task lease)
1. Compute event + next state under the lock (existing update path).
2. `atomicWrite` `pending-event.json` = { event, nextState, seq } (0600).
3. Append + fsync `events.jsonl` (existing `appendEvent`).
4. `atomicWrite` `state.json` **+ fsync parent dir**.
5. Fsync task dir.
6. Unlink `pending-event.json` + fsync dir.
- Startup recovery (new `src/state-recovery.ts`): validate journal sequence is
  contiguous and monotonic vs `state.eventSequence`; if `pending-event.json` exists,
  reconcile from the journal/state combination (journal has seq, state doesn't →
  apply nextState; state has seq → drop pending); a partial trailing journal write is
  truncated only when provable from the pending envelope, otherwise **fail closed**
  (`invalid_state`).
- `fsyncDir` helper tolerating `EINVAL`/`ENOTSUP` (platform-dependent dir fsync).

### Tests
- Fault-injection unit suite (`tests/unit/crash.test.ts`): simulate a crash at each of
  the 6 steps (fault-injectable fs wrapper or scenario fixtures for each pending-file
  state) and verify recovery: no duplicate sequence, no lost mutation.
- Startup recovery cases: pending exists + journal ahead; pending exists + state
  ahead; truncated trailing line; irreconcilable conflict → `invalid_state`.
- Keep the existing recovery coverage (`tests/characterization/runtime-v0.1.1.test.ts:149-159`).

### Exit gate
Crash injection at every step never produces a duplicate sequence or a lost state
mutation.

---

## PR 5 — Exact Git ownership

**Branch:** `feat/exact-git-ownership`

### Current state
`createAtomicCommit` (`src/repository.ts:603-777`):
- `:609-612` HEAD CAS vs `baseCommit`; `:613-616` **prefix-only** branch check
  (`startsWith('refs/heads/reasonix/')`).
- `:720-727` ref update `update-ref <branch> <commitHash> <baseCommit>` (CAS with
  `baseCommit` as oldvalue — good) — but `branch` is whatever HEAD said.
- `:753-773` rollback re-resolves `rev-parse --verify branch` and CASes back to
  `baseCommit`; the branch string is fixed from `:613`, but a HEAD moved between
  `:609` and `:613` (or onto another `reasonix/*` branch) redirects both the forward
  update and the rollback.
- `finalization.ts:404-421`: post-commit state persistence failure leaves a dangling
  commit with no ref rollback.

### Changes
- Signature: `createAtomicCommit(worktree, baseCommit, message, identity, expectedBranch)`
  — caller passes `task.branch` = `refs/heads/reasonix/<taskId>`
  (call site `src/runtime/finalization.ts:390-395`).
- **Exact match** replaces the prefix check (`:614`); reject before any ref/index
  write.
- Use `expectedBranch` for both the forward `update-ref` CAS (`:720-727`) and the
  rollback (`:753-773`) — never re-resolve from HEAD.
- Filter/hook hardening (overlaps PR 1): all git invocations that can run
  repo-configured filters/hooks go through the `SandboxedCommandRunner`; add
  `--no-ext-diff` to `assertStagedChecks` (`:595`) to match every other diff; set
  `GIT_ATTR_NOSYSTEM`/`GIT_CONFIG_NOSYSTEM` where applicable.
- Rollback policy for post-commit persistence failure: decide explicitly — either
  roll the ref back to `baseCommit` (CAS) before marking `commit_failed`, or keep the
  dangling commit but record it; document the choice in `docs/security.md`.

### Tests
- Fixture repo with a pre-existing `reasonix/<other>` branch: finalize → rejected
  (`ownership_ambiguous`) with ref and index byte-identical afterwards.
- Unit: exact-match logic; CAS failure (HEAD moved) → no update, rollback CAS failure
  → `commit_failed`.

### Exit gate
A branch with a valid prefix but wrong identity is rejected without changing ref or
index.

---

## PR 6 — Security proof matrix + documentation

**Branch:** `feat/security-proof-matrix`

### E2E matrix (`tests/e2e/security-matrix.test.ts`, reusing the `offline.test.ts` harness)
| # | Row | Gate (PR) |
|---|-----|-----------|
| 1 | Malicious verification source (credential read / sibling write / network / background descendant) | PR1 |
| 2 | Malicious package script (as verification command) | PR1 |
| 3 | Malicious Git hook (`run_git_hooks: true`) | PR1 |
| 4 | Environment exfiltration (fake worker dumps env; allowlist assertions) | PR2 |
| 5 | Network access from verification/hook → denied | PR1 |
| 6 | Filesystem escape (write outside worktree) → denied | PR1 |
| 7 | Crash recovery (kill mid-transaction; pending reconciliation) | PR4 |
| 8 | Stale review / pause token | PR3 |
| 9 | Wrong Reasonix branch (prefix-valid) | PR5 |

### Docs
- `docs/security.md`: new sections — Command sandboxing & trust boundaries;
  Environment allowlist; Approval & pause binding; Journal durability; Git ownership;
  Threat model + proof matrix table mapping each PR to its exit gate. Update
  "Known limits" (hooks off by default, sandbox required, `sandbox-exec` deprecation).
- `src/doctor.ts`: report sandbox availability + posture in the JSON report (new
  fields, covered in `tests/unit/doctor.test.ts`).
- `README.md`: only claim "hardened for untrusted repositories" after the Linux +
  macOS sandbox gates pass in CI.
- CI: add the adversarial e2e job (Linux + macOS) and make it a required check.

### Exit gate
All 9 matrix rows green on Linux and macOS; `docs/security.md` threat model matches
the implementation.

---

## Sequencing and dependencies

1. **PR 0** (compat hotfix — independent, can ship alone as a release)
2. **PR 1** (sandbox — largest; unblocks T1)
3. **PR 2** (env allowlist — T2)
4. **PR 3** (review/pause binding — T4, T5)
5. **PR 4** (journal transactions — T3)
6. **PR 5** (exact branch — T6; builds on PR1 for filter/hook hardening)
7. **PR 6** (proof matrix + docs — closes the loop)

PRs 1–2 and 3–5 are largely independent; PR5's filter hardening reuses the PR1
runner. Each PR must pass the full `pnpm check` gate (lint, format, typecheck,
coverage ≥ 80/75, build, package checks) and its own exit gate.

## Open questions for the owner

1. **PR 0**: exact shape/location of `usage.estimated` in a real v1.19.4+ payload.
2. **PR 1**: Windows posture — fail closed (recommended) vs opt-in unsandboxed;
   acceptance of the `sandbox-exec` deprecation on macOS.
3. **PR 3**: making `expected_review_revision`/`expected_review_tree_hash` required is
   a breaking client change — confirm bridge-generated clients are the only ones.
4. **PR 5**: rollback policy when post-commit state persistence fails (roll back ref vs
   record dangling commit).
