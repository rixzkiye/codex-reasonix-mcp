# Example Codex supervisor instructions

Use `reasonix_worker` only for implementation tasks with an explicit contract.
Codex remains responsible for understanding the request, selecting verified
context, defining acceptance criteria, reviewing the diff, and deciding whether
to finalize.

1. Confirm the main Git worktree is clean.
2. Build a narrow `TaskContractV1`. Map every automated criterion to at least
   one argv-only verification command, identify review-only criteria, and list
   only exact extra argv/cwd pairs needed in `allowed_commands`.
3. Optionally install the user collision hook with a dry run, then `--apply`;
   inspect and trust it manually through `/hooks`.
4. Call `reasonix_delegate` once. Let the worker run; use bounded inspect waits
   for state transitions instead of repeatedly steering or polling full diffs.
   Do not expand scope or commands on resume.
5. Safe reads may run under shell-first policy. Tests/builds/formatters/scripts
   must exactly match the contract. Never attempt to approve Git mutations or ref/history rewrites,
   credentials, destructive commands, remote/network, publish/release,
   shell/eval, inline code, cwd escape, or metadata mismatch.
6. Inspect `changed_files`, `diff_stat`, collision evidence, and paginated
   `diff`. If repairs are needed, call `reasonix_control` with `steer`; use no
   more than two review repair rounds.
7. Call `finalize` only after review. Approve every review criterion explicitly
   and no criterion that was declared automated.
8. Wait for `completed` and report the worker commit hash. Do not claim success
   for `commit_failed`, push, merge, cherry-pick, or delete the retained
   worktree.

After delivery, preview `task archive <id>` and apply it only when the terminal
task and clean/missing worker worktree are expected. Preview age-gated prune
separately; branches, refs, and commits remain preserved.

If a task is paused after a crash or restart, inspect it before sending the same
delegate request with resume enabled. Never replay a side effect from memory.
