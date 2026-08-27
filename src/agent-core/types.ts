/**
 * Agent Core 类型定义
 * 完全独立于运行环境，不依赖 Electron、HTTP 等
 */

// ============ LLM 相关类型 ============

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

// ============ Agent 事件类型 ============

export type AgentEvent =
  | { type: 'user'; message: string; timestamp: number }
  | { type: 'task-start'; taskId: string; task: string; timestamp: number }
  | { type: 'task-end'; taskId: string; timestamp: number }
  | { type: 'iteration'; index: number; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_start'; tool: string; args: any; timestamp: number }
  | { type: 'tool_result'; tool: string; result: string; duration: number; timestamp: number }
  | { type: 'assistant'; message: string; timestamp: number }
  | { type: 'error'; error: SerializedError; timestamp: number }
  | { type: 'done'; result: string; timestamp: number }
  | { type: 'stopped'; timestamp: number }
  | { type: 'compression'; level: 1 | 2 | 3; tokensBefore: number; tokensAfter: number; timestamp: number }
  | { type: 'session-warning'; reason: 'too-long' | 'frequent-compression'; suggestion: string; timestamp: number };

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

// ============ 工具系统类型 ============

export interface Tool {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
  meta?: ToolMeta;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ToolMeta {
  readonly?: boolean;      // 只读操作（可并发）
  concurrent?: boolean;     // 是否支持并发执行
  dangerous?: boolean;      // 危险操作（需要权限确认）
  tags?: string[];          // 工具标签
}

export interface ToolContext {
  signal: AbortSignal;
  sessionId: string;
  emitEvent: (event: AgentEvent) => void;
  storage?: SessionStorage;
  permissionCheck?: (tool: Tool, args: any) => Promise<boolean>;
  /** bash 后台任务注册表（JobRegistry）；undefined = 后台任务不可用 */
  jobs?: any;
  /** Windows 上 Git Bash 路径（可选，用于 bash 工具） */
  gitBashPath?: string;
}

// ============ 存储接口（依赖倒置）============

export interface SessionStorage {
  saveMessage(sessionId: string, message: ChatMessage): Promise<void>;
  loadMessages(sessionId: string): Promise<ChatMessage[]>;
  saveEvent(sessionId: string, event: AgentEvent): Promise<void>;
  loadEvents(sessionId: string): Promise<AgentEvent[]>;
  createSession(sessionId: string, title: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  renameSession(sessionId: string, newTitle: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'archived';
}

// ============ Agent 配置 ============

export interface AgentConfig {
  llm: LLMConfig;
  tools: Tool[];
  maxIterations?: number;
  sessionId?: string;
  storage?: SessionStorage;
  permissionMode?: 'standard' | 'trust' | 'ask';
  historyManagement?: HistoryManagementConfig;
}

// ============ 消息历史管理配置 ============

export interface HistoryManagementConfig {
  enabled?: boolean;               // 是否启用历史管理（默认 true）
  maxTokens?: number;              // 最大 token 数（默认 8000）
  maxToolOutputLength?: number;    // 单个工具输出最大长度（默认 1000）
  keepRecentMessages?: number;     // 保留最近 N 条消息（默认 10）
  compressionThreshold?: number;   // 触发第二层压缩的 token 阈值（默认 6000）
  aggressiveThreshold?: number;    // 触发第三层激进压缩的阈值（默认 10000）
  autoCompress?: boolean;          // 是否自动压缩（默认 true）
}

// ============ Agent 执行结果 ============

export interface AgentLoopResult {
  result: string;
  messages: ChatMessage[];
  stopReason: 'completed' | 'stopped' | 'max_iterations' | 'error';
}

// ============ 权限相关 ============

export type PermissionMode = 'standard' | 'trust' | 'ask';

export interface PermissionContext {
  mode: PermissionMode;
  sessionCache: Set<string>; // 本会话已允许的工具调用
}
