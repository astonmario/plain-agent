# 事件系统设计说明

## 概述

PlainAgent 基于 Node.js `EventEmitter` 实现了一套完整的事件系统，用于将 Agent 执行过程中的各种状态变化、工具调用、LLM 响应等信息实时传递给外部消费者（如 UI、日志系统、监控系统）。

## 核心设计原则

### 1. 事件即数据源

事件不仅用于实时通知，也是数据持久化的来源：

- **实时性**：事件通过 `EventEmitter` 立即发射，消费者可实时响应
- **持久化**：事件同时异步保存到 `SessionStorage`，用于会话恢复和审计
- **解耦**：持久化失败不影响事件发射，保证系统健壮性

### 2. 先发射，后持久化

事件处理流程：

```typescript
private emitEvent(event: AgentEvent): void {
  // 1. 异步持久化（可选，不阻塞发射）
  if (this.storage && event.type !== 'text_delta') {
    this.storage.saveEvent(this.sessionId, event).catch(err => {
      console.error('Failed to save event:', err);
    });
  }

  // 2. 立即发射给监听者
  this.emit('event', event);
}
```

**为什么不等待持久化完成？**

- 避免阻塞 Agent 执行流程
- 持久化失败不应导致整个任务失败
- UI 需要立即响应，不能等待数据库写入

### 3. text_delta 不持久化

`text_delta` 事件是流式输出的中间状态，特点：

- **数量大**：每次 LLM 生成几个 token 就触发一次
- **可还原**：最终的 `assistant` 消息包含完整文本
- **仅供实时显示**：用于 UI 打字机效果

因此 `text_delta` 仅发射不持久化，减少存储压力。

## 事件类型

### 任务级事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `task-start` | `submit()` 开始执行任务 | 标记任务开始，包含任务 ID 和描述 |
| `task-end` | `submit()` 执行完成 | 标记任务结束（成功或失败都会触发） |
| `error` | 捕获到异常 | 序列化后的错误信息 |
| `stopped` | 任务被中断 | 用户主动停止或超时 |

### 执行级事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `iteration` | ReAct 循环每次迭代开始 | 显示当前迭代次数 |
| `thinking` | LLM 开始推理 | 显示"正在思考..."状态 |
| `assistant` | LLM 完成一次响应 | 包含完整的 LLM 输出文本 |
| `text_delta` | LLM 流式输出的增量文本 | 实现打字机效果（不持久化） |

### 工具级事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `tool_start` | 工具开始执行 | 显示工具名称和参数 |
| `tool_result` | 工具执行完成 | 显示工具执行结果 |

### 系统级事件

| 事件类型 | 触发时机 | 用途 |
|---------|---------|------|
| `compression` | 历史压缩完成 | 显示压缩前后的 token 使用情况 |
| `session-warning` | 会话出现警告（过长、重复等） | 提示用户采取行动 |

## 事件流转示例

### 正常任务执行

```
task-start
  ├─ thinking (LLM 开始推理)
  ├─ text_delta (流式输出，多次)
  ├─ assistant (完整响应)
  ├─ tool_start (bash)
  ├─ tool_result
  ├─ thinking
  ├─ assistant
  └─ task-end
```

### 带压缩的任务执行

```
task-start
  ├─ thinking (检测到压缩触发条件)
  ├─ compression (level=2, tokensBefore=7500, tokensAfter=4200)
  ├─ thinking (压缩完成)
  ├─ thinking (LLM 开始推理)
  ├─ assistant
  └─ task-end
```

### 错误处理

```
task-start
  ├─ thinking
  ├─ tool_start (bash)
  ├─ error (工具执行失败)
  └─ task-end
```

## 事件发射点

### 在 agent.ts 中

| 位置 | 事件类型 | 说明 |
|------|---------|------|
| `submit()` 开始 | `task-start` | 任务入口 |
| 压缩检测 | `thinking` | 通知用户压缩原因 |
| 压缩完成 | `compression` | 统计信息 |
| 压缩后 | `thinking` | 压缩结果摘要 |
| 会话过长 | `session-warning` | 建议开启新会话 |
| `submit()` 结束 | `task-end` | 任务出口 |
| 异常捕获 | `error` | 错误处理 |
| 后台任务恢复 | `thinking` | 应用重启后检测到待回注的任务 |

### 在 loop.ts 中

