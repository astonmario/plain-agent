/**
 * 桌面端 API 客户端（Electron IPC）
 *
 * 将 window.desktopAPI 包装成统一的 AgentClient 接口
 */

import type {
  AgentClient,
  AppSettings,
  SkillSummary,
  SkillDetail,
  AppConfig,
  HistoryUsage,
  Workspace,
  RemoteSkillSummary,
  RemoteSkillDetail,
  SkillInstallResult,
} from './api-client';
import type { AgentEvent, Session, ChatMessage } from '@plain-agent/domain/types';

/** 桌面端 IPC API（preload 暴露在 window.api 上；完整定义见 desktop/src/shared/desktop-api.ts） */
interface DesktopAPI {
  submit(task: string, taskId?: string): Promise<string>;
  stop(taskId?: string): Promise<void>;
  answerInteraction(id: string, answers: string[]): Promise<void>;
  getSessionId(): Promise<string>;
  listSessions(): Promise<Session[]>;
  createSession(title: string): Promise<Session>;
  switchSession(sessionId: string): Promise<number>;
  renameSession(sessionId: string, newTitle: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(full?: boolean): Promise<ChatMessage[]>;
  compressHistory(quick?: boolean): Promise<void>;
  getConfig(): Promise<AppConfig>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<void>;
  getHistoryUsage(): Promise<HistoryUsage>;
  getMcpConfig(): Promise<Record<string, unknown>>;
  saveMcpConfig(config: Record<string, unknown>): Promise<void>;
  reloadMcp(): Promise<void>;
  getMcpTools(): Promise<Array<{ name: string; description: string }>>;
  getMcpToolCount(): Promise<number>;
  listSkills(): Promise<SkillSummary[]>;
  readSkill(name: string): Promise<SkillDetail | null>;
  saveSkill(input: SkillDetail): Promise<{ ok: boolean; message: string }>;
  deleteSkill(name: string): Promise<{ ok: boolean; message: string }>;
  searchRemoteSkills(query: string): Promise<RemoteSkillSummary[]>;
  getRemoteSkillDetail(id: string): Promise<RemoteSkillDetail>;
  installRemoteSkill(id: string, target: 'global' | 'project'): Promise<SkillInstallResult>;
  getWorkspace(): Promise<Workspace | null>;
  selectWorkspace(): Promise<Workspace | null>;
  clearWorkspace(): Promise<void>;
  onEvent(callback: (event: AgentEvent) => void): () => void;
}

export class DesktopClient implements AgentClient {
  private api: DesktopAPI;

  constructor() {
    // 不声明全局 Window.api：桌面端 env.d.ts 已用完整类型声明，重复声明会类型冲突
    const api = (window as unknown as { api?: DesktopAPI }).api;
    if (!api) {
      throw new Error('desktopAPI not available. Are you running in Electron?');
    }
    this.api = api;
  }

  // ---- 会话管理 ----

  async createSession(title: string): Promise<{ sessionId: string }> {
    const session = await this.api.createSession(title);
    return { sessionId: session.id };
  }

  async listSessions(): Promise<Session[]> {
    return this.api.listSessions();
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.api.renameSession(sessionId, title);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.api.deleteSession(sessionId);
  }

  async getMessages(sessionId: string, full?: boolean): Promise<ChatMessage[]> {
    const currentSessionId = await this.api.getSessionId();
    if (currentSessionId !== sessionId) {
      await this.api.switchSession(sessionId);
    }
    return this.api.getMessages(full);
  }

  async getEvents(_sessionId: string): Promise<AgentEvent[]> {
    return [];
  }

  async switchSession(sessionId: string): Promise<number> {
    return this.api.switchSession(sessionId);
  }

  async getSessionId(): Promise<string> {
    return this.api.getSessionId();
  }

  // ---- 任务执行 ----

  submitTask(_sessionId: string, task: string): EventSource {
    const eventTarget = new EventTarget();

    this.api.submit(task).catch((err) => {
      const errorEvent = new MessageEvent('message', {
        data: JSON.stringify({
          seq: 0,
          event: { type: 'error', error: err.message, timestamp: Date.now() },
        }),
      });
      eventTarget.dispatchEvent(errorEvent);
    });

    return eventTarget as unknown as EventSource;
  }

  reconnect(sessionId: string, _since: number): EventSource {
    return this.submitTask(sessionId, '');
  }

  async stopTask(_sessionId: string): Promise<void> {
    await this.api.stop();
  }

  async compactHistory(_sessionId: string, quick?: boolean): Promise<void> {
    await this.api.compressHistory(quick);
  }

  async answerInteraction(interactionId: string, answers: string[]): Promise<void> {
    await this.api.answerInteraction(interactionId, answers);
  }

  // ---- 配置与状态 ----

  async getConfig(): Promise<AppConfig> {
    return this.api.getConfig();
  }

  async getSettings(): Promise<AppSettings> {
    return this.api.getSettings();
  }

  async updateSettings(settings: Partial<AppSettings>): Promise<void> {
    const current = await this.api.getSettings();
    await this.api.updateSettings({ ...current, ...settings });
  }

  async getHistoryUsage(): Promise<HistoryUsage> {
    return this.api.getHistoryUsage();
  }

  // ---- 技能管理 ----

  async listSkills(): Promise<SkillSummary[]> {
    return this.api.listSkills();
  }

  async getSkill(name: string): Promise<SkillDetail> {
    const skill = await this.api.readSkill(name);
    if (!skill) {
      throw new Error(`Skill not found: ${name}`);
    }
    return skill;
  }

  async readSkill(name: string): Promise<SkillDetail | null> {
    return this.api.readSkill(name);
  }

  async saveSkill(name: string, content: string): Promise<void> {
    const result = await this.api.saveSkill({ name, content, description: '', source: 'user' });
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  async deleteSkill(name: string): Promise<void> {
    const result = await this.api.deleteSkill(name);
    if (!result.ok) {
      throw new Error(result.message);
    }
  }

  // ---- MCP 配置 ----

  async getMcpConfig(): Promise<Record<string, unknown>> {
    return this.api.getMcpConfig();
  }

  async saveMcpConfig(config: Record<string, unknown>): Promise<void> {
    await this.api.saveMcpConfig(config);
  }

  async reloadMcp(): Promise<void> {
    await this.api.reloadMcp();
  }

  async getMcpTools(): Promise<Array<{ name: string; description: string }>> {
    return this.api.getMcpTools();
  }

  async getMcpToolCount(): Promise<number> {
    return this.api.getMcpToolCount();
  }

  // ---- 技能发现 ----

  async searchRemoteSkills(query: string): Promise<RemoteSkillSummary[]> {
    return this.api.searchRemoteSkills(query);
  }

  async getRemoteSkillDetail(id: string): Promise<RemoteSkillDetail> {
    return this.api.getRemoteSkillDetail(id);
  }

  async installRemoteSkill(id: string, target: 'global' | 'project'): Promise<SkillInstallResult> {
    return this.api.installRemoteSkill(id, target);
  }

  // ---- 工作区 ----

  async getWorkspace(): Promise<Workspace | null> {
    return this.api.getWorkspace();
  }

  async selectWorkspace(): Promise<Workspace | null> {
    return this.api.selectWorkspace();
  }

  async clearWorkspace(): Promise<void> {
    await this.api.clearWorkspace();
  }

  // ---- 事件订阅 ----

  onEvent(callback: (event: AgentEvent) => void): () => void {
    return this.api.onEvent(callback);
  }

  // ---- 清理 ----

  destroy(): void {
    // 桌面端无需清理
  }
}
