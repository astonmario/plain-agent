/**
 * Agent 服务封装
 * 在主进程中实例化并管理 PlainAgent 生命周期
 * 支持多会话（每个会话一个 PlainAgent 实例），SQLite 持久化
 */

import { PlainAgent, SQLiteStorage, getBuiltinTools, loadMcpTools, loadProjectMcp, applyProxyConfig } from '@plain-agent/domain';
import type { AgentEvent, ChatMessage, LLMConfig, Session, Tool, McpServerConfig } from '@plain-agent/domain';
import { createSkillDiscovery, installRemoteSkill } from '@plain-agent/domain';
import type { RemoteSkill, RemoteSkillDetail, SkillInstallOptions } from '@plain-agent/domain';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { SettingsStore } from './settings-store.js';
import type { AppSettings, RemoteSkillSummary, RemoteSkillDetail as DesktopRemoteSkillDetail } from '../shared/desktop-api.js';
import * as yaml from 'js-yaml';

/**
 * 加载 .env 文件到 process.env
 * 依次尝试：进程 cwd（根目录启动时）→ 仓库根目录（monorepo 下从 desktop 包启动时）→ userData 目录（生产环境）
 */
export function loadEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    // pnpm --filter 启动时 cwd 是 desktop/，仓库根目录的 .env 在上一级
    join(app.getAppPath(), '..', '.env'),
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
  private mcpTools: Tool[] = [];
  private mcpCleanup: (() => Promise<void>) | null = null;
  private userDataDir: string;
  private currentWorkspace: { path: string; name: string } | null = null;

  constructor() {
    // 加载环境变量（作为 fallback 层）
    loadEnv();

    // SQLite 持久化到 userData 目录
    // 开发环境使用独立子目录，避免和生产环境数据混淆
    this.userDataDir = app.getPath('userData');
    if (process.env.ELECTRON_IS_DEV === 'true') {
      this.userDataDir = join(this.userDataDir, 'dev');
    }
    mkdirSync(this.userDataDir, { recursive: true });
    const dbPath = join(this.userDataDir, 'plain-agent.db');
    this.storage = new SQLiteStorage(dbPath);

    // 加载用户配置（settings.json > .env > 默认值）
    this.settingsStore = new SettingsStore(this.userDataDir);
    this.settings = this.settingsStore.load();

    // 加载 MCP 工具
    void this.loadMcp();
  }

  /**
   * 加载 MCP 工具
   */
  private async loadMcp(): Promise<void> {
    try {
      const mcpConfigPath = join(this.userDataDir, 'mcp.yaml');
      let mcpConfig: Record<string, McpServerConfig> = {};

      if (existsSync(mcpConfigPath)) {
        const content = readFileSync(mcpConfigPath, 'utf-8');
        mcpConfig = (yaml.load(content) as Record<string, McpServerConfig>) || {};
      }

      if (Object.keys(mcpConfig).length > 0) {
        console.log('[MCP] 加载 MCP 服务器...');
        const mcpManager = await loadMcpTools(mcpConfig);
        this.mcpTools = mcpManager.tools;
        this.mcpCleanup = mcpManager.cleanup;
        console.log(`[MCP] 已加载 ${this.mcpTools.length} 个 MCP 工具`);
      }
    } catch (err) {
      console.warn('[MCP] 加载失败:', (err as Error).message);
      this.mcpTools = [];
      this.mcpCleanup = null;
    }
  }

  /**
   * 重新加载 MCP 配置
   */
  async reloadMcp(): Promise<void> {
    // 清理旧连接
    if (this.mcpCleanup) {
      await this.mcpCleanup();
      this.mcpCleanup = null;
    }
    this.mcpTools = [];

    // 重新加载
    await this.loadMcp();

    // 重新创建所有 agent 实例以使用新工具
    const sessions = Array.from(this.agents.keys());
    this.agents.clear();
    for (const sid of sessions) {
      this.agents.set(sid, this.createAgent(sid));
    }
  }

  /**
   * 创建指定会话的 agent 实例
   */
  private createAgent(sessionId: string): PlainAgent {
    // 应用代理配置（每次创建 agent 时应用，支持运行时修改）
    applyProxyConfig(this.settings.proxy, this.settings.noProxy);

    const llmConfig = buildLLMConfigFromSettings(this.settings);

    const agent = new PlainAgent({
      llm: llmConfig,
      tools: [...getBuiltinTools(), ...this.mcpTools],
      enableSubagents: true,
      subagentConfig: {
        maxConcurrency: 3,
        maxDepth: 2,
      },
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

    // 转发 agent 事件（隔离错误，防止单个监听器异常影响其他监听器）
    agent.on('event', (event: AgentEvent) => {
      this.onEventListeners.forEach(listener => {
        try {
          listener(event);
        } catch (err) {
          console.error('[AgentService] Event listener error:', err);
        }
      });
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
    const agent = this.getCurrentAgent();
    // 首次对话后用第一个问题自动命名会话（fire-and-forget）
    this.maybeAutoRenameSession(agent.getSessionId(), task);
    return agent.submit(task, taskId);
  }

  /**
   * 首次对话后自动命名：会话标题仍为默认值时，用第一条用户消息命名
   */
  private async maybeAutoRenameSession(sessionId: string, firstMessage: string): Promise<void> {
    try {
      const sessions = await this.storage.listSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      // 已有自定义标题则不覆盖
      if (session.title && session.title !== '新会话') return;

      const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!title) return;

      await this.storage.renameSession(sessionId, title);
    } catch (error) {
      console.error('自动命名会话失败:', error);
    }
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

  // ============ MCP 管理 ============

  /**
   * 获取 MCP 配置
   */
  getMcpConfig(): Record<string, McpServerConfig> {
    try {
      const mcpConfigPath = join(this.userDataDir, 'mcp.yaml');
      if (!existsSync(mcpConfigPath)) {
        return {};
      }
      const content = readFileSync(mcpConfigPath, 'utf-8');
      return (yaml.load(content) as Record<string, McpServerConfig>) || {};
    } catch (err) {
      console.error('[MCP] 读取配置失败:', err);
      return {};
    }
  }

  /**
   * 保存 MCP 配置
   */
  async saveMcpConfig(config: Record<string, McpServerConfig>): Promise<void> {
    try {
      const mcpConfigPath = join(this.userDataDir, 'mcp.yaml');
      const content = yaml.dump(config);
      writeFileSync(mcpConfigPath, content, 'utf-8');
      console.log('[MCP] 配置已保存');
    } catch (err) {
      console.error('[MCP] 保存配置失败:', err);
      throw err;
    }
  }

  /**
   * 获取已加载的 MCP 工具列表
   */
  getMcpTools(): Array<{ name: string; description: string }> {
    return this.mcpTools.map(t => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * 获取 MCP 工具数量
   */
  getMcpToolCount(): number {
    return this.mcpTools.length;
  }

  // ============ 技能发现 ============

  /**
   * 搜索远程技能
   */
  async searchRemoteSkills(query: string): Promise<RemoteSkillSummary[]> {
    const client = createSkillDiscovery(this.settings.githubToken);
    const result = await client.search(query, { limit: 20 });
    return result.skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      author: skill.author,
      source: skill.source,
      sourceUrl: skill.sourceUrl,
      stars: skill.stars,
      topics: skill.topics,
      installable: skill.installable,
    }));
  }

  /**
   * 获取远程技能详情
   */
  async getRemoteSkillDetail(id: string): Promise<DesktopRemoteSkillDetail> {
    const client = createSkillDiscovery(this.settings.githubToken);
    const detail = await client.getDetail(id);
    return {
      id: detail.id,
      name: detail.name,
      description: detail.description,
      author: detail.author,
      source: detail.source,
      sourceUrl: detail.sourceUrl,
      stars: detail.stars,
      topics: detail.topics,
      installable: detail.installable,
      readme: detail.readme,
    };
  }

  /**
   * 安装远程技能
   */
  async installRemoteSkill(id: string, target: 'global' | 'project'): Promise<{ ok: boolean; message: string }> {
    const client = createSkillDiscovery(this.settings.githubToken);
    const detail = await client.getDetail(id);

    const options: SkillInstallOptions = {
      target,
      projectDir: target === 'project' ? this.currentWorkspace?.path : undefined,
    };

    const result = await installRemoteSkill(detail, options);
    return {
      ok: result.ok,
      message: result.message,
    };
  }

  // ============ 工作区管理 ============

  /**
   * 获取当前工作区
   */
  getWorkspace(): { path: string; name: string } | null {
    return this.currentWorkspace;
  }

  /**
   * 设置工作区
   */
  setWorkspace(path: string): { path: string; name: string } {
    const name = path.split(/[/\\]/).filter(Boolean).pop() || 'workspace';
    this.currentWorkspace = { path, name };
    return this.currentWorkspace;
  }

  /**
   * 清除工作区
   */
  clearWorkspace(): void {
    this.currentWorkspace = null;
  }

  /** 销毁服务 */
  destroy(): void {
    this.agents.forEach(agent => agent.destroy());
    this.agents.clear();
    this.onEventListeners.clear();

    // 清理 MCP 连接
    if (this.mcpCleanup) {
      void this.mcpCleanup();
    }
  }
}
