/**
 * SQLite 存储适配器
 */

import Database from 'better-sqlite3';
import type { SessionStorage, Session, ChatMessage, AgentEvent } from '../types';

export class SQLiteStorage implements SessionStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
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

  close(): void {
    this.db.close();
  }
}
