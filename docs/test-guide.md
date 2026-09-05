# 智能压缩自测指南

## 快速开始

```bash
# 运行智能压缩自测
pnpm test:compression
```

## 测试场景

### 场景 1：正常短对话
- **预期**：不触发压缩
- **验证**：健康会话不应被打扰

### 场景 2：长对话（25 轮）
- **预期**：触发 Level 2
- **验证**：对话轮数和 token 使用率触发

### 场景 3：工具输出堆积
- **预期**：触发 Level 1/2
- **验证**：大型工具输出被检测并清理

### 场景 4：Agent 重复行为 ⭐
- **预期**：触发 Level 3 + session-warning
- **验证**：重复度检测工作，发射退场信号

### 场景 5：Token 爆满
- **预期**：触发 Level 3
- **验证**：极端情况下的激进压缩

## 测试配置

```typescript
{
  maxTokens: 2000,           // 故意设低，方便测试
  compressionThreshold: 1200, // 60%
  aggressiveThreshold: 1800,  // 90%
  maxToolOutputLength: 200,
  keepRecentMessages: 5,
}
```

## 查看输出

测试会输出详细信息：

```
测试: 场景 4：Agent 重复行为
============================================================
初始状态:
  - 消息数: 28
  - 对话轮数: 6
  - Token: 850 (42.5%)
  - 大型输出: 0
  - 重复度: 45.0%  ← 关键指标！
  - 需要压缩: 是
  - 紧急度: high
  - 原因:
    • 检测到重复行为（45%），Agent 可能陷入困境

开始压缩...
  💭 检测到压缩触发条件：检测到重复行为（45%）...
  ✂️ Level 3 压缩: 850 → 200 tokens
  ⚠️ frequent-compression: 检测到重复行为...

压缩结果:
  ✅ 执行了 Level 3 压缩
  ✅ 符合预期（Level 3）
  ⚠️ 触发了 1 个警告
  ✅ 符合预期（应有警告）
```

## 关键验证点

### ✅ 重复检测工作
```
重复度: 45.0%
原因: 检测到重复行为（45%），Agent 可能陷入困境
```

### ✅ 正确决策层级
```
场景 1 → 不压缩
场景 2 → Level 2
场景 3 → Level 1/2
场景 4 → Level 3 ⚠️
场景 5 → Level 3
```

### ✅ 退场信号触发
```
场景 4: ⚠️ frequent-compression
建议: 检测到重复行为...建议检查任务或转人工处理
```

## 不需要 API

这个测试**不需要实际的 LLM API**，因为：
- 只测试触发逻辑
- 只测试健康评估
- 模拟消息历史

如果需要测试完整的压缩（包括 Anchor 生成），运行：

```bash
# 需要配置 API
API_KEY=xxx MODEL=xxx BASE_URL=xxx pnpm test:anchor
```

## 自定义测试

可以修改 `test-smart-compression.ts` 中的配置：

```typescript
const testConfig = {
  historyManagement: {
    maxTokens: 2000,           // 调整上限
    compressionThreshold: 1200, // 调整阈值
    aggressiveThreshold: 1800,
  }
};
```

或者添加新的测试场景：

```typescript
function createMyScenario() {
  return [
    { role: 'user', content: '...' },
    // ...
  ];
}

await runTest(
  '我的场景',
  createMyScenario(),
  2,     // 预期层级
  false  // 预期警告
);
```

## 故障排查

### 问题：压缩未触发

**检查**：
- `shouldCompress` 返回 false？
- `health.reason` 是否为空？
- token 估算是否准确？

### 问题：层级不符合预期

**检查**：
- `health.urgency` 是什么？
- 各个维度的值是多少？
- 是否满足 Level 3 条件？

### 问题：重复检测失效

**检查**：
- 消息数量是否足够（至少 10 条）
- 重复模式是否明显？
- 检测窗口是否合理？

## 下一步

测试通过后，可以：
1. 在实际应用中集成
2. 监控压缩事件
3. 根据实际情况调整阈值
4. 收集数据优化重复检测算法

## 相关文档

- [三层压缩架构](./three-layer-compression.md)
- [智能触发机制](./smart-compression-trigger.md)
- [Level 3 退场信号](./level3-exit-signal.md)
