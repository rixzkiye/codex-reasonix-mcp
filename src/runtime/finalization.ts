import type { BridgeConfig } from '../config.js';
import { assertLaneCompatible } from '../acp.js';
import { BridgeError, asBridgeError } from '../errors.js';
import { fileAssertionEvidenceForCriterion, verifyFileAssertions } from '../file-assertions.js';
import { transitionTask } from '../lifecycle.js';
import {
  assertChangedFilesInScope,
  assertFileSizes,
  assertNoWorkerCommits,
  assertStagedChecks,
  canonicalWorktreeTree,
  changedFiles,
  createAtomicCommit,
  defaultCommitMessage,
  resolveGitIdentity,
  stageExplicitFiles,
  stagedTree,
  unstageExplicitFiles,
  validateCommitMessage,
} from '../repository.js';
import { evidenceHash, scanStagedFiles, scanWorkingFiles } from '../security.js';
import type { StateStore } from '../state.js';
import type { AcceptanceEvidence, RepositoryIdentity, TaskRecord } from '../types.js';
import { runAllVerification } from '../verification.js';
import type { ControlInput } from './api.js';
import type { RuntimeCallContext } from './api.js';
import type { CollisionAccess } from './collision.js';
import type { SessionAccess } from './session-supervision.js';
import { taskView, waitForTask, waitTimeoutMs } from './shared.js';

export interface FinalizationDependencies {
  config: BridgeConfig;
  store: StateStore;
  collision: Pick<CollisionAccess, 'guardTask' | 'holdLease' | 'releaseLease'>;
  sessions: Pick<SessionAccess, 'workerForTask'>;
}

export interface FinalizationAccess {
  finalize(
    task: TaskRecord,
    input: Extract<ControlInput, { action: 'finalize' }>,
    repository: RepositoryIdentity,
    context?: RuntimeCallContext,
  ): Promise<Record<string, unknown>>;
  current(taskId: string): Promise<void> | undefined;
  abort(taskId: string): void;
  abortAll(): void;
  waitForAll(): Promise<void>;
}

