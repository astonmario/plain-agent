/**
 * agentLoop 单元测试（不调用真实 LLM：stub 全局 fetch 返回伪造 SSE）
 *
 * 验证：
 * 1. 使用传入的 LLMConfig（而非 process.env）
 * 2. 同轮可并发工具并行执行，不可并发工具保持顺序且独占
 * 3. tool 消息按 tool_calls 原顺序入历史；事件带 callId
 * 4. 中断时未执行的 tool_call 补"已取消"，历史保持合法
 */

import { agentLoop } from '../src/loop';
import type { AgentEvent, ChatMessage, LLMConfig, Tool, ToolCall, ToolContext } from '../src/types';

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

// ============ fetch stub ============

interface FetchRecord { url: string; auth: string; body: any }
const fetchLog: FetchRecord[] = [];
/** 每次请求依次弹出一个响应：tool_calls 数组或最终文本 */
let scripted: Array<ToolCall[] | string> = [];

function sseResponse(reply: ToolCall[] | string): Response {
  const delta = typeof reply === 'string'
    ? { content: reply }
    : {
        tool_calls: reply.map((c, index) => ({
          index, id: c.id, type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
      };
  const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

globalThis.fetch = (async (url: any, init: any) => {
  fetchLog.push({
    url: String(url),
    auth: init?.headers?.Authorization ?? '',
    body: JSON.parse(init?.body ?? '{}'),
  });
  const next = scripted.shift();
  if (next === undefined) throw new Error('no scripted response left');
  return sseResponse(next);
}) as typeof fetch;

// ============ helpers ============

const LLM: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-from-config',
  model: 'model-from-config',
  baseUrl: 'https://llm.example.test/v1',
};

function call(id: string, name: string, args: object = {}): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** 记录执行区间的工具：sleep ms 后返回 */
function timedTool(name: string, ms: number, meta: Tool['meta'], log: Array<{ name: string; start: number; end: number }>): Tool {
  return {
    name,
    description: name,
    schema: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
    meta,
    handler: async () => {
      const start = Date.now();
      await new Promise(r => setTimeout(r, ms));
      log.push({ name, start, end: Date.now() });
      return `${name}-result`;
    },
  };
}

function makeCtx(events: AgentEvent[], controller = new AbortController()): ToolContext {
  return {
    signal: controller.signal,
    sessionId: 's',
    emitEvent: (e) => events.push(e),
  };
}

// ============ tests ============

async function testUsesConfig() {
  console.log('\n[1] 使用传入的 LLMConfig');
  const savedKey = process.env.API_KEY;
  const savedUrl = process.env.BASE_URL;
  process.env.API_KEY = 'sk-from-env';
  process.env.BASE_URL = 'https://env.example.test';
  try {
    fetchLog.length = 0;
    scripted = ['hello'];
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const result = await agentLoop('hi', messages, makeCtx([]), [], LLM);
    assert(result.result === 'hello', '返回最终回答');
    assert(fetchLog[0]?.url === 'https://llm.example.test/v1/chat/completions', `请求发往配置的 baseUrl（${fetchLog[0]?.url}）`);
    assert(fetchLog[0]?.auth === 'Bearer sk-from-config', '使用配置的 apiKey（不是环境变量）');
    assert(fetchLog[0]?.body.model === 'model-from-config', '使用配置的 model');
  } finally {
    process.env.API_KEY = savedKey;
    process.env.BASE_URL = savedUrl;
  }
}

async function testBatching() {
  console.log('\n[2] 批次执行：并发工具并行，有副作用工具独占且保序');
  const log: Array<{ name: string; start: number; end: number }> = [];
  const tools = [
    timedTool('read_a', 150, { readonly: true }, log),
    timedTool('read_b', 150, { readonly: true }, log),
    timedTool('write_c', 50, { readonly: false }, log),
    timedTool('read_d', 50, { readonly: true }, log),
    timedTool('ask', 50, { readonly: true, concurrent: false }, log),
  ];
  scripted = [
    [call('c1', 'read_a'), call('c2', 'read_b'), call('c3', 'write_c'), call('c4', 'read_d'), call('c5', 'ask')],
    'done',
  ];
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  const t0 = Date.now();
  await agentLoop('go', messages, makeCtx(events), tools, LLM);
  const elapsed = Date.now() - t0;

  const by = (n: string) => log.find(l => l.name === n)!;
  const a = by('read_a'), b = by('read_b'), c = by('write_c'), d = by('read_d'), ask = by('ask');
  assert(b.start < a.end && a.start < b.end, 'read_a 与 read_b 并行');
  assert(c.start >= Math.max(a.end, b.end), 'write_c 在前一批全部完成后才开始');
  assert(d.start >= c.end, 'read_d 在 write_c 之后（不越过有副作用的工具）');
  assert(ask.start >= d.end, 'concurrent:false 的只读工具也独占执行');
  assert(elapsed < 150 + 150 + 50 + 50 + 50, `总耗时短于全串行（${elapsed}ms）`);

  const toolMsgs = messages.filter(m => m.role === 'tool');
  assert(toolMsgs.map(m => m.tool_call_id).join(',') === 'c1,c2,c3,c4,c5', 'tool 消息按 tool_calls 原顺序');
  assert(toolMsgs[0].content === 'read_a-result', 'tool 消息内容对应正确');

  const starts = events.filter(e => e.type === 'tool_start') as Array<Extract<AgentEvent, { type: 'tool_start' }>>;
  const results = events.filter(e => e.type === 'tool_result') as Array<Extract<AgentEvent, { type: 'tool_result' }>>;
  assert(starts.every(e => !!e.callId) && results.every(e => !!e.callId), 'tool_start / tool_result 都带 callId');
  assert(results.find(e => e.callId === 'c2')?.result === 'read_b-result', 'callId 与结果对应');
}

async function testAbortFillsCancelled() {
  console.log('\n[3] 中断时补齐 tool 消息');
  const controller = new AbortController();
  const log: Array<{ name: string; start: number; end: number }> = [];
  const stopper: Tool = {
    ...timedTool('write_x', 10, { readonly: false }, log),
    handler: async () => { controller.abort(); return 'x-result'; },
  };
  const tools = [stopper, timedTool('write_y', 10, { readonly: false }, log)];
  scripted = [[call('k1', 'write_x'), call('k2', 'write_y')]];
  const events: AgentEvent[] = [];
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  const result = await agentLoop('go', messages, makeCtx(events, controller), tools, LLM);

  assert(result.stopReason === 'stopped', '返回 stopped');
  const toolMsgs = messages.filter(m => m.role === 'tool');
  assert(toolMsgs.length === 2, `每个 tool_call 都有 tool 消息（${toolMsgs.length}/2）`);
  assert(toolMsgs[0].content === 'x-result' && toolMsgs[1].content === '[已取消]', '已执行的保留结果，未执行的标记已取消');
  assert(!log.some(l => l.name === 'write_y'), 'write_y 未执行');
  assert(events.some(e => e.type === 'stopped'), '发出 stopped 事件');
}

async function main() {
  console.log('agentLoop 单元测试');
  for (const t of [testUsesConfig, testBatching, testAbortFillsCancelled]) {
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
