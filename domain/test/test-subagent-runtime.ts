/**
 * SubagentRuntime 单元测试（不调用 LLM）
 *
 * 用假 Agent 替代 PlainAgent，确定性地验证：
 * spawn/wait、上下文隔离、工具白名单、并发限制、递归深度、超时、取消
 */

import { SubagentRuntime } from '../src/subagent';
import type { AgentConfig, Tool } from '../src/types';

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

function makeTool(name: string, readonly?: boolean): Tool {
  return {
    name,
    description: name,
    schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
    handler: async () => 'ok',
    meta: readonly === undefined ? undefined : { readonly },
  };
}

const baseTools = [
  makeTool('read_file', true),
  makeTool('grep', true),
  makeTool('write_file', false),
  makeTool('bash', false),
  makeTool('no_meta_tool'),
];

/** 假 Agent：submit 延迟 delay 后返回，stop 时立即以 stopped 结束 */
class FakeAgent {
  config: AgentConfig;
  delay: number;
  private listeners: Array<(e: any) => void> = [];
  private stopResolve?: () => void;
  submitted?: string;

  constructor(config: AgentConfig, delay: number) {
    this.config = config;
    this.delay = delay;
  }
  on(_: 'event', l: (e: any) => void) { this.listeners.push(l); return this; }
  async submit(task: string): Promise<string> {
    this.submitted = task;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.delay);
      this.stopResolve = () => { clearTimeout(t); resolve(); };
    });
    if (task.includes('FAIL')) throw new Error('boom');
    return `done: ${task}`;
  }
  stop() { this.stopResolve?.(); }
  destroy() {}
  getMessages() {
    return [
      { role: 'system', content: this.config.systemPrompt ?? '' },
      { role: 'user', content: this.submitted ?? '' },
      { role: 'assistant', content: 'x' },
    ];
  }
}

function makeRuntime(opts: { delay?: number; maxConcurrency?: number; maxDepth?: number; defaultTimeout?: number } = {}) {
  const created: FakeAgent[] = [];
  const runtime = new SubagentRuntime({
    agentFactory: (cfg) => {
      const a = new FakeAgent(cfg, opts.delay ?? 20);
      created.push(a);
      return a as any;
    },
    parentConfig: {
      llm: { provider: 'openai', apiKey: 'k', model: 'm' },
      tools: baseTools,
      permissionMode: 'trust',
    },
    maxConcurrency: opts.maxConcurrency,
    maxDepth: opts.maxDepth,
    defaultTimeout: opts.defaultTimeout,
  });
  return { runtime, created };
}

async function testSpawnWait() {
  console.log('\n[1] spawn + wait 基本流程');
  const { runtime, created } = makeRuntime();
  const { runId } = await runtime.spawn({ parentRunId: 'root', task: 'hello' });
  const result = await runtime.wait(runId);
  assert(result.status === 'completed', `状态 completed（实际 ${result.status}，error=${result.error ?? ''}）`);
  assert(result.output === 'done: hello', '输出正确');
  assert(created.length === 1, '只创建了一个子 Agent');
  const status = await runtime.getStatus(runId);
  assert(status.status === 'completed', 'getStatus 返回 completed');
}

async function testContextIsolation() {
  console.log('\n[2] 上下文隔离 / system prompt');
  const { runtime, created } = makeRuntime();
  const { runId } = await runtime.spawn({
    parentRunId: 'root',
    task: 'analyze',
    role: '代码审查员',
    context: { summary: 'SUMMARY-XYZ', files: ['a.ts'] },
  });
  await runtime.wait(runId);
  const cfg = created[0].config;
  assert(!!cfg.systemPrompt?.includes('代码审查员'), 'system prompt 含角色');
  assert(!!cfg.systemPrompt?.includes('SUMMARY-XYZ'), 'system prompt 含上下文摘要');
  assert(cfg.storage === undefined, '子 Agent 不写父会话存储');
  assert(cfg.sessionId === runId, '子 Agent sessionId = runId（用于递归深度追溯）');
}