| 位置 | 事件类型 | 说明 |
|------|---------|------|
| ReAct 循环开始 | `iteration` | 每次迭代 |
| LLM 调用前 | `thinking` | 开始推理 |
| 流式输出 | `text_delta` | 增量文本（不持久化） |
| LLM 响应完成 | `assistant` | 完整响应 |
| 工具执行前 | `tool_start` | 工具名称和参数 |
| 工具执行后 | `tool_result` | 执行结果 |
| 达到最大迭代 | `stopped` | 超出限制 |
| 检测到中断信号 | `stopped` | 用户取消 |

## 消费者示例

### CLI/TUI 显示

```typescript
agent.on('event', (event) => {
  switch (event.type) {
    case 'task-start':
      console.log(`🚀 任务开始: ${event.task}`);
      break;

    case 'thinking':
      console.log(`💭 ${event.content}`);
      break;

    case 'tool_start':
      console.log(`🔧 执行工具: ${event.tool}`);
      break;

    case 'tool_result':
      console.log(`✅ 工具结果: ${event.result.substring(0, 100)}...`);
      break;

    case 'text_delta':
      // 流式打字机效果
      process.stdout.write(event.delta);
      break;

    case 'assistant':
      console.log(`\n🤖 ${event.message}`);
      break;

    case 'compression':
      console.log(`📦 压缩: ${event.tokensBefore} → ${event.tokensAfter} tokens`);
      break;

    case 'task-end':
      console.log(`✨ 任务完成`);
      break;

    case 'error':
      console.error(`❌ 错误: ${event.error.message}`);
      break;
  }
});
```

### HTTP SSE 流

```typescript
app.post('/api/sessions/:id/run', async (c) => {
  const { task } = await c.req.json();
  const agent = await manager.getAgent(sessionId);

  return streamSSE(c, async (stream) => {
    agent.on('event', (event) => {
      // 实时推送事件到客户端
      stream.writeSSE({
        data: JSON.stringify(event),
        event: event.type,
      });
    });

    const result = await agent.submit(task);

    stream.writeSSE({
      data: JSON.stringify({ type: 'done', result }),
      event: 'done',
    });
  });
});
```

### 日志和监控

```typescript
agent.on('event', (event) => {
  // 1. 结构化日志
  logger.info('agent-event', {
    sessionId: agent.getSessionId(),
    type: event.type,
    timestamp: event.timestamp,
    ...event,
  });

  // 2. 性能监控
  if (event.type === 'tool_result') {
    const duration = event.timestamp - lastToolStartTime;
    metrics.recordToolDuration(event.tool, duration);
  }

  // 3. 错误追踪
  if (event.type === 'error') {
    errorTracker.captureException(event.error);
  }
});
```

## 持久化策略

### 消息 vs 事件

**消息（Messages）**

- 保存时机：任务完成后批量保存新增消息
- 保存位置：`messages` 表
- 用途：恢复会话上下文，供 LLM 继续对话
- 包含：`user`、`assistant`、`tool` 角色的消息

**事件（Events）**

- 保存时机：事件发射时立即异步保存
- 保存位置：`events` 表
- 用途：审计、调试、UI 重放、统计分析
- 包含：所有事件类型（除 `text_delta`）

### 持久化代码位置

