# TaskContractV1

`reasonix_delegate` receives the contract directly. The bridge validates it,
normalizes repository-relative paths to POSIX form, stores canonical JSON, and
binds its SHA-256 hash to the task ID.

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
    cwd?: string;
    timeout_seconds?: number;
    proves: string[];
  }>;
  pause_conditions: string[];
}
```

## Rules

- `write_scope` is required and nonempty. `forbidden_scope` always wins.
- Every path/glob is repository-relative, POSIX-normalized, and may not be
  absolute or contain a `..` segment.
- Symlinks are resolved before write-scope checks; an escape is rejected.
- Verification uses argv without a shell, a repository-relative cwd, a maximum
  timeout of 30 minutes, bounded output, and a sanitized environment.
- Every automated acceptance criterion must be named by at least one
  verification command's `proves` list.
- Every review criterion must be approved explicitly and exclusively in
  `finalize`.
- A task's repository, base commit, task ID, and contract hash are immutable.
  Expanded scope requires a new task.

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
  "pause_conditions": ["A public API change appears necessary"]
}
```

Use narrow scopes and small verification lanes. A single oversized command is
harder to diagnose and weaker evidence than focused checks tied to criteria.
