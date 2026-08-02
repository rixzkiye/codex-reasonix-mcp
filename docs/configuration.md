# Configuration

Configuration is supplied when the MCP server is registered. Restart Codex after
changing its MCP environment.

| Variable                             | Default                  | Meaning                                                                   |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| `REASONIX_BIN`                       | `reasonix`               | Reasonix executable or absolute local build path                          |
| `CODEX_REASONIX_STATE_DIR`           | platform state directory | Private task, worktree, lock, log, and evidence root                      |
| `CODEX_REASONIX_MODEL`               | `deepseek-v4-flash`      | Required Reasonix model selector                                          |
| `CODEX_REASONIX_NETWORK`             | off                      | Set to `on` to request sandbox egress; Codex metadata must also permit it |
| `CODEX_REASONIX_SECRET_SCANNER_ARGV` | unset                    | JSON argv array for an additional secret scanner                          |

The state directory defaults to `$XDG_STATE_HOME/codex-reasonix-mcp` when set,
`~/Library/Application Support/codex-reasonix-mcp` on macOS, and
`~/.local/state/codex-reasonix-mcp` otherwise. Directories and files are created
with owner-only permissions on POSIX systems.

Example registration with an external scanner:

```sh
codex mcp add reasonix-worker \
  --env REASONIX_BIN=/opt/reasonix/bin/reasonix \
  --env CODEX_REASONIX_SECRET_SCANNER_ARGV='["secret-scanner","scan"]' \
  -- npx -y codex-reasonix-mcp@0.1.0
```

The scanner receives the changed file list appended to its configured argv and
runs with a sanitized environment. Do not place credentials in the argv.

## Network

Network is disabled unless the server is explicitly configured with
`CODEX_REASONIX_NETWORK=on`. Even then, the effective value is the intersection
with Codex's per-request permission profile. Reasonix is launched with that
effective policy, and the reported sandbox status must match before a prompt is
sent.

Model-provider traffic is owned by the Reasonix process and its provider
configuration. The network switch governs commands inside the Reasonix bash
sandbox; it does not copy credentials into verification subprocesses.

## Retention

Completed and closed task artifacts are retained deliberately. There is no v1
cleanup command. Stop all bridge processes before manually archiving or removing
a specific task worktree/state directory; never remove the entire state root to
clean one task.

## npm trusted publishing

The tracked release workflow expects an npm trusted publisher bound to this
GitHub repository, `.github/workflows/release.yml`, and the `npm` GitHub
environment. A published GitHub release must use the exact tag `v<package
version>`. The workflow validates the tag, reruns every quality/security gate,
uploads the tarball as a release artifact, and publishes with OIDC provenance.
It intentionally does not read `NPM_TOKEN`.

SemVer prereleases publish under `next`; stable versions publish under `latest`.
Every stable release must pass `doctor` against a supported official Reasonix
binary. Capability checks remain fail closed even when the binary version is
newer than the documented v1.19.0 baseline.
