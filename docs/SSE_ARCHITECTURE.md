# Plain-Agent SSE 架构文档

## 概述

Plain-Agent 使用 **Server-Sent Events (SSE)** 实现客户端与服务端的实时通信。架构参考了 any-code 的成熟实践，核心特性：

- **常驻 Agent**：Agent 不随任务结束销毁，由 Manager 常驻管理
- **事件历史 + seq**：每个会话维护累积事件历史，seq 为数组下标
- **断线续传**：客户端用 `since=seq` 参数重放历史事件
- **队列支持**：运行中收到新任务自动入队，前任务结束后接续执行

---

## 架构分层

```
┌─────────────────────────────────────────────────┐
│  Client (Desktop/Web)                           │
│  - EventSource 连接 SSE                         │
│  - 维护 lastSeq，断线时用 since 续传            │
└────────────────┬────────────────────────────────┘
                 │ HTTP + SSE
┌────────────────▼────────────────────────────────┐
│  HTTP Layer (app.ts)                            │
│  - POST /api/sessions/:id/run   → 新任务 + SSE  │
│  - GET  /api/sessions/:id/stream?since=N → 重挂 │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│  AgentManager (manager.ts)                      │
│  - 管理所有 Agent 实例（不随任务销毁）          │
│  - 维护每个会话的事件历史 (StreamFrame[])       │
│  - 订阅/广播机制（subs: Set<callback>）         │
│  - 任务队列（running 时新任务入队）             │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│  PlainAgent (domain/agent.ts)                   │
│  - 执行任务，emit AgentEvent                    │
│  - 事件类型：thinking/tool_call/tool_result/   │
│              text/interaction/done/error...     │
└─────────────────────────────────────────────────┘
```

---

## 核心数据结构

### 1. StreamFrame（SSE 帧格式）

```typescript
interface StreamFrame {
  seq: number;        // 会话累积事件历史下标（从 0 开始）
  event: AgentEvent;  // Agent 发出的事件
}
```

**SSE 传输格式**：
```
data: {"seq":0,"event":{"type":"thinking","content":"开始执行...","timestamp":1234567890}}\n\n
data: {"seq":1,"event":{"type":"tool_call","name":"bash","args":{...}}}\n\n
: keepalive\n\n
data: {"seq":2,"event":{"type":"done","timestamp":1234567891}}\n\n
```

### 2. AgentEvent（事件类型）

```typescript
type AgentEvent =
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_call'; name: string; args: unknown; id: string }
  | { type: 'tool_result'; result: string; id: string }
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'interaction'; id: string; question: string; options: unknown[] }
  | { type: 'done'; timestamp: number }
  | { type: 'error'; error: string; timestamp: number }
  | { type: 'stopped'; timestamp: number }
  | { type: 'task-end'; timestamp: number }
  | ...
```

### 3. Manager Entry（会话条目）

```typescript
interface Entry {
  agent: AgentLike;                      // Agent 实例
  history: AgentEvent[];                 // 累积事件历史（seq = 下标）
  subs: Set<(frame: StreamFrame) => void>; // SSE 订阅者
  record: (event: AgentEvent) => void;   // 事件记录函数
  running: boolean;                      // 是否有任务在跑
  queue: string[];                       // 任务队列
}
```

---

## 关键流程

### 流程 1：提交任务（POST /api/sessions/:id/run）

```
客户端                     HTTP Layer                AgentManager              PlainAgent
  │                            │                          │                       │
  │─POST /run {task}──────────▶│                          │                       │
  │                            │──run(sessionId, task)───▶│                       │
  │                            │                          │──ensureEntry()        │
  │                            │                          │──exec(entry, task)───▶│
  │                            │◀─startSeq: 5─────────────│                       │
  │                            │                          │                       │
  │◀─SSE stream start──────────│                          │                       │
  │                            │──subscribe(send)────────▶│                       │
  │                            │──frames().replay────────▶│                       │
  │◀─data: {seq:5, event}──────│◀─send(frame)─────────────│◀─emit('event')───────│
  │◀─data: {seq:6, event}──────│◀─send(frame)─────────────│◀─emit('event')───────│
  │◀─data: {seq:7, "done"}─────│◀─send(frame)─────────────│◀─emit('event')───────│
  │◀─[stream closed]───────────│──unsub()────────────────▶│                       │
```

**代码片段**：
```typescript
// app.ts:110
app.post('/api/sessions/:sessionId/run', async (c) => {
  const { startSeq } = manager.run(sessionId, body.task.trim());
  
  return stream(c, async (s) => {
    // 1. 设置 SSE 响应头
    for (const [k, v] of Object.entries(SSE_HEADERS)) c.header(k, v);
    
    // 2. 订阅实时事件
    const unsub = manager.subscribe(sessionId, send);
    
    // 3. 重放 startSeq 之后的历史（不漏不重）
    for (const frame of manager.frames(sessionId)) {
      if (frame.seq >= startSeq && replayable(frame)) send(frame);
    }
  });
});
```

