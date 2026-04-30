# 智能压缩触发机制

## 从"傻"到"智能"

### 之前：傻瓜式触发

```typescript
// ❌ 只看 token 数量
if (tokens >= 6000) {
  compress(); // Level 2
}
if (tokens >= 10000) {
  compressAggressively(); // Level 3
}
```

**问题**：
- 不考虑会话特征
- 忽略 Agent 行为模式
- 可能过早或过晚压缩
- 丢失关键信息

### 现在：智能触发

```typescript
// ✅ 综合判断
const health = evaluateSessionHealth(messages);

if (health.shouldCompress) {
  const level = decideLevel(health); // 1, 2, 或 3
  compress(level);
}
```

**优势**：
- 多维度评估
- 识别异常行为
- 精准决策层级
- 保留关键证据

## 五大评估维度

### 1. 对话轮数

```typescript
// 计算 user-assistant 配对数
const rounds = countRounds(messages);

if (rounds >= 30) {
  // 🚨 高优先级：长任务状态
  urgency = 'high';
} else if (rounds >= 20) {
  // ⚠️ 中优先级：建议压缩
  urgency = 'medium';
}
```

**阈值说明**：
- 20-30 轮：正常长对话
- 30+ 轮：明显进入长任务

### 2. Token 使用率

```typescript
const percentage = (tokens / maxTokens) * 100;

if (percentage >= 75%) {
  // 🚨 接近上限
  urgency = 'high';
} else if (percentage >= 60%) {
  // ⚠️ 建议压缩
  urgency = 'medium';
}
```

**阈值说明**：
- 60-75%：提前预警
- 75%+：紧急压缩

### 3. 工具结果堆积

```typescript
// 检测大型输出
if (largeOutputCount >= 5) {
  // 🔧 5 个以上大型工具输出
  reasons.push('大型工具输出堆积');
}

// 检测特定类型
if (hasLogs && totalSize > 10000) {
  // 📝 日志大量堆积
  reasons.push('日志输出需要清理');
}

if (hasTests && totalSize > 8000) {
  // 🧪 测试输出堆积
  reasons.push('测试输出需要清理');
}

if (hasDiffs && totalSize > 6000) {
  // 📊 代码 diff 堆积
  reasons.push('代码 diff 需要清理');
}
```

**识别类型**：
- 日志：`INFO`, `DEBUG`, `ERROR`, `WARN`
- 测试：`test`, `spec`, `passed`, `failed`
- Diff：`+++`, `---`, `@@`

### 4. 重复行为检测 ⭐

```typescript
const repetitionScore = detectRepetition(messages);

if (repetitionScore >= 0.4) {
  // 🚨 严重重复（40%+）
  reasons.push('Agent 可能陷入困境');
  urgency = 'high';
} else if (repetitionScore >= 0.25) {
  // ⚠️ 轻度重复（25%+）
  reasons.push('检测到一些重复行为');
}
```

**重复检测**：
- 相同的 assistant 消息内容
- 相同的工具调用模式
- 窗口内频繁重复

**典型场景**：
```
Agent: 试试增加连接池
[失败]
Agent: 试试增加 retry
[失败]
Agent: 试试增加连接池  ← 重复了！
```

### 5. 消息数量

```typescript
if (messageCount >= 100) {
  // 🚨 远超正常范围
  urgency = 'high';
} else if (messageCount >= 60) {
  // ⚠️ 偏多
  urgency = 'medium';
}
```

## 智能决策层级

```typescript
function decideLevel(health: SessionHealth): 1 | 2 | 3 {
  // Level 1：基础清理（总是执行）
  if (!health.shouldCompress || health.urgency === 'low') {
    return 1;
  }

  // Level 3：紧急情况
  if (health.urgency === 'high' && (
    health.tokenPercentage >= 90 ||    // Token 爆满
    health.repetitionScore >= 0.4 ||   // 严重重复
    health.messageCount >= 100         // 消息过多
  )) {
    return 3;
  }

  // Level 2：标准压缩
  return 2;
}
```

**决策逻辑**：
- **Level 1**：轻微问题，快速清理
- **Level 2**：明确需要压缩，保留结构
- **Level 3**：紧急情况，激进压缩

## 实际案例

### 案例 1：正常长对话

