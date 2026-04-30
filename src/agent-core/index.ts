/**
 * Agent Core 统一导出
 */

export { PlainAgent } from './agent';
export { agentLoop } from './loop';
export { callLLM, streamLLM, ToolCallAccumulator } from './llm';
export { SQLiteStorage, MemoryStorage } from './storage';
export { getBuiltinTools, readFileTool, writeFileTool, bashTool } from './tools';
export { HistoryManager, estimateTokens } from './history-manager';
export { AnchorManager } from './anchor';
export { CompressionTrigger } from './compression-trigger';

export type {
  AgentConfig,
  AgentEvent,
  AgentLoopResult,
  ChatMessage,
  LLMConfig,
  Tool,
  ToolSchema,
  ToolContext,
  ToolMeta,
  SessionStorage,
  Session,
  PermissionMode,
  HistoryManagementConfig,
} from './types';

export type { HistoryConfig } from './history-manager';
export type { ConversationAnchor } from './anchor';
export type { SessionHealth } from './compression-trigger';
