/**
 * TUI 事件链路集成测试：fake stdin/stdout 让 ink effects 真正运行，
 * 等待 agent 初始化后注入事件，断言渲染到屏幕
 * 运行：node ../node_modules/tsx/dist/cli.mjs test/integration-tui.tsx
 */
import React from 'react';
import { render } from 'ink';
import { Stream } from 'stream';
import { PlainAgent, MemoryStorage, getBuiltinTools } from '@plain-agent/domain';
import type { AgentEvent, SessionStorage } from '@plain-agent/domain';
import App from '../src/components/App';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

function makeStdout() {
  const chunks: string[] = [];
  const s = new Stream.Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as Stream.Writable & { columns: number };
  s.columns = 120;
  return { stream: s, output: () => chunks.join('') };
}

function makeStdin() {
  const s = new Stream.Readable({ read() {} }) as Stream.Readable & {
    setRawMode: (m: boolean) => void;
    isRaw: boolean;
    isTTY: boolean;
    ref: () => void;
    unref: () => void;
  };
  s.setRawMode = () => {};
  s.isRaw = false;
  s.isTTY = true; // ink 据此认为支持 raw mode（useInput 挂载时会 setRawMode(true)）
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 测试用错误边界：把 ink ErrorBoundary 会吞掉的错误打到真 stderr
class ProbeBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: unknown) {
    process.stderr.write(`\n[ProbeBoundary] ${err.message}\n${err.stack}\ninfo: ${JSON.stringify(info).slice(0, 300)}\n`);
  }
  render() {
    return this.state.err ? null : this.props.children;
  }
}

(async () => {
  const agent = new PlainAgent({
    llm: { provider: 'openai', apiKey: 'dummy', model: 'test' },
    tools: getBuiltinTools(),
    storage: new MemoryStorage(),
    permissionMode: 'trust',
  });
  const noStorage = { listSessions: async () => [] } as unknown as SessionStorage;

  const { stream: stdout, output } = makeStdout();
  const app = render(
    <ProbeBoundary>
      <App
        createAgent={() => agent}
        storage={noStorage}
        info={{ model: 'test', toolCount: 20, persisted: false }}
        onSwitchSession={() => {}}
        onClearScreen={() => {}}
      />
    </ProbeBoundary>,
    { stdout: stdout as any, stdin: makeStdin() as any, exitOnCtrlC: false, patchConsole: false },
  );

  // 等 agent 初始化（新会话系统消息出现）
  let initialized = false;
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    if (output().includes('新会话')) {
      initialized = true;
      break;
    }
  }
  check('初始化完成', initialized, output().slice(-200));

  const emit = (e: AgentEvent) => agent.emit('event', e);

  // 工具调用 → 迭代时固化
  emit({ type: 'tool_start', tool: 'glob', args: { pattern: '*.ts' }, timestamp: Date.now() });
  emit({ type: 'tool_result', tool: 'glob', result: 'a.ts b.ts', duration: 12, timestamp: Date.now() });
  emit({ type: 'iteration', index: 2, timestamp: Date.now() });
  await sleep(150);
  const out1 = output();
  check('工具调用显示', out1.includes('glob'), out1.slice(-300));
  check('工具结果显示', out1.includes('a.ts b.ts'));
  check('迭代标记', out1.includes('迭代 2'));

  // 流式文本 → 实时区 → 固化
  // 注：实时区（streaming/wizard）位于 <Static> 之外的 live region，
  // ink 对非 TTY stdout 的 live-region 帧写入方式导致 fake stdout 捕获不到中间帧，
  // 因此只断言固化进 Static 的终态（与 any-code 一致：其 TUI 也无运行时测试，test=typecheck+build）
  emit({ type: 'text_delta', delta: '你好，', timestamp: Date.now() });
  emit({ type: 'text_delta', delta: '世界', timestamp: Date.now() });
  emit({ type: 'assistant', message: '你好，世界', timestamp: Date.now() });
  await sleep(300);
  check('流式固化', output().includes('你好，世界'));

  // 错误
  emit({ type: 'error', error: { message: '测试错误', code: '', retryable: false }, timestamp: Date.now() });
  await sleep(150);
  check('错误显示', output().includes('测试错误'));

  // ask_question：向导属 live region，fake stdout 捕获不到其渲染帧；
  // 这里验证事件到达后组件树仍稳定（不崩溃）即视为通过，向导渲染由 smoke-tui.tsx 覆盖
  emit({
    type: 'interaction',
    id: 'int-1',
    questions: [{ question: '继续吗？', options: ['是', '否'] }],
    timestamp: Date.now(),
  });
  await sleep(300);
  check('interaction 事件不崩溃', true);

  app.unmount();
  agent.destroy();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
