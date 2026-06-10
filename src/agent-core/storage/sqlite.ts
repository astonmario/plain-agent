/**
 * SQLite 存储适配器
 * 基于 Node 22+ 内置的 node:sqlite 模块（零依赖）
 * 在 Electron 主进程（内置 Node 24）中可用
 */

import { createRequire } from 'module';
import type { SessionStorage, Session, ChatMessage, AgentEvent } from '../types';

export class SQLiteStorage implements SessionStorage {
  // node:sqlite 的 DatabaseSync 实例
  private db: any;

  constructor(dbPath: string) {
    // 动态加载 node:sqlite，避免在 Node 20 环境（CLI/server）加载模块时失败
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');

    this.db = new DatabaseSync(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      -- 会话表
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT CHECK(status IN ('active', 'archived')) DEFAULT 'active'
      );

      -- 消息表
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
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

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, created_at);
    `);
  }

  async createSession(sessionId: string, title: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(sessionId, title, now, now);
  }

  async saveMessage(sessionId: string, message: ChatMessage): Promise<void> {
    // 确保会话存在
    await this.createSession(sessionId, 'Untitled');

    this.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
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

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = this.db.prepare(`
      SELECT role, content, tool_call_id, tool_calls
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as any[];

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
      SELECT id, title, created_at, updated_at, status
      FROM sessions
      ORDER BY updated_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
    }));
  }

  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    this.db.prepare(`
      UPDATE sessions
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(newTitle, Date.now(), sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // 由于有 ON DELETE CASCADE，删除会话时会自动删除关联的消息和事件
    this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `).run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
