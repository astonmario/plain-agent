/**
 * 内存存储适配器（用于测试和 CLI）
 */

import type { SessionStorage, Session, ChatMessage, AgentEvent, PersistedJob } from '../types';
import type { SessionPreferences } from '../session-preferences';
import { hasPreferences } from '../session-preferences';
import { MemoryTaskStore } from '../tasks';
import type { TaskStore } from '../tasks';

export class MemoryStorage implements SessionStorage {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, ChatMessage[]>();
  private events = new Map<string, AgentEvent[]>();
  private jobs = new Map<string, Map<string, PersistedJob>>();
  private preferences = new Map<string, SessionPreferences>();
  private taskStore = new MemoryTaskStore();

  getTaskStore(): TaskStore {
    return this.taskStore;
  }

  async createSession(sessionId: string, title: string, workspace?: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      const now = Date.now();
      this.sessions.set(sessionId, {
        id: sessionId,
        title,
        createdAt: now,
        updatedAt: now,
        status: 'active',
        workspace,
      });
    }
  }

  async getSessionWorkspace(sessionId: string): Promise<string | null> {
    return this.sessions.get(sessionId)?.workspace ?? null;
  }

  async setSessionWorkspace(sessionId: string, workspace: string | null): Promise<void> {
    await this.createSession(sessionId, 'Untitled');
    const session = this.sessions.get(sessionId);
    if (session) {
      session.workspace = workspace ?? undefined;
      session.updatedAt = Date.now();
    }
  }

  private messageKey(sessionId: string, taskId?: string): string {
    return `${sessionId}\u0000${taskId ?? ''}`;
  }

  async saveMessage(sessionId: string, message: ChatMessage, taskId?: string): Promise<void> {
    await this.createSession(sessionId, 'Untitled');

    const key = this.messageKey(sessionId, taskId);
    const msgs = this.messages.get(key) || [];
    msgs.push(message);
    this.messages.set(key, msgs);

    // 更新会话时间
    const session = this.sessions.get(sessionId);
    if (session) {
      session.updatedAt = Date.now();
    }
  }

  async loadMessages(sessionId: string, taskId?: string): Promise<ChatMessage[]> {
    return this.messages.get(this.messageKey(sessionId, taskId)) || [];
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
    const tasks = await this.taskStore.listTasks({ sessionId });
    const childSessions = new Set<string>();
    for (const root of tasks) {
      for (const member of await this.taskStore.listTasks({ rootId: root.rootId })) {
        if (member.sessionId !== sessionId) childSessions.add(member.sessionId);
      }
    }
    for (const childSession of childSessions) {
      this.sessions.delete(childSession);
      for (const key of this.messages.keys()) {
        if (key.startsWith(`${childSession}\u0000`)) this.messages.delete(key);
      }
      this.events.delete(childSession);
      this.jobs.delete(childSession);
    }
    this.sessions.delete(sessionId);
    for (const key of this.messages.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.messages.delete(key);
    }
    this.events.delete(sessionId);
    this.jobs.delete(sessionId);
    this.preferences.delete(sessionId);
    await this.taskStore.deleteTasksBySession(sessionId);
  }

  async getSessionPreferences(sessionId: string): Promise<SessionPreferences | null> {
    const preferences = this.preferences.get(sessionId);
    return preferences ? { ...preferences } : null;
  }

  async saveSessionPreferences(
    sessionId: string,
    preferences: SessionPreferences,
  ): Promise<void> {
    await this.createSession(sessionId, 'Untitled');
    if (!hasPreferences(preferences)) {
      this.preferences.delete(sessionId);
      return;
    }
    this.preferences.set(sessionId, { ...preferences, updatedAt: Date.now() });
  }

  async saveJob(sessionId: string, job: PersistedJob): Promise<void> {
    await this.createSession(sessionId, 'Untitled');
    let sessionJobs = this.jobs.get(sessionId);
    if (!sessionJobs) {
      sessionJobs = new Map();
      this.jobs.set(sessionId, sessionJobs);
    }
    // 保留已回注状态：重复保存同一任务不重置 consumedAt
    const existing = sessionJobs.get(job.id);
    sessionJobs.set(job.id, { ...job, consumedAt: job.consumedAt ?? existing?.consumedAt ?? null });
  }

  async loadPendingJobs(sessionId: string): Promise<PersistedJob[]> {
    const sessionJobs = this.jobs.get(sessionId);
    if (!sessionJobs) return [];
    return [...sessionJobs.values()]
      .filter(j => j.consumedAt == null)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }

  async markJobConsumed(sessionId: string, jobId: string): Promise<void> {
    const job = this.jobs.get(sessionId)?.get(jobId);
    // 幂等：已回注的不覆盖首次时间
    if (job && job.consumedAt == null) {
      job.consumedAt = Date.now();
    }
  }

  clear(): void {
    this.sessions.clear();
    this.messages.clear();
    this.events.clear();
    this.jobs.clear();
    this.taskStore.clear();
  }
}
