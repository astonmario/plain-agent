# Level 3 压缩：退场信号

## 概述

Level 3（激进摘要）不仅仅是压缩机制，更是**会话健康状态的指示器**。

当 Level 3 被触发时，意味着：
- 会话已经非常长
- Level 1 和 Level 2 都不足以控制 token 使用
- Agent 可能在复杂问题中陷入困境

## Level 3 作为退场信号

### 单次触发

```
Level 3 触发 1 次
    ↓
【警告】会话很长，但可以继续
    ↓
建议：监控后续进展
```

**处理方式**：
- 继续执行，但提高警惕
- 记录触发事件

### 频繁触发（退场信号）

```
Level 3 在 5 分钟内触发 2 次
    ↓
【严重】session-warning 事件
    ↓
建议采取行动
```

**触发条件**：
```typescript
const recentLevel3 = compressionHistory.filter(
  h => h.level === 3 && Date.now() - h.timestamp < 300000 // 5 分钟内
);

if (recentLevel3.length >= 2) {
  // 发射退场警告
  emitEvent({
    type: 'session-warning',
    reason: 'too-long',
    suggestion: '建议：1) 开启新会话 2) 转人工处理 3) 拆分任务'
  });
}
```

## 退场策略

### 策略 1：开启新会话

**适用场景**：任务已基本完成，准备开始新任务

```typescript
agent.on('event', (event) => {
  if (event.type === 'session-warning' && event.reason === 'too-long') {
    // 总结当前会话
    const summary = await agent.submit('总结一下我们完成了什么');
    
    // 创建新 Agent 实例
    const newAgent = new PlainAgent({
      llm: config.llm,
      tools: config.tools,
      // 新的 sessionId
    });
    
    // 可选：将摘要作为上下文传递
    await newAgent.submit(`上一个会话的结果：${summary}\n\n新任务：...`);
  }
});
```

### 策略 2：转人工处理

**适用场景**：Agent 反复尝试失败，陷入困境

```typescript
agent.on('event', (event) => {
  if (event.type === 'session-warning') {
    // 提取当前状态
    const fullHistory = agent.getMessages(true);
    const usage = agent.getHistoryUsage(false);
    
    // 通知人工
    await notifyHuman({
      reason: 'Agent 会话过长，可能遇到复杂问题',
      sessionId: agent.getSessionId(),
      messageCount: fullHistory.length,
      tokenUsage: usage.tokens,
      suggestedAction: '请人工介入检查'
    });
    
    // 暂停 Agent
    agent.stop();
  }
});
```

### 策略 3：拆分任务

**适用场景**：任务太大，需要分解

```typescript
agent.on('event', async (event) => {
  if (event.type === 'session-warning') {
    // 请 Agent 拆分任务
    const breakdown = await agent.submit(
      '我们的对话太长了。请将剩余任务拆分成 3-5 个独立的子任务，每个子任务应该可以独立完成。'
    );
    
    // 解析子任务
    const subtasks = parseSubtasks(breakdown);
    
    // 为每个子任务创建新会话
    for (const subtask of subtasks) {
      const subAgent = new PlainAgent(config);
      await subAgent.submit(subtask);
    }
  }
});
```

## 监控和指标

### 压缩事件

```typescript
agent.on('event', (event) => {
  if (event.type === 'compression') {
    console.log(`Level ${event.level} 压缩`);
    console.log(`Token: ${event.tokensBefore} → ${event.tokensAfter}`);
    console.log(`压缩率: ${((1 - event.tokensAfter / event.tokensBefore) * 100).toFixed(1)}%`);
    
    // 记录到监控系统
    metrics.record('compression', {
      level: event.level,
      compressionRatio: event.tokensAfter / event.tokensBefore,
      sessionId: agent.getSessionId()
    });
  }
});
```

### 会话健康度

```typescript
function getSessionHealth(agent: PlainAgent): {
  status: 'healthy' | 'warning' | 'critical';
  reason: string;
} {
  const usage = agent.getHistoryUsage(false);
  const messageCount = agent.getMessages(true).length;
  
  // 临界状态：接近 Level 3 阈值
  if (usage.tokens >= 9000) {
    return {
      status: 'critical',
      reason: `Token 使用率 ${usage.percentage.toFixed(1)}%，即将触发 Level 3`
    };
  }
  
  // 警告状态：消息太多或接近 Level 2 阈值
  if (messageCount > 100 || usage.tokens >= 5000) {
    return {
      status: 'warning',
      reason: `会话较长（${messageCount} 条消息），建议考虑拆分`
    };
  }
  
  return {
    status: 'healthy',
    reason: '会话状态良好'
  };
}
```

## 实战案例

### 案例 1：数据库调优死循环

**场景**：
- Agent 反复尝试调整配置
- 每次都失败，但不记得已经试过
- 会话长度暴增

**Level 3 触发**：
```
15:00 - Level 2 压缩（试了连接池）
15:10 - Level 2 压缩（试了 retry）
15:20 - Level 3 压缩！（试了 timeout）
15:25 - Level 3 压缩！（又试连接池）
       ↓
    【警告】退场信号
```

**正确处理**：
1. 检查 Anchor 的 `excludedApproaches`
2. 发现 Agent 在重复尝试
3. 转人工：可能需要 DBA 介入

### 案例 2：功能开发任务过大

**场景**：
- 用户要求"创建完整的用户管理系统"
- 涉及认证、权限、CRUD、前端、测试
- 会话包含 200+ 条消息

**Level 3 触发**：
```
【警告】会话过长
```

**正确处理**：
1. Agent 提议拆分：
   - 子任务 1：后端 API
   - 子任务 2：前端页面
   - 子任务 3：测试用例
2. 每个子任务开新会话
3. 最后汇总集成

## 配置建议

### 保守配置（早退场）
```typescript
{
  compressionThreshold: 4000,      // 更早触发 Level 2
  aggressiveThreshold: 6000,       // 更早触发 Level 3
  keepRecentMessages: 8            // 保留更少消息
}
```
**优点**：提前预警，避免深陷困境  
**缺点**：可能过早中断正常长对话

### 激进配置（晚退场）
```typescript
{
  compressionThreshold: 8000,      // 延后触发 Level 2
  aggressiveThreshold: 15000,      // 延后触发 Level 3
  keepRecentMessages: 15           // 保留更多消息
}
```
**优点**：允许更长的连续对话  
**缺点**：可能在问题严重时才发现

### 推荐配置（平衡）
```typescript
{
  compressionThreshold: 6000,      // 75% 触发 Level 2
  aggressiveThreshold: 10000,      // 125% 触发 Level 3
  keepRecentMessages: 10           // 标准保留
}
```

## 总结

**Level 3 的双重角色**：
1. **技术层面**：极限压缩，救急措施
2. **信号层面**：会话健康预警，建议退场

**最佳实践**：
- ✅ 监控 Level 3 触发频率
- ✅ 5 分钟内触发 2 次 = 立即行动
- ✅ 三种退场策略：新会话、转人工、拆任务
- ✅ 记录到监控系统，分析根本原因

**记住**：Level 3 不是失败，而是信号。及时响应，避免资源浪费！
