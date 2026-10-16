import type { TaskEventRecord, TaskRecord, TaskStatus } from './types';
import { canTransition, normalizeTaskStatus } from './transitions';
import type { TaskStore, TaskTerminalStatus } from './store';

export const DEFAULT_TASK_LEASE_MS = 60_000;

const CLAIMABLE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'waiting_child',
  'waiting_process',
]);

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private events = new Map<string, TaskEventRecord[]>();
  private nextSeq = 1;

  async createTask(task: TaskRecord): Promise<void> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task already exists: ${task.id}`);
    }
    this.tasks.set(task.id, clone(task));
    await this.appendEvent(task.id, 'task-created', { status: task.status });
  }

  async saveTask(task: TaskRecord): Promise<void> {
    if (this.tasks.has(task.id)) {
      this.tasks.set(task.id, {
        ...this.tasks.get(task.id)!,
        ...clone(task),
        updatedAt: Date.now(),
      });
      return;
    }
    await this.createTask(task);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId);
    return task ? clone(task) : null;
  }

  async listTasks(filter: {
    sessionId?: string;
    rootId?: string;
    parentId?: string;
    status?: TaskStatus | TaskStatus[];
  } = {}): Promise<TaskRecord[]> {
    const statuses = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;

    return [...this.tasks.values()]
      .filter(task => !filter.sessionId || task.sessionId === filter.sessionId)
      .filter(task => !filter.rootId || task.rootId === filter.rootId)
      .filter(task => filter.parentId === undefined || task.parentId === filter.parentId)
      .filter(task => !statuses || statuses.has(task.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  async updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current) return false;
    this.tasks.set(taskId, { ...current, ...clone(patch), updatedAt: Date.now() });
    return true;
  }

  async transition(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    patch: Partial<TaskRecord> = {},
  ): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current || current.status !== from || !canTransition(from, to)) return false;

    this.tasks.set(taskId, {
      ...current,
      ...clone(patch),
      status: to,
      updatedAt: Date.now(),
    });
    await this.appendEvent(taskId, 'status-changed', { from, to });
    return true;
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, result?: unknown): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current) return false;
    const normalized = normalizeTaskStatus(status);
    if (current.status === normalized) return false;
    const patch: Partial<TaskRecord> = {};
    if (result !== undefined) patch.result = result;
    if (typeof result === 'object' && result !== null) {
      const value = result as Record<string, unknown>;
      if (typeof value.summary === 'string') patch.resultSummary = value.summary;
      if (typeof value.error === 'string') patch.error = value.error;
      if (typeof value.output === 'string' && !patch.resultSummary) {
        patch.resultSummary = value.output.slice(0, 500);
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(normalized)) {
      patch.leaseOwner = undefined;
      patch.leaseUntil = undefined;
    }
    if (!canTransition(current.status, normalized)) return false;
    this.tasks.set(taskId, {
      ...current,
      ...patch,
      status: normalized,
      finishedAt: ['completed', 'failed', 'cancelled'].includes(normalized)
        ? Date.now()
        : current.finishedAt,
      updatedAt: Date.now(),
    });
    await this.appendEvent(taskId, 'status-changed', {
      from: current.status,
      to: normalized,
    });
    return true;
  }

  async finishAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    status: TaskTerminalStatus,
    result?: unknown,
  ): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current ||
        current.status !== 'running' ||
        current.leaseOwner !== workerId ||
        current.leaseUntil === undefined ||
        current.leaseUntil <= Date.now() ||
        current.attempt !== attempt ||
        !canTransition(current.status, status)) {
      return false;
    }
    return this.updateTaskStatus(taskId, status, result);
  }

  async retryAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    error: string,
  ): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current ||
        current.status !== 'running' ||
        current.leaseOwner !== workerId ||
        current.leaseUntil === undefined ||
        current.leaseUntil <= Date.now() ||
        current.attempt !== attempt ||
        current.attempt >= current.maxAttempts ||
        !canTransition(current.status, 'queued')) {
      return false;
    }
    this.tasks.set(taskId, {
      ...current,
      status: 'queued',
      error,
      leaseOwner: undefined,
      leaseUntil: undefined,
      updatedAt: Date.now(),
    });
    await this.appendEvent(taskId, 'status-changed', { from: 'running', to: 'queued' });
    return true;
  }

  async cancelAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    result?: unknown,
  ): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current ||
        current.status !== 'running' ||
        current.leaseOwner !== workerId ||
        current.attempt !== attempt) {
      return false;
    }
    return this.updateTaskStatus(taskId, 'cancelled', result);
  }

  async claimNext(workerId: string): Promise<TaskRecord | null> {
    const now = Date.now();
    const task = [...this.tasks.values()]
      .filter(candidate =>
        candidate.status === 'queued' ||
        (CLAIMABLE.has(candidate.status) &&
          candidate.leaseUntil !== undefined &&
          candidate.leaseUntil <= now),
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    return task ? this.claim(task.id, workerId, now) : null;
  }

  async claimTask(taskId: string, workerId: string): Promise<TaskRecord | null> {
    return this.claim(taskId, workerId, Date.now());
  }

  private async claim(taskId: string, workerId: string, now: number): Promise<TaskRecord | null> {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const expired = current.leaseUntil !== undefined && current.leaseUntil <= now;
    if (current.status !== 'queued' && !(CLAIMABLE.has(current.status) && expired)) return null;
    if (current.attempt >= current.maxAttempts) {
      this.tasks.set(taskId, {
        ...current,
        status: 'failed',
        error: current.error ?? `Task exceeded maximum attempts (${current.maxAttempts})`,
        finishedAt: now,
        leaseOwner: undefined,
        leaseUntil: undefined,
        updatedAt: now,
      });
      await this.appendEvent(taskId, 'task-failed', {
        reason: 'max-attempts-exceeded',
        attempt: current.attempt,
      });
      return null;
    }

    const claimed: TaskRecord = {
      ...current,
      status: 'running',
      attempt: current.attempt + 1,
      leaseOwner: workerId,
      leaseUntil: now + DEFAULT_TASK_LEASE_MS,
      startedAt: current.startedAt ?? now,
      updatedAt: now,
    };
    this.tasks.set(taskId, claimed);
    await this.appendEvent(taskId, 'task-claimed', { workerId, attempt: claimed.attempt });
    return clone(claimed);
  }

  async renewLease(taskId: string, workerId: string, attempt?: number): Promise<boolean> {
    const current = this.tasks.get(taskId);
    const now = Date.now();
    if (!current ||
        current.leaseOwner !== workerId ||
        current.status !== 'running' ||
        current.leaseUntil === undefined ||
        current.leaseUntil <= now ||
        (attempt !== undefined && current.attempt !== attempt)) return false;
    current.leaseUntil = now + DEFAULT_TASK_LEASE_MS;
    current.updatedAt = now;
    return true;
  }

  async releaseLease(taskId: string, workerId: string, attempt?: number): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current ||
        current.leaseOwner !== workerId ||
        (attempt !== undefined && current.attempt !== attempt)) return false;
    current.leaseOwner = undefined;
    current.leaseUntil = undefined;
    current.updatedAt = Date.now();
    return true;
  }

  async recoverExpiredTasks(now = Date.now()): Promise<number> {
    let count = 0;
    for (const current of this.tasks.values()) {
      if (
        current.leaseUntil !== undefined &&
        current.leaseUntil <= now &&
        CLAIMABLE.has(current.status)
      ) {
        const exhausted = current.attempt >= current.maxAttempts;
        current.status = exhausted ? 'failed' : 'queued';
        current.leaseOwner = undefined;
        current.leaseUntil = undefined;
        if (exhausted) {
          current.error = current.error ?? `Task exceeded maximum attempts (${current.maxAttempts})`;
          current.finishedAt = now;
        }
        current.updatedAt = now;
        count++;
        await this.appendEvent(current.id, 'lease-expired', {
          recoveredAt: now,
          nextStatus: current.status,
        });
        if (exhausted) {
          await this.appendEvent(current.id, 'task-failed', {
            reason: 'max-attempts-exceeded',
            attempt: current.attempt,
          });
        }
      }
    }
    return count;
  }

  async appendEvent(taskId: string, type: string, data: unknown): Promise<TaskEventRecord> {
    const event: TaskEventRecord = {
      seq: this.nextSeq++,
      taskId,
      type,
      data: clone(data),
      createdAt: Date.now(),
    };
    const events = this.events.get(taskId) ?? [];
    events.push(event);
    this.events.set(taskId, events);
    return clone(event);
  }

  async listEvents(taskId: string, afterSeq = 0): Promise<TaskEventRecord[]> {
    return (this.events.get(taskId) ?? [])
      .filter(event => event.seq > afterSeq)
      .map(clone);
  }

  async deleteTasksBySession(sessionId: string): Promise<void> {
    const rootIds = new Set(
      [...this.tasks.values()]
        .filter(task => task.sessionId === sessionId)
        .map(task => task.rootId),
    );
    for (const task of [...this.tasks.values()]) {
      if (task.sessionId === sessionId || rootIds.has(task.rootId)) {
        this.tasks.delete(task.id);
        this.events.delete(task.id);
      }
    }
  }

  clear(): void {
    this.tasks.clear();
    this.events.clear();
    this.nextSeq = 1;
  }
}

