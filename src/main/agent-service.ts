/**
 * Agent 服务封装
 * 在主进程中实例化并管理 PlainAgent 生命周期
 * 支持多会话（每个会话一个 PlainAgent 实例），SQLite 持久化
 */

import { PlainAgent, SQLiteStorage, getBuiltinTools } from '../agent-core/index.js';
import type { AgentEvent, ChatMessage, LLMConfig, Session } from '../agent-core/types.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { SettingsStore } from './settings-store.js';
import type { AppSettings } from '../shared/desktop-api.js';

/**
 * 加载 .env 文件到 process.env
 * 开发环境从项目根目录读取，生产环境从 userData 目录读取
 */
export function loadEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    join(app.getPath('userData'), '.env'),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch (error) {
      console.error(`加载 .env 失败: ${envPath}`, error);
    }
  }
}

/**
 * 从配置构建 LLM 配置
 */
function buildLLMConfigFromSettings(settings: AppSettings): LLMConfig {
  return {
    provider: 'openai',
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: settings.baseUrl,
    maxTokens: settings.maxTokens,
  };
}

export class AgentService {
  private storage: SQLiteStorage;
  private settingsStore: SettingsStore;
  private settings: AppSettings;
  private agents = new Map<string, PlainAgent>();
  private currentSessionId: string | null = null;
  private onEventListeners = new Set<(event: AgentEvent) => void>();

  constructor() {
    // 加载环境变量（作为 fallback 层）
    loadEnv();

    // SQLite 持久化到 userData 目录
    const userDataDir = app.getPath('userData');
    mkdirSync(userDataDir, { recursive: true });
    const dbPath = join(userDataDir, 'plain-agent.db');
    this.storage = new SQLiteStorage(dbPath);

    // 加载用户配置（settings.json > .env > 默认值）
    this.settingsStore = new SettingsStore(userDataDir);
    this.settings = this.settingsStore.load();
  }

  /**
   * 创建指定会话的 agent 实例
   */
  private createAgent(sessionId: string): PlainAgent {
    const agent = new PlainAgent({
      llm: buildLLMConfigFromSettings(this.settings),
      tools: getBuiltinTools(),
      storage: this.storage,
      sessionId,
      permissionMode: this.settings.permissionMode,
      maxIterations: 150,
      historyManagement: {
        enabled: true,
        maxTokens: 8000,
        compressionThreshold: 6000,
        aggressiveThreshold: 10000,
        maxToolOutputLength: 1000,
        keepRecentMessages: 10,
      },
    });

    // 转发 agent 事件
    agent.on('event', (event: AgentEvent) => {
      this.onEventListeners.forEach(listener => listener(event));
    });

    this.agents.set(sessionId, agent);
    return agent;
  }

  /**
   * 获取当前会话的 agent 实例（不存在则创建新会话并持久化）
   */
  private getCurrentAgent(): PlainAgent {
    if (!this.currentSessionId || !this.agents.has(this.currentSessionId)) {
      // 创建新会话
      const sessionId = randomUUID();
      this.currentSessionId = sessionId;
      const agent = this.createAgent(sessionId);

      // 持久化会话记录（fire-and-forget，db 操作是同步的）
      this.storage.createSession(sessionId, '新会话').catch(err => {
        console.error('创建会话失败:', err);
      });

      return agent;
    }
    return this.agents.get(this.currentSessionId)!;
  }

  /**
   * 订阅 agent 事件
   * @returns 取消订阅函数
   */
  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.onEventListeners.add(listener);
    return () => this.onEventListeners.delete(listener);
  }

  // ============ 会话管理 ============

  /** 列出所有会话 */
  async listSessions(): Promise<Session[]> {
    return this.storage.listSessions();
  }

  /** 创建新会话 */
  async createSession(title: string): Promise<Session> {
    const agent = this.createAgent(randomUUID());
    this.currentSessionId = agent.getSessionId();
    await this.storage.createSession(agent.getSessionId(), title);

    return {
      id: agent.getSessionId(),
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'active',
    };
  }

  /** 切换到指定会话（自动加载历史） */
  async switchSession(sessionId: string): Promise<number> {
    const agent = this.agents.get(sessionId) || this.createAgent(sessionId);
    this.currentSessionId = sessionId;
    return agent.loadHistory();
  }

  /** 重命名会话 */
  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    await this.storage.renameSession(sessionId, newTitle);
  }

  /** 删除会话 */
  async deleteSession(sessionId: string): Promise<void> {
    // 删除存储中的数据
    await this.storage.deleteSession(sessionId);

    // 如果删除的是当前会话，清空当前会话
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

    // 销毁 agent 实例
    const agent = this.agents.get(sessionId);
    if (agent) {
      agent.destroy();
      this.agents.delete(sessionId);
    }
  }

  /** 获取当前会话 ID */
  getSessionId(): string {
    return this.getCurrentAgent().getSessionId();
  }

  // ============ 任务操作（委托给当前会话）============

  /** 提交任务 */
  async submit(task: string, taskId?: string): Promise<string> {
    return this.getCurrentAgent().submit(task, taskId);
  }

  /** 停止任务 */
  stop(taskId?: string): void {
    this.getCurrentAgent().stop(taskId);
  }

  /** 获取运行中的任务 ID */
  getRunningTasks(): string[] {
    return this.getCurrentAgent().getRunningTasks();
  }

  /** 获取消息历史 */
  getMessages(full = false): ChatMessage[] {
    return this.getCurrentAgent().getMessages(full);
  }

  /** 获取历史使用情况 */
  getHistoryUsage() {
    return this.getCurrentAgent().getHistoryUsage();
  }

  /** 加载当前会话历史 */
  async loadHistory(): Promise<number> {
    return this.getCurrentAgent().loadHistory();
  }

  /** 手动压缩历史 */
  async compressHistory(quick = false): Promise<void> {
    await this.getCurrentAgent().compressHistory(quick);
  }

  /** 获取当前配置（含是否已配置 API Key 的简略信息） */
  getConfig() {
    return {
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      hasApiKey: Boolean(this.settings.apiKey),
      permissionMode: this.settings.permissionMode,
    };
  }

  /** 获取完整配置（用于设置页展示） */
  getSettings(): AppSettings {
    return { ...this.settings };
  }

  /**
   * 更新配置
   * 保存到 settings.json，并重建所有 agent（LLM 配置变化需要重建）
   */
  async updateSettings(settings: AppSettings): Promise<void> {
    // 保存配置
    this.settings = { ...settings };
    this.settingsStore.save(this.settings);

    // 重建 agent（销毁旧的，配置变了）
    const oldSessionId = this.currentSessionId;
    this.agents.forEach(agent => agent.destroy());
    this.agents.clear();

    // 重建当前会话（如果存在）并恢复历史
    if (oldSessionId) {
      const agent = this.createAgent(oldSessionId);
      this.currentSessionId = oldSessionId;
      await agent.loadHistory();
    } else {
      this.currentSessionId = null;
    }
  }

  /** 销毁服务 */
  destroy(): void {
    this.agents.forEach(agent => agent.destroy());
    this.agents.clear();
    this.onEventListeners.clear();
  }
}
