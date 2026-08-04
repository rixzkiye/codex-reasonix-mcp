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
4. Call `reasonix_delegate` once with the lowest sufficient per-task
   `reasoning_effort` and a proportionate `execution_timeout_seconds` (default
   3,600; maximum 14,400). Keep the default `wait_mode: "review"` and let that
   call wait for review, interaction, failure, or timeout. A wait timeout does
   not cancel the worker; re-delegate the same immutable task to wait again when
   necessary. Use `path_base: "cwd"` unless the contract deliberately uses
   repository-root paths. Do not poll inspect, steer unnecessarily, or expand
   scope/commands on resume.
5. Safe reads may run under shell-first policy. Tests/builds/formatters/scripts
   must exactly match the contract. Never attempt to approve Git mutations or ref/history rewrites,
   credentials, destructive commands, remote/network, publish/release,
   shell/eval, inline code, cwd escape, or metadata mismatch.
6. Review the delegate response bundle: `changed_files`, `diff_stat`, bounded
   `diff`, risks, usage, and any active interaction. If repairs are needed, use
   inspect/steer as recovery tools; use no more than two review repair rounds.
7. Call `finalize` only after review. Approve every review criterion explicitly
   and no criterion that was declared automated.
8. Let that finalize call wait for `completed` and return the worker commit
   hash. The source checkout is still unchanged. After review, perform one
   explicit `git cherry-pick <hash>` if integration is desired. Never claim
   success for `commit_failed`; never push, merge, or delete the retained
   worktree.

After delivery, preview `task archive <id>` and apply it only when the terminal
task and clean/missing worker worktree are expected. Preview age-gated prune
separately; branches, refs, and commits remain preserved.

If a task is paused after a crash or restart, inspect it before sending the same
delegate request with resume enabled. Never replay a side effect from memory.
