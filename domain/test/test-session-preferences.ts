/**
 * 会话级偏好测试
 *
 * 覆盖：合并/校验、Memory/SQLite 存储、system prompt 注入、
 * 对话中通过工具写入并在下一轮生效、会话隔离、旧库迁移。
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import {
  MemoryStorage,
  PlainAgent,
  SQLiteStorage,
  setSessionPreferencesTool,
} from '../src';
import type { LLMConfig, Tool } from '../src';
import {
  describePreferences,
  hasPreferences,
  mergeSessionPreferences,
  renderPreferencesPrompt,
} from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const llm: LLMConfig = {
  provider: 'openai',
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://prefs.example.test/v1',
};

type Reply = string | { tool: string; args: object };

let script: Reply[] = [];
let requestBodies: any[] = [];

function sseFromDelta(delta: object): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

globalThis.fetch = (async (_url: string, init: RequestInit) => {
  requestBodies.push(JSON.parse(String(init.body)));
  const reply = script.shift();
  if (reply === undefined) throw new Error('No scripted LLM response');
  if (typeof reply === 'string') return sseFromDelta({ content: reply });
  return sseFromDelta({
    tool_calls: [{
      index: 0,
      id: `call-${requestBodies.length}`,
      type: 'function',
      function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
    }],
  });
}) as typeof fetch;

const BLOCK_MARKER = '## 会话偏好（用户设定，长期有效）';

function systemContent(bodies: any[], turnIndex = 0): string {
  const body = bodies[turnIndex];
  const system = body.messages.find((message: any) => message.role === 'system');
  return String(system?.content ?? '');
}

function makeAgent(storage: MemoryStorage | SQLiteStorage, sessionId: string, tools: Tool[]): PlainAgent {
  return new PlainAgent({
    llm,
    tools,
    storage,
    sessionId,
    permissionMode: 'trust',
    maxIterations: 4,
  });
}

async function testMergeRules(): Promise<void> {
  const merged = mergeSessionPreferences(null, { address: '  老   板 ', tone: 'concise' });
  assert(merged.address === '老 板', 'address is whitespace-normalized');
  assert(merged.tone === 'concise', 'tone accepted');

  const cleared = mergeSessionPreferences(merged, { clear: ['tone'] });
  assert(cleared.tone === undefined && cleared.address === '老 板', 'clear removes only the named key');

  let invalid = '';
  try {
    mergeSessionPreferences(null, { tone: 'sarcastic' });
  } catch (error) {
    invalid = String(error);
  }
  assert(invalid.includes('tone 必须是'), 'invalid tone is rejected');

  const long = mergeSessionPreferences(null, { address: 'x'.repeat(80) });
  assert((long.address ?? '').length === 40, 'address is capped at 40 chars');

  const named = mergeSessionPreferences(null, { assistantName: '  大 肥 鱼 ' });
  assert(named.assistantName === '大 肥 鱼', 'assistantName is whitespace-normalized');
  const longName = mergeSessionPreferences(null, { assistantName: '鱼'.repeat(40) });
  assert((longName.assistantName ?? '').length === 20, 'assistantName is capped at 20 chars');
  const namedCleared = mergeSessionPreferences(named, { clear: ['assistantName'] });
  assert(namedCleared.assistantName === undefined, 'assistantName can be cleared');

  assert(!hasPreferences(mergeSessionPreferences(null, { address: '  ' })),
    'blank address does not count as a preference');
  assert(renderPreferencesPrompt(null) === '', 'no preferences renders no block');
}

async function testStorageRoundTrip(kind: 'memory' | 'sqlite'): Promise<void> {
  const dbPath = kind === 'sqlite' ? join(tmpdir(), `plain-agent-prefs-${randomUUID()}.db`) : undefined;
  const storage = kind === 'sqlite' ? new SQLiteStorage(dbPath!) : new MemoryStorage();
  try {
    const sessionId = `${kind}-prefs`;
    assert((await storage.getSessionPreferences!(sessionId)) === null, `${kind}: empty by default`);

    await storage.saveSessionPreferences!(sessionId, { address: '王工', depth: 'detailed' });
    const loaded = await storage.getSessionPreferences!(sessionId);
    assert(loaded?.address === '王工' && loaded?.depth === 'detailed', `${kind}: roundtrip`);
    assert(typeof loaded?.updatedAt === 'number', `${kind}: updatedAt recorded`);

    // 另一个会话不受影响
    assert((await storage.getSessionPreferences!(`${sessionId}-other`)) === null,
      `${kind}: preferences are session-scoped`);

    // 空对象等同清除
    await storage.saveSessionPreferences!(sessionId, {});
    assert((await storage.getSessionPreferences!(sessionId)) === null, `${kind}: empty clears`);

    // 删除会话后偏好一起消失
    await storage.saveSessionPreferences!(sessionId, { tone: 'warm' });
    await storage.deleteSession(sessionId);
    assert((await storage.getSessionPreferences!(sessionId)) === null,
      `${kind}: preferences die with the session`);
  } finally {
    if (storage instanceof SQLiteStorage) {
      storage.close();
      rmSync(dbPath!, { force: true });
      rmSync(`${dbPath!}-wal`, { force: true });
      rmSync(`${dbPath!}-shm`, { force: true });
    }
  }
}

async function testPromptInjection(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = `inject-${randomUUID()}`;
  await storage.saveSessionPreferences(sessionId, {
    address: '老板',
    assistantName: '大肥鱼',
    tone: 'concise',
    language: 'zh',
  });

  requestBodies = [];
  script = ['收到'];
  const agent = makeAgent(storage, sessionId, []);
  const output = await agent.submit('打个招呼');
  assert(output === '收到', 'agent returns the answer');

  const system = systemContent(requestBodies);
  assert(system.includes(BLOCK_MARKER), 'preferences block injected');
  assert(system.includes('称呼用户：老板'), 'address injected');
  assert(system.includes('你的自称：大肥鱼'), 'assistantName injected');
  assert(system.includes('简洁直接'), 'tone injected');
  assert(system.includes('回复语言：中文'), 'language injected');
  assert(system.split(BLOCK_MARKER).length === 2, 'block injected exactly once');

  // 没有偏好的会话不注入
  requestBodies = [];
  script = ['好的'];
  const cleanAgent = makeAgent(storage, `clean-${randomUUID()}`, []);
  await cleanAgent.submit('你好');
  assert(!systemContent(requestBodies).includes(BLOCK_MARKER), 'no block without preferences');
}

async function testToolWritesAndNextTurn(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = `tool-${randomUUID()}`;
  await storage.saveSessionPreferences(sessionId, { address: '老板', tone: 'concise' });

  requestBodies = [];
  script = [
    { tool: 'set_session_preferences', args: { address: '阿甲', depth: 'detailed' } },
    '记住了，阿甲。',
  ];
  const agent = makeAgent(storage, sessionId, [setSessionPreferencesTool]);
  const output = await agent.submit('以后叫我阿甲，讲细一点');
  assert(output === '记住了，阿甲。', 'tool turn completes');

  const saved = await storage.getSessionPreferences(sessionId);
  assert(saved?.address === '阿甲', 'tool updated the address');
  assert(saved?.depth === 'detailed', 'tool added depth');
  assert(saved?.tone === 'concise', 'tool preserved untouched fields');

  // 同一轮内的第二次模型调用仍使用旧快照（偏好写在下一轮）
  const sameTurnSystem = systemContent(requestBodies, 0);
  assert(!sameTurnSystem.includes('阿甲'), 'preferences do not change mid-turn');

  // 下一轮请求带上新偏好
  requestBodies = [];
  script = ['好的'];
  await agent.submit('继续');
  const nextTurnSystem = systemContent(requestBodies);
  assert(nextTurnSystem.includes('称呼用户：阿甲'), 'next turn sees the new address');
  assert(nextTurnSystem.includes('教学式'), 'next turn sees the new depth');
  assert(nextTurnSystem.split(BLOCK_MARKER).length === 2, 'no duplicate block on next turn');

  // 清除单项
  requestBodies = [];
  script = [
    { tool: 'set_session_preferences', args: { clear: ['tone'] } },
    '好的，恢复默认语气。',
  ];
  await agent.submit('语气正常点就行');
  const afterClear = await storage.getSessionPreferences(sessionId);
  assert(afterClear?.tone === undefined, 'clear removed the tone');
  assert(afterClear?.address === '阿甲', 'clear kept the address');
  assert(describePreferences(afterClear).includes('称呼=阿甲'), 'describe output stays readable');
}

async function testAssistantNameScenario(): Promise<void> {
  // 复现用户实测场景：「你好，你叫大肥鱼」→ 工具写入 assistantName，下一轮问「你叫什么」
  const storage = new MemoryStorage();
  const sessionId = `name-${randomUUID()}`;

  requestBodies = [];
  script = [
    { tool: 'set_session_preferences', args: { assistantName: '大肥鱼' } },
    '好，我叫大肥鱼。',
  ];
  const agent = makeAgent(storage, sessionId, [setSessionPreferencesTool]);
  await agent.submit('你好，你叫大肥鱼');

  const saved = await storage.getSessionPreferences(sessionId);
  assert(saved?.assistantName === '大肥鱼', 'assistantName saved from conversation');
  assert(saved?.address === undefined, 'assistantName does not leak into address');

  requestBodies = [];
  script = ['我叫大肥鱼。'];
  await agent.submit('你叫什么');
  const system = systemContent(requestBodies);
  assert(system.includes('你的自称：大肥鱼'), 'next turn knows its own name');
  assert(!system.includes('称呼用户：大肥鱼'), 'name is not used as the user address');
}

async function testClearAll(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = `clear-${randomUUID()}`;
  await storage.saveSessionPreferences(sessionId, { address: '老板', tone: 'formal' });

  requestBodies = [];
  script = [
    { tool: 'set_session_preferences', args: { clear: ['address', 'tone'] } },
    '好的，恢复默认。',
  ];
  const agent = makeAgent(storage, sessionId, [setSessionPreferencesTool]);
  await agent.submit('不用讲究称呼和语气了');
  assert((await storage.getSessionPreferences(sessionId)) === null, 'clearing all removes the row');
}

async function testInvalidToolArgs(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = `invalid-${randomUUID()}`;
  await storage.saveSessionPreferences(sessionId, { address: '老板' });

  requestBodies = [];
  script = [
    { tool: 'set_session_preferences', args: { tone: 'sarcastic' } },
    '抱歉，参数不对。',
  ];
  const agent = makeAgent(storage, sessionId, [setSessionPreferencesTool]);
  await agent.submit('换个讽刺的语气');

  const saved = await storage.getSessionPreferences(sessionId);
  assert(saved?.address === '老板' && saved?.tone === undefined,
    'invalid args leave existing preferences untouched');
}

async function testSqliteMigration(): Promise<void> {
  const dbPath = join(tmpdir(), `plain-agent-prefs-migrate-${randomUUID()}.db`);
  const storage = new SQLiteStorage(dbPath);
  await storage.createSession('legacy', 'Legacy');
  storage.close();

  const { createRequire } = await import('node:module');
  const requireNode = createRequire(import.meta.url);
  const { DatabaseSync } = requireNode('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const raw = new DatabaseSync(dbPath);
  raw.exec('ALTER TABLE sessions DROP COLUMN preferences_json');
  raw.close();

  const reopened = new SQLiteStorage(dbPath);
  try {
    assert((await reopened.getSessionPreferences!('legacy')) === null,
      'old database opens without preferences column');
    await reopened.saveSessionPreferences!('legacy', { language: 'en' });
    const saved = await reopened.getSessionPreferences!('legacy');
    assert(saved?.language === 'en', 'column is added on demand and usable');
  } finally {
    reopened.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function main(): Promise<void> {
  await testMergeRules();
  await testStorageRoundTrip('memory');
  await testStorageRoundTrip('sqlite');
  await testPromptInjection();
  await testToolWritesAndNextTurn();
  await testAssistantNameScenario();
  await testClearAll();
  await testInvalidToolArgs();
  await testSqliteMigration();
  console.log('session preferences tests passed');
}

void main();
