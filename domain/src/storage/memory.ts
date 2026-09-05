/**
 * 内存存储适配器（用于测试和 CLI）
 */

import type { SessionStorage, Session, ChatMessage, AgentEvent } from '../types';

export class MemoryStorage implements SessionStorage {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, ChatMessage[]>();
  private events = new Map<string, AgentEvent[]>();

  async createSession(sessionId: string, title: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      const now = Date.now();
      this.sessions.set(sessionId, {
        id: sessionId,
        title,
        createdAt: now,
        updatedAt: now,
        status: 'active',
      });
    }
  }

  async saveMessage(sessionId: string, message: ChatMessage): Promise<void> {
    await this.createSession(sessionId, 'Untitled');

    const msgs = this.messages.get(sessionId) || [];
    msgs.push(message);
    this.messages.set(sessionId, msgs);

    // 更新会话时间
    const session = this.sessions.get(sessionId);
    if (session) {
      session.updatedAt = Date.now();
    }
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.messages.get(sessionId) || [];
  }

  async saveEvent(sessionId: string, event: AgentEvent): Promise<void> {
    await this.createSession(sessionId, 'Untitled');

    const evts = this.events.get(sessionId) || [];
    evts.push(event);
    this.events.set(sessionId, evts);
  }

  async loadEvents(sessionId: string): Promise<AgentEvent[]> {
    return this.events.get(sessionId) || [];
  }

  async listSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.title = newTitle;
      session.updatedAt = Date.now();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    this.events.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.messages.clear();
    this.events.clear();
  }
}
