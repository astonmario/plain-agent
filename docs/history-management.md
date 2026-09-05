# 消息历史管理

## 概述

Agent 在长时间对话中会积累大量消息历史，导致：
- **Token 超限**：超过 LLM 的上下文窗口限制
- **成本增加**：每次调用都要传递完整历史
- **响应变慢**：处理更多 tokens 需要更多时间

消息历史管理器通过**两层压缩策略**解决这些问题，同时**保留完整历史**用于追溯。

## 核心设计

### 双版本存储

```
┌─────────────────────────────────────┐
│  fullMessages (完整版本)            │
│  - 永不删除                          │
│  - 用于追溯、审计                    │
│  - 保存到存储                        │
└─────────────────────────────────────┘
              ↓
         压缩处理 (按需)
              ↓
┌─────────────────────────────────────┐
│  compressedMessages (压缩版本)      │
│  - 缓存结果                          │
│  - 发送给 LLM                        │
│  - 不保存，可重新生成                │
└─────────────────────────────────────┘
```

**关键特性**：
- ✅ 完整历史永不丢失
- ✅ LLM 看到的是压缩版本（节省 token）
- ✅ 可以随时查看完整内容
- ✅ LLM 可以主动请求查看被截断的内容

## 两层压缩策略

### 第一层：清理冗长的工具输出

**目标**：快速减少 token 使用，无需调用 LLM

**处理对象**：
- 📝 日志文件（server.log、error.log）
- 🌐 API 响应（大型 JSON、XML）
- 🔍 查询结果（数据库查询、文件搜索）
- 💻 代码输出（编译日志、测试报告）

**策略**：
1. 自动检测内容类型（日志、JSON、代码、查询结果）
2. 截断到配置的最大长度（默认 1000 字符）
3. 添加说明：`[日志已截断，省略 5000 字符]`

**示例**：

```typescript
// 压缩前（15000 字符）
{
  role: 'tool',
  content: '[2024-01-15 10:23:45] INFO: Starting...\n[2024-01-15 10:23:45] DEBUG: ...\n...(重复数百行)'
}

// 压缩后（1050 字符）
{
  role: 'tool',
  content: '[2024-01-15 10:23:45] INFO: Starting...\n...(前1000字符)\n\n[日志已截断，省略 14000 字符]'
}
```

### 第二层：对话状态摘要

**目标**：将旧对话合并成任务状态，保留关键信息

**处理对象**：
- 早期的用户消息和 AI 回复
- 已完成的工具调用
- 中间过程的讨论

**保留内容**：
- 系统消息（始终保留）
- 最近 N 条消息（默认 10 条，不压缩）

**生成摘要包含**：
1. **用户意图**：用户想做什么
2. **已做改动**：修改了哪些文件，做了什么操作
3. **已做决策**：选择了什么方案，为什么
4. **下一步计划**：接下来要做什么

**示例**：

```typescript
// 压缩前（30 条消息，2000 tokens）
[
  { role: 'user', content: '创建 Express 服务器' },
  { role: 'assistant', content: '好的，我来创建' },
  { role: 'tool', content: '文件已创建' },
  { role: 'user', content: '添加 CORS' },
  { role: 'assistant', content: '添加 CORS 中间件' },
  // ... 20 条消息
]

// 压缩后（12 条消息，800 tokens）
[
  { role: 'system', content: '你是代码助手' },
  { role: 'system', content: `[历史对话摘要]
用户意图：创建一个支持 CORS 的 Express 服务器
已做改动：
- 创建了 server.js，包含基础 Express 配置
- 添加了 CORS 中间件
- 配置了端口 3000
已做决策：使用 cors 包而非手动设置响应头
下一步：添加用户相关的路由
[摘要结束，以下是最近的对话]` },
  // ... 最近 10 条消息
]
```

## 使用方式

### 1. 自动管理（推荐）

Agent 会自动监测消息历史长度，达到阈值时自动压缩：

