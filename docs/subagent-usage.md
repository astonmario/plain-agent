# Subagent 使用指南

## 概述

Subagent（子agent）功能允许 Agent 将任务委派给独立的子 Agent 执行，实现任务分解、并行处理和递归协作。

## 快速开始

### 1. 启用子agent功能

```typescript
import { PlainAgent, getBuiltinTools, MemoryStorage } from '@plain-agent/domain';

const agent = new PlainAgent({
  llm: {
    provider: 'openai',
    apiKey: process.env.API_KEY!,
    model: 'deepseek-chat',
    baseUrl: process.env.BASE_URL,
  },
  tools: getBuiltinTools(),
  storage: new MemoryStorage(),
  enableSubagents: true, // 启用子agent
  subagentConfig: {
    maxConcurrency: 5,      // 最多5个并发子任务
    defaultTimeout: 300000, // 5分钟超时
    maxDepth: 3,            // 最多3层递归
  },
});
```

### 2. 使用子agent工具

启用后，Agent 自动获得以下工具：

#### `spawn_subagent` - 创建子任务

```typescript
// Agent 可以这样调用
await agent.submit(`
  创建一个子任务来分析 package.json 文件：
  - 使用 spawn_subagent 工具
  - task: "读取并分析 package.json，提取项目名称和依赖列表"
  - wait: true  // 等待完成
`);
```

#### `wait_subagent` - 等待子任务完成

```typescript
// 异步创建多个子任务后等待
await agent.submit(`
  1. 创建子任务A（wait=false）
  2. 创建子任务B（wait=false）
  3. 使用 wait_subagent 分别等待它们完成
`);
```

#### `cancel_subagent` - 取消子任务

```typescript
await agent.submit(`
  取消运行中的子任务：run_id=xxx
`);
```

#### `get_subagent_status` - 查询子任务状态

```typescript
await agent.submit(`
  查询子任务状态：run_id=xxx
`);
```

## 核心特性

### 1. 独立状态隔离

每个子 Agent 拥有独立的：
- 对话历史
- 工具上下文
- 执行状态

```typescript
// 父 Agent 的历史不会传递给子 Agent
// 只通过 context_summary 传递必要信息
```

### 2. 工具白名单

限制子 Agent 可用的工具：

```typescript
await agent.submit(`
  创建只读子任务：
  - task: "分析代码结构"
  - allowed_tools: ["read_file", "grep", "glob"]  // 只允许只读工具
  - wait: true
`);
```

### 3. 并发控制

自动管理并发数量：

```typescript
subagentConfig: {
  maxConcurrency: 3  // 最多3个子任务同时运行
}
```

### 4. 递归深度限制

防止无限嵌套：

```typescript
subagentConfig: {
  maxDepth: 2  // 子任务最多嵌套2层
}
```

## 使用场景

### 场景1：任务分解

```typescript
const result = await agent.submit(`
  项目代码审查任务，分解为3个子任务：
  1. 子任务A：检查 src/utils 目录的代码质量
  2. 子任务B：检查 src/components 目录
  3. 子任务C：检查 tests 目录的测试覆盖率
  
  使用 spawn_subagent 并发执行（wait=false），然后汇总结果
`);
```

### 场景2：专家角色

```typescript
const result = await agent.submit(`
  创建一个代码审查专家子任务：
  - role: "代码审查员"
  - task: "审查 src/agent.ts，关注安全性和性能"
  - context_summary: "这是 Agent 核心类，负责任务管理和生命周期控制"
  - wait: true
`);
```

### 场景3：递归任务

```typescript
const result = await agent.submit(`
  创建一个递归任务规划器：
  1. 子任务：分析项目，生成重构计划
  2. 该子任务内部可以再创建更多子任务来执行每个重构步骤
`);
```

### 场景4：隔离危险操作

```typescript
const result = await agent.submit(`
  创建一个隔离的子任务来测试代码：
  - task: "运行测试套件"
  - allowed_tools: ["bash", "read_file"]
  - 即使测试失败也不影响主任务
`);
```

## 事件监听

监听子agent相关事件：

```typescript
agent.on('event', (event) => {
  if (event.type === 'tool_start' && event.tool === 'spawn_subagent') {
    console.log('创建子任务:', event.args.task);
  }
});

// SubagentRuntime 也支持事件
const runtime = agent.subagentRuntime;
runtime.on('subagent-created', ({ runId, request }) => {
  console.log('子任务已创建:', runId);
});

runtime.on('subagent-completed', ({ runId, result }) => {
  console.log('子任务完成:', runId, result.status);
});
```

## 最佳实践

### ✅ 推荐做法

1. **明确子任务边界**
   - 每个子任务应该是独立、可完成的单元
   - 避免子任务之间有复杂的依赖关系

2. **传递必要上下文**
   - 使用 `context_summary` 传递关键信息
   - 不要传递完整的父 Agent 历史

3. **合理设置超时**
   - 根据子任务复杂度设置合适的超时时间
   - 长任务可以设置更长的超时

4. **控制并发数**
   - 根据系统资源设置合理的 `maxConcurrency`
   - 避免创建过多并发子任务导致资源耗尽

