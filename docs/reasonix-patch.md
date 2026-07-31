# Reasonix compatibility patch

The bridge requires a small upstream-compatible patch against Reasonix
`main-v2`. The tracked patch is under `patches/reasonix/` and was prepared from
base commit `d534de0f`.

The patch adds:

- `reasonix acp --planner=off` with precedence over user/project
  `planner_model`;
- supervised `--workspace-only`, `--sandbox-bash=enforce`, and explicit
  `--sandbox-network=on|off` hard bounds;
- `_reasonix.io/session/status` snapshots and monotonic
  `_reasonix.io/session/status_update` notifications at schema version 1;
- effective model, effort, mode, work mode, planner, sandbox, phase, goal,
  outcome, readiness, usage/cache/cost, and recovery metadata;
- structured ACP permission `rawInput`, locations, reason, and Reasonix `_meta`;
  foreground static Bash calls include trusted schema-v1 `argv`/`cwd` metadata,
  while shell expansion, control syntax, redirects, and background calls do not;
  and
- capability, multi-session, aggregation, pause/error, resume recovery, and
  planner-precedence tests.

The extension never puts reasoning text in status. Status state is local ACP
telemetry and does not alter provider-visible messages or tool definitions.

## Apply and build

```sh
git clone <reasonix-upstream-url> DeepSeek-Reasonix
cd DeepSeek-Reasonix
git checkout d534de0f
git apply --check /path/to/codex-reasonix-mcp/patches/reasonix/main-v2-acp-supervisor.patch
git apply /path/to/codex-reasonix-mcp/patches/reasonix/main-v2-acp-supervisor.patch
git diff --name-only --diff-filter=ACM -z -- '*.go' | xargs -0 gofmt -w
go test ./internal/acp ./internal/cli ./internal/control
go test ./internal/boot -run '^TestPlannerOffHasHighestPrecedence$'
go vet ./internal/acp ./internal/cli ./internal/control ./internal/boot
go build ./cmd/reasonix
```

Run upstream's complete `go test ./...` and `go vet ./...` in a clean Reasonix
development environment before submitting the patch. This repository's CI does
not download or build Reasonix.