```
轮数: 25
Token: 5500 (68%)
工具输出: 3 个大型
重复度: 10%
消息数: 55

评估结果:
✓ 对话已进行 25 轮，建议压缩
✓ Token 使用率 68%，建议压缩
→ 紧急度: medium
→ 建议层级: Level 2
```

**处理**：执行 Anchor 压缩，保留结构化状态

### 案例 2：工具输出堆积

```
轮数: 15
Token: 7200 (90%)
工具输出: 8 个大型（日志 + 测试）
重复度: 5%
消息数: 40

评估结果:
✓ Token 使用率 90%，接近上限
✓ 大型工具输出堆积（8 个）
✓ 日志输出大量堆积
✓ 测试输出大量堆积
→ 紧急度: high
→ 建议层级: Level 2
```

**处理**：
1. Level 1 清理工具输出（日志、测试截断）
2. Token 仍高 → 执行 Level 2

### 案例 3：Agent 陷入困境

```
轮数: 35
Token: 8500 (106%)
工具输出: 12 个大型
重复度: 45% ⚠️
消息数: 95

评估结果:
✓ 对话已进行 35 轮，接近长任务状态
✓ Token 使用率 106%，接近上限
✓ 大型工具输出堆积（12 个）
✓ 检测到重复行为（45%），Agent 可能陷入困境
✓ 消息数量 95，偏多
→ 紧急度: high
→ 建议层级: Level 3 🚨
```

**处理**：
1. 触发 Level 3 激进压缩
2. 发射 `session-warning` 事件
3. 建议：转人工或拆分任务

### 案例 4：健康会话

```
轮数: 8
Token: 1200 (15%)
工具输出: 1 个大型
重复度: 0%
消息数: 20

评估结果:
→ 会话状态良好，暂不需要压缩
→ 建议层级: Level 1（基础清理）
```

**处理**：仅清理工具输出，不执行深度压缩

## 使用示例

```typescript
const agent = new PlainAgent({
  llm: { /* ... */ },
  tools: [/* ... */],
  historyManagement: {
    enabled: true,
    // 智能触发器会自动评估，无需手动设置阈值
  }
});

// 监控会话健康
agent.on('event', (event) => {
  if (event.type === 'thinking' && event.content.includes('压缩触发条件')) {
    console.log('触发原因:', event.content);
  }
  
  if (event.type === 'compression') {
    console.log(`执行 Level ${event.level} 压缩`);
    console.log(`Token: ${event.tokensBefore} → ${event.tokensAfter}`);
  }
  
  if (event.type === 'session-warning') {
    console.warn('⚠️ 会话警告:', event.suggestion);
    // 采取行动...
  }
});
```

## 压缩前的诊断信息

```typescript
// 获取会话健康状况（无需压缩）
const health = agent.historyManager.getSessionHealth(messages);

console.log('会话诊断:');
console.log(`- 对话轮数: ${health.roundCount}`);
console.log(`- Token 使用: ${health.tokenUsage} (${health.tokenPercentage.toFixed(1)}%)`);
console.log(`- 大型输出: ${health.largeOutputCount} 个`);
console.log(`- 重复度: ${(health.repetitionScore * 100).toFixed(1)}%`);
console.log(`- 消息数: ${health.messageCount}`);
console.log(`- 是否需要压缩: ${health.shouldCompress}`);
console.log(`- 紧急程度: ${health.urgency}`);
console.log(`- 原因: ${health.reason.join('；')}`);
```

## 总结

**智能触发 vs 傻瓜触发**：

| 维度 | 傻瓜触发 | 智能触发 |
|------|---------|---------|
| 判断依据 | 单一 token 数 | 5 个维度综合 |
| 重复检测 | ✗ | ✓ |
| 工具分析 | ✗ | ✓ |
| 行为模式 | ✗ | ✓ |
| 分层决策 | 固定阈值 | 动态评估 |
| 证据保留 | 可能丢失 | 精准保留 |

**核心理念**：
> 真正好的压缩，是让 Agent 在长 session 里继续保持清醒。

- ✅ 少压：不该压的不压
- ✅ 分层压：根据问题选层级
- ✅ 保留证据：关键信息不丢
- ✅ 保留回退路径：完整历史可追溯
