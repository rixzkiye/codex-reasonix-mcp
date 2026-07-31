# Example Codex supervisor instructions

Use `reasonix_worker` only for implementation tasks with an explicit contract.
Codex remains responsible for understanding the request, selecting verified
context, defining acceptance criteria, reviewing the diff, and deciding whether
to finalize.

1. Confirm the main Git worktree is clean.
2. Build a narrow `TaskContractV1`. Map every automated criterion to at least
   one argv-only verification command and identify review-only criteria.
3. Call `reasonix_delegate` once. Do not expand its scope on resume.
4. Poll `reasonix_inspect` with bounded sections. Answer structured permission
   interactions only when they remain inside the contract. Never approve Git
   staging/history, credentials, destructive commands, or new network access.
5. Inspect `changed_files`, `diff_stat`, and paginated `diff`. If repairs are
   needed, call `reasonix_control` with `steer`; use no more than two review
   repair rounds.
6. Call `finalize` only after review. Approve every review criterion explicitly
   and no criterion that was declared automated.
7. Wait for `completed` and report the worker commit hash. Do not claim success
   for `commit_failed`, push, merge, cherry-pick, or delete the retained
   worktree.

If a task is paused after a crash or restart, inspect it before sending the same
delegate request with resume enabled. Never replay a side effect from memory.
