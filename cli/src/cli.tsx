/**
 * TUI 入口
 *
 * 职责：环境装配（.env / API Key / 存储）、启动参数（--resume/--continue/--sessions）、
 * 以及 Ink 实例生命周期。
 *
 * 会话切换/清屏必须 unmount 旧 Ink 实例 + 清屏转义码 + 重新 render：
 * Ink 的 fullStaticOutput 是 append-only，<Static> 已写入终端 scrollback 的旧消息
 * 在同一实例内无法清除（借鉴 any-code/tui 的教训）。
 */

import React from 'react';
import { render } from 'ink';
import {
  PlainAgent,
  SQLiteStorage,
  MemoryStorage,
  TaskOrchestrator,
  getBuiltinTools,
  loadMcpTools,
  loadProjectMcp,
} from '@plain-agent/domain';
import type {
  SessionStorage,
  PermissionMode,
  Tool,
  TaskStore,
  TaskVerificationPolicy,
} from '@plain-agent/domain';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import App from './components/App';
import { TUI_SYSTEM_PROMPT } from './prompt';

/**
 * 从 cwd 向上逐级找 .env（就近优先），找不到再用 ~/.plain-agent/.env 兜底。
 * pnpm --filter 启动时 cwd 是包目录，需要向上找才能命中项目根目录的 .env
 */
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
  console.log('请创建 .env 文件（当前目录或 ~/.plain-agent/.env）:');
  console.log('  API_KEY=your-api-key');
  console.log('  MODEL=deepseek-chat');
  console.log('  BASE_URL=https://api.deepseek.com\n');
  process.exit(1);
}

// 优先 SQLite 持久化（Node 22+），Node 20 回退内存会话
// 会话按项目隔离：每个 cwd 一个独立 DB（借鉴 any-code 的 projectKey 语义），
// /resume、--sessions、--continue 都只看到自己项目的会话
let storage: SQLiteStorage | MemoryStorage;
let taskStore: TaskStore;
let persisted = false;
const projectKey = process.cwd().replace(/[/\\:]/g, '-');
try {
  const dir = join(homedir(), '.plain-agent', 'projects');
  mkdirSync(dir, { recursive: true });
  storage = new SQLiteStorage(join(dir, `${projectKey}.db`));
  taskStore = storage.getTaskStore();
  persisted = true;
} catch {
  storage = new MemoryStorage();
  taskStore = storage.getTaskStore();
}

// 加载 MCP 工具（启动时加载，所有 agent 实例共享）
let mcpTools: Tool[] = [];
let mcpCleanup: (() => Promise<void>) | null = null;

async function loadMcp(): Promise<void> {
  try {
    const mcpConfig = loadProjectMcp(process.cwd());
    if (Object.keys(mcpConfig).length > 0) {
      console.log('🔌 加载 MCP 服务器...');
      const mcpManager = await loadMcpTools(mcpConfig);
      mcpTools = mcpManager.tools;
      mcpCleanup = mcpManager.cleanup;
      if (mcpTools.length > 0) {
        console.log(`✅ 已加载 ${mcpTools.length} 个 MCP 工具`);
      }
    }
  } catch (err) {
    console.warn('⚠️  MCP 加载失败:', (err as Error).message);
    mcpTools = [];
    mcpCleanup = null;
  }
}

const info = {
  model: process.env.MODEL || 'deepseek-chat',
  baseUrl: process.env.BASE_URL,
  toolCount: getBuiltinTools().length + mcpTools.length + 4, // +4 for subagent tools
  persisted,
  project: process.cwd(),
};

function createAgent(sessionId?: string): PlainAgent {
  const llmConfig = {
    provider: 'openai' as const,
    apiKey: process.env.API_KEY!,
    model: info.model,
    baseUrl: info.baseUrl,
  };

  return new PlainAgent({
    llm: llmConfig,
    tools: [...getBuiltinTools(), ...mcpTools],
    enableSubagents: true,
    subagentConfig: {
      maxConcurrency: 3,
      maxDepth: 2,
    },
    storage,
    taskStore,
    sessionId,
    systemPrompt: TUI_SYSTEM_PROMPT,
    permissionMode: (process.env.PERMISSION_MODE as PermissionMode) || 'trust',
    maxIterations: 150,
    historyManagement: {
      enabled: true,
      maxTokens: 200_000,
      compressionThreshold: 150_000,
      aggressiveThreshold: 180_000,
      maxToolOutputLength: 1000,
      keepRecentMessages: 10,
    },
  });
}

