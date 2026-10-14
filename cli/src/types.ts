/**
 * TUI 消息类型定义
 */

export enum MessageType {
  SYSTEM = 'SYSTEM',
  USER = 'USER',
  TOOL = 'TOOL',
  ITERATION = 'ITERATION',
  ASSISTANT = 'ASSISTANT',
  THINKING = 'THINKING',
  ERROR = 'ERROR',
  WARNING = 'WARNING',
}

export interface Message {
  id: string;
  type: MessageType;
  content: string;
  timestamp: number;
  /** 回复中解析出的可选项（options 代码块），仅 ASSISTANT 消息可能有 */
  options?: string[];
}

/** 工具调用状态 */
export type ToolCallStatus = 'running' | 'success' | 'error';

/** 工具调用信息 */
export interface ToolCall {
  id: string;
  /** LLM 的 tool_call.id，用于并发工具的 start/result 精确配对 */
  callId?: string;
  tool: string;
  args: Record<string, unknown>;
  description?: string;
  result?: string;
  resultSummary?: string;
  duration?: number;
  status: ToolCallStatus;
}