export class FinalizationController implements FinalizationAccess {
  private readonly finalizationAbort = new Map<string, AbortController>();
  private readonly finalizationTasks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: FinalizationDependencies) {}

  async finalize(
    task: TaskRecord,
    input: Extract<ControlInput, { action: 'finalize' }>,
    repository: RepositoryIdentity,
    context: RuntimeCallContext = {},
  ): Promise<Record<string, unknown>> {
    if (task.status !== 'review_required' || task.repairActive) {
      throw new BridgeError('invalid_state', 'finalize requires idle review_required state');
    }
    await this.dependencies.collision.guardTask(task.taskId, 'finalize_start');
    const worker = this.dependencies.sessions.workerForTask(task);
    const status = await worker.status(task.acpSessionId!);
    if (status.state !== 'idle') {
      throw new BridgeError('invalid_state', 'Reasonix must be idle before finalize');
    }
    assertLaneCompatible(
      status,
      task.executionProfile.workerLane,
      task.executionProfile.requestedReasoningEffort,
    );
    const criteria = new Set(task.contract.acceptance_criteria.map((criterion) => criterion.id));
    const requiredReview = task.contract.acceptance_criteria
      .filter((criterion) => criterion.evidence === 'review')
      .map((criterion) => criterion.id)
      .sort();
    const approved = [...new Set(input.approved_review_criteria)].sort();
    const missing = requiredReview.filter((id) => !approved.includes(id));
    const foreign = approved.filter((id) => !criteria.has(id));
    if (missing.length > 0 || foreign.length > 0) {
      throw new BridgeError(
        'invalid_request',
        'Finalize approval must cover every review acceptance criterion and only valid acceptance ids',
        {
          required: requiredReview,
          missing,
          foreign,
        },
      );
    }
    const message = input.commit_message
      ? validateCommitMessage(input.commit_message)
      : defaultCommitMessage(task.taskId, task.contract.objective);
    const identity = await resolveGitIdentity(repository);
    await this.dependencies.collision.holdLease(repository, task.taskId);
    await this.dependencies.store.recordEvent(task.taskId, 'finalization_started', {}, (record) => {
      record.reviewSummary = input.review_summary.trim();
      transitionTask(record, 'verifying', 'preflight');
    });
    const controller = new AbortController();
    this.finalizationAbort.set(task.taskId, controller);
    let finalizationError: BridgeError | undefined;
    const finalization = this.runFinalization(
      task.taskId,
      approved,
      message,
      identity,
      controller.signal,
    )
      .catch(async (error: unknown) => {
        const bridgeError = asBridgeError(error);
        finalizationError = bridgeError;
        // Repairable failures return the task to review_required with the
        // worktree possibly edited by hand since the last review snapshot.
        // Re-capture the canonical tree so the next finalize compares against
        // the current state instead of looping on a stale snapshot.
        const commitOrRefFailure = bridgeError.code === 'commit_failed';
        const indexRecoveryFailed = bridgeError.details?.indexRecoveryFailed === true;
        let repairableTree: string | undefined;
        if (!commitOrRefFailure && !indexRecoveryFailed) {
          try {
            const current = await this.dependencies.store.loadTask(task.taskId);
            if (current.status === 'verifying') {
              repairableTree = await canonicalWorktreeTree(current.worktree, current.baseCommit);
            }
          } catch {
            // Keep the stored snapshot; the next finalize re-compares and this
            // failure path re-runs.
          }
        }
        await this.dependencies.store.recordEvent(
          task.taskId,
          'finalization_failed',
          { code: bridgeError.code, message: bridgeError.message, details: bridgeError.details },
          (record) => {
            if (record.status === 'verifying') {
              transitionTask(
                record,
                commitOrRefFailure
                  ? 'commit_failed'
                  : indexRecoveryFailed
                    ? 'paused'
                    : 'review_required',
                commitOrRefFailure
                  ? 'commit_failed'
                  : indexRecoveryFailed
                    ? 'index_recovery_failed'
                    : 'verification_repair_required',
                `${bridgeError.code}: ${bridgeError.message}`,
              );
              if (repairableTree !== undefined && repairableTree !== record.reviewTreeHash) {
                record.reviewTreeHash = repairableTree;
                record.reviewRevision = (record.reviewRevision ?? 0) + 1;
              }
            }
          },
        );
        const failed = await this.dependencies.store.loadTask(task.taskId);
        if (failed.status === 'commit_failed') {
          await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
        }
      })
      .finally(() => {
        if (this.finalizationAbort.get(task.taskId) === controller) {
          this.finalizationAbort.delete(task.taskId);
        }
        if (this.finalizationTasks.get(task.taskId) === finalization) {
          this.finalizationTasks.delete(task.taskId);
        }
      });
    this.finalizationTasks.set(task.taskId, finalization);
    const started = await this.dependencies.store.loadTask(task.taskId);
    const waited = await waitForTask(
      this.dependencies.store,
      task.taskId,
      started,
      waitTimeoutMs(input.wait_timeout_seconds),
      (record) => record.status !== 'verifying',
      context,
      'Bridge is verifying and creating the isolated worker commit',
    );
    if (waited.timedOut) {
      throw new BridgeError(
        'invalid_state',
        'Finalize wait timed out; finalization remains recoverable in bridge state',
        { task: taskView(waited.task), timed_out: true, recoverable: true },
      );
    }
    const view = taskView(waited.task);
    if (waited.task.status !== 'completed') {
      if (finalizationError) throw finalizationError;
      const reason = waited.task.reason ?? `Finalization stopped in ${waited.task.status}`;
      throw new BridgeError('invalid_state', reason, { task: view });
    }
    return view;
  }

  current(taskId: string): Promise<void> | undefined {
    return this.finalizationTasks.get(taskId);
  }

  abort(taskId: string): void {
    this.finalizationAbort.get(taskId)?.abort();
  }

  abortAll(): void {
    for (const controller of this.finalizationAbort.values()) controller.abort();
  }

  async waitForAll(): Promise<void> {
    await Promise.allSettled(this.finalizationTasks.values());
  }

  private async runFinalization(
    taskId: string,
    approvedReview: string[],
    commitMessage: string,
    identity: Awaited<ReturnType<typeof resolveGitIdentity>>,
    signal: AbortSignal,
  ): Promise<void> {
    const assertActive = async (): Promise<void> => {
      if (signal.aborted) throw new BridgeError('invalid_state', 'Finalization was cancelled');
      const current = await this.dependencies.store.loadTask(taskId);
      if (current.status !== 'verifying') {
        throw new BridgeError('invalid_state', `Finalization stopped in ${current.status}`);
      }
    };
    await assertActive();
    let task = await this.dependencies.store.loadTask(taskId);
    await assertNoWorkerCommits(task.worktree, task.baseCommit);
    let files = await changedFiles(task.worktree);
    await assertChangedFilesInScope(task.worktree, task.contract, files);
    await assertFileSizes(task.worktree, files, this.dependencies.config);
    await scanWorkingFiles(task.worktree, files, this.dependencies.config, signal);
    const preflightTree = await canonicalWorktreeTree(task.worktree, task.baseCommit);
    const expectedReviewTree = task.reviewTreeHash ?? preflightTree;
    if (task.reviewTreeHash !== undefined && preflightTree !== task.reviewTreeHash) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Working tree changed since the Codex review snapshot',
        {
          reviewedTree: task.reviewTreeHash,
          currentTree: preflightTree,
        },
      );
    }
    await this.dependencies.store.recordEvent(
      taskId,
      'preflight_passed',
      {
        files,
        treeSha256: preflightTree,
      },
      (record) => {
        record.changedFiles = files;
        record.phase = 'verification';
      },
    );

    await assertActive();
    const verification = await runAllVerification(task, this.dependencies.store, signal);
    if (verification.some((item) => !item.passed)) {
      throw new BridgeError(
        'verification_failed',
        'One or more contract verification commands failed',
        {
          failed: verification.filter((item) => !item.passed).map((item) => item.id),
        },
      );
    }
    await assertActive();
    await this.dependencies.collision.guardTask(taskId, 'after_verification');
    await assertNoWorkerCommits(task.worktree, task.baseCommit);
    const verifiedFiles = await changedFiles(task.worktree);
    await assertChangedFilesInScope(task.worktree, task.contract, verifiedFiles);
    await assertFileSizes(task.worktree, verifiedFiles, this.dependencies.config);
    await scanWorkingFiles(task.worktree, verifiedFiles, this.dependencies.config, signal);
    const verifiedTree = await canonicalWorktreeTree(task.worktree, task.baseCommit);
    if (verifiedTree !== expectedReviewTree) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Verification changed the Codex-reviewed working tree',
        {
          reviewedTree: expectedReviewTree,
          currentTree: verifiedTree,
        },
      );
    }
    const assertionEvidence = await verifyFileAssertions(task.worktree, task.contract);
    files = verifiedFiles;
    await this.dependencies.store.recordEvent(taskId, 'verification_postflight_passed', {
      files,
      treeSha256: verifiedTree,
      assertions: assertionEvidence.map((item) => ({
        id: item.id,
        path: item.path,
        sha256: item.sha256,
        outputBytes: item.outputBytes,
      })),
    });
    const acceptance: AcceptanceEvidence[] = task.contract.acceptance_criteria.map((criterion) => {
      if (criterion.evidence === 'review') {
        return {
          criterionId: criterion.id,
          evidence: 'review',
          approved: approvedReview.includes(criterion.id),
          source: 'Codex finalize approval',
        };
      }
      const assertionProof = fileAssertionEvidenceForCriterion(assertionEvidence, criterion.id);
      if (assertionProof) {
        return {
          criterionId: criterion.id,
          evidence: 'automated',
          approved: true,
          source: assertionProof.source,
          sha256: assertionProof.sha256,
          outputBytes: assertionProof.outputBytes,
        };
      }
      const proofs = verification.filter(
        (item) => item.passed && item.proves.includes(criterion.id),
      );
      return {
        criterionId: criterion.id,
        evidence: 'automated',
        approved: proofs.length > 0,
        source: proofs.map((item) => item.id).join(','),
        sha256: evidenceHash(proofs.map((item) => item.sha256).join('\n')),
        outputBytes: proofs.reduce((total, item) => total + item.outputBytes, 0),
      };
    });
    if (acceptance.some((item) => !item.approved)) {
      throw new BridgeError('verification_failed', 'Acceptance evidence is incomplete');
    }
    await assertActive();
    await this.dependencies.store.recordEvent(
      taskId,
      'acceptance_evidence_ready',
      acceptance,
      (record) => {
        record.acceptanceEvidence = acceptance;
        record.phase = 'staging';
      },
    );

    await assertActive();
    await this.dependencies.collision.guardTask(taskId, 'before_staging');
    task = await this.dependencies.store.loadTask(taskId);
    let stagedByBridge = false;
    let commitCreated = false;
    try {
      await stageExplicitFiles(task.worktree, files);
      stagedByBridge = true;
      const staged = await stagedTree(task.worktree);
      if (staged !== expectedReviewTree) {
        throw new BridgeError(
          'ownership_ambiguous',
          'Staged tree differs from the reviewed worktree tree',
          {
            reviewedTree: expectedReviewTree,
            stagedTree: staged,
          },
        );
      }
      await assertStagedChecks(task.worktree);
      await scanStagedFiles(task.worktree, files);
      await scanWorkingFiles(task.worktree, files, this.dependencies.config, signal);
      await this.dependencies.store.recordEvent(taskId, 'staged_diff_verified', {
        files,
        treeSha256: staged,
      });

      await assertActive();
      await this.dependencies.collision.guardTask(taskId, 'before_commit');
      await this.dependencies.collision.guardTask(taskId, 'immediately_before_commit');
      await this.dependencies.store.recordEvent(taskId, 'commit_started', {}, (record) => {
        if (record.status !== 'verifying') {
          throw new BridgeError('invalid_state', `Finalization stopped in ${record.status}`);
        }
        record.phase = 'committing';
      });
      let commitHash: string;
      try {
        commitHash = await createAtomicCommit(
          task.worktree,
          task.baseCommit,
          commitMessage,
          identity,
        );
        commitCreated = true;
      } catch (error) {
        const cause = asBridgeError(error);
        throw new BridgeError('commit_failed', 'Atomic commit/ref transaction failed', {
          causeCode: cause.code,
          causeMessage: cause.message,
        });
      }
      await this.dependencies.store.recordEvent(
        taskId,
        'task_completed',
        { commitHash },
        (record) => {
          record.commitHash = commitHash;
          transitionTask(record, 'completed', 'completed');
        },
      );
      stagedByBridge = false;
    } catch (error) {
      const cause = asBridgeError(error);
      if (commitCreated) {
        throw new BridgeError(
          'commit_failed',
          'Commit was created but completion state persistence failed',
          { causeCode: cause.code, causeMessage: cause.message },
        );
      }
      if (stagedByBridge) {
        try {
          await unstageExplicitFiles(task.worktree, files);
        } catch (recoveryError) {
          const recovery = asBridgeError(recoveryError);
          throw new BridgeError(
            cause.code === 'commit_failed' ? 'commit_failed' : 'ownership_ambiguous',
            'Finalization failed and the bridge-owned index could not be restored',
            {
              causeCode: cause.code,
              causeMessage: cause.message,
              recoveryCode: recovery.code,
              recoveryMessage: recovery.message,
              indexRecoveryFailed: true,
            },
          );
        }
      }
      throw error;
    }
    await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
  }
}
