import type { BridgeConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { acquireLease, type Lease } from '../lease.js';
import { canTransition, transitionTask } from '../lifecycle.js';
import { isWriteAllowed } from '../contracts.js';
import { resolveBaseCommit, sourceRepositoryChanges } from '../repository.js';
import type { StateStore } from '../state.js';
import {
  TERMINAL_STATUSES,
  type RepositoryIdentity,
  type SourceCollisionEvidence,
  type TaskRecord,
} from '../types.js';

interface RepositoryLease {
  lease: Lease;
  tasks: Set<string>;
}

export interface CollisionDependencies {
  config: BridgeConfig;
  store: StateStore;
}

export interface LeaseAccess {
  holdLease(repository: RepositoryIdentity, taskId: string): Promise<void>;
  releaseLease(repositoryId: string, taskId: string): Promise<void>;
}

export interface SourceCollisionAccess {
  guardTask(taskId: string, checkpoint: string): Promise<void>;
  scanTask(task: TaskRecord, checkpoint: string): Promise<SourceCollisionEvidence | undefined>;
}

export interface CollisionAccess extends LeaseAccess, SourceCollisionAccess {
  assertExistingTask(
    existing: TaskRecord,
    repository: RepositoryIdentity,
    contractHash: string,
    baseRef?: string,
  ): Promise<void>;
  assertTaskRepository(task: TaskRecord, repository: RepositoryIdentity): void;
  shutdown(): Promise<void>;
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new BridgeError(
      'unsupported_platform',
      'Native Windows is unsupported in v1; run codex-reasonix-mcp inside WSL',
    );
  }
}

export class CollisionController implements CollisionAccess {
  private readonly leases = new Map<string, RepositoryLease>();
  private readonly leaseAcquisitions = new Map<string, Promise<RepositoryLease>>();

  constructor(private readonly dependencies: CollisionDependencies) {}

  async assertExistingTask(
    existing: TaskRecord,
    repository: RepositoryIdentity,
    contractHash: string,
    baseRef?: string,
  ): Promise<void> {
    if (existing.repository.id !== repository.id || existing.contractHash !== contractHash) {
      throw new BridgeError(
        'task_conflict',
        'task_id already belongs to a different repository or contract hash',
      );
    }
    if (baseRef) {
      const requestedBase = await resolveBaseCommit(repository, baseRef.trim());
      if (requestedBase !== existing.baseCommit) {
        throw new BridgeError('task_conflict', 'Explicit base_ref differs from the existing task');
      }
    }
  }

  assertTaskRepository(task: TaskRecord, repository: RepositoryIdentity): void {
    if (repository.id !== task.repository.id) {
      throw new BridgeError('task_conflict', 'Task belongs to a different repository');
    }
  }

  async scanTask(
    task: TaskRecord,
    checkpoint: string,
  ): Promise<SourceCollisionEvidence | undefined> {
    const detectedAt = new Date().toISOString();
    try {
      const changes = await sourceRepositoryChanges(task.repository, task.baseCommit);
      const dirtyOverlap = changes.dirtyPaths.filter((candidate) =>
        isWriteAllowed(task.contract, candidate),
      );
      const committedOverlap = changes.committedPaths.filter((candidate) =>
        isWriteAllowed(task.contract, candidate),
      );
      const overlappingPaths = [...new Set([...dirtyOverlap, ...committedOverlap])].sort();
      if (overlappingPaths.length === 0) return undefined;
      return {
        checkpoint,
        baseCommit: task.baseCommit,
        sourceHead: changes.sourceHead,
        dirtyPaths: changes.dirtyPaths,
        committedPaths: changes.committedPaths,
        overlappingPaths,
        unavailable: false,
        detectedAt,
      };
    } catch {
      return {
        checkpoint,
        baseCommit: task.baseCommit,
        dirtyPaths: [],
        committedPaths: [],
        overlappingPaths: [],
        unavailable: true,
        detectedAt,
      };
    }
  }

  async guardTask(taskId: string, checkpoint: string): Promise<void> {
    const task = await this.dependencies.store.loadTask(taskId);
    const collision = await this.scanTask(task, checkpoint);
    if (!collision) {
      if (task.sourceCollision) {
        await this.dependencies.store.recordEvent(
          taskId,
          'source_collision_cleared',
          { checkpoint },
          (record) => {
            delete record.sourceCollision;
          },
        );
      }
      return;
    }

    const message = collision.unavailable
      ? 'Source repository is unavailable; ownership cannot be established'
      : `Source changes overlap task write_scope: ${collision.overlappingPaths.join(', ')}`;
    const paused = await this.dependencies.store.recordEvent(
      taskId,
      'source_collision_detected',
      collision,
      (record) => {
        record.sourceCollision = collision;
        if (!TERMINAL_STATUSES.has(record.status) && canTransition(record.status, 'paused')) {
          transitionTask(record, 'paused', 'source_collision', message);
          record.inspectedAfterPause = false;
        }
      },
    );
    await this.releaseLease(paused.repository.id, paused.taskId);
    throw new BridgeError('ownership_ambiguous', message, {
      checkpoint,
      baseCommit: collision.baseCommit,
      sourceHead: collision.sourceHead,
      dirtyPaths: collision.dirtyPaths,
      committedPaths: collision.committedPaths,
      overlappingPaths: collision.overlappingPaths,
      unavailable: collision.unavailable,
    });
  }

  async holdLease(repository: RepositoryIdentity, taskId: string): Promise<void> {
    const existing = this.leases.get(repository.id);
    if (existing) {
      existing.tasks.add(taskId);
      return;
    }

    let acquisition = this.leaseAcquisitions.get(repository.id);
    if (!acquisition) {
      acquisition = acquireLease(
        this.dependencies.store.locksDir(),
        `repo-${repository.id}`,
        this.dependencies.config.leaseStaleMs,
        this.dependencies.config.leaseHeartbeatMs,
      ).then((lease) => {
        const held = { lease, tasks: new Set<string>() };
        this.leases.set(repository.id, held);
        return held;
      });
      this.leaseAcquisitions.set(repository.id, acquisition);
    }

    try {
      const held = await acquisition;
      held.tasks.add(taskId);
    } finally {
      if (this.leaseAcquisitions.get(repository.id) === acquisition) {
        this.leaseAcquisitions.delete(repository.id);
      }
    }
  }

  async releaseLease(repositoryId: string, taskId: string): Promise<void> {
    const held = this.leases.get(repositoryId);
    if (!held) return;
    held.tasks.delete(taskId);
    if (held.tasks.size === 0) {
      this.leases.delete(repositoryId);
      await held.lease.release();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.leaseAcquisitions.values());
    this.leaseAcquisitions.clear();
    await Promise.all([...this.leases.values()].map(async (held) => await held.lease.release()));
    this.leases.clear();
  }
}
