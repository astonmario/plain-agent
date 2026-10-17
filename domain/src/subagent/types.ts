export interface SubagentRequest {
  parentRunId: string;
  /** Stable parent tool-call identity for crash-safe spawn deduplication. */
  parentCallId?: string;
  task: string;
  role?: string;
  context?: {
    summary?: string;
    files?: string[];
    [key: string]: any;
  };
  tools?: string[];
  config?: {
    maxIterations?: number;
    timeout?: number;
    permissionMode?: 'trust' | 'standard' | 'ask';
    maxDepth?: number;
  };
}

export interface SubagentResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'blocked' | 'timeout' | 'pending' | 'running';
  output?: string;
  error?: string;
  artifacts?: Array<{
    type: 'file' | 'data' | 'report';
    path?: string;
    content?: string;
    metadata?: Record<string, any>;
  }>;
  stats?: {
    startedAt: number;
    finishedAt: number;
    duration: number;
    iterations: number;
    toolCalls: number;
    tokensUsed?: number;
  };
  summary?: string;
}

export interface SubagentStatus {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'timeout';
  progress?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface SubagentRuntime {
  spawn(request: SubagentRequest): Promise<{ runId: string }>;
  wait(runId: string, timeout?: number): Promise<SubagentResult>;
  cancel(runId: string): Promise<void>;
  getStatus(runId: string): Promise<SubagentStatus>;
  subscribeSubagent(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void,
  ): void;
  unsubscribeSubagent(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void,
  ): void;
}

export interface ToolPolicy {
  filterTools(allTools: any[], allowedToolNames?: string[]): any[];
  checkToolCall(
    toolName: string,
    args: any,
    context: { parentRunId: string; depth: number },
  ): Promise<boolean>;
}

export interface SubagentRun {
  runId: string;
  request: SubagentRequest;
  status: SubagentStatus['status'];
  agent?: any;
  promise: Promise<SubagentResult>;
  resolveDone: (result: SubagentResult) => void;
  result?: SubagentResult;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  depth: number;
  workerId?: string;
  attempt?: number;
  persistence?: Promise<SubagentResult>;
}
