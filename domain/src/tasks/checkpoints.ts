import type { ToolCall } from '../types';

export type TaskCheckpointPhase = 'ready' | 'after_llm' | 'after_tools' | 'paused';
export type TaskCheckpointAction =
  | 'continue'
  | 'complete'
  | 'wait_child'
  | 'wait_user'
  | 'blocked';

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  attempt: number;
  iteration: number;
  transcriptCursor: number;
  state: {
    phase: TaskCheckpointPhase;
    nextAction: TaskCheckpointAction;
    pendingChildIds: string[];
    pendingJobIds: string[];
    pendingToolCalls?: ToolCall[];
    contextSummary?: string;
  };
  summary: string;
  createdAt: number;
}