5. **使用工具白名单**
   - 限制子 Agent 的权限，遵循最小权限原则
   - 只读任务只允许只读工具

### ❌ 避免做法

1. **避免无限递归**
   - 不要让子任务无条件地创建更多子任务
   - 始终设置合理的 `maxDepth`

2. **避免状态共享**
   - 不要让子任务修改父任务的状态
   - 通过返回值传递结果

3. **避免过度分解**
   - 不是所有任务都需要子任务
   - 简单任务直接执行更高效

4. **避免循环依赖**
   - 子任务A等待子任务B，B又等待A
   - 设计时避免循环依赖

## 架构说明

### 核心组件

```
SubagentRuntime
├── spawn()      - 创建子任务
├── wait()       - 等待完成
├── cancel()     - 取消任务
└── getStatus()  - 查询状态

ToolPolicy
├── filterTools()     - 过滤工具（未指定白名单时只给 meta.readonly 的工具）
└── checkToolCall()   - 检查权限

TaskStore（默认内存实现，SQLite 待做）
├── saveTask()        - 保存任务
├── updateTaskStatus() - 更新状态
└── getTaskHistory()  - 查询历史
```

上下文传递目前只有一种方式：`role`、`context_summary`、`relevant_files` 写入子 Agent 的
system prompt，任务本身作为 user 消息提交；子 Agent 的最终回复作为工具结果返回给父 Agent。

隔离规则：

- 子 Agent 的 `sessionId` 即 `runId`，不写父会话存储
- 子 Agent 只继承父 Agent 的基础工具，不继承绑定父历史的 `lookup_history` / `search_history`
- 子 Agent 权限模式默认与父 Agent 一致
- 子 Agent 共享父级 runtime，并发数与递归深度全局统一计算；到达深度上限的子 Agent 不再拿到 `spawn_subagent` 工具
- 父任务被停止时，正在 `wait` 的子任务会被一并取消

### 数据流

```
父 Agent
  ↓ spawn_subagent
SubagentRuntime
  ↓ create
子 Agent 实例
  ↓ execute
SubagentResult
  ↓ 工具结果
父 Agent 对话历史
```

## 测试

```bash
# 运行时单元测试（不调用 LLM，假 Agent，秒级完成）
pnpm test:subagent

# 端到端测试（真实调用 LLM，读取根目录 .env）
pnpm test:subagent:e2e
```

单元测试覆盖：spawn/wait、上下文隔离、工具白名单、并发上限（含并发 spawn 竞态）、
递归深度、失败、超时、取消（终态不被覆盖）。

端到端测试覆盖：同步委派、并行委派、递归委派 + 深度限制。

## 配置参考

### AgentConfig 扩展

```typescript
interface AgentConfig {
  // ... 其他配置
  enableSubagents?: boolean;  // 默认 false
  subagentConfig?: {
    maxConcurrency?: number;   // 默认 5
    defaultTimeout?: number;   // 默认 300000 (5分钟)
    maxDepth?: number;         // 默认 3
  };
}
```

### SubagentRequest

```typescript
interface SubagentRequest {
  parentRunId: string;         // 父任务ID
  task: string;                // 任务描述
  role?: string;               // 角色（可选）
  context?: {
    summary?: string;          // 上下文摘要
    files?: string[];          // 相关文件
    [key: string]: any;        // 自定义数据
  };
  tools?: string[];            // 工具白名单
  config?: {
    maxIterations?: number;    // 最大迭代次数
    timeout?: number;          // 超时时间
    permissionMode?: string;   // 权限模式
  };
}
```

### SubagentResult

```typescript
interface SubagentResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  output?: string;             // 输出结果
  error?: string;              // 错误信息
  artifacts?: Array<{          // 产出物
    type: 'file' | 'data' | 'report';
    path?: string;
    content?: string;
  }>;
  stats?: {                    // 统计信息
    startedAt: number;
    finishedAt: number;
    duration: number;
    iterations: number;
    toolCalls: number;
  };
  summary?: string;            // 摘要
}
```

## 故障排查

### 问题1：子任务超时

**症状**：子任务执行时间过长，超时失败

**解决**：
```typescript
// 增加超时时间
subagentConfig: {
  defaultTimeout: 600000  // 10分钟
}

// 或在创建时指定
spawn_subagent({
  task: "...",
  config: { timeout: 600000 }
})
```

### 问题2：超过并发限制

**症状**：错误 "Maximum concurrent subagents reached"

**解决**：
```typescript
// 增加并发数
subagentConfig: {
  maxConcurrency: 10
}

// 或等待已有子任务完成
```

### 问题3：超过递归深度

**症状**：错误 "Maximum recursion depth exceeded"

**解决**：
```typescript
// 增加最大深度
subagentConfig: {
  maxDepth: 5
}

// 或重构任务，减少嵌套层级
```

## 更多信息

- [架构设计文档](./subagent-architecture.md) - 详细的架构设计
- [API 文档](../domain/src/subagent/types.ts) - 完整的类型定义
- [测试用例](../domain/test/test-subagent.ts) - 实际使用示例

---

**版本**: v0.1.0 (Phase 1 MVP)  
**状态**: ✅ 可用  
**最后更新**: 2025-01-XX