```typescript
import { PlainAgent } from '@plain-agent/domain';

const agent = new PlainAgent({
  llm: { /* LLM 配置 */ },
  tools: [/* 工具列表 */],
  historyManagement: {
    enabled: true,                    // 启用历史管理（默认 true）
    maxTokens: 8000,                  // 最大 token 数
    compressionThreshold: 6000,       // 6000 tokens 时触发压缩
    maxToolOutputLength: 1000,        // 工具输出最大 1000 字符
    keepRecentMessages: 10,           // 保留最近 10 条消息
  }
});

// 正常使用，无需手动管理
await agent.submit('任务描述');

// 获取消息（默认返回压缩版本）
const messages = agent.getMessages();

// 获取完整历史（用于追溯）
const fullMessages = agent.getMessages(true);
```

**压缩触发时机**：
- 每次 `submit()` 调用前检查
- token 使用率超过阈值（默认 75%，即 6000/8000）
- 自动执行压缩，对用户透明

**事件通知**：
```typescript
agent.on('event', (event) => {
  if (event.type === 'thinking' && event.content.includes('压缩')) {
    console.log('历史压缩中:', event.content);
  }
});
```

### 2. LLM 主动查看被压缩的内容

当启用历史管理时，Agent 会自动注册两个特殊工具供 LLM 使用：

#### `lookup_history` - 查看被截断的工具输出

```typescript
// LLM 会自动调用这个工具
{
  "tool": "lookup_history",
  "args": {
    "tool_name": "read_file",        // 工具名称
    "search_text": "error.log",      // 可选：搜索关键词
    "max_results": 3                 // 返回最多 3 个结果
  }
}
```

**使用场景**：
- LLM 看到 `[日志已截断，省略 5000 字符]`
- LLM 需要查看完整的 API 响应
- 调试时需要完整的错误堆栈

#### `search_history` - 搜索完整历史

```typescript
{
  "tool": "search_history",
  "args": {
    "query": "user_id=123",          // 搜索关键词
    "message_type": "tool",          // user | assistant | tool | system | all
    "max_results": 5
  }
}
```

**使用场景**：
- "之前用户提到的那个 bug 是什么来着？"
- "上次执行这个命令的结果是什么？"
- "我们之前决定用哪个方案？"

### 3. 手动管理

你也可以主动查询和压缩：

```typescript
// 查询当前使用情况（默认基于压缩版本）
const usage = agent.getHistoryUsage();
console.log(`当前使用: ${usage.tokens}/${usage.maxTokens} tokens`);
console.log(`使用率: ${usage.percentage.toFixed(1)}%`);

// 查询完整历史的使用情况
const fullUsage = agent.getHistoryUsage(false);
console.log(`完整历史: ${fullUsage.tokens} tokens`);

// 手动压缩（快速模式，仅第一层）
await agent.compressHistory(true);

// 手动压缩（完整模式，两层）
await agent.compressHistory(false);

// 获取特定消息的完整内容
const fullMessage = agent.getFullMessage(42);
console.log(fullMessage?.content);

// 搜索工具输出
const results = agent.searchToolOutputs('bash', 'npm install');
results.forEach(r => {
  console.log(`消息 #${r.index}:`, r.message.content);
});
```

### 3. 独立使用 HistoryManager

如果你需要在其他地方使用压缩功能：

```typescript
import { HistoryManager, estimateTokens } from '@plain-agent/domain';

const manager = new HistoryManager({
  maxTokens: 4000,
  maxToolOutputLength: 500,
  keepRecentMessages: 5,
});

// 检查是否需要压缩
if (manager.shouldCompress(messages)) {
  // 快速压缩（仅第一层）
  const compressed = manager.compressQuick(messages);
  
  // 或完整压缩（两层）
  const compressed = await manager.compress(messages, llmConfig);
}