### 流程 2：断线续传（GET /api/sessions/:id/stream?since=N）

```
客户端                     HTTP Layer                AgentManager
  │                            │                          │
  │─GET /stream?since=7───────▶│                          │
  │                            │──frames()───────────────▶│
  │◀─SSE stream start──────────│                          │
  │◀─data: {seq:8, event}──────│◀─replay history──────────│
  │◀─data: {seq:9, event}──────│◀─replay history──────────│
  │◀─data: {seq:10, event}─────│◀─send(live)──────────────│
  │◀─data: {seq:11, "done"}────│◀─send(live)──────────────│
  │◀─[stream closed]───────────│──unsub()────────────────▶│
```

**关键点**：
- `since=N`：重放 `seq > N` 的历史事件
- **先订阅再重放**（中间无 await）：确保不漏帧
- **过滤已回答的 interaction**：避免重挂时重复弹权限窗

### 流程 3：任务队列（运行中提交新任务）

```
客户端A                    AgentManager              PlainAgent
  │                            │                       │
  │─run(task1)────────────────▶│                       │
  │                            │──exec(task1)─────────▶│ [running=true]
  │                            │                       │
客户端B                        │                       │
  │─run(task2)────────────────▶│                       │
  │                            │──queue.push(task2)    │ [入队]
  │◀─{status: "queued"}────────│                       │
  │                            │                       │
  │                            │◀─emit('done')─────────│ [task1 完成]
  │                            │──exec(task2)─────────▶│ [自动接续]
```

**代码片段**：
```typescript
// manager.ts:92
run(sessionId: string, task: string) {
  const entry = this.ensureEntry(sessionId);
  const startSeq = entry.history.length;
  
  if (entry.running) {
    entry.queue.push(task);
    return { status: 'queued', startSeq };
  }
  
  void this.exec(entry, task);
  return { status: 'started', startSeq };
}

// manager.ts:108 (exec 结束后)
private async exec(entry: Entry, task: string) {
  entry.running = true;
  await entry.agent.submit(task);
  entry.running = false;
  
  // 自动接续队列中的下一个任务
  const next = entry.queue.shift();
  if (next) void this.exec(entry, next);
}
```

---

## 不漏帧保证

### 问题：重放与订阅的时序竞态

```
错误做法（会漏帧）：
1. 重放历史 (await for...)
2. 订阅实时事件
→ 重放期间新产生的事件会被漏掉
```

### 解决方案：先订阅再重放（无 await 间隙）

```typescript
// app.ts:140
const unsub = manager.subscribe(sessionId, send);  // 先订阅
for (const frame of manager.frames(sessionId)) {   // 再重放（同步）
  if (frame.seq >= startSeq) send(frame);
}
```

**原理**：
- `subscribe()` 立即生效，后续 `agent.emit()` 的事件会被捕获
- `frames()` 返回当前快照，重放是同步的（无 await）
- 订阅与重放之间没有异步间隙 → 不漏不重

---

## 终态事件与流关闭

### 终态事件集合

```typescript
const TERMINAL_EVENTS = new Set([
  'done',      // 任务正常完成
  'task-end',  // 任务结束（可能多轮对话后）
  'error',     // 执行出错
  'stopped'    // 用户主动停止
]);
```

### 流关闭逻辑

```typescript
const send = (frame: StreamFrame) => {
  void s.write(`data: ${JSON.stringify(frame)}\n\n`).then(() => {
    if (TERMINAL_EVENTS.has(frame.event.type)) {
      finish();  // 关闭流、清理订阅、停止 keepalive
    }
  });
};
```

---

## Keepalive 机制

```typescript
// app.ts:134
const keepalive = setInterval(() => {
  if (!closed) void s.write(': keepalive\n\n');
}, 15000);  // 每 15 秒发送一个注释帧
```

**作用**：
- 防止反向代理（nginx/cloudflare）超时断连
- 客户端检测连接是否存活

---

## 重放过滤（interaction 去重）

### 问题

断线重连时，已经回答过的权限询问（interaction）会重复弹窗。

### 解决方案

```typescript
// app.ts:42
function replayable(frame: StreamFrame): boolean {
  if (frame.event.type === 'interaction') {
    return hasPendingInteraction(frame.event.id);  // 仅重放未回答的
  }
  return true;
}

// 重放时应用过滤
for (const frame of manager.frames(sessionId)) {
  if (frame.seq >= startSeq && replayable(frame)) send(frame);
}
```

---

## API 端点总览

