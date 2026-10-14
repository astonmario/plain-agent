/**
 * HTTP Server 入口
 *
 * 装配：.env（从 cwd 向上逐级找）→ 按项目隔离的 SQLite 存储 → 常驻 AgentManager → Hono 路由
 * 用法：pnpm --filter @plain-agent/server dev [--port=3000]
 */

import { serve } from '@hono/node-server';
import {
  PlainAgent,
  SQLiteStorage,
  MemoryStorage,
  getBuiltinTools,
} from '@plain-agent/domain';
import type { SessionStorage, PermissionMode } from '@plain-agent/domain';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { AgentManager } from './manager';
import type { AgentLike } from './manager';
import { buildApp } from './app';

/** 从 cwd 向上逐级找 .env（就近优先），再 ~/.plain-agent/.env 兜底 */
function loadEnv(): void {
  const candidates: string[] = [];
  let dir = process.cwd();
  while (true) {
    candidates.push(join(dir, '.env'));
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(join(homedir(), '.plain-agent', '.env'));
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
        if (key && !process.env[key]) process.env[key] = value;
      }
    } catch {
      /* 读取失败跳过 */
    }
  }
}

loadEnv();

if (!process.env.API_KEY) {
  console.error('❌ 错误: 未配置 API_KEY\n');
  console.log('请创建 .env 文件（项目目录或 ~/.plain-agent/.env）:');
  console.log('  API_KEY=your-api-key');
  console.log('  MODEL=deepseek-chat');
  console.log('  BASE_URL=https://api.deepseek.com\n');
  process.exit(1);
}

// 会话按项目隔离：每个 cwd 一个独立 DB（与 TUI 同一约定）
let storage: SessionStorage;
let persisted = false;
const projectKey = process.cwd().replace(/[/\\:]/g, '-');
try {
  const dir = join(homedir(), '.plain-agent', 'projects');
  mkdirSync(dir, { recursive: true });
  storage = new SQLiteStorage(join(dir, `${projectKey}.db`));
  persisted = true;
} catch {
  storage = new MemoryStorage();
}

const info = {
  model: process.env.MODEL || 'deepseek-chat',
  baseUrl: process.env.BASE_URL,
  toolCount: getBuiltinTools().length + 4, // +4 for subagent tools
  persisted,
  project: process.cwd(),
};

function createAgent(sessionId: string): AgentLike {
  const llmConfig = {
    provider: 'openai' as const,
    apiKey: process.env.API_KEY!,
    model: info.model,
    baseUrl: info.baseUrl,
  };

  return new PlainAgent({
    llm: llmConfig,
    tools: getBuiltinTools(),
    enableSubagents: true,
    subagentConfig: {
      maxConcurrency: 3,
      maxDepth: 2,
    },
    storage,
    sessionId,
    permissionMode: (process.env.PERMISSION_MODE as PermissionMode) || 'trust',
    maxIterations: 150,
    historyManagement: {
      enabled: true,
      maxTokens: 8000,
      compressionThreshold: 6000,
      aggressiveThreshold: 10000,
      maxToolOutputLength: 1000,
      keepRecentMessages: 10,
    },
  }) as unknown as AgentLike;
}

const manager = new AgentManager({ storage, createAgent });
const app = buildApp({ manager, storage, info });

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT) || 3000;

console.log(`\n🚀 Plain Agent HTTP Server`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`📍 地址: http://127.0.0.1:${port}`);
console.log(`📊 配置: ${info.model}${info.persisted ? '' : ' · 内存模式'}`);
console.log(`🔧 工具: ${info.toolCount} 个`);
console.log(`📁 项目: ${info.project}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
console.log(`📖 主要端点:`);
console.log(`  GET  /health                              - 健康检查`);
console.log(`  POST /api/sessions                        - 创建会话`);
console.log(`  GET  /api/sessions                        - 会话列表`);
console.log(`  POST /api/sessions/:id/run                - 提交任务（SSE 流）`);
console.log(`  GET  /api/sessions/:id/stream?since=N     - 重挂续传（SSE）`);
console.log(`  POST /api/sessions/:id/stop               - 停止并清空队列`);
console.log(`  POST /api/sessions/:id/queue              - 排队任务`);
console.log(`  POST /api/sessions/:id/interact           - 回答 ask_question`);
console.log(`  POST /api/sessions/:id/compact            - 手动压缩历史`);
console.log(`  GET  /api/running                         - 运行中会话`);
console.log(`\n按 Ctrl+C 停止服务器\n`);

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
