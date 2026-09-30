/**
 * Agent Core 统一导出
 */

export { PlainAgent } from './agent';
export { agentLoop } from './loop';
export { callLLM, streamLLM, ToolCallAccumulator } from './llm';
export { SQLiteStorage, MemoryStorage } from './storage';
export { getBuiltinTools, readFileTool, writeFileTool, bashTool } from './tools';
export {
  webFetchTool,
  webSearchTool,
  browserUseTool,
  askQuestionTool,
  useSkillTool,
  createSkillTool,
} from './tools';
export {
  loadMcpTools,
  loadProjectMcp,
  closeIdleConnections,
  resetPool,
  poolStats,
} from './mcp';
export { applyProxyConfig } from './proxy';
export {
  registerInteraction,
  unregisterInteraction,
  submitInteractionAnswer,
  pendingInteractionCount,
  hasPendingInteraction,
} from './interactions';
export {
  discoverSkills,
  skillsCatalogPrompt,
  globalSkillsDir,
  projectSkillsDir,
  SKILL_NAME_RE,
  listUserSkills,
  readUserSkill,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
} from './skills';
export { HistoryManager, estimateTokens } from './history-manager';
export { AnchorManager } from './anchor';
export { CompressionTrigger } from './compression-trigger';
export { DEFAULT_SYSTEM_PROMPT } from './prompt';

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
  PersistedJob,
  PermissionMode,
  HistoryManagementConfig,
  InteractionQuestion,
  SkillEntry,
} from './types';

export type { HistoryConfig } from './history-manager';
export type { ConversationAnchor } from './anchor';
export type { SessionHealth } from './compression-trigger';
export type { SkillCrudResult } from './skills';
export type {
  McpServerConfig,
  StdioServerConfig,
  SseServerConfig,
  McpManager,
} from './mcp';
