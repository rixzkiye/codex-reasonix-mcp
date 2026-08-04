# Troubleshooting

Start with standard local diagnostics:

```sh
codex-reasonix-mcp doctor
```

Its JSON report marks required failures. Standard doctor starts no ACP session
and makes no provider call.

## Codex MCP call times out early

Both delegate-to-review and finalize-to-terminal are intentionally
long-running. Configure the worker explicitly in `~/.codex/config.toml`:

```toml
[mcp_servers.reasonix-worker]
tool_timeout_sec = 900
```

Rerun doctor after restarting Codex. A missing value or any value below 900 is
a required failure; do not rely on Codex's version-dependent default.

## Deep conformance

Only run this when one bounded live provider Goal, up to 50,000 cumulative
provider tokens, ten minutes, cost, and temporary local mutation are explicitly
authorized:

```sh
codex-reasonix-mcp doctor --deep --allow-provider-call
```

The report must show exactly one provider run; structured edit, static command,
exact verification, final commit, and unchanged-source proofs; usage/cost;
duration; and successful cleanup. `--allow-provider-call` without `--deep` is a
usage error. On failure, the report retains only privacy-safe partial proofs,
task-state classes, and a bounded event-type tail. Cleanup is attempted even on
failure, provider-usage cutoff, or timeout.

## Required Reasonix capability unavailable

The bridge expects the ACP supervisor/status extension and static command
metadata v1. Install official Reasonix v1.19.0 or a compatible newer release.
If it is not on `PATH`, set `REASONIX_BIN`, restart Codex, and rerun standard
doctor. There is no degraded mode for missing capabilities.

## Shell request denied

Inspect the denial code and recovery hint. Reasonix execute requests must carry
private `_meta.reasonix.io` static argv v1 metadata and the exact absolute
worktree cwd. Safe reads are audited. Test/build/format/package/project commands
must exactly match verification or `allowed_commands` argv plus cwd.

Git mutations or ref/history rewrites, remotes, `gh`, network, credentials, publish/release,
privilege escalation, destructive filesystem operations, shell/eval, inline
code, cwd escape, and metadata mismatch are immutable denials even if listed in
a contract. The third identical denial in one prompt pauses the task after one
recovery steer; it does not wait for a permission override.

## Sandbox metadata or platform failure

Delegation/finalization require writable `codex/sandbox-state-meta`.
`reasonix_inspect` remains read-only. Linux/WSL requires `bwrap`; macOS requires
`/usr/bin/sandbox-exec`; native Windows requires WSL.

## Dirty repository or source collision

Task creation requires a clean source worktree. During a task, source dirty
paths and committed movement since base are compared with `write_scope`. An
overlap or unavailable source pauses/blocks and appears in `source_collision`.
Resolve ownership yourself, then inspect before resume. The bridge never
resets, stashes, or deletes user changes.

## Optional hook issues

```sh
codex-reasonix-mcp hooks status --user
codex-reasonix-mcp hooks install --user
```

Install/uninstall are dry runs without `--apply`. Corrupt `~/.codex/hooks.json`
is not overwritten. Installation preserves third-party hooks, but you must
still review/trust the hook through `/hooks`. If an active sentinel exists while
its state is corrupt, Bash and `apply_patch` fail closed until state ownership
is repaired. Core collision scanning remains active without the hook.

## Task paused after restart

Call `reasonix_inspect` first. Valid older state migrates atomically to v3 during
load. Corrupt, noncanonical, or unknown future state is rejected and must be
manually investigated—never edit the version number to force acceptance.

After inspection and collision resolution, repeat the same delegate request
with resume enabled and unchanged contract/base/config posture.

## Verification or commit failed

Inspect verification, acceptance evidence, opt-in events, collision evidence,
and the bounded diff. `allowed_commands` results do not count as acceptance
evidence. A verification failure before commit returns to `review_required`
with repairable evidence. `commit_failed` is reserved for commit/ref failures;
neither state is reported as completed. The branch/worktree are retained.

## Archive and prune refused

```sh
codex-reasonix-mcp task list --all --json
codex-reasonix-mcp task archive <id>
codex-reasonix-mcp task prune --older-than 30d
```

Preview first; add `--apply` only after checking targets. Archive requires a
terminal task and clean/missing worker worktree whose identity/ref/head match
state. Prune sees archives only and age is measured from archive time. Branches,
refs, and commits are never removed. Interrupted prune staging is recovered on
the next task-operation initialization or fails closed for manual inspection.
