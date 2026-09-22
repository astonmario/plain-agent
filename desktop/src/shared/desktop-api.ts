/**
 * 桌面端 IPC 共享类型
 * preload 和 renderer 共同引用，避免跨环境依赖
 */

import type { AgentEvent, ChatMessage, Session } from '@plain-agent/domain/types';
import type { McpServerConfig } from '@plain-agent/domain';

export interface HistoryUsageInfo {
  tokens: number;
  maxTokens: number;
  percentage: number;
  needsCompression: boolean;
}

export interface AgentConfigInfo {
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  permissionMode: string;
}

export interface AppSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
  permissionMode: 'standard' | 'trust' | 'ask';
}

/** 技能列表项（不含磁盘路径） */
export interface SkillSummary {
  name: string;
  description: string;
}

/** 技能详情（编辑用） */
export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface SkillSaveResult {
  ok: boolean;
  message: string;
}

/** MCP 工具信息 */
export interface McpToolInfo {
  name: string;
  description: string;
}

export interface DesktopAPI {
  // 任务
  submit(task: string, taskId?: string): Promise<string>;
  stop(taskId?: string): Promise<void>;
  getRunningTasks(): Promise<string[]>;
  /** 回答 ask_question 工具的提问（唤醒挂起的 agent loop） */
  answerInteraction(id: string, answers: string[]): Promise<void>;

  // 会话
  getSessionId(): Promise<string>;
  listSessions(): Promise<Session[]>;
  createSession(title: string): Promise<Session>;
  switchSession(sessionId: string): Promise<number>;
  renameSession(sessionId: string, newTitle: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(full?: boolean): Promise<ChatMessage[]>;
  getHistoryUsage(): Promise<HistoryUsageInfo>;
  loadHistory(): Promise<number>;
  compressHistory(quick?: boolean): Promise<void>;

  // 配置
  getConfig(): Promise<AgentConfigInfo>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<void>;

  // MCP 管理
  getMcpConfig(): Promise<Record<string, McpServerConfig>>;
  saveMcpConfig(config: Record<string, McpServerConfig>): Promise<void>;
  reloadMcp(): Promise<void>;
  getMcpTools(): Promise<McpToolInfo[]>;
  getMcpToolCount(): Promise<number>;

  // 技能管理（只操作用户全局技能目录，不碰项目级）
  listSkills(): Promise<SkillSummary[]>;
  readSkill(name: string): Promise<SkillDetail | null>;
  /** 存在则更新、不存在则新建 */
  saveSkill(input: SkillDetail): Promise<SkillSaveResult>;
  deleteSkill(name: string): Promise<SkillSaveResult>;

  // 事件订阅
  onEvent(callback: (event: AgentEvent) => void): () => void;
}
