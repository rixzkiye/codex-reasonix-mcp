import type { BridgeConfig } from './config.js';
import { StateStore } from './state.js';
import type { ControlInput, DelegateInput, InspectInput } from './runtime/api.js';
import { CollisionController } from './runtime/collision.js';
import { FinalizationController } from './runtime/finalization.js';
import { InspectionController } from './runtime/inspection.js';
import { OperationController } from './runtime/operations.js';
import { PermissionController } from './runtime/permissions.js';
import { SessionSupervisor } from './runtime/session-supervision.js';

export { INSPECT_SECTIONS } from './runtime/api.js';
export type { ControlInput, DelegateInput, InspectInput, InspectSection } from './runtime/api.js';
export { assertSupportedPlatform } from './runtime/collision.js';
export { makeTaskRecordForTest } from './runtime/shared.js';

export class BridgeRuntime {
  readonly store: StateStore;
  private readonly collision: CollisionController;
  private readonly permissions: PermissionController;
  private readonly sessions: SessionSupervisor;
  private readonly finalization: FinalizationController;
  private readonly inspection: InspectionController;
  private readonly operations: OperationController;

  constructor(readonly config: BridgeConfig) {
    this.store = new StateStore(config.stateDir);
    this.collision = new CollisionController({ config, store: this.store });

    this.permissions = new PermissionController({
      config,
      store: this.store,
      collision: this.collision,
      taskIdForSession: (sessionId) => this.sessions.taskIdForSession(sessionId),
      cancelSession: async (task) => await this.sessions.cancelWorker(task),
      steerRecovery: async (task, message) => {
        const worker = this.sessions.workerForTask(task);
        await worker.steer(task.acpSessionId!, message);
      },
    });
    this.sessions = new SessionSupervisor({
      config,
      store: this.store,
      permissions: this.permissions,
      collision: this.collision,
    });
    this.finalization = new FinalizationController({
      config,
      store: this.store,
      collision: this.collision,
      sessions: this.sessions,
    });
    this.inspection = new InspectionController({ config, store: this.store });
    this.operations = new OperationController({
      config,
      store: this.store,
      collision: this.collision,
      permissions: this.permissions,
      sessions: this.sessions,
      finalization: this.finalization,
    });
  }

  async initialize(): Promise<string[]> {
    await this.store.initialize();
    await this.inspection.initialize();
    return await this.store.recoverInterruptedTasks();
  }

  async delegate(input: DelegateInput, requestMeta: unknown): Promise<Record<string, unknown>> {
    return await this.operations.delegate(input, requestMeta);
  }

  async control(input: ControlInput, requestMeta: unknown): Promise<Record<string, unknown>> {
    return await this.operations.control(input, requestMeta);
  }

  async inspect(input: InspectInput): Promise<Record<string, unknown>> {
    return await this.inspection.inspect(input);
  }

  async shutdown(): Promise<void> {
    this.finalization.abortAll();
    this.permissions.cancelAllInteractions();
    await this.finalization.waitForAll();
    await this.sessions.shutdown();
    await this.collision.shutdown();
  }
}
