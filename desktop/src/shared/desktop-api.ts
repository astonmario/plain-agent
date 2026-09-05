/**
 * 桌面端 IPC 共享类型
 * preload 和 renderer 共同引用，避免跨环境依赖
 */

import type { AgentEvent, ChatMessage, Session } from '@plain-agent/domain/types';

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

export interface DesktopAPI {
  // 任务
  submit(task: string, taskId?: string): Promise<string>;
  stop(taskId?: string): Promise<void>;
  getRunningTasks(): Promise<string[]>;

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

  // 事件订阅
  onEvent(callback: (event: AgentEvent) => void): () => void;
}