const taskOrchestrator = new TaskOrchestrator({
  taskStore,
  sessionStorage: storage,
  workerId: `cli-${process.pid}`,
  workspaceRoot: process.cwd(),
  createAgent: (sessionId) => createAgent(sessionId),
  prepareAgent: (agent) => agent.loadHistory().then(() => undefined),
});

// ---- 启动参数 ----
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return undefined;
};

/** 可重复参数：--verify "cmd" / --verify="cmd" */
const flagValues = (name: string): string[] => {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      values.push(argv[++i]);
    } else if (arg.startsWith(`--${name}=`)) {
      values.push(arg.slice(name.length + 3));
    }
  }
  return values;
};

const verifyCommands = flagValues('verify');
const verification: TaskVerificationPolicy | undefined = verifyCommands.length === 0
  ? undefined
  : {
      mode: 'required',
      timeoutMs: Number(flagValue('verify-timeout') ?? 120_000),
      checks: verifyCommands.map((command, index) => ({
        kind: 'command' as const,
        name: `verify-${index + 1}`,
        command,
      })),
    };

async function main(): Promise<void> {
  // 子命令：skill
  if (argv[0] === 'skill') {
    const { handleSkillCommand } = await import('./commands/skill');
    await handleSkillCommand(argv.slice(1));
    return;
  }

  // 加载 MCP 工具
  await loadMcp();

  // --sessions：列出会话并退出
  if (argv.includes('--sessions')) {
    const sessions = await storage.listSessions();
    if (sessions.length === 0) {
      console.log('没有会话记录。');
    } else {
      console.log('会话列表:');
      for (const s of sessions) {
        console.log(`  ${s.id.slice(0, 8)}  ${s.title || '(未命名)'}  ${new Date(s.updatedAt).toLocaleString()}`);
      }
    }
    await mcpCleanup?.();
    process.exit(0);
  }

  void taskOrchestrator.recover().catch((error) => {
    console.error('Failed to recover persisted tasks:', error);
  });

  let sessionId: string | undefined;
  const resumeId = flagValue('resume');
  const isContinue = argv.includes('--continue');
  if (resumeId) {
    sessionId = resumeId;
  } else if (isContinue) {
    const sessions = await storage.listSessions();
    const recent = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      sessionId = recent.id;
    } else {
      console.log('没有历史会话，将开启新会话。');
    }
  }

  let inkInstance: ReturnType<typeof render> | undefined;
  const startApp = (sid?: string, opts?: { echoHistory?: boolean }) => {
    if (inkInstance) {
      inkInstance.unmount();
      // \x1B[2J 擦屏幕 / \x1B[3J 擦 scrollback / \x1B[H 光标归位
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
    }
    inkInstance = render(
      <App
        createAgent={createAgent}
        submitTask={(agent, task) =>
          taskOrchestrator.run(agent.getSessionId(), task, undefined, agent, { verification })
        }
        stopTask={(agent) => {
          const activeIds = agent.getRunningTasks();
          for (const taskId of activeIds) {
            void taskOrchestrator.cancel(taskId);
          }
          // 兜底：无论 orchestrator 是否接住，都直接中断 agent 的控制器（幂等）
          agent.stop();
        }}
        storage={storage}
        info={info}
        sessionId={sid}
        echoHistory={opts?.echoHistory}
        onSwitchSession={(nextSid) => startApp(nextSid)}
        onClearScreen={() => startApp(sid, { echoHistory: false })}
      />,
    );
  };
  startApp(sessionId);

  // 清理 MCP 连接（进程退出时）
  process.on('exit', () => {
    void mcpCleanup?.();
  });
  process.on('SIGINT', async () => {
    await mcpCleanup?.();
    process.exit(0);
  });
}

void main();
