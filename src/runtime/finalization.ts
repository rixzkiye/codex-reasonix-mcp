import type { BridgeConfig } from '../config.js';
import { BridgeError, asBridgeError } from '../errors.js';
import { transitionTask } from '../lifecycle.js';
import {
  assertChangedFilesInScope,
  assertFileSizes,
  assertNoWorkerCommits,
  assertStagedChecks,
  changedFiles,
  createAtomicCommit,
  defaultCommitMessage,
  stageExplicitFiles,
  stagedDiff,
  validateCommitMessage,
  workingDiff,
} from '../repository.js';
import { evidenceHash, scanStagedFiles, scanWorkingFiles } from '../security.js';
import type { StateStore } from '../state.js';
import type { AcceptanceEvidence, RepositoryIdentity, TaskRecord } from '../types.js';
import { runAllVerification } from '../verification.js';
import type { ControlInput } from './api.js';
import type { CollisionAccess } from './collision.js';
import type { SessionAccess } from './session-supervision.js';
import { sha256, taskView } from './shared.js';

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
    const requiredReview = task.contract.acceptance_criteria
      .filter((criterion) => criterion.evidence === 'review')
      .map((criterion) => criterion.id)
      .sort();
    const approved = [...new Set(input.approved_review_criteria)].sort();
    if (
      approved.some((id) => !requiredReview.includes(id)) ||
      requiredReview.some((id) => !approved.includes(id))
    ) {
      throw new BridgeError(
        'invalid_request',
        'All and only review acceptance criteria must be approved',
        {
          required: requiredReview,
          approved,
        },
      );
    }
    const message = input.commit_message
      ? validateCommitMessage(input.commit_message)
      : defaultCommitMessage(task.taskId, task.contract.objective);
    await this.dependencies.collision.holdLease(repository, task.taskId);
    await this.dependencies.store.recordEvent(task.taskId, 'finalization_started', {}, (record) => {
      record.reviewSummary = input.review_summary.trim();
      transitionTask(record, 'verifying', 'preflight');
    });
    const controller = new AbortController();
    this.finalizationAbort.set(task.taskId, controller);
    const finalization = this.runFinalization(task.taskId, approved, message, controller.signal)
      .catch(async (error: unknown) => {
        const bridgeError = asBridgeError(error);
        await this.dependencies.store.recordEvent(
          task.taskId,
          'finalization_failed',
          { code: bridgeError.code, message: bridgeError.message, details: bridgeError.details },
          (record) => {
            if (record.status === 'verifying') {
              transitionTask(
                record,
                'commit_failed',
                'finalization_failed',
                `${bridgeError.code}: ${bridgeError.message}`,
              );
            }
          },
        );
        await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
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
    void finalization;
    return taskView(await this.dependencies.store.loadTask(task.taskId));
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
    const reviewedDiff = await workingDiff(task.worktree);
    await this.dependencies.store.recordEvent(
      taskId,
      'preflight_passed',
      {
        files,
        diffSha256: sha256(reviewedDiff),
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
    const verifiedDiff = await workingDiff(task.worktree);
    if (sha256(reviewedDiff) !== sha256(verifiedDiff)) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Verification changed the Codex-reviewed working diff',
      );
    }
    files = verifiedFiles;
    await this.dependencies.store.recordEvent(taskId, 'verification_postflight_passed', {
      files,
      diffSha256: sha256(verifiedDiff),
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
      const proofs = verification.filter(
        (item) => item.passed && item.proves.includes(criterion.id),
      );
      return {
        criterionId: criterion.id,
        evidence: 'automated',
        approved: proofs.length > 0,
        source: proofs.map((item) => item.id).join(','),
        sha256: evidenceHash(proofs.map((item) => item.sha256).join('\n')),
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
    const before = verifiedDiff;
    await stageExplicitFiles(task.worktree, files);
    const staged = await stagedDiff(task.worktree);
    if (sha256(before) !== sha256(staged)) {
      throw new BridgeError(
        'ownership_ambiguous',
        'Staged diff differs from reviewed working diff',
      );
    }
    await assertStagedChecks(task.worktree);
    await scanStagedFiles(task.worktree, files);
    await scanWorkingFiles(task.worktree, files, this.dependencies.config, signal);
    await this.dependencies.store.recordEvent(taskId, 'staged_diff_verified', {
      files,
      sha256: sha256(staged),
      bytes: Buffer.byteLength(staged),
    });

    await assertActive();
    await this.dependencies.collision.guardTask(taskId, 'before_commit');
    await this.dependencies.store.recordEvent(taskId, 'commit_started', {}, (record) => {
      if (record.status !== 'verifying') {
        throw new BridgeError('invalid_state', `Finalization stopped in ${record.status}`);
      }
      record.phase = 'committing';
    });
    await this.dependencies.collision.guardTask(taskId, 'immediately_before_commit');
    const commitHash = await createAtomicCommit(task.worktree, task.baseCommit, commitMessage);
    await this.dependencies.store.recordEvent(
      taskId,
      'task_completed',
      { commitHash },
      (record) => {
        record.commitHash = commitHash;
        transitionTask(record, 'completed', 'completed');
      },
    );
    await this.dependencies.collision.releaseLease(task.repository.id, task.taskId);
  }
}
