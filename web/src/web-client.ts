/**
 * Web 端 API 客户端（HTTP + SSE）
 *
 * 通过 HTTP 请求和 Server-Sent Events 与服务端通信
 */

import type { AgentClient, AppSettings, SkillSummary, SkillDetail, StreamFrame } from './api-client';
import type { AgentEvent, Session, ChatMessage } from '@plain-agent/domain/types';

export class WebClient implements AgentClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // 去掉尾部斜杠
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ---- 会话管理 ----

  async createSession(title: string): Promise<{ sessionId: string }> {
    return this.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  async listSessions(): Promise<Session[]> {
    const data = await this.fetch<{ sessions: Session[] }>('/api/sessions');
    return data.sessions;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const data = await this.fetch<{ messages: ChatMessage[] }>(`/api/sessions/${sessionId}/messages`);
    return data.messages;
  }

  async getEvents(sessionId: string): Promise<AgentEvent[]> {
    const data = await this.fetch<{ events: AgentEvent[] }>(`/api/sessions/${sessionId}/events`);
    return data.events;
  }

  // ---- 任务执行 ----

  submitTask(sessionId: string, task: string): EventSource {
    // POST /api/sessions/:id/run 返回 SSE 流
    const url = `${this.baseUrl}/api/sessions/${sessionId}/run`;

    // 注意：EventSource 只支持 GET，需要特殊处理 POST
    // 方案：先 POST 任务，然后立即 GET stream
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    }).catch(err => {
      console.error('Failed to submit task:', err);
    });

    // 立即建立 SSE 连接（服务端会缓冲事件）
    return new EventSource(`${this.baseUrl}/api/sessions/${sessionId}/stream?since=-1`);
  }

  reconnect(sessionId: string, since: number): EventSource {
    return new EventSource(`${this.baseUrl}/api/sessions/${sessionId}/stream?since=${since}`);
  }

  async stopTask(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
  }

  async compactHistory(sessionId: string): Promise<void> {
    await this.fetch(`/api/sessions/${sessionId}/compact`, { method: 'POST' });
  }

  async answerInteraction(interactionId: string, answers: string[]): Promise<void> {
    // 需要找到对应的 sessionId，这里假设前端维护了 sessionId
    // 实际实现中可能需要调整 API 设计
    await this.fetch(`/api/sessions/current/interact`, {
      method: 'POST',
      body: JSON.stringify({ interactionId, answers }),
    });
  }

  // ---- 设置与技能 ----
  // 注意：这些接口目前服务端可能没有实现，需要后续添加

  async getSettings(): Promise<AppSettings> {
    // TODO: 服务端需要添加 /api/settings 端点
    return this.fetch('/api/settings');
  }

  async updateSettings(settings: Partial<AppSettings>): Promise<void> {
    await this.fetch('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  }

  async listSkills(): Promise<SkillSummary[]> {
    const data = await this.fetch<{ skills: SkillSummary[] }>('/api/skills');
    return data.skills;
  }

  async getSkill(name: string): Promise<SkillDetail> {
    return this.fetch(`/api/skills/${encodeURIComponent(name)}`);
  }

  async saveSkill(name: string, content: string): Promise<void> {
    await this.fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  }

  async deleteSkill(name: string): Promise<void> {
    await this.fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  // ---- MCP 配置 ----

  async getMcpConfig(): Promise<Record<string, unknown>> {
    return this.fetch('/api/mcp/config');
  }

  async saveMcpConfig(config: Record<string, unknown>): Promise<void> {
    await this.fetch('/api/mcp/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  }

  // ---- 清理 ----

  destroy(): void {
    // Web 客户端无需清理资源
  }
}
