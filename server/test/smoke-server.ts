/**
 * server 冒烟测试：注入 fake agent，经 app.request() 走真实路由
 * 运行：node ../node_modules/tsx/dist/cli.mjs test/smoke-server.ts
 */
import { EventEmitter } from 'events';
import { MemoryStorage } from '@plain-agent/domain';
import type { AgentEvent } from '@plain-agent/domain';
import { AgentManager } from '../src/manager';
import { buildApp } from '../src/app';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

/** 可控 fake agent：submit 依次发 task-start/text_delta/assistant/task-end */
class FakeAgent extends EventEmitter {
  submitted: string[] = [];
  stopped = false;
  compressed = false;
  destroyed = false;
  private gate: Promise<void> | null = null;

  constructor(private sessionId: string) {
    super();
  }

  /** 设置闸门：submit 阻塞直到 release（测试排队/停止用，默认永不放行） */
  blockOnGate(): void {
    this.gate = new Promise(() => {});
  }

  async submit(task: string): Promise<void> {
    this.submitted.push(task);
    const ts = Date.now();
    this.emit('event', { type: 'task-start', taskId: 't1', task, timestamp: ts } as AgentEvent);
    if (this.gate) await this.gate;
    this.emit('event', { type: 'text_delta', delta: `echo:${task}`, timestamp: ts } as AgentEvent);
    this.emit('event', { type: 'assistant', message: `echo:${task}`, timestamp: ts } as AgentEvent);
    this.emit('event', { type: 'task-end', taskId: 't1', timestamp: ts } as AgentEvent);
  }

  stop(): void { this.stopped = true; this.emit('event', { type: 'stopped', timestamp: Date.now() } as AgentEvent); }
  destroy(): void { this.destroyed = true; }
  getSessionId(): string { return this.sessionId; }
  getMessages(): { role: string }[] { return [{ role: 'user' }]; }
  async compressHistory(): Promise<void> { this.compressed = true; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 读 SSE 响应直到收集到 terminal 帧（或超时） */
async function readSse(res: Response, timeoutMs = 3000): Promise<{ seqs: number[]; raw: string; types: string[] }> {
  const seqs: number[] = [];
  const types: string[] = [];
  let raw = '';
  let consumed = 0; // 已解析到的字节位置，避免每次重扫全量累积
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      sleep(timeoutMs).then(() => ({ done: true, value: undefined }) as const),
    ]);
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    const complete = raw.slice(0, raw.lastIndexOf('\n') + 1); // 只解析完整行
    for (const line of complete.slice(consumed).split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const frame = JSON.parse(line.slice(6));
          if (typeof frame.seq === 'number') {
            seqs.push(frame.seq);
            types.push(frame.event?.type ?? '?');
          }
        } catch { /* keepalive 等 */ }
      }
    }
    consumed = complete.length;
    if (types.some((t) => ['task-end', 'done', 'error', 'stopped'].includes(t))) break;
  }
  reader.cancel().catch(() => {});
  return { seqs, raw, types };
}

const post = (app: ReturnType<typeof buildApp>, url: string, body: unknown) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body) });

(async () => {
  const storage = new MemoryStorage();
  let fake: FakeAgent | null = null;
  const manager = new AgentManager({
    storage,
    createAgent: (sessionId) => {
      fake = new FakeAgent(sessionId);
      return fake;
    },
  });
  const app = buildApp({
    manager,
    storage,
    info: { model: 'test', toolCount: 20, persisted: false, project: '/tmp/proj' },
  });

  // 建会话
  const resCreate = await post(app, '/api/sessions', { title: 't1' });
  const { sessionId } = await resCreate.json() as { sessionId: string };
  check('创建会话', resCreate.status === 201 && !!sessionId);

  const resList = await app.request('/api/sessions');
  const { sessions } = await resList.json() as { sessions: { id: string }[] };
  check('会话列表', sessions.length === 1 && sessions[0].id === sessionId);

  // run → SSE：帧带连续 seq，含 task-start 与 task-end
  const resRun = await post(app, `/api/sessions/${sessionId}/run`, { task: 'hello' });
  check('run 响应是 SSE', resRun.headers.get('content-type')?.includes('text/event-stream') ?? false);
  const run1 = await readSse(resRun);
  check('run 帧 seq 从 0 连续', run1.seqs.length > 0 && run1.seqs[0] === 0 && run1.seqs.every((s, i) => s === i), JSON.stringify(run1.seqs));
  check('run 帧含 task-start/task-end', run1.types.includes('task-start') && run1.types.includes('task-end'), run1.types.join(','));
  check('fake 收到任务', fake!.submitted.includes('hello'));

  // 第二个任务 → seq 接续（累积不清空），回放不含旧帧
  const resRun2 = await post(app, `/api/sessions/${sessionId}/run`, { task: 'world' });
  const run2 = await readSse(resRun2);
  check('第二 run 回放从上一水位开始', run2.seqs.length > 0 && run2.seqs[0] === run1.seqs.length, JSON.stringify(run2.seqs));
  check('第二 run 含新任务文本', run2.raw.includes('echo:world'));

  // 续传：since=1 → 从 seq=2 开始重放
  const resStream = await app.request(`/api/sessions/${sessionId}/stream?since=1`);
  check('stream 响应是 SSE', resStream.headers.get('content-type')?.includes('text/event-stream') ?? false);
  const replay = await readSse(resStream);
  check('since=1 重放 seq>=2', replay.seqs.length > 0 && replay.seqs[0] === 2, JSON.stringify(replay.seqs));

  // 未知会话续传 → 404
  const res404 = await app.request('/api/sessions/nope/stream');
  check('未知会话 stream 404', res404.status === 404);

  // 排队：闸门挡住第一个任务，第二个进队列
  fake!.blockOnGate();
  const q1 = await (await post(app, `/api/sessions/${sessionId}/queue`, { task: 'blocked' })).json() as { status: string };
  check('空闲时 queue 立即执行', q1.status === 'started');
  await sleep(50); // 等 submit 进入闸门
  const q2 = await (await post(app, `/api/sessions/${sessionId}/queue`, { task: 'queued-task' })).json() as { status: string };
  check('运行中 queue 入队', q2.status === 'queued');
  const { queued } = await (await app.request(`/api/sessions/${sessionId}/queue`)).json() as { queued: string[] };
  check('队列内容可见', queued.includes('queued-task'));
  const { running } = await (await app.request('/api/running')).json() as { running: string[] };
  check('running 列表', running.includes(sessionId));

  // 停止：清空队列并发 stopped
  const resStop = await post(app, `/api/sessions/${sessionId}/stop`, {});
  check('stop 200', resStop.status === 200);
  await sleep(50);
  check('agent 收到 stop', fake!.stopped === true);
  const { queued: queued2 } = await (await app.request(`/api/sessions/${sessionId}/queue`)).json() as { queued: string[] };
  check('stop 清空队列', queued2.length === 0);

  // interact / compact / messages
  const resInteract = await post(app, `/api/sessions/${sessionId}/interact`, { interactionId: 'x', answers: ['a'] });
  check('interact 200', resInteract.status === 200);
  const resCompact = await post(app, `/api/sessions/${sessionId}/compact`, {});
  check('compact 200', resCompact.status === 200 && fake!.compressed === true);
  const resMsgs = await app.request(`/api/sessions/${sessionId}/messages`);
  check('messages 200', resMsgs.status === 200);

  // 删除会话：agent 销毁
  const resDel = await app.request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  check('删除会话', resDel.status === 200 && fake!.destroyed === true && !manager.has(sessionId));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
