import type { TaskEventRecord, TaskRecord, TaskStatus } from './types';
import type { TaskCheckpoint } from './checkpoints';
import type {
  TaskVerificationRecord,
  VerificationCheckOutcome,
  VerificationCheckSeed,
} from './verification';

export type TaskTerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface TaskStore {
  createTask(task: TaskRecord): Promise<void>;
  saveTask(task: TaskRecord): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  listTasks(filter?: {
    sessionId?: string;
    rootId?: string;
    parentId?: string;
    status?: TaskStatus | TaskStatus[];
  }): Promise<TaskRecord[]>;

  updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<boolean>;
  transition(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    patch?: Partial<TaskRecord>,
  ): Promise<boolean>;
  updateTaskStatus(taskId: string, status: TaskStatus, result?: unknown): Promise<boolean>;
  /**
   * Finish only the exact attempt that still owns the lease.
   * This prevents a stale worker from overwriting a later retry.
   */
  finishAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    status: TaskTerminalStatus,
    result?: unknown,
  ): Promise<boolean>;
  /** Block only the exact attempt that still owns the lease. */
  blockAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    error?: string,
  ): Promise<boolean>;
  /** Requeue only the exact attempt that still owns the lease. */
  retryAttempt(taskId: string, workerId: string, attempt: number, error: string): Promise<boolean>;
  /** Cancel only the exact attempt that still owns the lease. */
  cancelAttempt(taskId: string, workerId: string, attempt: number, result?: unknown): Promise<boolean>;

  claimNext(workerId: string): Promise<TaskRecord | null>;
  claimTask(taskId: string, workerId: string): Promise<TaskRecord | null>;
  renewLease(taskId: string, workerId: string, attempt?: number): Promise<boolean>;
  releaseLease(taskId: string, workerId: string, attempt?: number): Promise<boolean>;
  recoverExpiredTasks(now?: number): Promise<number>;
  /**
   * Tasks that can be resumed without an external wakeup.
   * Waiting states are intentionally excluded until their wakeup is materialized.
   */
  listRecoverableTasks(now?: number): Promise<TaskRecord[]>;
  listChildren(parentId: string): Promise<TaskRecord[]>;
  /** Return a stable snapshot of a task tree after lease recovery. */
  recoverTaskTree(rootId: string, now?: number): Promise<TaskRecord[]>;

  createCheckpoint(checkpoint: TaskCheckpoint): Promise<void>;
  getCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null>;
  getLatestCheckpoint(taskId: string): Promise<TaskCheckpoint | null>;
  commitCheckpoint(
    taskId: string,
    checkpoint: TaskCheckpoint,
    event: { type: string; data: unknown },
    guard?: { workerId?: string; attempt?: number },
  ): Promise<boolean>;

  appendEvent(taskId: string, type: string, data: unknown): Promise<TaskEventRecord>;
  listEvents(taskId: string, afterSeq?: number): Promise<TaskEventRecord[]>;

  /**
   * running -> verifying（原子）。
   * 该 (taskId, attempt) 已有 running/interrupted 记录时直接返回它（幂等）。
   * Guard: status='running' AND lease_owner=workerId AND attempt AND lease 未过期。
   */
  beginVerification(
    taskId: string,
    workerId: string,
    attempt: number,
    checks: VerificationCheckSeed[],
  ): Promise<TaskVerificationRecord | null>;
  getVerification(verificationId: string): Promise<TaskVerificationRecord | null>;
  getLatestVerification(taskId: string, attempt?: number): Promise<TaskVerificationRecord | null>;
  listVerifications(taskId: string): Promise<TaskVerificationRecord[]>;
  /**
   * 恢复路径：只接管租约，不改变 status/attempt。
   * Guard: status='verifying' AND (lease 为空或已过期)。
   */
  claimVerification(
    taskId: string,
    workerId: string,
  ): Promise<{ task: TaskRecord; verification: TaskVerificationRecord } | null>;
  startVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
  ): Promise<boolean>;
  finishVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
    outcome: VerificationCheckOutcome,
  ): Promise<boolean>;
  /**
   * verifying -> completed | failed（原子：证据 + 状态 + 事件 + 释放租约）。
   * 非当前 worker/attempt，或任务已不是 verifying 时返回 null。
   */
  concludeVerification(
    verificationId: string,
    workerId: string,
    input: {
      passed: boolean;
      changedFiles: string[];
      diffHash?: string;
      result?: unknown;
      error?: string;
    },
  ): Promise<'completed' | 'failed' | null>;

  deleteTasksBySession(sessionId: string): Promise<void>;
}

