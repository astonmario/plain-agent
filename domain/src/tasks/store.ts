import type { TaskEventRecord, TaskRecord, TaskStatus } from './types';

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
  /** Requeue only the exact attempt that still owns the lease. */
  retryAttempt(taskId: string, workerId: string, attempt: number, error: string): Promise<boolean>;
  /** Cancel only the exact attempt that still owns the lease. */
  cancelAttempt(taskId: string, workerId: string, attempt: number, result?: unknown): Promise<boolean>;

  claimNext(workerId: string): Promise<TaskRecord | null>;
  claimTask(taskId: string, workerId: string): Promise<TaskRecord | null>;
  renewLease(taskId: string, workerId: string, attempt?: number): Promise<boolean>;
  releaseLease(taskId: string, workerId: string, attempt?: number): Promise<boolean>;
  recoverExpiredTasks(now?: number): Promise<number>;

  appendEvent(taskId: string, type: string, data: unknown): Promise<TaskEventRecord>;
  listEvents(taskId: string, afterSeq?: number): Promise<TaskEventRecord[]>;
  deleteTasksBySession(sessionId: string): Promise<void>;
}

