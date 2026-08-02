# Troubleshooting

Start with:

```sh
codex-reasonix-mcp doctor
```

The command does not call a model. Its JSON report marks required failures.

## Required Reasonix extension unavailable

The bridge expects both capabilities directly in ACP
`agentCapabilities._meta`:

```text
_reasonix.io/session/status
_reasonix.io/session/status_update
schemaVersion: 1
```

Install official Reasonix v1.19.0 or a compatible newer release. If the binary
is not on `PATH`, set `REASONIX_BIN` to its absolute path, restart Codex, and
rerun `doctor`. The bridge intentionally has no degraded mode for missing
capabilities.

## Sandbox mismatch

Linux/WSL requires `bwrap`; macOS requires `/usr/bin/sandbox-exec`. The bridge
launches Reasonix with an enforced bash sandbox, one worktree write root, and
explicit network posture. A mismatched status blocks the task before prompting.

On native Windows, use WSL and install Node, Git, Reasonix, and Bubblewrap inside
the WSL distribution.

## Missing sandbox metadata or read-only profile

Delegation and finalization must be invoked by a Codex client that advertises
`codex/sandbox-state-meta`. Ensure the MCP server is registered with Codex and
the current repository is writable. `reasonix_inspect` remains read-only and
does not require repository metadata.

## Dirty repository

Commit, discard, or otherwise resolve main-worktree changes yourself, then
delegate again. The bridge never stashes or absorbs uncommitted user work.

## Task paused after restart

Call `reasonix_inspect` first. The first inspection marks the preserved task as
audited; a matching `reasonix_delegate` call can then resume it. This prevents
automatic replay of an uncertain side effect.

## Verification or commit failed

Inspect `verification`, `acceptance_evidence`, `events`, and optionally `diff`.
No completion is claimed when a command, secret scan, hook, scope check, staged
diff check, or commit fails. The branch and worktree are retained for diagnosis.

## Model unavailable

Configure Reasonix with the `deepseek-v4-flash` model (or set
`CODEX_REASONIX_MODEL` to the exact compatible advertised selector). The bridge
chooses the highest effort actually advertised; it falls back honestly to
`auto` and never claims an unavailable level.
