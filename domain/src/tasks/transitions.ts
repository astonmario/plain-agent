import type { TaskStatus } from './types';

export const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'blocked', 'cancelled'],
  running: [
    'queued',
    'waiting_child',
    'waiting_process',
    'waiting_user',
    'blocked',
    'verifying',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ],
  waiting_child: ['running', 'blocked', 'failed', 'cancelled'],
  waiting_process: ['running', 'blocked', 'failed', 'cancelled'],
  waiting_user: ['running', 'cancelled'],
  blocked: ['queued', 'running', 'cancelled'],
  verifying: ['completed', 'running', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TASK_TRANSITIONS[from].includes(to);
}

export function normalizeTaskStatus(status: string): TaskStatus {
  if (status === 'pending') return 'queued';
  if (status === 'timeout') return 'failed';
  if (status in ALLOWED_TASK_TRANSITIONS) return status as TaskStatus;
  throw new Error(`Unknown task status: ${status}`);
}

