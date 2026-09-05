# 智能消息历史管理系统 - 完整实现总结

## 🎯 核心目标

让 Agent 在长 session 里继续保持清醒：
- ✅ **少压**：不该压的不压
- ✅ **分层压**：根据问题选层级
- ✅ **保留证据**：关键信息不丢
- ✅ **保留回退路径**：完整历史可追溯

## 📦 已实现的功能

### 1. 双版本存储架构

```typescript
fullMessages (完整版本)
  ↓ 永不删除，持久化到数据库
compressedMessages (压缩版本)
  ↓ 缓存，发送给 LLM
```

**关键特性**：
- 完整历史永不丢失
- 压缩版本按需生成
- LLM 可以主动查看被截断内容

### 2. 三层压缩策略

#### Level 1：清理工具输出（< 10ms，无需 LLM）
- 截断日志、JSON、代码、查询结果
- 压缩率：30-50%
- 总是执行

#### Level 2：Anchor 状态快照（1-3s，需要 LLM）
- 结构化提取 5 个关键字段：
  - 📋 用户意图
  - ✅ 已做改动
  - 🎯 已做决策
  - ❌ 已排除方案（防遗忘）
  - ⏭️ 下一步计划
- 增量更新（v1 → v2 → v3）
- 压缩率：60-80%

#### Level 3：激进摘要（1-2s，极端情况）
- 超简化摘要（< 300 字）
- 减少保留消息数
- 压缩率：80-90%
- **退场信号**：5 分钟内触发 2 次 → 建议新会话/转人工/拆任务

### 3. 智能触发机制

**五大评估维度**：

| 维度 | 指标 | 阈值 | 作用 |
|------|------|------|------|
| 对话轮数 | user-assistant 配对 | 20/30 | 识别长任务 |
| Token 使用率 | % of maxTokens | 60%/75% | 避免超限 |
| 工具结果堆积 | 大型输出数量+类型 | 5个/10KB | 清理冗余 |
| **重复行为** ⭐ | 内容+工具重复率 | 25%/40% | **发现困境** |
| 消息数量 | 总消息数 | 60/100 | 整体控制 |

**智能决策**：
```typescript
if (urgency === 'high' && repetitionScore >= 0.4) {
  level = 3; // Agent 陷入困境！
  emitWarning('session-too-long');
}
```

### 4. 历史追溯工具

自动注册的工具，供 LLM 使用：

#### `lookup_history`
查看被截断的完整工具输出
```typescript
{
  tool_name: "read_file",
  search_text: "error.log",
  max_results: 3
}
```

#### `search_history`
搜索完整对话历史
```typescript
{
  query: "user_id=123",
  message_type: "tool",
  max_results: 5
}
```

### 5. 事件系统

#### `compression` 事件
```typescript
{
  type: 'compression',
  level: 1 | 2 | 3,
  tokensBefore: number,
  tokensAfter: number,
  timestamp: number
}
```

#### `session-warning` 事件
```typescript
{
  type: 'session-warning',
  reason: 'too-long' | 'frequent-compression',
  suggestion: string,
  timestamp: number
}
```

## 📂 文件结构

### 核心实现

```
domain/src/
├── agent.ts                    # Agent 主类（集成历史管理）
├── history-manager.ts          # 三层压缩管理器
├── anchor.ts                   # Anchor 结构化状态
├── compression-trigger.ts      # 智能触发器
├── tools/
│   └── history-lookup.ts      # 历史追溯工具
└── types.ts                    # 类型定义
```

### 测试文件

```
domain/test/
├── test-history.ts             # 历史管理测试
├── test-anchor.ts              # Anchor 机制测试
└── test-smart-compression.ts   # 智能触发测试
```

### 文档

```
docs/
├── history-management.md           # 消息历史管理
├── three-layer-compression.md      # 三层压缩架构
├── smart-compression-trigger.md    # 智能触发机制
├── level3-exit-signal.md          # Level 3 退场信号
└── test-guide.md                  # 测试指南
```

## 🚀 使用示例

### 基础使用

