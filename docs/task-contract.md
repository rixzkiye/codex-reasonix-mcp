# TaskContractV1

`reasonix_delegate` validates the contract, normalizes repository-relative paths
to POSIX form, stores canonical JSON, and binds its SHA-256 hash to the task ID.
The optional `allowed_commands` addition is backward compatible: when absent,
legacy canonical JSON and hashes remain byte-for-byte unchanged.

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

- `write_scope` is required and nonempty; `forbidden_scope` always wins.
- Paths/globs and command cwd are repository-relative, POSIX-normalized, never
  absolute, and may not contain a `..` segment.
- Symlinks are resolved before scope checks; escapes are rejected.
- Command IDs are unique across verification and `allowed_commands`.
- argv is static, nonempty, bounded, and compared element-for-element without a
  shell. cwd must match after repository-relative normalization.
- Every automated criterion must be named by at least one verification
  command's `proves`; unknown criterion IDs are rejected.
- Every review criterion must be approved explicitly and exclusively during
  finalize.
- Repository, base commit, task ID, and contract hash are immutable. Expanded
  scope/commands require a new task contract.

## Execution permission versus evidence

Verification commands are automatically part of the allowed command set.
`allowed_commands` permits additional exact test/build/format/package/project
commands needed during implementation, but has no `proves` field and can never
be automated acceptance evidence. Finalization derives automated evidence only
from verification results.

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
