# Contributing

## Development setup

Use Node.js 22+ and the package-manager version pinned in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm audit --audit-level high
```

`pnpm check` includes lint, format verification, TypeScript checking, all test
lanes, production build, an npm package-content allowlist, and package dry-run.

Tests must remain offline by default. Never add a test that needs a live model,
provider credential, external mutation, push, or npm publish. Use temporary Git
repositories and the fake ACP agent.

## Design constraints

- Preserve exactly three MCP tools and snapshot their schemas.
- Keep contracts immutable and repository-relative; forbidden scope wins.
- Do not add a direct-execution CLI, router, model, auto-push, or auto-merge.
- Keep Reasonix unable to stage or commit; bridge finalization owns one commit.
- Fail closed when sandbox metadata or the Reasonix status extension is absent.
- Do not persist thoughts, credentials, or unbounded terminal output.
- Add focused unit/integration lanes instead of one catch-all test.

## Pull requests

Explain the threat boundary affected, tests run, and any Reasonix compatibility
requirement. Do not include generated credentials, local state, `.tmp`
checkouts, worktrees, or package tarballs.

## Releases

Update `CHANGELOG.md` and `package.json` together, then create a GitHub release
whose tag exactly matches `v<version>`. The `npm` environment and npm trusted
publisher must both authorize `.github/workflows/release.yml`. Never add an npm
automation token: the workflow uses short-lived OIDC and provenance.

Prereleases publish under `next`; stable versions publish under `latest`. A
stable release also requires a clean-install verification, registry signatures
and provenance, `doctor` against a supported official Reasonix binary, and a
fresh Codex catalog smoke that does not invoke Reasonix work.