// 估算 token 数
const tokens = estimateTokens(messages);
console.log(`估算 ${tokens} tokens`);
```

## 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用历史管理 |
| `maxTokens` | number | `8000` | 最大 token 数（上限） |
| `compressionThreshold` | number | `6000` | 触发压缩的阈值（75%） |
| `maxToolOutputLength` | number | `1000` | 单个工具输出最大字符数 |
| `keepRecentMessages` | number | `10` | 保留最近 N 条消息不压缩 |

**推荐配置**：

```typescript
// 对于长对话场景（客服、助手）
historyManagement: {
  maxTokens: 12000,              // 更大的窗口
  compressionThreshold: 9000,    // 更高的阈值
  keepRecentMessages: 15,        // 保留更多最近消息
}

// 对于短对话场景（单次任务）
historyManagement: {
  maxTokens: 4000,               // 较小的窗口
  compressionThreshold: 3000,
  keepRecentMessages: 5,
}

// 对于工具密集型场景（代码生成）
historyManagement: {
  maxToolOutputLength: 500,      // 更激进地截断工具输出
  compressionThreshold: 5000,    // 更早触发压缩
}
```

## 最佳实践

### 1. 选择合适的阈值

- **过低**（如 50%）：频繁压缩，可能损失有用信息
- **过高**（如 95%）：接近上限才压缩，可能突然失败
- **推荐**：75-80%，留有缓冲空间

### 2. 工具输出长度

根据工具类型调整：
- **日志工具**：500 字符足够（只需看到错误/警告）
- **代码工具**：1000 字符（保留关键部分）
- **搜索工具**：1500 字符（需要更多上下文）

### 3. 保留最近消息数

- **交互式对话**：10-15 条（保持对话连贯性）
- **自动化任务**：5-8 条（减少 token 使用）
- **调试场景**：15-20 条（需要更多上下文）

### 4. 禁用压缩的场景

某些场景下应该禁用自动压缩：

```typescript
// 短生命周期任务（执行后即销毁）
const agent = new PlainAgent({
  historyManagement: { enabled: false }
});

// 需要完整上下文的任务
const agent = new PlainAgent({
  historyManagement: { 
    compressionThreshold: 999999  // 实际上永远不会触发
  }
});
```

## Token 估算说明

`estimateTokens()` 使用启发式规则：
- **中文字符**：1.5 字符 ≈ 1 token
- **英文字符**：4 字符 ≈ 1 token
- **工具调用**：每个约 50 tokens

**注意**：这只是粗略估算，实际 token 数可能有 ±20% 误差。

## 性能影响

### 第一层压缩（compressQuick）
- ⏱️ **速度**：极快（< 10ms）
- 💰 **成本**：无额外成本
- 📉 **效果**：通常减少 30-50% tokens

### 第二层压缩（compress）
- ⏱️ **速度**：较慢（需要 LLM 调用，1-3 秒）
- 💰 **成本**：一次额外的 LLM 调用
- 📉 **效果**：通常减少 60-80% tokens

**建议**：
- 日常使用：启用两层压缩
- 低延迟场景：仅使用第一层（`compressQuick`）
- 成本敏感：提高阈值，减少压缩频率

## 测试

运行测试查看压缩效果：

```bash
pnpm test:history
```

或在代码中：

```typescript
import { testHistoryManager } from '../domain/test/test-history';
await testHistoryManager();
```

## 故障排除

### Q: 压缩后 AI 忘记了早期的对话内容

**A**: 增加 `keepRecentMessages` 或降低 `compressionThreshold`，让更多消息保留原样。

### Q: 工具输出被截断，导致信息丢失

**A**: 增加 `maxToolOutputLength`，或者在工具 handler 中自行总结输出。

### Q: 压缩摘要质量不高

**A**: 这取决于你使用的 LLM 模型。考虑：
- 使用更强的模型（如 GPT-4）生成摘要
- 或禁用第二层，仅使用第一层压缩

### Q: 如何查看压缩前后的变化？

**A**: 监听事件并对比：

```typescript
agent.on('event', (event) => {
  if (event.type === 'thinking' && event.content.includes('压缩')) {
    const before = agent.getMessages().length;
    // ... 压缩后
    const after = agent.getMessages().length;
    console.log(`消息数: ${before} → ${after}`);
  }
});
```
