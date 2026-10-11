/**
 * Subagent 类型定义
 *
 * 设计原则：
 * - 独立状态：每个子 Agent 拥有独立的对话历史
 * - 明确接口：通过 Request/Result 通信
 * - 可插拔：不污染 Agent Core
 */

// ============ 子 Agent 请求 ============

export interface SubagentRequest {
  /** 父任务运行 ID（追溯链路） */
  parentRunId: string;

  /** 子任务描述 */
  task: string;

  /** 可选角色（如 "代码审查员"、"测试生成器"） */
  role?: string;

  /** 上下文信息（父 Agent 传递给子 Agent） */
  context?: {
    /** 摘要信息（避免传递完整历史） */
    summary?: string;

    /** 相关文件列表 */
    files?: string[];

    /** 自定义上下文数据 */
    [key: string]: any;
  };

  /** 工具白名单（限制子 Agent 可用工具） */
  tools?: string[];

  /** 执行配置 */
  config?: {
    /** 最大迭代次数 */
    maxIterations?: number;

    /** 超时时间（毫秒） */
    timeout?: number;

    /** 权限模式 */
    permissionMode?: 'trust' | 'standard' | 'ask';

    /** 递归深度（防无限嵌套） */
    maxDepth?: number;
  };
}

// ============ 子 Agent 结果 ============

export interface SubagentResult {
  /** 子任务运行 ID */
  runId: string;

  /** 执行状态 */
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';

  /** 输出结果（成功时） */
  output?: string;

  /** 错误信息（失败时） */
  error?: string;

  /** 产出的文件/资源 */
  artifacts?: Array<{
    type: 'file' | 'data' | 'report';
    path?: string;
    content?: string;
    metadata?: Record<string, any>;
  }>;

  /** 执行统计 */
  stats?: {
    startedAt: number;
    finishedAt: number;
    duration: number;
    iterations: number;
    toolCalls: number;
    tokensUsed?: number;
  };

  /** 压缩的执行摘要（用于回注父 Agent） */
  summary?: string;
}

// ============ 子 Agent 状态 ============

export interface SubagentStatus {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  progress?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

// ============ 子 Agent 运行时接口 ============

export interface SubagentRuntime {
  /**
   * 创建并启动子 Agent
   * @returns 子任务运行 ID
   */
  spawn(request: SubagentRequest): Promise<{ runId: string }>;

  /**
   * 等待子 Agent 完成（阻塞）
   * @param runId 子任务运行 ID
   * @param timeout 可选超时时间（毫秒）
   * @returns 执行结果
   */
  wait(runId: string, timeout?: number): Promise<SubagentResult>;

  /**
   * 取消子 Agent 执行
   * @param runId 子任务运行 ID
   */
  cancel(runId: string): Promise<void>;

  /**
   * 获取子 Agent 当前状态（非阻塞）
   * @param runId 子任务运行 ID
   */
  getStatus(runId: string): Promise<SubagentStatus>;

  /**
   * 订阅子 Agent 事件
   * @param runId 子任务运行 ID
   * @param event 事件类型
   * @param listener 事件监听器
   */
  subscribeSubagent(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void
  ): void;

  /**
   * 取消订阅
   */
  unsubscribeSubagent(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void
  ): void;
}

// ============ 上下文管理器 ============

export interface ContextManager {
  /**
   * 为子 Agent 准备上下文（摘要 + 相关文件）
   */
  prepareSubagentContext(
    parentMessages: any[],
    request: SubagentRequest
  ): Promise<any[]>;

  /**
   * 将子 Agent 结果压缩后注入父 Agent
   */
  injectResult(
    parentMessages: any[],
    result: SubagentResult
  ): any[];
}

// ============ 工具权限策略 ============

export interface ToolPolicy {
  /**
   * 过滤工具列表
   */
  filterTools(
    allTools: any[],
    allowedToolNames?: string[]
  ): any[];

  /**
   * 检查工具调用是否允许
   */
  checkToolCall(
    toolName: string,
    args: any,
    context: { parentRunId: string; depth: number }
  ): Promise<boolean>;
}

// ============ 任务存储 ============

export interface TaskStore {
  /**
   * 保存子任务记录
   */
  saveTask(task: {
    runId: string;
    parentRunId: string;
    request: SubagentRequest;
    status: string;
    createdAt: number;
  }): Promise<void>;

  /**
   * 更新任务状态
   */
  updateTaskStatus(
    runId: string,
    status: string,
    result?: SubagentResult
  ): Promise<void>;

  /**
   * 加载未完成的任务（恢复用）
   */
  loadPendingTasks(parentRunId: string): Promise<SubagentRequest[]>;

  /**
   * 获取子任务历史（调试/审计用）
   */
  getTaskHistory(parentRunId: string): Promise<SubagentResult[]>;

  /**
   * 获取任务详情
   */
  getTask(runId: string): Promise<SubagentStatus | null>;
}

// ============ 内部运行状态（Runtime 内部使用）============

export interface SubagentRun {
  runId: string;
  request: SubagentRequest;
  status: SubagentStatus['status'];
  agent: any; // PlainAgent 实例
  abortController: AbortController;
  promise: Promise<SubagentResult>;
  result?: SubagentResult;
  error?: Error;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  depth: number; // 递归深度
}
