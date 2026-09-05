# Agent 取消机制指南

## 概述

Agent 的取消机制基于 `AbortController` 和 `AbortSignal`，但需要在多个层面正确实现才能真正停止整个工作流。

## 取消传播路径

```
agent.stop(taskId)
  ↓
abortController.abort()
  ↓
signal.aborted = true
  ↓
┌─────────────────────────────────────┐
│ 1. Loop 每次迭代前检查              │
│ 2. LLM 调用时传递 signal            │
│ 3. 工具执行前检查                   │
│ 4. 工具内部检查 (需要开发者实现)    │
└─────────────────────────────────────┘
```

## 已实现的检查点

### 1. 循环迭代前检查 (loop.ts:47-57)
```typescript
for (let i = 0; i < maxIterations; i++) {
  if (ctx.signal.aborted) {
    ctx.emitEvent({ type: 'stopped', timestamp: Date.now() });
    return { result: '[stopped]', messages, stopReason: 'stopped' };
  }
  // ...
}
```

### 2. LLM 调用时传递 signal (loop.ts:87)
```typescript
response = await callLLM(llmConfig, messages, toolSchemas, ctx.signal);
```

### 3. 工具执行前检查 (loop.ts:116-128, 224-236)
- 在工具列表遍历前检查
- 在单个工具执行前再次检查

## ⚠️ 工具开发者的责任

**关键点**：工具 handler 内部必须主动检查 `signal.aborted`

### ❌ 错误示例：长时间运行的工具
```typescript
const longRunningTool: Tool = {
  name: 'process_data',
  handler: async (args, ctx) => {
    // 问题：没有检查取消信号
    for (let i = 0; i < 10000; i++) {
      await processItem(i); // 即使调用 stop()，这里仍会继续执行
    }
    return 'done';
  }
};
```

### ✅ 正确示例：响应取消的工具
```typescript
const longRunningTool: Tool = {
  name: 'process_data',
  handler: async (args, ctx) => {
    for (let i = 0; i < 10000; i++) {
      // 定期检查取消信号
      if (ctx.signal.aborted) {
        throw new Error('Operation cancelled');
      }
      await processItem(i);
    }
    return 'done';
  }
};
```

### ✅ 网络请求工具示例
```typescript
const fetchTool: Tool = {
  name: 'fetch_url',
  handler: async (args, ctx) => {
    try {
      // 将 signal 传递给 fetch
      const response = await fetch(args.url, {
        signal: ctx.signal
      });
      return await response.text();
    } catch (error) {
      if (error.name === 'AbortError') {
        return '[请求已取消]';
      }
      throw error;
    }
  }
};
```

### ✅ 文件操作工具示例
```typescript
const readLargeFileTool: Tool = {
  name: 'read_large_file',
  handler: async (args, ctx) => {
    const stream = fs.createReadStream(args.path);
    const chunks: Buffer[] = [];

    // 监听取消信号
    ctx.signal.addEventListener('abort', () => {
      stream.destroy();
    });

    for await (const chunk of stream) {
      if (ctx.signal.aborted) {
        throw new Error('File reading cancelled');
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString();
  }
};
```

## 最佳实践

### 1. 在循环中检查
任何包含循环的工具都应该定期检查 `signal.aborted`：
```typescript
for (const item of items) {
  if (ctx.signal.aborted) break;
  // 处理 item
}
```

### 2. 传递给异步操作
将 signal 传递给支持它的 API（如 fetch、axios）：
```typescript
await fetch(url, { signal: ctx.signal });
await axios.get(url, { signal: ctx.signal });
```

### 3. 监听 abort 事件
对于需要清理资源的操作：
```typescript
ctx.signal.addEventListener('abort', () => {
  // 清理资源
  connection.close();
  stream.destroy();
});
```

### 4. 抛出错误 vs 返回消息
- 如果取消是正常操作：返回描述性消息 `return '[已取消]'`
- 如果取消是异常情况：抛出错误 `throw new Error('Cancelled')`

## 测试取消功能

```typescript
import { PlainAgent } from '@plain-agent/domain';

const agent = new PlainAgent({
  tools: [/* your tools */],
  maxIterations: 100
});

// 启动任务
const taskPromise = agent.submit('long running task', 'task-1');

// 2 秒后取消
setTimeout(() => {
  agent.stop('task-1');
  console.log('Task cancelled');
}, 2000);

// 检查结果
try {
  const result = await taskPromise;
  console.log('Result:', result); // 应该是 '[stopped]'
} catch (error) {
  console.error('Error:', error);
}
```

## 常见陷阱

### ❌ 陷阱 1：同步密集计算
```typescript
// 无法取消！
handler: (args, ctx) => {
  let sum = 0;
  for (let i = 0; i < 1e9; i++) {
    sum += i; // 同步计算，无法插入检查点
  }
  return sum;
}
```

### ✅ 解决方案：分批处理
```typescript
handler: async (args, ctx) => {
  let sum = 0;
  const batchSize = 1e6;
  for (let i = 0; i < 1e9; i += batchSize) {
    if (ctx.signal.aborted) break;
    // 处理一批
    for (let j = i; j < Math.min(i + batchSize, 1e9); j++) {
      sum += j;
    }
    await new Promise(resolve => setImmediate(resolve)); // 让出控制权
  }
  return sum;
}
```

### ❌ 陷阱 2：忘记清理资源
```typescript
handler: async (args, ctx) => {
  const connection = await connectToDatabase();
  await longOperation(ctx.signal);
  await connection.close(); // 如果 longOperation 抛出 AbortError，这行不会执行
}
```

### ✅ 解决方案：使用 try-finally
```typescript
handler: async (args, ctx) => {
  const connection = await connectToDatabase();
  try {
    await longOperation(ctx.signal);
  } finally {
    await connection.close(); // 总是会执行
  }
}
```

## 总结

1. **框架层面**：已在循环、LLM 调用、工具执行前设置检查点
2. **工具层面**：开发者必须在长时间操作中主动检查 `ctx.signal.aborted`
3. **网络请求**：始终将 `ctx.signal` 传递给支持的 API
4. **资源清理**：使用 `signal.addEventListener('abort', ...)` 或 try-finally
5. **测试**：编写测试用例验证取消功能是否生效
