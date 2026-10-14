/**
 * Subagent 端到端测试（真实调用 LLM，需要 .env 中的 API_KEY）
 *
 * 通过 runtime 事件断言子 Agent 确实被创建并完成，而不只是看父 Agent 的回答。
 * 运行时逻辑的确定性测试见 test-subagent-runtime.ts。
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PlainAgent, MemoryStorage, getBuiltinTools } from '../src/index';
import type { AgentEvent } from '../src/index';

function loadEnv(): void {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

loadEnv();

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

interface Trace {
  created: Array<{ runId: string; depth: number; task: string }>;
  finished: Array<{ runId: string; status: string }>;
  depthErrors: number;
}

function createAgent(maxDepth = 2): { agent: PlainAgent; trace: Trace } {
  const agent = new PlainAgent({
    llm: {
      provider: 'openai',
      apiKey: process.env.API_KEY!,
      model: process.env.MODEL || 'deepseek-chat',
      baseUrl: process.env.BASE_URL,
    },
    tools: getBuiltinTools(),
    storage: new MemoryStorage(),
    permissionMode: 'trust',
    enableSubagents: true,
    subagentConfig: { maxConcurrency: 5, defaultTimeout: 120000, maxDepth },
  });

  const trace: Trace = { created: [], finished: [], depthErrors: 0 };
  const runtime = (agent as any).subagentRuntime;
  runtime.on('subagent-created', ({ runId, depth, request }: any) => {
    trace.created.push({ runId, depth, task: request.task });
    console.log(`    ↳ 子 Agent 创建 depth=${depth} ${runId.slice(0, 8)}: ${request.task.slice(0, 60)}`);
  });
  runtime.on('subagent-completed', ({ runId, result }: any) => {
    trace.finished.push({ runId, status: result.status });
    console.log(`    ↳ 子 Agent 完成 ${runId.slice(0, 8)} (${result.stats.duration}ms, ${result.stats.toolCalls} 次工具调用)`);
  });
  runtime.on('subagent-failed', ({ runId, error }: any) => {
    trace.finished.push({ runId, status: 'failed' });
    console.log(`    ↳ 子 Agent 失败 ${runId.slice(0, 8)}: ${error}`);
  });

  agent.on('event', (event: AgentEvent) => {
    if (event.type === 'tool_start' && event.tool.includes('subagent')) {
      console.log(`    🔧 父 Agent 调用 ${event.tool}`);
    }
    if (event.type === 'tool_result' && event.result.includes('Maximum recursion depth')) {
      trace.depthErrors++;
    }
  });

  return { agent, trace };
}

async function testBasic() {
  console.log('\n[1] 同步委派（wait=true）');
  const { agent, trace } = createAgent();
  try {
    const result = await agent.submit(
      '用 spawn_subagent 工具（wait=true, allowed_tools=["read_file"]）委派一个子任务：' +
      '读取当前目录下的 package.json，返回其中的 name 字段。然后把子任务给出的 name 告诉我。'
    );
    console.log(`    父 Agent 回答：${result.slice(0, 200)}`);
    assert(trace.created.length >= 1, `创建了子 Agent（${trace.created.length} 个）`);
    assert(trace.finished.some(f => f.status === 'completed'), '子 Agent 成功完成');
    assert(result.includes('@plain-agent/domain'), '父 Agent 拿到了子任务结果（package name）');
  } finally {
    agent.destroy();
  }
}

async function testParallel() {
  console.log('\n[2] 并行委派（wait=false + wait_subagent）');
  const { agent, trace } = createAgent();
  try {
    const t0 = Date.now();
    const result = await agent.submit(
      '请并行完成：先用 spawn_subagent（wait=false）连续创建两个子任务，' +
      '子任务 A：读取 package.json 返回 name 字段；子任务 B：读取 tsconfig.json 返回 compilerOptions.target 字段。' +
      '两个都创建好之后，再分别用 wait_subagent 等待结果，最后汇总两个值告诉我。'
    );
    console.log(`    父 Agent 回答：${result.slice(0, 200)}（${Date.now() - t0}ms）`);
    assert(trace.created.length >= 2, `创建了 ≥2 个子 Agent（${trace.created.length} 个）`);
    assert(trace.finished.filter(f => f.status === 'completed').length >= 2, '两个子 Agent 都完成');
  } finally {
    agent.destroy();
  }
}

async function testRecursion() {
  console.log('\n[3] 递归委派 + 深度限制（maxDepth=2）');
  const { agent, trace } = createAgent(2);
  try {
    const result = await agent.submit(
      '这是一个测试递归子 Agent 的任务。请用 spawn_subagent（wait=true）创建子任务 A，' +
      'A 的 task 原文为："请用 spawn_subagent（wait=true）创建子任务 B，B 的 task 原文为：' +
      '\'请用 spawn_subagent（wait=true）创建子任务 C，C 只需回答 hi。如果创建失败，请原样报告错误信息。\'' +
      '。最后报告 B 的结果。"。最后告诉我整个链路发生了什么。'
    );
    console.log(`    父 Agent 回答：${result.slice(0, 300)}`);
    const depths = trace.created.map(c => c.depth);
    assert(depths.includes(0) && depths.includes(1), `子 Agent 能继续 spawn（创建深度：${depths.join(',')}）`);
    assert(!depths.includes(2), '没有越过 maxDepth 创建第 3 层');
  } finally {
    agent.destroy();
  }
}

async function main() {
  if (!process.env.API_KEY) {
    console.error('缺少 API_KEY（.env 或环境变量）');
    process.exitCode = 1;
    return;
  }
  console.log(`Subagent 端到端测试（model=${process.env.MODEL || 'deepseek-chat'}）`);

  for (const t of [testBasic, testParallel, testRecursion]) {
    try {
      await t();
    } catch (e: any) {
      failed++;
      console.log(`  ❌ 未捕获异常: ${e.message}`);
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
