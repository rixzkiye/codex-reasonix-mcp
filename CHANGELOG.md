# Changelog

All notable changes are documented here. Versions follow Semantic Versioning.

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