```typescript
const agent = new PlainAgent({
  llm: { /* ... */ },
  tools: [/* ... */],
  historyManagement: {
    enabled: true,
    maxTokens: 8000,
    compressionThreshold: 6000,     // Level 2: 75%
    aggressiveThreshold: 10000,     // Level 3: 125%
  }
});

// 自动智能触发
await agent.submit('任务描述');
```

### 监控会话健康

```typescript
agent.on('event', (event) => {
  // 查看触发原因
  if (event.type === 'thinking' && event.content.includes('触发条件')) {
    console.log('触发原因:', event.content);
  }
  
  // 压缩事件
  if (event.type === 'compression') {
    console.log(`Level ${event.level}: ${event.tokensBefore} → ${event.tokensAfter}`);
  }
  
  // 退场警告
  if (event.type === 'session-warning') {
    console.warn('⚠️', event.suggestion);
    
    // 采取行动
    if (event.reason === 'too-long') {
      // 开新会话 / 转人工 / 拆任务
      handleSessionExit(agent);
    }
  }
});
```

### 手动查询

```typescript
// 获取会话健康状况
const health = agent.historyManager.getSessionHealth(messages);
console.log(`轮数: ${health.roundCount}, 重复度: ${health.repetitionScore}`);

// 获取完整历史
const fullHistory = agent.getMessages(true);

// 搜索工具输出
const results = agent.searchToolOutputs('bash', 'npm install');
```

## 📊 压缩效果

### 典型场景

| 场景 | 初始 | Level 1 | Level 2 | Level 3 |
|------|------|---------|---------|---------|
| 正常对话 | 100% | 70% | - | - |
| 长对话 | 100% | 60% | 30% | - |
| 工具密集 | 100% | 50% | 25% | - |
| 陷入困境 | 100% | 70% | 40% | 15% |

### Token 节省

- **Level 1**：节省 30-50%，无成本
- **Level 2**：节省 60-80%，1 次 LLM 调用
- **Level 3**：节省 80-90%，2 次 LLM 调用

## ✅ 测试

```bash
# 历史管理基础测试
pnpm test:history

# Anchor 机制测试
pnpm test:anchor

# 智能触发器测试（推荐）
pnpm test:compression
```

## 🎯 核心创新

### 1. 重复行为检测 ⭐
识别 Agent 是否在重复尝试失败方案：
```
试连接池 → 失败
试 retry → 失败
试连接池 → 重复！触发警告
```

### 2. Anchor 增量更新
不重新生成，只更新增量：
```
v1 (0-20) → v2 (0-40) → v3 (0-60)
保留 excludedApproaches，防遗忘
```

### 3. 智能分层决策
不是固定阈值，而是综合评估：
```
健康会话 → Level 1
长对话 → Level 2
陷入困境 → Level 3 + 退场警告
```

### 4. 双版本存储
压缩不丢失数据：
```
fullMessages (数据库) ← 完整保留
compressedMessages (内存) ← 发送 LLM
```

## 🔧 配置建议

### 一般场景（默认）
```typescript
{
  maxTokens: 8000,
  compressionThreshold: 6000,      // 75%
  aggressiveThreshold: 10000,      // 125%
  keepRecentMessages: 10
}
```

### 长会话（客服、助手）
```typescript
{
  maxTokens: 16000,
  compressionThreshold: 12000,     // 75%
  aggressiveThreshold: 20000,      // 125%
  keepRecentMessages: 15
}
```

### 工具密集型（代码生成）
```typescript
{
  maxToolOutputLength: 500,        // 更激进截断
  compressionThreshold: 5000,
  aggressiveThreshold: 8000,
  keepRecentMessages: 8
}
```

## 📈 后续优化方向

1. **更精准的重复检测**
   - 语义相似度（embeddings）
   - 工具调用模式识别

2. **自适应阈值**
   - 根据历史数据动态调整
   - 不同任务类型不同阈值

3. **压缩质量评估**
   - 压缩后 Agent 表现
   - 信息丢失率

4. **可视化监控**
   - 会话健康仪表盘
   - 压缩历史图表

## 🎉 总结

这不是简单的"token 超了就压缩"，而是：

✅ **智能会话健康管理系统**
- 多维度评估
- 分层渐进压缩
- 完整数据保留
- 异常行为检测
- 退场信号机制

> **让 Agent 在长 session 里继续保持清醒！**
