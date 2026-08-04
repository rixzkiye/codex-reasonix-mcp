# Contributing

## Development setup

Use Node.js 22+ and the package-manager version pinned in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm audit --audit-level high
```

`pnpm check` includes lint, format verification, TypeScript checking, V8
coverage, production build, an npm package-content allowlist, and package
dry-run. Coverage must remain at least 80% for lines, statements, and functions
and 75% for branches.

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
- Keep hard shell denials ahead of contract matching; `allowed_commands` must
  never become acceptance evidence.
- Treat the optional user hook as a manually trusted guardrail; core collision
  scans remain authoritative.
- Keep task mutations dry-run by default and preserve worker refs/commits.
- Add focused unit/integration lanes instead of one catch-all test.

## Pull requests

Explain the threat boundary affected, tests run, and any Reasonix compatibility
requirement. Do not include generated credentials, local state, `.tmp`
checkouts, worktrees, or package tarballs.

## Releases

Update `CHANGELOG.md`, `package.json`, and `src/version.ts` together, verify the
lockfile, then create a GitHub release whose tag exactly matches `v<version>`.
The `npm` environment and trusted publisher must authorize
`.github/workflows/release.yml`. Never add an npm automation token: the workflow
uses short-lived OIDC and provenance. Never publish locally.

Prereleases publish under `next`; stable versions publish under `latest`. A
release candidate must pass all five protected checks: Verify on Node 22 Linux,
Node 24 Linux, and Node 22 macOS, Dependency audit, and CodeQL. Run standard
doctor without a provider call. The single deep-doctor live conformance run is
separate, explicit, cost-authorized, bounded to 50,000 cumulative provider
tokens plus ten minutes, and required before stable promotion.

Stable promotion changes only version/changelog metadata after RC conformance,
then repeats protected checks. Verify clean installs, package contents,
registry signatures/attestations, provenance, and dist-tags after each publish.
If an RC fails, prepare the next RC; never overwrite/unpublish. If a published
stable defect appears, release a patch.