async function testToolWhitelist() {
  console.log('\n[3] 工具白名单');
  const { runtime, created } = makeRuntime();

  const r1 = await runtime.spawn({ parentRunId: 'root', task: 't1' });
  await runtime.wait(r1.runId);
  const defaultNames = created[0].config.tools.map(t => t.name);
  assert(
    defaultNames.includes('read_file') && defaultNames.includes('grep') &&
    !defaultNames.includes('write_file') && !defaultNames.includes('bash') &&
    !defaultNames.includes('no_meta_tool'),
    `默认只给只读工具（实际 ${defaultNames.join(',')}）`
  );

  const r2 = await runtime.spawn({ parentRunId: 'root', task: 't2', tools: ['read_file', 'bash'] });
  await runtime.wait(r2.runId);
  const names = created[1].config.tools.map(t => t.name);
  assert(names.length === 2 && names.includes('read_file') && names.includes('bash'), `白名单生效（实际 ${names.join(',')}）`);
}

async function testConcurrencyLimit() {
  console.log('\n[4] 并发限制');
  const { runtime } = makeRuntime({ delay: 100, maxConcurrency: 2 });
  // 同时发起 3 个 spawn，第 3 个应被拒（检查与登记之间不能有竞态）
  const results = await Promise.allSettled([
    runtime.spawn({ parentRunId: 'root', task: 'a' }),
    runtime.spawn({ parentRunId: 'root', task: 'b' }),
    runtime.spawn({ parentRunId: 'root', task: 'c' }),
  ]);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  assert(ok === 2, `并发上限 2，实际成功 ${ok}`);
  for (const r of results) {
    if (r.status === 'fulfilled') await runtime.wait(r.value.runId);
  }
  const after = await runtime.spawn({ parentRunId: 'root', task: 'd' });
  assert(!!after.runId, '前序完成后可再次 spawn');
  await runtime.wait(after.runId);
}

async function testDepthLimit() {
  console.log('\n[5] 递归深度');
  const { runtime } = makeRuntime({ delay: 200, maxDepth: 2 });
  const l1 = await runtime.spawn({ parentRunId: 'root', task: 'l1' });
  // 子 Agent 以自己的 sessionId(=runId) 作为 parentRunId 发起下一层
  const l2 = await runtime.spawn({ parentRunId: l1.runId, task: 'l2' });
  let err = '';
  try {
    await runtime.spawn({ parentRunId: l2.runId, task: 'l3' });
  } catch (e: any) {
    err = e.message;
  }
  assert(err.includes('depth'), `第 3 层被拒（maxDepth=2）：${err || '未抛错'}`);
  await runtime.wait(l1.runId);
  await runtime.wait(l2.runId);
}

async function testFailure() {
  console.log('\n[6] 子任务失败');
  const { runtime } = makeRuntime();
  const { runId } = await runtime.spawn({ parentRunId: 'root', task: 'FAIL please' });
  const result = await runtime.wait(runId);
  assert(result.status === 'failed' && result.error === 'boom', `状态 failed（实际 ${result.status}）`);
}

async function testTimeout() {
  console.log('\n[7] 超时');
  const { runtime } = makeRuntime({ delay: 5000 });
  const { runId } = await runtime.spawn({ parentRunId: 'root', task: 'slow' });
  const t0 = Date.now();
  const result = await runtime.wait(runId, 100);
  assert(result.status === 'timeout', `状态 timeout（实际 ${result.status}）`);
  assert(Date.now() - t0 < 1000, '超时及时返回');
  const status = await runtime.getStatus(runId);
  assert(status.status === 'timeout', `超时后状态不被覆盖（实际 ${status.status}）`);
}

async function testCancel() {
  console.log('\n[8] 取消');
  const { runtime } = makeRuntime({ delay: 5000 });
  const { runId } = await runtime.spawn({ parentRunId: 'root', task: 'long' });
  await new Promise(r => setTimeout(r, 20));
  await runtime.cancel(runId);
  const result = await runtime.wait(runId, 1000);
  assert(result.status === 'cancelled', `wait 返回 cancelled（实际 ${result.status}）`);
  const status = await runtime.getStatus(runId);
  assert(status.status === 'cancelled', `取消后状态不被覆盖为 completed（实际 ${status.status}）`);
}

async function main() {
  console.log('SubagentRuntime 单元测试');
  const t0 = Date.now();
  const tests = [testSpawnWait, testContextIsolation, testToolWhitelist, testConcurrencyLimit,
    testDepthLimit, testFailure, testTimeout, testCancel];
  for (const t of tests) {
    try {
      await t();
    } catch (e: any) {
      failed++;
      console.log(`  ❌ 未捕获异常: ${e.message}`);
    }
  }
  console.log(`\n结果：${passed} 通过，${failed} 失败（${Date.now() - t0}ms）`);
  // 不调用 process.exit：若有悬挂定时器，进程会卡住，借此暴露泄漏
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
