# codex-reasonix-mcp

[![CI](https://github.com/rixzkiye/codex-reasonix-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rixzkiye/codex-reasonix-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rixzkiye/codex-reasonix-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/rixzkiye/codex-reasonix-mcp/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![Codex supervising a Reasonix worker through the security-first MCP bridge](docs/assets/codex-reasonix-bridge.svg)

`codex-reasonix-mcp` is a security-first MCP bridge that lets Codex supervise
Reasonix as the implementation worker. Codex owns the immutable contract,
review, and final commit decision. Reasonix works in an isolated Git worktree
through ACP Goal mode. The bridge never pushes, merges, or changes the caller's
main worktree.

The core is generic to Git repositories. It contains no application-specific
paths, LLM router, native-Windows implementation, or Codex source modification.

## Release status

The last published stable npm release is `0.1.1`. This source tree is prepared
as `0.2.0-rc.3`; that version is not available from npm until its GitHub
prerelease and trusted-publishing workflow complete successfully. Official
Reasonix `v1.19.0` remains the documented compatibility baseline, while runtime
capability checks—not a version string—remain authoritative.

## Requirements

- Node.js 22 or newer
- pnpm 10 for source development
- Git 2.36 or newer
- Linux, macOS, or Windows through WSL; native Windows is rejected
- Reasonix v1.19.0 or a compatible newer build with ACP v1 supervisor/status
  capabilities and static command metadata v1
- Bubblewrap on Linux/WSL or Seatbelt on macOS (required: verification, the
  secret scanner, and Git hooks execute inside the OS command sandbox and
  fail closed when no engine is available)
- A configured Reasonix provider exposing the selected model

Reasonix, provider credentials, and provider billing remain user-managed. This
package neither downloads nor bundles Reasonix.

## Security posture

Repository-controlled content never executes unsandboxed: verification
commands, the external secret scanner, and (when explicitly enabled) Git hooks
run inside a network-disabled, filesystem-restricted OS sandbox with hidden
credential stores. Git hooks are **off by default**
(`CODEX_REASONIX_RUN_GIT_HOOKS=true` re-enables them through the sandbox).
The Reasonix worker receives an explicitly allowlisted environment
(`CODEX_REASONIX_ENV_ALLOWLIST`) instead of the host environment; injection
variables are hard-denied. Finalize approvals and pause acknowledgments are
bound to reviewed-snapshot and pause tokens, journal appends are
crash-consistent, and the bridge commit requires the exact task branch.

See [docs/security.md](docs/security.md) for the threat model, the proof
matrix, and the configuration knobs. The matrix gates run on Linux and macOS
in CI.

## Install for Codex

Use the published stable package today:

```sh
codex mcp add reasonix-worker -- npx -y codex-reasonix-mcp@0.1.1
```

For a local checkout of this release-candidate tree:

```sh
pnpm install --frozen-lockfile
pnpm build
codex mcp add reasonix-worker -- node /absolute/path/to/codex-reasonix-mcp/dist/index.js
```

After `0.2.0-rc.3` is actually published, consumers can pin that exact version
instead of relying on a moving dist-tag. Prereleases publish under `next`;
stable releases publish under `latest`.

## Diagnostics

Standard doctor is local-only and does not create an ACP session or call a
provider:

```sh
codex-reasonix-mcp doctor
```

It checks Node, Git, platform/WSL, the Reasonix binary and supervisor flags, OS
sandbox availability, state permissions, network posture, and that Codex has
`tool_timeout_sec = 900` under `[mcp_servers.reasonix-worker]`. This explicit
value is required even when a Codex release provides a shorter default.

The deep lane is explicit, bounded to one Goal, 50,000 cumulative provider
tokens, and ten minutes, and may incur provider cost:

```sh
codex-reasonix-mcp doctor --deep --allow-provider-call
```

It creates temporary source/state, proves a structured edit, static command,
exact verification, final worker commit, and unchanged source repository,
reports duration/usage/estimated cost, and always attempts cleanup. This lane
is never implied by standard doctor. Failure reports preserve only bounded,
privacy-safe partial proof and event-type diagnostics before cleanup.

## MCP surface

The `reasonix_worker` server exposes exactly three tools:

- `reasonix_delegate` validates `TaskContractV1`, creates or resumes the
  isolated task, and by default waits for review, interaction, failure, or a
  bounded timeout.
- `reasonix_control` steers, answers an interaction, cancels, finalizes, or
  closes a task. At most two post-review repair rounds are accepted.
- `reasonix_inspect` reads bounded status, evidence, interactions, collision
  evidence, and optional paginated diffs. Events are opt-in.

Each tool advertises a concrete success schema and every successful response
contains matching `structuredContent`. Errors remain `isError` responses with a
redacted `code`, `message`, `retryable`, closed-enum `next_action`, and optional
safe details. Delegate/control are annotated mutating, destructive,
non-idempotent, and open-world; inspect is read-only, idempotent, and
closed-world.

Codex calls `reasonix_delegate` only after explicit user request or approval for
Reasonix implementation. Delegate and finalization derive repository authority
from `codex/sandbox-state-meta`; no model-provided repository path is accepted.

The normal success path is exactly two long-running calls: one delegate with
the default `wait_mode: "review"`, then one `finalize` that waits for a terminal
result and returns the worker commit hash. Finalize echoes the reviewed
snapshot by mapping `review_revision` to `expected_review_revision` and
`review_tree_hash` to `expected_review_tree_hash`. New tasks run on the `worker_lane:
"fast"` (direct edits in Reasonix economy + normal mode, no Goal/AutoResearch/
subagents, 600-second default deadline); choose `worker_lane: "deep"` only for
explicitly long-horizon Delivery + Goal work (3,600-second default).
`reasoning_effort` is selected per task (`low`, `medium`, `high`, or `max`);
precedence is task field, then `CODEX_REASONIX_EFFORT`, then `medium`. Choose
the lowest sufficient effort. `execution_timeout_seconds` is a persisted
per-task execution deadline; new tasks default by lane (600 fast / 3,600 deep)
and may request 60–14,400 seconds. The separate delegate wait remains bounded
to 600 seconds: if it expires, the call returns a recoverable running view
while the worker continues. Re-delegating the same immutable task can wait
again without changing its stored execution profile. There is no hard worker
token ceiling. `path_base` defaults to the
invocation `cwd`; use `repository` only for legacy repository-root path
semantics. Inspect/steer are recovery tools, not happy-path polling steps.

If finalization fails, keep the retained task at review, inspect or repair it
there, and finalize again using the newly reviewed snapshot. Do not manually
copy the diff into the source checkout and do not close the task as a recovery
shortcut.

Completion creates a commit on the retained worker branch. It does not
integrate the caller's checkout: after reviewing the returned hash, Codex may
explicitly `git cherry-pick <hash>`. The bridge never pushes or merges.

## Shell-first supervision

Reasonix shell requests must carry private `_meta.reasonix.io` static argv v1
metadata and a cwd inside the worker worktree. The bridge then applies this
precedence:

1. Audited reads such as safe `rg`, non-in-place `sed`, `cat`, `ls`, safe
   `find`, and sanitized Git reads receive one-time approval.
2. Tests, builds, formatters, package managers, project scripts, and restricted
   `env` wrappers require an exact argv plus cwd match in contract verification
   or `allowed_commands`.
3. Git mutations or ref/history rewrites, `gh`, remotes, publish/release, network access,
   credentials, privilege escalation, destructive filesystem operations,
   shell/eval, inline interpreters, cwd escape, and metadata mismatch are always
   denied. A contract cannot override these rules.
4. Unknown executables are denied with a recovery hint.

Every allowed command has a watchdog and immediate post-command scope,
symlink, size, secret, and source-collision checks. Repeated identical immutable
denials receive one recovery steer; the third denial in the same prompt cancels
the turn and pauses the task instead of opening a permission interaction.

`allowed_commands` expands execution permission only. Verification commands
are implicitly allowed and remain the sole source of automated acceptance
evidence. See [task contracts](docs/task-contract.md).

## Collision safety and optional Codex hook

The bridge compares source dirty paths and committed movement since the task's
base against `write_scope` on resume, before and after worker mutation, at
review readiness, and throughout finalization. Overlap pauses or blocks the task
without reset, stash, or deletion. This core scanner is authoritative.

An optional user hook provides an earlier guardrail for Codex `Bash` and
`apply_patch` calls:

```sh
codex-reasonix-mcp hooks install --user
codex-reasonix-mcp hooks install --user --apply
codex-reasonix-mcp hooks status --user
```

Install/uninstall are dry runs without `--apply`. Installation atomically
merges `~/.codex/hooks.json`, preserves third-party hooks, and installs a
versioned runtime in private state. You must still inspect and trust it manually
through Codex `/hooks`; the installer does not bypass trust. The hook is a
guardrail, never the collision authority.

## Task retention

```sh
codex-reasonix-mcp task list
codex-reasonix-mcp task list --all --json
codex-reasonix-mcp task archive <id>
codex-reasonix-mcp task archive <id> --apply
codex-reasonix-mcp task prune --older-than 30d
codex-reasonix-mcp task prune --older-than 30d --apply
```

List shows active tasks by default; `--all` includes terminal live tasks,
archives, and tombstones. Archive accepts only a terminal task whose worker
worktree is clean or missing. It moves the full audit atomically and may detach
a clean worktree, but never deletes the branch, ref, or commit. Prune applies
only to archives at least the requested age and replaces them with permanent,
integrity-bound tombstones. Mutations are dry runs unless `--apply` is present.

## Local data and metrics

Task state uses a validated, version-gated v2 schema. Valid v1 records migrate
atomically on read; corrupt, noncanonical, and unknown future versions fail
closed. Private local
metrics record only closed numeric/outcome classes for permissions, denial
loops, commands/timeouts, collisions, lifecycle duration, verification, and
provider usage. They hash task identity and never store raw prompts, argv,
command output, secrets, or file contents. There is no telemetry or upload.

## Develop

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm audit --audit-level high
```

`pnpm check` includes lint, formatting, TypeScript, V8 coverage, build, package
allowlist, and pack dry-run. Coverage minimums are 80% for lines, statements,
and functions and 75% for branches. CI runs Verify on Node 22/24 Linux and Node
22 macOS, plus dependency audit and CodeQL—the five protected checks expected by
the release train.

GitHub OIDC trusted publishing uses provenance and no long-lived npm token. The
release workflow validates exact `v<package-version>` tags and maps prereleases
to `next` and stable versions to `latest`. No local `npm publish` is part of the
release process.

See [architecture](docs/architecture.md), [configuration](docs/configuration.md),
[security](docs/security.md), [troubleshooting](docs/troubleshooting.md), and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Community

- Use the structured [bug report](https://github.com/rixzkiye/codex-reasonix-mcp/issues/new?template=bug_report.yml)
  or [feature request](https://github.com/rixzkiye/codex-reasonix-mcp/issues/new?template=feature_request.yml).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately through
  [GitHub Security Advisories](https://github.com/rixzkiye/codex-reasonix-mcp/security/advisories/new),
  as described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