| 端点 | 方法 | 功能 | 返回 |
|------|------|------|------|
| `/api/sessions` | POST | 创建会话 | `{sessionId}` |
| `/api/sessions` | GET | 列出所有会话 | `{sessions: [...]}` |
| `/api/sessions/:id` | PATCH | 重命名会话 | `{ok: true}` |
| `/api/sessions/:id` | DELETE | 删除会话 | `{ok: true}` |
| `/api/sessions/:id/run` | POST | 提交任务 → SSE 流 | SSE stream |
| `/api/sessions/:id/stream?since=N` | GET | 断线续传 → SSE 流 | SSE stream |
| `/api/sessions/:id/queue` | POST | 提交任务（不等待） | `{status, startSeq}` |
| `/api/sessions/:id/queue` | GET | 查看队列 | `{queued: [...]}` |
| `/api/sessions/:id/stop` | POST | 停止任务 | `{ok: true}` |
| `/api/sessions/:id/messages` | GET | 获取对话历史 | `{messages: [...]}` |
| `/api/sessions/:id/events` | GET | 获取事件历史 | `{events: [...]}` |
| `/api/sessions/:id/compact` | POST | 压缩历史 | `{ok: true}` |
| `/api/sessions/:id/interact` | POST | 回答 interaction | `{ok: true}` |

---

## 客户端集成示例

### Desktop (React + EventSource)

```typescript
// desktop/src/renderer/src/App.tsx 片段
const eventSource = new EventSource(
  `${API_URL}/api/sessions/${sessionId}/stream?since=${lastSeq}`
);

eventSource.onmessage = (e) => {
  const frame: StreamFrame = JSON.parse(e.data);
  setLastSeq(frame.seq);  // 持久化 lastSeq，断线时续传
  
  switch (frame.event.type) {
    case 'thinking':
      setStatus(frame.event.content);
      break;
    case 'text':
      appendMessage(frame.event.content);
      break;
    case 'done':
      setRunning(false);
      eventSource.close();
      break;
  }
};

eventSource.onerror = () => {
  // 自动重连（浏览器会重试，或手动重建 EventSource）
  setTimeout(() => reconnect(), 3000);
};
```

---

## 性能优化

### 1. 事件历史清理

**问题**：长会话的 `history[]` 会无限增长

**方案**：
- 定期调用 `/api/sessions/:id/compact` 压缩历史
- Manager 保留最近 N 个事件（如 1000），旧事件写入存储后删除

### 2. 订阅者清理

```typescript
// 客户端断连时自动清理
c.req.raw.signal.addEventListener('abort', () => {
  unsub();  // 从 subs Set 中移除
}, { once: true });
```

### 3. Keepalive 开销

- 15 秒一次注释帧，单会话开销 ~100 bytes/15s
- 1000 并发会话 ≈ 6.7 KB/s，可接受

---

## 与 WebSocket 对比

| 特性 | SSE | WebSocket |
|------|-----|-----------|
| **协议** | HTTP (单向推送) | 独立协议（双向） |
| **断线续传** | ✅ seq + since 天然支持 | ❌ 需自行实现 |
| **代理兼容** | ✅ 标准 HTTP，透传容易 | ⚠️ 部分代理不支持 Upgrade |
| **浏览器支持** | ✅ 原生 EventSource | ✅ 原生 WebSocket |
| **实现复杂度** | ✅ 简单（Hono stream） | ⚠️ 需处理心跳/重连 |
| **双向通信** | ❌ 需额外 POST 端点 | ✅ 天然双向 |

**Plain-Agent 选择 SSE 的原因**：
- Agent 任务是**单向推送**为主（服务端 → 客户端）
- **seq 机制**让断线续传极简（WebSocket 需自己维护状态）
- **标准 HTTP**，代理/防火墙兼容性好

---

## 常见问题

### Q1: 为什么不用 WebSocket？

A: SSE 更适合单向推送场景，seq 机制天然支持续传。WebSocket 需要自己实现断线重连和消息去重逻辑。

### Q2: history[] 会无限增长吗？

A: 目前是的。生产环境需实现定期清理（保留最近 N 个事件，旧事件落库）。

### Q3: 多客户端连接同一会话会怎样？

A: 所有客户端都会收到实时事件（广播）。但 interaction 回答是全局的，一个客户端回答后其他客户端看不到弹窗（`replayable()` 过滤）。

### Q4: 如何处理慢客户端？

A: 当前实现是内存广播（同步调用 `send()`）。如果某个客户端写入慢（网络差），会阻塞其他订阅者。生产环境可改为异步队列 + 背压控制。

---

## 总结

Plain-Agent 的 SSE 架构设计精炼且健壮：

✅ **seq 机制** → 断线续传语义清晰  
✅ **先订阅再重放** → 不漏不重保证  
✅ **终态自动关流** → 资源自动清理  
✅ **任务队列** → 支持并发提交  
✅ **interaction 过滤** → 避免重复弹窗  

核心思想：**事件流 = 可重放的有序日志**，客户端通过 `since=seq` 随时追上最新状态。
