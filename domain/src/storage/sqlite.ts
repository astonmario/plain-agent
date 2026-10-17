/**
 * SQLite 存储适配器
 * 基于 Node 22+ 内置的 node:sqlite 模块（零依赖）
 * 在 Electron 主进程（内置 Node 24）中可用
 */

import { createRequire } from 'module';
import type { SessionStorage, Session, ChatMessage, AgentEvent, PersistedJob } from '../types';
import type { SessionPreferences } from '../session-preferences';
import { hasPreferences } from '../session-preferences';
import { SQLiteTaskStore } from '../tasks';
import type { TaskStore } from '../tasks';

/** 入库输出上限（截断保留尾部，更早的内容由 job_output 工具的内存注册表兜底） */
const JOB_OUTPUT_CAP = 50 * 1024;
/** 已消费任务的保留期，saveJob 时顺带清理过期记录 */
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class SQLiteStorage implements SessionStorage {
  // node:sqlite 的 DatabaseSync 实例
  private db: any;

  constructor(dbPath: string) {
    // 动态加载 node:sqlite，避免在 Node 20 环境（CLI/server）加载模块时失败
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initTables();
  }

  /** Create a task store backed by this storage's database connection. */
  getTaskStore(): TaskStore {
    return new SQLiteTaskStore(this.db);
  }

  private initTables(): void {
    this.db.exec(`
      -- 会话表
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        preferences_json TEXT,
        workspace TEXT,
        status TEXT CHECK(status IN ('active', 'archived')) DEFAULT 'active'
      );

      -- 消息表
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        role TEXT CHECK(role IN ('system', 'user', 'assistant', 'tool')) NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- 事件表（用于回放和审计）
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- 后台任务表（结果先落盘，回注状态用 consumed_at 标记，幂等投递）
      CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        command     TEXT NOT NULL,
        intent      TEXT,
        status      TEXT CHECK(status IN ('done', 'error')) NOT NULL,
        exit_code   INTEGER,
        output      TEXT,
        truncated   INTEGER DEFAULT 0,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        consumed_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_pending
        ON jobs(session_id, consumed_at);
    `);
    this.ensureMessageColumn('task_id', 'TEXT');
    this.ensureSessionColumn('preferences_json', 'TEXT');
    this.ensureSessionColumn('workspace', 'TEXT');
  }

  private ensureSessionColumn(column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!columns.some(entry => entry.name === column)) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${definition}`);
    }
  }

  private ensureMessageColumn(column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    if (!columns.some(entry => entry.name === column)) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_task
        ON messages(session_id, task_id, id)
    `);
  }

  async createSession(sessionId: string, title: string, workspace?: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, status, workspace)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(sessionId, title, now, now, workspace ?? null);
  }

  async getSessionWorkspace(sessionId: string): Promise<string | null> {
    const row = this.db.prepare(`
      SELECT workspace FROM sessions WHERE id = ?
    `).get(sessionId) as { workspace: string | null } | undefined;
    return row?.workspace ?? null;
  }

  async setSessionWorkspace(sessionId: string, workspace: string | null): Promise<void> {
    await this.createSession(sessionId, 'Untitled');
    this.db.prepare(`
      UPDATE sessions SET workspace = ?, updated_at = ? WHERE id = ?
    `).run(workspace, Date.now(), sessionId);
  }

  async saveMessage(sessionId: string, message: ChatMessage, taskId?: string): Promise<void> {
    // 确保会话存在
    await this.createSession(sessionId, 'Untitled');

    this.db.prepare(`
      INSERT INTO messages (session_id, task_id, role, content, tool_call_id, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      taskId ?? null,
      message.role,
      message.content,
      message.tool_call_id || null,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      Date.now()
    );

    // 更新会话时间
    this.db.prepare(`
      UPDATE sessions SET updated_at = ? WHERE id = ?
    `).run(Date.now(), sessionId);
  }

  async loadMessages(sessionId: string, taskId?: string): Promise<ChatMessage[]> {
    const rows = this.db.prepare(`
      SELECT role, content, tool_call_id, tool_calls
      FROM messages
      WHERE session_id = ?
        AND ${taskId === undefined ? 'task_id IS NULL' : 'task_id = ?'}
      ORDER BY id ASC
    `).all(...(taskId === undefined ? [sessionId] : [sessionId, taskId])) as any[];

    return rows.map(row => ({
      role: row.role,
      content: row.content,
      tool_call_id: row.tool_call_id || undefined,
      tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    }));
  }

  async saveEvent(sessionId: string, event: AgentEvent): Promise<void> {
    // 确保会话存在
    await this.createSession(sessionId, 'Untitled');

    this.db.prepare(`
      INSERT INTO events (session_id, type, data, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      sessionId,
      event.type,
      JSON.stringify(event),
      Date.now()
    );
  }

  async loadEvents(sessionId: string): Promise<AgentEvent[]> {
    const rows = this.db.prepare(`
      SELECT data
      FROM events
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as any[];

    return rows.map(row => JSON.parse(row.data));
  }

  async listSessions(): Promise<Session[]> {
    const rows = this.db.prepare(`
      SELECT id, title, created_at, updated_at, status, workspace
      FROM sessions
      ORDER BY updated_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      workspace: row.workspace ?? undefined,
    }));
  }

  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    this.db.prepare(`
      UPDATE sessions
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(newTitle, Date.now(), sessionId);
  }

  async getSessionPreferences(sessionId: string): Promise<SessionPreferences | null> {
    const row = this.db.prepare(`
      SELECT preferences_json FROM sessions WHERE id = ?
    `).get(sessionId) as { preferences_json: string | null } | undefined;
    if (!row?.preferences_json) return null;
    try {
      return JSON.parse(row.preferences_json) as SessionPreferences;
    } catch {
      return null;
    }
  }

  async saveSessionPreferences(
    sessionId: string,
    preferences: SessionPreferences,
  ): Promise<void> {
    await this.createSession(sessionId, 'Untitled');
    const payload = hasPreferences(preferences)
      ? JSON.stringify({ ...preferences, updatedAt: Date.now() })
      : null;
    this.db.prepare(`
      UPDATE sessions
      SET preferences_json = ?, updated_at = ?
      WHERE id = ?
    `).run(payload, Date.now(), sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const taskStore = this.getTaskStore();
    const tasks = await taskStore.listTasks({ sessionId });
    const childSessions = new Set<string>();
    for (const root of tasks) {
      for (const member of await taskStore.listTasks({ rootId: root.rootId })) {
        if (member.sessionId !== sessionId) childSessions.add(member.sessionId);
      }
    }
    await taskStore.deleteTasksBySession(sessionId);
    for (const childSession of childSessions) {
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(childSession);
    }
    // 由于有 ON DELETE CASCADE，删除会话时会自动删除关联的消息和事件
    this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `).run(sessionId);
  }

  async saveJob(sessionId: string, job: PersistedJob): Promise<void> {
    // 确保会话存在
    await this.createSession(sessionId, 'Untitled');

    // 截断输出，保留尾部（尾部通常是错误信息，对诊断最有价值）
    let output = job.output;
    let truncated = job.truncated;
    if (output.length > JOB_OUTPUT_CAP) {
      output = '…[earlier output dropped]\n' + output.slice(-JOB_OUTPUT_CAP);
      truncated = true;
    }

    this.db.prepare(`
      INSERT INTO jobs (id, session_id, command, intent, status, exit_code, output, truncated, started_at, finished_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        exit_code = excluded.exit_code,
        output = excluded.output,
        truncated = excluded.truncated,
        finished_at = excluded.finished_at
    `).run(
      job.id, sessionId, job.command, job.intent || null, job.status,
      job.exitCode, output, truncated ? 1 : 0,
      job.startedAt, job.finishedAt ?? null, job.consumedAt ?? null
    );

    // 顺带清理过期的已消费任务（7 天前），避免表无限增长
    this.db.prepare(`
      DELETE FROM jobs WHERE consumed_at IS NOT NULL AND consumed_at < ?
    `).run(Date.now() - JOB_RETENTION_MS);
  }

  async loadPendingJobs(sessionId: string): Promise<PersistedJob[]> {
    const rows = this.db.prepare(`
      SELECT id, command, intent, status, exit_code, output, truncated, started_at, finished_at
      FROM jobs
      WHERE session_id = ? AND consumed_at IS NULL
      ORDER BY finished_at ASC
    `).all(sessionId) as any[];

    return rows.map(row => ({
      id: row.id,
      command: row.command,
      intent: row.intent || undefined,
      status: row.status,
      exitCode: row.exit_code,
      output: row.output || '',
      truncated: !!row.truncated,
      startedAt: row.started_at,
      finishedAt: row.finished_at || undefined,
      consumedAt: null,
    }));
  }

  async markJobConsumed(sessionId: string, jobId: string): Promise<void> {
    // WHERE consumed_at IS NULL 保证幂等：重复调用不会覆盖首次回注时间
    this.db.prepare(`
      UPDATE jobs SET consumed_at = ?
      WHERE id = ? AND session_id = ? AND consumed_at IS NULL
    `).run(Date.now(), jobId, sessionId);
  }

  close(): void {
    this.db.close();
  }
}
