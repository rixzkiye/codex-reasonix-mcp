import type { BridgeConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { acquireLease, type Lease } from '../lease.js';
import { resolveBaseCommit } from '../repository.js';
import type { StateStore } from '../state.js';
import type { RepositoryIdentity, TaskRecord } from '../types.js';

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

export interface CollisionAccess extends LeaseAccess {
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
