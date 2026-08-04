# TaskContractV1

`reasonix_delegate` validates the contract, normalizes repository-relative paths
to POSIX form, stores canonical JSON, and binds its SHA-256 hash to the task ID.
The optional `allowed_commands` and `file_assertions` additions are backward
compatible: when absent, legacy canonical JSON and hashes remain byte-for-byte
unchanged.

Execution profile fields such as `worker_lane`, `reasoning_effort`,
`execution_timeout_seconds`, `wait_mode`, wait timeout, and `path_base` belong
to the delegate request, not `TaskContractV1`, so they do not alter its
canonical hash. New tasks default to `worker_lane: "fast"` (600-second
deadline); `worker_lane: "deep"` tasks default to 3,600 seconds. Overrides
stay within 60–14,400 seconds; a wait timeout does not cancel the worker.
Contract paths default to interpretation relative to the invocation cwd and are
normalized to repository-relative paths before hashing; `path_base:
"repository"` retains legacy repository-root semantics.

```ts
interface TaskContractV1 {
  schema_version: 1;
  objective: string;
  user_outcome: string;
  verified_context: Array<{ path: string; reason: string }>;
  write_scope: string[];
  forbidden_scope: string[];
  invariants: string[];
  non_goals: string[];
  acceptance_criteria: Array<{
    id: string;
    requirement: string;
    evidence: 'automated' | 'review';
  }>;
  verification: Array<{
    id: string;
    argv: [string, ...string[]];
    cwd?: string; // default "."
    timeout_seconds?: number; // bridge default 600, maximum 1800
    proves: string[];
  }>;
  allowed_commands?: Array<{
    id: string;
    argv: [string, ...string[]];
    cwd?: string; // default "."
    timeout_seconds?: number; // default 120, maximum 1800
  }>;
  file_assertions?: Array<{
    id: string;
    path: string;
    expected_utf8: string; // exact UTF-8 bytes including newline, <= 64 KiB
    proves: string[];
  }>;
  pause_conditions: string[];
}
```

## Validation and linting

```sh
codex-reasonix-mcp contract lint --file contract.json
codex-reasonix-mcp contract lint --stdin
```

Exactly one source is required. Lint reports all safely evaluable schema and
semantic problems together rather than stopping at the first issue.

Contract rules:

- `write_scope` is required, nonempty, and already acts as the exclusive write
  allowlist: every unlisted path is denied. `forbidden_scope` is only an extra
  sensitive carve-out inside a broader write scope and always wins. Never use
  `**/*` or another catch-all that matches a concrete `write_scope` target.
- Paths/globs and command cwd are repository-relative, POSIX-normalized, never
  absolute, and may not contain a `..` segment.
- Symlinks are resolved before scope checks; escapes are rejected.
- Command IDs are unique across verification and `allowed_commands`.
- argv is static, nonempty, bounded, and compared element-for-element without a
  shell. cwd must match after repository-relative normalization.
- Every automated criterion must be named by at least one verification
  command's `proves` or by a `file_assertions` entry; unknown criterion IDs are
  rejected.
- File assertions prove automated criteria only, compare the worktree file
  byte-for-byte against `expected_utf8` (exact bytes, including any trailing
  newline, at most 64 KiB), and record only hash plus byte length as evidence.
- Every review criterion must be approved during finalize; automated criterion
  ids may be included in approval but are ignored for it.
- Repository, base commit, task ID, and contract hash are immutable. Expanded
  scope/commands require a new task contract.

## Execution permission versus evidence

Verification commands are automatically part of the allowed command set.
`allowed_commands` permits additional exact test/build/format/package/project
commands needed during implementation, but has no `proves` field and can never
be automated acceptance evidence. Finalization derives automated evidence from
verification results and from byte-exact `file_assertions` (hash/length only,
never raw content).

Hard policy runs before exact contract matching. Neither command list can
authorize Git mutations or ref/history rewrites, remote/network access, credentials,
publish/release, privilege escalation, destructive filesystem operations,
shell/eval, inline-code interpreters, metadata mismatch, or cwd escape.

## Example

```json
{
  "schema_version": 1,
  "objective": "Add deterministic slug normalization",
  "user_outcome": "Equivalent titles generate the same safe slug",
  "verified_context": [
    { "path": "src/slug.ts", "reason": "Current implementation" },
    { "path": "tests/slug.test.ts", "reason": "Existing behavior" }
  ],
  "write_scope": ["src/slug.ts", "tests/slug.test.ts"],
  "forbidden_scope": ["src/auth/**"],
  "invariants": ["Public function signature remains compatible"],
  "non_goals": ["No routing or UI changes"],
  "acceptance_criteria": [
    {
      "id": "ac_slug",
      "requirement": "Normalization is deterministic and covered by tests",
      "evidence": "automated"
    }
  ],
  "verification": [
    {
      "id": "test_slug",
      "argv": ["pnpm", "vitest", "run", "tests/slug.test.ts"],
      "cwd": ".",
      "timeout_seconds": 300,
      "proves": ["ac_slug"]
    }
  ],
  "allowed_commands": [
    {
      "id": "format_slug",
      "argv": ["pnpm", "prettier", "--check", "src/slug.ts", "tests/slug.test.ts"],
      "cwd": ".",
      "timeout_seconds": 120
    }
  ],
  "pause_conditions": ["A public API change appears necessary"]
}
```

Prefer narrow scopes and focused verification. Extra allowed commands should be
the minimum exact argv/cwd needed for implementation, never speculative access.
