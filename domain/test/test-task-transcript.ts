import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { MemoryStorage, SQLiteStorage } from '../src';
import type { ChatMessage, SessionStorage } from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const message = (content: string): ChatMessage => ({
  role: 'user',
  content,
});

async function exercise(name: string, storage: SessionStorage): Promise<void> {
  const sessionId = `${name}-session`;
  const taskA = randomUUID();
  const taskB = randomUUID();
  await storage.createSession(sessionId, 'Transcript');

  await storage.saveMessage(sessionId, message('session message'));
  await storage.saveMessage(sessionId, message('task a 1'), taskA);
  await storage.saveMessage(sessionId, message('task b 1'), taskB);
  await storage.saveMessage(sessionId, message('task a 2'), taskA);

  assert(
    (await storage.loadMessages(sessionId)).map(item => item.content).join('|') === 'session message',
    `${name}: legacy session transcript remains isolated`,
  );
  assert(
    (await storage.loadMessages(sessionId, taskA)).map(item => item.content).join('|') === 'task a 1|task a 2',
    `${name}: task A transcript is isolated`,
  );
  assert(
    (await storage.loadMessages(sessionId, taskB)).map(item => item.content).join('|') === 'task b 1',
    `${name}: task B transcript is isolated`,
  );
}

async function testMemory(): Promise<void> {
  await exercise('memory', new MemoryStorage());
}

async function testSQLite(): Promise<void> {
  const dbPath = join(tmpdir(), `plain-agent-transcript-${randomUUID()}.db`);
  const storage = new SQLiteStorage(dbPath);
  try {
    await exercise('sqlite', storage);
  } finally {
    storage.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function testLegacySQLiteMigration(): Promise<void> {
  const dbPath = join(tmpdir(), `plain-agent-transcript-legacy-${randomUUID()}.db`);
  const require = await import('node:module').then(module => module.createRequire(import.meta.url));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO sessions VALUES ('legacy-session', 'Legacy', 1, 1, 'active');
    INSERT INTO messages (session_id, role, content, created_at)
      VALUES ('legacy-session', 'user', 'legacy message', 1);
  `);
  db.close();

  const storage = new SQLiteStorage(dbPath);
  try {
    const messages = await storage.loadMessages('legacy-session');
    assert(messages[0]?.content === 'legacy message', 'sqlite: legacy messages remain readable after migration');
    await storage.saveMessage('legacy-session', message('new task message'), 'task-1');
    assert((await storage.loadMessages('legacy-session', 'task-1')).length === 1,
      'sqlite: migrated database accepts task-scoped messages');
  } finally {
    storage.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function main(): Promise<void> {
  await testMemory();
  await testSQLite();
  await testLegacySQLiteMigration();
  console.log('task transcript tests passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