**消息持久化**（[agent.ts:466-469](d:\code\plain-agent\domain\src\agent.ts#L466-L469)）：

```typescript
// 保存消息到存储（保存完整版本，不是压缩版本）
if (this.storage && newMessages.length > 0) {
  for (const msg of newMessages) {
    await this.storage.saveMessage(this.sessionId, msg);
  }
}
```

**事件持久化**（[agent.ts:736-742](d:\code\plain-agent\domain\src\agent.ts#L736-L742)）：

```typescript
private emitEvent(event: AgentEvent): void {
  // 保存事件到存储（text_delta 不持久化）
  if (this.storage && event.type !== 'text_delta') {
    this.storage.saveEvent(this.sessionId, event).catch(err => {
      console.error('Failed to save event:', err);
    });
  }

  // 发射事件
  this.emit('event', event);
}
```

### 后台任务结果持久化

后台任务（bash jobs）的结果也会立即持久化（[agent.ts:169-184](d:\code\plain-agent\domain\src\agent.ts#L169-L184)）：

```typescript
private onJobDone(job: BashJob): void {
  // 1. 持久化（可选存储；失败仅告警，不阻塞回注流程）
  if (this.storage?.saveJob) {
    const record: PersistedJob = {
      id: job.id,
      command: job.command,
      intent: job.intent,
      status: job.exitCode === -1 ? 'error' : 'done',
      exitCode: job.exitCode,
      output: job.output,
      truncated: job.truncated,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
    this.storage.saveJob(this.sessionId, record).catch(err => {
      console.error('Failed to persist job result:', err);
    });
  }

  // 2. 进内存队列，submit 时注入
  this.pendingJobResults.push({...});
}
```

## 会话恢复机制

### 恢复流程

```typescript
// 1. 创建 Agent 实例
const agent = new PlainAgent({
  sessionId: existingSessionId,
  storage: sqliteStorage,
  ...
});

// 2. 加载历史消息
await agent.loadHistory();

// 3. 继续对话
const result = await agent.submit('继续之前的任务');
```

### 恢复的内容

**从存储恢复**：

- ✅ 完整消息历史（`fullMessages`）
- ✅ 未回注的后台任务结果（`pendingJobResults`）

**不恢复**：

- ❌ 事件历史（仅用于审计，不影响执行）
- ❌ 压缩缓存（`compressedMessages`，会根据 `fullMessages` 重新生成）

## 类型定义

事件的完整类型定义在 [types.ts](d:\code\plain-agent\domain\src\types.ts) 中：

```typescript
export type AgentEvent =
  | { type: 'task-start'; taskId: string; task: string; timestamp: number }
  | { type: 'task-end'; taskId: string; timestamp: number }
  | { type: 'iteration'; count: number; timestamp: number }
  | { type: 'thinking'; content: string; timestamp: number }
  | { type: 'tool_start'; tool: string; args: any; timestamp: number }
  | { type: 'tool_result'; tool: string; result: string; timestamp: number }
  | { type: 'assistant'; message: string; timestamp: number }
  | { type: 'text_delta'; delta: string; timestamp: number }
  | { type: 'error'; error: { name: string; message: string; stack?: string }; timestamp: number }
  | { type: 'stopped'; reason: string; timestamp: number }
  | { type: 'compression'; level: 1 | 2 | 3; tokensBefore: number; tokensAfter: number; timestamp: number }
  | { type: 'session-warning'; reason: string; suggestion: string; timestamp: number };
```

## 最佳实践

### 1. 监听事件时区分类型

使用 TypeScript 的类型守卫：

```typescript
agent.on('event', (event) => {
  if (event.type === 'tool_start') {
    // TypeScript 知道 event 有 tool 和 args 属性
    console.log(`执行工具: ${event.tool}`);
  }
});
```

### 2. 不要阻塞事件处理

事件监听器应该快速返回：

```typescript
// ❌ 不好：阻塞后续事件
agent.on('event', async (event) => {
  await someSlowOperation(event); // 阻塞！
});

// ✅ 好：异步处理不阻塞
agent.on('event', (event) => {
  someSlowOperation(event).catch(console.error); // 不等待
});
```

### 3. 清理事件监听器

避免内存泄漏：

```typescript
function watchAgent(agent: PlainAgent) {
  const handler = (event: AgentEvent) => {
    console.log(event);
  };

  agent.on('event', handler);

  return () => {
    // 清理函数
    agent.off('event', handler);
  };
}

const cleanup = watchAgent(agent);
// ... 使用 agent
cleanup(); // 不再需要时清理
```

### 4. 持久化失败不应影响业务逻辑

事件持久化是"尽力而为"（best-effort）：

```typescript
// emitEvent 内部的做法：失败仅记录日志
this.storage.saveEvent(this.sessionId, event).catch(err => {
  console.error('Failed to save event:', err);
  // 不抛出异常，不阻塞后续流程
});
```

## 扩展点

### 添加新事件类型

1. 在 `types.ts` 中扩展 `AgentEvent` 联合类型
2. 在适当位置调用 `this.emitEvent()`
3. 更新消费者代码处理新事件

示例：添加子 Agent 事件

```typescript
// 1. 扩展类型
export type AgentEvent =
  | ... // 现有类型
  | { type: 'subagent-start'; subagentId: string; task: string; timestamp: number }
  | { type: 'subagent-end'; subagentId: string; result: string; timestamp: number };

// 2. 发射事件
this.emitEvent({
  type: 'subagent-start',
  subagentId: subagent.id,
  task: subagent.task,
  timestamp: Date.now(),
});

// 3. 消费事件
agent.on('event', (event) => {
  if (event.type === 'subagent-start') {
    console.log(`子 Agent 开始: ${event.task}`);
  }
});
```

## 相关文档

- [历史管理机制](./history-management.md) - 消息压缩和恢复
- [取消机制](./cancellation-guide.md) - 任务中断和 `stopped` 事件
- [长任务持久化](./long-task-persistence-priority.md) - 任务状态和事件的持久化策略
- [SSE 架构](./SSE_ARCHITECTURE.md) - HTTP 服务如何通过 SSE 流式传输事件
