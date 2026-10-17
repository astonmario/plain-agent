/**
 * API 客户端抽象层
 *
 * 定义统一接口，桌面端和 Web 端分别实现：
 * - DesktopClient：通过 Electron IPC 调用主进程
 * - WebClient：通过 HTTP + SSE 调用服务端
 */

import type { AgentEvent, Session, ChatMessage, InteractionQuestion } from '@plain-agent/domain/types';

/** 应用设置 */
export interface AppSettings {
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens?: number;
  permissionMode?: 'standard' | 'trust' | 'ask';
  proxy?: string;
  noProxy?: string;
  githubToken?: string; // 技能发现用
  /** 默认文件夹：启动时未选择工作区时自动使用（桌面端） */
  defaultWorkspace?: string;
  [key: string]: unknown;
}

/** 技能摘要 */
export interface SkillSummary {
  name: string;
  source: string;
  description?: string;
}

/** 技能详情 */
export interface SkillDetail extends SkillSummary {
  content: string;
  path?: string;
}

/** SSE 事件帧 */
export interface StreamFrame {
  seq: number;
  event: AgentEvent;
}

/** 应用配置信息 */
export interface AppConfig {
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  permissionMode: string;
}

/** 历史用量信息 */
export interface HistoryUsage {
  tokens: number;
  maxTokens: number;
  percentage: number;
  needsCompression: boolean;
}

/** 工作区信息 */
export interface Workspace {
  /** 工作区目录路径 */
  path: string;
  /** 工作区名称（目录名） */
  name: string;
}

/** 远程技能（技能发现） */
export interface RemoteSkillSummary {
  id: string;
  name: string;
  description: string;
  author: string;
  source: 'official' | 'community';
  sourceUrl: string;
  stars?: number;
  topics?: string[];
  installable: boolean;
}

export interface RemoteSkillDetail extends RemoteSkillSummary {
  readme: string;
}

/** 技能安装结果 */
export interface SkillInstallResult {
  ok: boolean;
  message: string;
}

/** 统一 API 客户端接口 */
export interface AgentClient {
  // ---- 会话管理 ----
  createSession(title: string): Promise<{ sessionId: string }>;
  listSessions(): Promise<Session[]>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string, full?: boolean): Promise<ChatMessage[]>;
  getEvents(sessionId: string): Promise<AgentEvent[]>;
  switchSession?(sessionId: string): Promise<number>; // 桌面端特有
  getSessionId?(): Promise<string>; // 桌面端特有

  // ---- 任务执行 ----
  /** 提交任务，返回 EventSource（SSE 流） */
  submitTask(sessionId: string, task: string): EventSource;
  /** 断线续传，返回 EventSource */
  reconnect(sessionId: string, since: number): EventSource;
  /** 停止任务 */
  stopTask(sessionId: string): Promise<void>;
  /** 压缩历史 */
  compactHistory(sessionId: string, quick?: boolean): Promise<void>;
  /** 回答交互问题 */
  answerInteraction(interactionId: string, answers: string[]): Promise<void>;

  // ---- 配置与状态 ----
  getConfig?(): Promise<AppConfig>; // 桌面端特有
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<void>;
  getHistoryUsage?(): Promise<HistoryUsage>; // 桌面端特有

  // ---- 技能管理 ----
  listSkills(): Promise<SkillSummary[]>;
  getSkill(name: string): Promise<SkillDetail>;
  saveSkill(name: string, content: string): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  readSkill?(name: string): Promise<SkillDetail | null>; // 桌面端特有

  // ---- 技能发现（桌面端特有；未实现时界面不显示入口） ----
  searchRemoteSkills?(query: string): Promise<RemoteSkillSummary[]>;
  getRemoteSkillDetail?(id: string): Promise<RemoteSkillDetail>;
  installRemoteSkill?(id: string, target: 'global' | 'project'): Promise<SkillInstallResult>;

  // ---- 工作区（桌面端特有；未实现时界面不显示入口） ----
  getWorkspace?(): Promise<Workspace | null>;
  /** 打开目录选择对话框；用户取消返回 null */
  selectWorkspace?(): Promise<Workspace | null>;
  clearWorkspace?(): Promise<void>;
  /** 只选择目录并返回路径（用于“默认文件夹”设置，不改变当前工作区） */
  pickFolder?(): Promise<string | null>;

  // ---- MCP 配置 ----
  getMcpConfig(): Promise<Record<string, unknown>>;
  saveMcpConfig(config: Record<string, unknown>): Promise<void>;
  getMcpToolCount?(): Promise<number>; // 桌面端特有
  getMcpTools?(): Promise<Array<{ name: string; description: string }>>; // 桌面端特有
  reloadMcp?(): Promise<void>; // 桌面端特有

  // ---- 事件订阅（桌面端特有，Web 端通过 EventSource） ----
  onEvent?(callback: (event: AgentEvent) => void): () => void;

  // ---- 清理 ----
  destroy(): void;
}
