import { randomUUID } from 'node:crypto';
import type { TaskEventRecord, TaskRecord, TaskStatus } from './types';
import type { TaskCheckpoint } from './checkpoints';
import type {
  TaskVerificationRecord,
  VerificationCheckOutcome,
  VerificationCheckSeed,
  VerificationStatus,
} from './verification';
import { canTransition, normalizeTaskStatus } from './transitions';
import type { TaskStore, TaskTerminalStatus } from './store';

export const DEFAULT_TASK_LEASE_MS = 60_000;

const CLAIMABLE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
]);
/** Lease expiry also scans verifying, which recovers without a new attempt. */
const RECOVERABLE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'verifying',
]);

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private events = new Map<string, TaskEventRecord[]>();
  private checkpoints = new Map<string, TaskCheckpoint>();
  private verifications = new Map<string, TaskVerificationRecord>();
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
    if (status === 'completed' && current.verification?.mode === 'required') {
      const passed = [...this.verifications.values()].some(record =>
        record.taskId === taskId && record.attempt === attempt && record.status === 'passed',
      );
      if (!passed) {
        await this.appendEvent(taskId, 'completion-rejected', {
          reason: 'verification-required-but-not-passed',
          attempt,
        });
        return false;
      }
    }
    return this.updateTaskStatus(taskId, status, result);
  }

  async blockAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    error?: string,
  ): Promise<boolean> {
    const current = this.tasks.get(taskId);
    const now = Date.now();
    if (!current ||
        current.status !== 'running' ||
        current.leaseOwner !== workerId ||
        current.leaseUntil === undefined ||
        current.leaseUntil <= now ||
        current.attempt !== attempt ||
        !canTransition(current.status, 'blocked')) {
      return false;
    }
    this.tasks.set(taskId, {
      ...current,
      status: 'blocked',
      error: error ?? current.error,
      leaseOwner: undefined,
      leaseUntil: undefined,
      updatedAt: now,
    });
    await this.appendEvent(taskId, 'status-changed', {
      from: 'running',
      to: 'blocked',
    });
    return true;
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
        (current.status !== 'running' && current.status !== 'verifying') ||
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
        (current.status !== 'running' && current.status !== 'verifying') ||
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
        RECOVERABLE.has(current.status)
      ) {
        if (current.status === 'verifying') {
          // Verification is not a new attempt: release the lease, keep status/attempt.
          const verification = [...this.verifications.values()]
            .filter(record => record.taskId === current.id && record.attempt === current.attempt)
            .sort((a, b) => b.startedAt - a.startedAt)[0];
          current.leaseOwner = undefined;
          current.leaseUntil = undefined;
          current.updatedAt = now;
          if (verification) {
            if (verification.status === 'running') verification.status = 'interrupted';
            for (const check of verification.checks) {
              if (check.status === 'running') {
                check.status = 'interrupted';
                check.finishedAt = now;
              }
            }
          }
          count++;
          await this.appendEvent(current.id, 'lease-expired', {
            recoveredAt: now,
            nextStatus: 'verifying',
          });
          await this.appendEvent(current.id, 'verification-interrupted', {
            attempt: current.attempt,
          });
          continue;
        }

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

  async listRecoverableTasks(now = Date.now()): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter(task =>
        task.status === 'queued' ||
        (task.status === 'running' &&
          task.leaseUntil !== undefined &&
          task.leaseUntil <= now) ||
        (task.status === 'verifying' &&
          (task.leaseUntil === undefined || task.leaseUntil <= now)),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  async listChildren(parentId: string): Promise<TaskRecord[]> {
    return this.listTasks({ parentId });
  }

  async recoverTaskTree(rootId: string, now = Date.now()): Promise<TaskRecord[]> {
    await this.recoverExpiredTasks(now);
    return this.listTasks({ rootId });
  }

  async createCheckpoint(checkpoint: TaskCheckpoint): Promise<void> {
    if (!this.tasks.has(checkpoint.taskId)) {
      throw new Error(`Task not found: ${checkpoint.taskId}`);
    }
    if (this.checkpoints.has(checkpoint.id)) {
      throw new Error(`Checkpoint already exists: ${checkpoint.id}`);
    }
    this.checkpoints.set(checkpoint.id, clone(checkpoint));
  }

  async getCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null> {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? clone(checkpoint) : null;
  }

  async getLatestCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
    const checkpoints = [...this.checkpoints.values()]
      .filter(checkpoint => checkpoint.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return checkpoints[0] ? clone(checkpoints[0]) : null;
  }

  async commitCheckpoint(
    taskId: string,
    checkpoint: TaskCheckpoint,
    event: { type: string; data: unknown },
    guard?: { workerId?: string; attempt?: number },
  ): Promise<boolean> {
    const current = this.tasks.get(taskId);
    if (!current || checkpoint.taskId !== taskId) return false;
    if (
      guard?.attempt !== undefined &&
      (current.attempt !== guard.attempt ||
        current.status !== 'running' ||
        (guard.workerId !== undefined && current.leaseOwner !== guard.workerId) ||
        current.leaseUntil === undefined ||
        current.leaseUntil <= Date.now())
    ) return false;
    if (this.checkpoints.has(checkpoint.id)) return false;
    this.checkpoints.set(checkpoint.id, clone(checkpoint));
    current.checkpointId = checkpoint.id;
    current.updatedAt = Date.now();
    await this.appendEvent(taskId, event.type, event.data);
    return true;
  }

  async beginVerification(
    taskId: string,
    workerId: string,
    attempt: number,
    checks: VerificationCheckSeed[],
  ): Promise<TaskVerificationRecord | null> {
    if (checks.length === 0) return null;
    const now = Date.now();
    const current = this.tasks.get(taskId);
    if (
      !current ||
      current.status !== 'running' ||
      current.leaseOwner !== workerId ||
      current.attempt !== attempt ||
      current.leaseUntil === undefined ||
      current.leaseUntil <= now
    ) {
      return null;
    }

    const existing = [...this.verifications.values()].find(record =>
      record.taskId === taskId &&
      record.attempt === attempt &&
      (record.status === 'running' || record.status === 'interrupted'),
    );
    if (existing) return clone(existing);

    const record: TaskVerificationRecord = {
      id: randomUUID(),
      taskId,
      attempt,
      status: 'running',
      checks: checks.map(check => ({
        index: check.index,
        name: check.name,
        kind: check.kind,
        command: check.command,
        status: 'pending',
      })),
      changedFiles: [],
      startedAt: now,
    };
    this.verifications.set(record.id, record);
    current.status = 'verifying';
    current.updatedAt = now;
    await this.appendEvent(taskId, 'status-changed', { from: 'running', to: 'verifying' });
    await this.appendEvent(taskId, 'verification-started', {
      verificationId: record.id,
      attempt,
    });
    return clone(record);
  }

  async getVerification(verificationId: string): Promise<TaskVerificationRecord | null> {
    const record = this.verifications.get(verificationId);
    return record ? clone(record) : null;
  }

  async getLatestVerification(
    taskId: string,
    attempt?: number,
  ): Promise<TaskVerificationRecord | null> {
    const record = [...this.verifications.values()]
      .filter(candidate =>
        candidate.taskId === taskId &&
        (attempt === undefined || candidate.attempt === attempt),
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return record ? clone(record) : null;
  }

  async listVerifications(taskId: string): Promise<TaskVerificationRecord[]> {
    return [...this.verifications.values()]
      .filter(record => record.taskId === taskId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(clone);
  }

  async claimVerification(
    taskId: string,
    workerId: string,
  ): Promise<{ task: TaskRecord; verification: TaskVerificationRecord } | null> {
    const now = Date.now();
    const current = this.tasks.get(taskId);
    const free = current && current.status === 'verifying' &&
      (current.leaseOwner === undefined ||
        current.leaseUntil === undefined ||
        current.leaseUntil <= now);
    if (!current || !free) return null;

    const verification = [...this.verifications.values()]
      .filter(record => record.taskId === taskId && record.attempt === current.attempt)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!verification) return null;

    current.leaseOwner = workerId;
    current.leaseUntil = now + DEFAULT_TASK_LEASE_MS;
    current.updatedAt = now;
    if (verification.status === 'interrupted') verification.status = 'running';
    await this.appendEvent(taskId, 'verification-claimed', {
      workerId,
      verificationId: verification.id,
      attempt: current.attempt,
    });
    return { task: clone(current), verification: clone(verification) };
  }

  async startVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
  ): Promise<boolean> {
    const now = Date.now();
    const record = this.verifications.get(verificationId);
    if (!record || !this.canDriveVerification(record, workerId, now)) return false;
    const check = record.checks.find(candidate => candidate.index === index);
    if (!check || !['pending', 'running', 'interrupted'].includes(check.status)) return false;
    check.status = 'running';
    check.startedAt = now;
    check.error = undefined;
    await this.appendEvent(record.taskId, 'verification-check-started', {
      verificationId,
      index,
    });
    return true;
  }

  async finishVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
    outcome: VerificationCheckOutcome,
  ): Promise<boolean> {
    const now = Date.now();
    const record = this.verifications.get(verificationId);
    if (!record || !this.canDriveVerification(record, workerId, now)) return false;
    const check = record.checks.find(candidate => candidate.index === index);
    if (!check || check.status !== 'running') return false;
    check.status = outcome.status;
    check.exitCode = outcome.exitCode ?? undefined;
    check.outputRef = outcome.outputRef;
    check.outputTail = outcome.outputTail;
    check.durationMs = outcome.durationMs;
    check.error = outcome.error;
    check.finishedAt = now;
    await this.appendEvent(record.taskId, 'verification-check-completed', {
      verificationId,
      index,
      status: outcome.status,
      exitCode: outcome.exitCode ?? null,
    });
    return true;
  }

  async concludeVerification(
    verificationId: string,
    workerId: string,
    input: {
      passed: boolean;
      changedFiles: string[];
      diffHash?: string;
      result?: unknown;
      error?: string;
    },
  ): Promise<'completed' | 'failed' | null> {
    const now = Date.now();
    const record = this.verifications.get(verificationId);
    if (!record || !this.canDriveVerification(record, workerId, now)) return null;
    const task = this.tasks.get(record.taskId);
    if (!task || task.status !== 'verifying' || task.leaseOwner !== workerId) return null;

    if (!input.passed) {
      for (const check of record.checks) {
        if (check.status === 'pending' || check.status === 'interrupted') {
          check.status = 'skipped';
          check.finishedAt = now;
        }
      }
    }
    record.status = input.passed ? 'passed' : 'failed';
    record.changedFiles = [...input.changedFiles];
    record.diffHash = input.diffHash;
    record.error = input.error;
    record.finishedAt = now;

    const finalStatus = input.passed ? 'completed' : 'failed';
    const patch: Partial<TaskRecord> = {
      status: finalStatus,
      finishedAt: now,
      leaseOwner: undefined,
      leaseUntil: undefined,
      updatedAt: now,
    };
    if (input.result !== undefined) {
      patch.result = input.result;
      if (typeof input.result === 'object' && input.result !== null) {
        const value = input.result as Record<string, unknown>;
        if (typeof value.summary === 'string') patch.resultSummary = value.summary;
        else if (typeof value.output === 'string') patch.resultSummary = value.output.slice(0, 500);
      }
    }
    if (input.error !== undefined) patch.error = input.error;
    Object.assign(task, patch);

    await this.appendEvent(task.id, 'status-changed', { from: 'verifying', to: finalStatus });
    await this.appendEvent(
      task.id,
      input.passed ? 'verification-completed' : 'verification-failed',
      input.passed
        ? { verificationId, changedFiles: input.changedFiles, diffHash: input.diffHash ?? null }
        : { verificationId, error: input.error ?? 'verification-failed' },
    );
    await this.appendEvent(
      task.id,
      input.passed ? 'task-completed' : 'task-failed',
      input.passed
        ? { verificationId }
        : { verificationId, error: input.error ?? 'verification-failed' },
    );
    return finalStatus;
  }

  private canDriveVerification(
    record: TaskVerificationRecord,
    workerId: string,
    now: number,
  ): boolean {
    const task = this.tasks.get(record.taskId);
    return Boolean(
      task &&
      record.status === 'running' &&
      task.status === 'verifying' &&
      task.attempt === record.attempt &&
      task.leaseOwner === workerId &&
      task.leaseUntil !== undefined &&
      task.leaseUntil > now,
    );
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
        for (const checkpoint of this.checkpoints.values()) {
          if (checkpoint.taskId === task.id) this.checkpoints.delete(checkpoint.id);
        }
        for (const verification of this.verifications.values()) {
          if (verification.taskId === task.id) this.verifications.delete(verification.id);
        }
      }
    }
  }

  clear(): void {
    this.tasks.clear();
    this.events.clear();
    this.checkpoints.clear();
    this.verifications.clear();
    this.nextSeq = 1;
  }
}

