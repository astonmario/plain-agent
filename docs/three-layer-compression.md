# 三层压缩架构

## 概览

```
原始消息 (50条, 10000 tokens)
    ↓
【第一层】清理工具输出 (< 10ms)
    ↓
压缩后 (50条, 6000 tokens)
    ↓
【第二层】生成 Anchor (1-3s) 
    ↓
压缩后 (15条, 2000 tokens)
    ↓
【第三层】激进摘要 (1-2s, 极端情况)
    ↓
最终 (8条, 500 tokens)
```

## 第一层：清理工具输出

**触发条件**：总是执行

**特点**：
- ⚡ 快速（< 10ms）
- 🔧 无需 LLM
- 📊 减少 30-50% tokens

**处理方式**：
- 检测内容类型（日志、JSON、代码、查询结果）
- 截断到最大长度（默认 1000 字符）
- 添加说明：`[日志已截断，省略 5000 字符]`

**示例**：
```typescript
// 压缩前
{ role: 'tool', content: '...(15000字符日志)...' }

// 压缩后
{ role: 'tool', content: '...(前1000字符)...\n\n[日志已截断，省略 14000 字符]' }
```

## 第二层：Anchor 状态快照

**触发条件**：第一层后仍超过 `compressionThreshold`（默认 6000 tokens）

**特点**：
- 🏗️ 结构化（5 个固定字段）
- 🔄 增量式（不重新生成）
- 🧠 防遗忘（记录失败方案）
- 📊 减少 60-80% tokens
- ⏱️ 耗时 1-3 秒

**生成内容**：
```
[对话状态 v1]

📋 用户意图
主要目标: 解决数据库性能问题

✅ 已完成改动
- [file_modified] config/database.js: 增加连接池到 50
- [command_executed] CREATE INDEX: 创建复合索引

🎯 已做决策
- 使用复合索引而非单列索引
  原因: 查询同时使用多个字段

❌ 已排除方案（不要再尝试）
- 增加连接池大小: 尝试后问题未解决
- 增加 retry 机制: 尝试后问题未解决
- 调整 timeout: 只是延后超时

⏭️ 下一步
- [high] 检查其他慢查询并创建索引

[状态结束，以下是最近的对话]
```

**关键特性**：
- **excludedApproaches** 最重要：防止 Agent 反复尝试失败方案
- **增量更新**：Anchor v1 → v2 → v3，不丢失历史信息
- **决策追溯**：保留"为什么"，不只是"做了什么"

## 第三层：激进摘要

**触发条件**：第二层后仍超过 `aggressiveThreshold`（默认 10000 tokens）

**特点**：
- 🚨 极端情况才触发
- 🗜️ 极限压缩（< 300 字）
- 📊 保留 < 20% 内容
- ⏱️ 耗时 1-2 秒

**处理方式**：
1. 将 Anchor 压缩为超简化摘要
2. 只保留：意图、已排除方案、当前状态、下一步
3. 减少保留消息数（10 条 → 3-5 条）

**示例**：
```
[极简摘要]
意图: 解决数据库性能问题
已排除: 连接池、retry、timeout（都无效）
状态: 已创建索引，性能改善
下一步: 检查其他慢查询
```

## 配置

```typescript
const agent = new PlainAgent({
  llm: { /* ... */ },
  tools: [/* ... */],
  historyManagement: {
    enabled: true,
    maxTokens: 8000,                // 最大 token 数
    maxToolOutputLength: 1000,      // 第一层：工具输出最大长度
    keepRecentMessages: 10,         // 保留最近 N 条消息
    compressionThreshold: 6000,     // 第二层：触发阈值 (75%)
    aggressiveThreshold: 10000,     // 第三层：触发阈值 (极端情况)
  }
});
```

## 决策流程

```typescript
// Agent 内部自动决策
async compress(messages) {
  // 第一层：总是执行
  let compressed = compressToolOutputs(messages);
  let tokens = estimateTokens(compressed);
  
  // 第二层：超过 75% 阈值
  if (tokens >= 6000) {
    compressed = await compressWithAnchor(compressed);
    tokens = estimateTokens(compressed);
    
    // 第三层：超过极端阈值
    if (tokens >= 10000) {
      compressed = await compressAggressively(compressed);
    }
  }
  
  return compressed;
}
```

## 推荐配置

### 场景 1：一般对话（默认）
```typescript
{
  maxTokens: 8000,
  compressionThreshold: 6000,      // 75% 触发第二层
  aggressiveThreshold: 10000,      // 125% 触发第三层（罕见）
  keepRecentMessages: 10
}
```

### 场景 2：长会话（客服、助手）
```typescript
{
  maxTokens: 16000,
  compressionThreshold: 12000,     // 75% 触发
  aggressiveThreshold: 20000,      // 125% 触发
  keepRecentMessages: 15
}
```

### 场景 3：短会话（单次任务）
```typescript
{
  maxTokens: 4000,
  compressionThreshold: 3000,      // 75% 触发
  aggressiveThreshold: 5000,       // 125% 触发
  keepRecentMessages: 5
}
```

### 场景 4：工具密集型（代码生成）
```typescript
{
  maxToolOutputLength: 500,        // 更激进地截断
  compressionThreshold: 5000,      // 更早触发
  aggressiveThreshold: 8000,
  keepRecentMessages: 8
}
```

## 性能对比

| 层次 | 方法 | 耗时 | 压缩率 | LLM 调用 | 信息保留 |
|------|------|------|--------|----------|----------|
| 第一层 | 清理工具输出 | < 10ms | 30-50% | ✗ | 高 |
| 第二层 | Anchor 快照 | 1-3s | 60-80% | ✓ | 中-高 |
| 第三层 | 激进摘要 | 1-2s | 80-90% | ✓ | 低-中 |

## 信息保留策略

### 第一层
- ✅ 保留：工具名称、参数、前 1000 字符输出
- ❌ 丢弃：冗长的日志、完整的 JSON

### 第二层
- ✅ 保留：意图、改动、决策、排除方案、下一步
- ❌ 丢弃：中间过程、重复讨论

### 第三层
- ✅ 保留：核心意图、排除方案（最重要）、当前状态
- ❌ 丢弃：决策细节、改动清单

## 注意事项

1. **第三层很少触发**：正常使用中，第二层压缩通常足够
2. **排除方案最重要**：所有层级都保留 `excludedApproaches`
3. **完整历史始终保留**：压缩只影响发送给 LLM 的版本
4. **可以手动查看**：`agent.getMessages(true)` 获取完整历史

## 总结

- **第一层**：清理冗余，快速有效
- **第二层**：结构化压缩，保留关键信息
- **第三层**：极限压缩，极端情况救急

三层设计确保在任何情况下都能保持对话继续，同时尽可能保留重要信息！
