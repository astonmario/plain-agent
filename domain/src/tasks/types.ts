import type { SubagentRequest } from '../subagent/types';
import type { TaskVerificationPolicy } from './verification';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_child'
  | 'waiting_process'
  | 'waiting_user'
  | 'blocked'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskRecord {
  id: string;
  parentId?: string;
  rootId: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  /** Persisted delegation metadata used to recreate sub-agent runs after restart. */
  delegation?: SubagentRequest;
  /** Sub-agent depth relative to the top-level task. */
  depth?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  checkpointId?: string;
  /** Task-level verification policy; undefined means mode='off'. */
  verification?: TaskVerificationPolicy;
  resultSummary?: string;
  resultRef?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export interface TaskEventRecord {
  seq: number;
  taskId: string;
  type: string;
  data: unknown;
  createdAt: number;
}

