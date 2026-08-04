# Configuration

Configuration is supplied when the MCP server is registered. Restart Codex
after changing its MCP environment.

| Variable                             | Default                  | Meaning                                                                   |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| `REASONIX_BIN`                       | `reasonix`               | Reasonix executable or absolute local build path                          |
| `CODEX_REASONIX_STATE_DIR`           | platform state directory | Private tasks, worktrees, locks, archives, tombstones, hooks, and metrics |
| `CODEX_REASONIX_MODEL`               | `deepseek-v4-flash`      | Required Reasonix model selector                                          |
| `CODEX_REASONIX_EFFORT`              | `medium`                 | Default task effort: low, medium, high, or max (minimal is legacy-only)   |
| `CODEX_REASONIX_NETWORK`             | off                      | Request sandbox egress; Codex metadata must also permit it                |
| `CODEX_REASONIX_SECRET_SCANNER_ARGV` | unset                    | JSON argv array for an additional local secret scanner                    |

The state directory defaults to `$XDG_STATE_HOME/codex-reasonix-mcp` when set,
`~/Library/Application Support/codex-reasonix-mcp` on macOS, and
`~/.local/state/codex-reasonix-mcp` otherwise. POSIX state is owner-only.

Example stable registration with an external scanner:

```sh
codex mcp add reasonix-worker \
  --env REASONIX_BIN=/opt/reasonix/bin/reasonix \
  --env CODEX_REASONIX_SECRET_SCANNER_ARGV='["secret-scanner","scan"]' \
  -- npx -y codex-reasonix-mcp@0.1.1
```

The scanner receives changed file names appended to its configured argv and
runs in a sanitized environment. Never place credentials in argv.

Long-running review and finalization calls require an explicit Codex MCP tool
timeout. Add this to `~/.codex/config.toml` after registration:

```toml
[mcp_servers.reasonix-worker]
tool_timeout_sec = 900
```

The bridge requires 900 seconds because Codex defaults MCP tools to 60 seconds.
Standard and deep doctor both fail their required configuration check when the
setting is absent or lower.

Task input `reasoning_effort` overrides `CODEX_REASONIX_EFFORT`; when both are
absent the bridge uses `medium`. `minimal` is no longer accepted on the wire or
in new configuration; persisted legacy records that used it remain readable.
There is no implicit inheritance from Codex's chat effort control. A resumed
task retains its stored effort.

Task input `worker_lane` selects the execution lane: `fast` (default) runs a
direct-edit Reasonix session in economy + normal mode with no Goal, AutoResearch,
review/task skills, or subagents; `deep` runs Delivery + Goal for explicitly
long-horizon tasks. The lane is persisted in the task execution profile and is
immutable for an existing task.

Task input `execution_timeout_seconds` controls the worker lifetime independently
of MCP wait time. New fast-lane tasks default to 600 seconds and deep-lane tasks
to 3,600 seconds, both accepting 60–14,400 seconds; an omitted resume retains
the stored value. The delegate wait remains bounded to 600 seconds and returns
recoverably without cancelling a longer worker. Worker usage is reported but
has no hard token ceiling; the execution deadline and repeated-denial limit
remain the runaway guards.

## Network

Network is disabled unless `CODEX_REASONIX_NETWORK=on`. Even then, effective
permission is the intersection with Codex request metadata. Reasonix-reported
sandbox posture must match. The switch governs Reasonix sandbox commands; it
does not copy provider credentials into verification or scanner subprocesses.

Remote-access and publish/release commands remain immutable shell-policy
denials even when provider traffic is enabled.

## Diagnostics

```sh
codex-reasonix-mcp doctor
codex-reasonix-mcp doctor --deep --allow-provider-call
```

Standard doctor performs local executable/configuration checks only; it starts
no ACP session and no provider Goal. Deep doctor requires both flags, runs one
bounded Goal for at most 50,000 cumulative provider tokens and ten minutes,
reports conformance proofs, privacy-safe partial diagnostics, usage, cost,
duration, and cleanup, and always attempts to remove its temporary repo/state.

## Contract and task commands

```sh
codex-reasonix-mcp contract lint --file contract.json
codex-reasonix-mcp contract lint --stdin
codex-reasonix-mcp task list [--all] [--json]
codex-reasonix-mcp task archive <id> [--apply]
codex-reasonix-mcp task prune [--older-than 30d] [--apply]
```

Contract lint requires exactly one source and reports all validation issues
together. Task mutation commands are previews without `--apply`. Archive
requires terminal state and a clean/missing worker worktree. Prune considers
archives only and defaults to 30 days.

## Optional user hook

```sh
codex-reasonix-mcp hooks install --user [--apply]
codex-reasonix-mcp hooks status --user
codex-reasonix-mcp hooks uninstall --user [--apply]
```

Install/uninstall default to dry run. Apply atomically merges
`~/.codex/hooks.json`, preserving unrelated hook groups, and installs a
versioned runtime under private state. Review and trust the result through
Codex `/hooks`; the installer does not and cannot bypass trust. Corrupt existing
hook JSON is never overwritten.

## State, retention, and metrics

Task state is validated and version-gated at v2. Valid v1 state migrates
atomically; malformed or future versions are rejected. Terminal task archives
retain the full audit. Pruned
archives become permanent tombstones containing identity, contract hash,
status/ref/commit, evidence hashes, and timestamps.

Local metric events are kept below the private state root with bounded
retention. They contain closed classes, counts/durations, hashed task identity,
and provider usage numbers only. They contain no raw prompt, argv, command
output, secret, or file content and have no telemetry transport.

## npm trusted publishing

The tracked workflow expects an npm trusted publisher bound to this repository,
`.github/workflows/release.yml`, and the `npm` GitHub environment. A GitHub
release tag must exactly equal `v<package-version>`. The workflow reruns quality
and audit gates, uploads the tarball, and publishes with OIDC provenance; it
does not read `NPM_TOKEN`.

`scripts/release-metadata.mjs` maps SemVer prereleases to `next` and stable
versions to `latest`. Publication is workflow-only—never run local
`npm publish`.
