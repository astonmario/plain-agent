# Subagent 架构设计

## 设计原则

**核心理念**：将子 Agent 能力设计为可插拔的独立模块，而非写死在 Agent Core 中。

> 子 Agent 应与主 Agent 共用执行逻辑，但拥有独立的运行状态。通过明确的任务输入和结果接口通信，避免共享可变对话状态。

## 架构分层

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Core                           │
│  推理循环、上下文、任务状态、工具调用                      │
│  (复用现有 PlainAgent 实现)                              │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ↓                         ↓
┌───────────────────┐    ┌──────────────────┐
│ Subagent Runtime  │    │   Scheduler      │
│ - spawn()         │    │ - 串行调度        │
│ - wait()          │    │ - 并行调度        │
│ - cancel()        │    │ - 任务队列        │
│ - resume()        │    └──────────────────┘
└─────────┬─────────┘
          │
    ┌─────┴──────┬──────────┬──────────────┐
    ↓            ↓          ↓              ↓
┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
│ Context │ │  Tool   │ │  Task    │ │  Event   │
│ Manager │ │ Policy  │ │  Store   │ │  Bridge  │
└─────────┘ └─────────┘ └──────────┘ └──────────┘
```

## 核心接口设计

### 1. SubagentRequest - 子 Agent 请求

```typescript
export interface SubagentRequest {
  /** 父任务运行 ID（追溯链路） */
  parentRunId: string;
  
  /** 子任务描述 */
  task: string;
  
  /** 可选角色（如 "代码审查员"、"测试生成器"） */
  role?: string;
  
  /** 上下文信息（父 Agent 传递给子 Agent） */
  context?: {
    /** 摘要信息（避免传递完整历史） */
    summary?: string;
    
    /** 相关文件列表 */
    files?: string[];
    
    /** 自定义上下文数据 */
    [key: string]: any;
  };
  
  /** 工具白名单（限制子 Agent 可用工具） */
  tools?: string[];
  
  /** 执行配置 */
  config?: {
    /** 最大迭代次数 */
    maxIterations?: number;
    
    /** 超时时间（毫秒） */
    timeout?: number;
    
    /** 权限模式 */
    permissionMode?: 'trust' | 'standard' | 'ask';
  };
}
```

### 2. SubagentResult - 子 Agent 结果

```typescript
export interface SubagentResult {
  /** 子任务运行 ID */
  runId: string;
  
  /** 执行状态 */
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  
  /** 输出结果（成功时） */
  output?: string;
  
  /** 错误信息（失败时） */
  error?: string;
  
  /** 产出的文件/资源 */
  artifacts?: Array<{
    type: 'file' | 'data' | 'report';
    path?: string;
    content?: string;
    metadata?: Record<string, any>;
  }>;
  
  /** 执行统计 */
  stats?: {
    startedAt: number;
    finishedAt: number;
    iterations: number;
    toolCalls: number;
    tokensUsed: number;
  };
  
  /** 压缩的执行摘要（用于回注父 Agent） */
  summary?: string;
}
```

### 3. SubagentRuntime - 运行时接口

```typescript
export interface SubagentRuntime {
  /**
   * 创建并启动子 Agent
   * @returns 子任务运行 ID
   */
  spawn(request: SubagentRequest): Promise<{ runId: string }>;
  
  /**
   * 等待子 Agent 完成（阻塞）
   * @param runId 子任务运行 ID
   * @param timeout 可选超时时间（毫秒）
   * @returns 执行结果
   */
  wait(runId: string, timeout?: number): Promise<SubagentResult>;
  
  /**
   * 取消子 Agent 执行
   * @param runId 子任务运行 ID
   */
  cancel(runId: string): Promise<void>;
  
  /**
   * 获取子 Agent 当前状态（非阻塞）
   * @param runId 子任务运行 ID
   */
  getStatus(runId: string): Promise<{
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    progress?: string;
  }>;
  
  /**
   * 恢复已持久化的子任务（应用重启后）
   * @param runId 子任务运行 ID
   */
  resume(runId: string): Promise<SubagentResult>;
  
  /**
   * 订阅子 Agent 事件
   * @param runId 子任务运行 ID
   * @param listener 事件监听器
   */
  on(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void
  ): void;
}
```

## 关键组件设计

### 1. Context Manager - 上下文管理

**职责**：
- 隔离父子 Agent 的对话历史
- 摘要父 Agent 上下文传递给子 Agent
- 结果回注到父 Agent（避免上下文爆炸）

```typescript
interface ContextManager {
  /**
   * 为子 Agent 准备上下文（摘要 + 相关文件）
   */
  prepareSubagentContext(
    parentMessages: ChatMessage[],
    request: SubagentRequest
  ): Promise<ChatMessage[]>;
  
  /**
   * 将子 Agent 结果压缩后注入父 Agent
   */
  injectResult(
    parentMessages: ChatMessage[],
    result: SubagentResult
  ): ChatMessage[];
}
```

**实现策略**：
- 传递摘要而非完整历史（复用现有 `HistoryManager` 的压缩能力）
- 结果回注时控制注入长度（类似当前的 `JOB_INJECT_MAX_PER_JOB`）
- 支持多层嵌套（子 Agent 的子 Agent）

### 2. Tool Policy - 工具权限控制

**职责**：
- 白名单控制子 Agent 可用工具
- 危险工具降级（如禁止子 Agent 使用 `bash` 删除文件）
- 工具调用审计

```typescript
interface ToolPolicy {
  /**
   * 过滤工具列表
   */
  filterTools(
    allTools: Tool[],
    allowedToolNames?: string[]
  ): Tool[];
  
  /**
   * 检查工具调用是否允许
   */
  checkToolCall(
    toolName: string,
    args: any,
    context: { parentRunId: string; depth: number }
  ): Promise<boolean>;
}
```

**默认策略**：
- 只读工具默认允许（`read_file`、`grep`、`glob`）
- 写入工具需要明确授权（`write_file`、`edit_file`）
- `bash` 工具需要命令白名单
- 递归深度限制（防止子 Agent 无限嵌套）

### 3. Task Store - 任务持久化

**职责**：
- 持久化子任务状态（应用重启后可恢复）
- 存储子任务结果（父 Agent 可查询）
- 支持任务链路追溯

```typescript
interface TaskStore {
  /**
   * 保存子任务记录
   */
  saveTask(task: {
    runId: string;
    parentRunId: string;
    request: SubagentRequest;
    status: string;
    createdAt: number;
  }): Promise<void>;
  
  /**
   * 更新任务状态
   */
  updateTaskStatus(
    runId: string,
    status: string,
    result?: SubagentResult
  ): Promise<void>;
  
  /**
   * 加载未完成的任务（恢复用）
   */
  loadPendingTasks(parentRunId: string): Promise<SubagentRequest[]>;
  
  /**
   * 获取子任务历史（调试/审计用）
   */
  getTaskHistory(parentRunId: string): Promise<SubagentResult[]>;
}
```

**存储设计**：
- 复用现有 `SessionStorage` 接口扩展
- SQLite 表：`subagent_tasks` 和 `subagent_results`
- 支持按父任务 ID 查询所有子任务

### 4. Scheduler - 调度器

**职责**：
- 串行执行多个子任务
- 并行执行多个子任务（带并发限制）
- 任务依赖管理（A 完成后才能执行 B）

```typescript
interface Scheduler {
  /**
   * 串行执行
   */
  sequential(
    requests: SubagentRequest[]
  ): AsyncIterableIterator<SubagentResult>;
  
  /**
   * 并行执行（带并发限制）
   */
  parallel(
    requests: SubagentRequest[],
    concurrency?: number
  ): Promise<SubagentResult[]>;
  
  /**
   * DAG 依赖执行
   */
  dag(
    tasks: Array<{
      request: SubagentRequest;
      dependsOn?: string[]; // runIds
    }>
  ): AsyncIterableIterator<SubagentResult>;
}
```

## 使用示例

### 基础用法：单个子任务

```typescript
const runtime = new SubagentRuntime({
  agentFactory: (config) => new PlainAgent(config),
  storage: agent.storage,
});

// 1. 创建子任务
const { runId } = await runtime.spawn({
  parentRunId: currentTaskId,
  task: '分析 src/utils.ts 文件，找出所有未使用的函数',
  tools: ['read_file', 'grep'], // 只允许只读工具
  config: {
    maxIterations: 20,
    timeout: 60000, // 1 分钟超时
  },
});

// 2. 等待完成
const result = await runtime.wait(runId);

// 3. 使用结果
if (result.status === 'completed') {
  console.log('子任务输出:', result.output);
}
```

### 进阶用法：并行任务

```typescript
const files = ['a.ts', 'b.ts', 'c.ts'];

// 并行分析多个文件
const results = await scheduler.parallel(
  files.map(file => ({
    parentRunId: currentTaskId,
    task: `检查 ${file} 的代码质量`,
    tools: ['read_file'],
  })),
  3 // 最多 3 个并发
);

// 聚合结果
const issues = results.flatMap(r => r.artifacts || []);
```

### 高级用法：递归子任务

```typescript
// 父任务：代码重构
const { runId: planRunId } = await runtime.spawn({
  parentRunId: mainTaskId,
  task: '分析项目，生成重构计划',
  tools: ['read_file', 'glob', 'grep'],
});

const plan = await runtime.wait(planRunId);

// 子任务：执行重构步骤
if (plan.artifacts) {
  for (const step of plan.artifacts) {
    const { runId } = await runtime.spawn({
      parentRunId: planRunId, // 父任务是 plan
      task: step.content,
      tools: ['read_file', 'write_file', 'edit_file'],
    });
    
    await runtime.wait(runId);
  }
}
```

## 实现路线图

### Phase 1: 基础能力（MVP）
- [ ] 定义核心接口（`SubagentRuntime`、`SubagentRequest`、`SubagentResult`）
- [ ] 实现简单的子 Agent 创建和等待（共享 Agent Core）
- [ ] 上下文隔离（独立的消息历史）
- [ ] 基础工具白名单

### Phase 2: 持久化和恢复
- [ ] `TaskStore` 接口和 SQLite 实现
- [ ] 任务状态持久化
- [ ] 应用重启后恢复未完成任务

### Phase 3: 调度和并发
- [ ] `Scheduler` 实现
- [ ] 串行执行
- [ ] 并行执行（带并发限制）
- [ ] 超时控制

### Phase 4: 高级特性
- [ ] 递归子任务（子 Agent 的子 Agent）
- [ ] 结果摘要和智能回注
- [ ] 事件桥接（父 Agent 监听子 Agent 事件）
- [ ] DAG 任务依赖

### Phase 5: 工具和监控
- [ ] 内置工具：`spawn_subagent`、`wait_subagent`
- [ ] 可视化：任务树、执行时间线
- [ ] 审计日志：所有子任务的完整记录

## 架构优势

### 1. 可插拔性
- Agent Core 保持独立，不污染核心逻辑
- 可替换不同的 `SubagentRuntime` 实现
- 支持外部 Agent 适配器（如调用远程 API）

### 2. 灵活性
- 支持简单委派、Supervisor、递归子任务
- 可定制上下文传递策略
- 可配置工具权限和执行策略

### 3. 可扩展性
- 从单机到分布式（未来可部署独立的 Subagent 服务）
- 从内存到持久化（SQLite → PostgreSQL）
- 从同步到异步（等待 → 事件订阅）

### 4. 可维护性
- 清晰的接口边界
- 独立的状态管理
- 便于测试和调试

## 关键架构取舍

### ✅ DO - 推荐做法

1. **独立状态**：每个子 Agent 拥有独立的对话历史
2. **明确接口**：通过 `SubagentRequest` 和 `SubagentResult` 通信
3. **结果压缩**：回注时摘要子任务执行过程
4. **工具隔离**：白名单控制子 Agent 可用工具
5. **持久化优先**：所有子任务状态写入存储

### ❌ DON'T - 避免做法

1. **共享状态**：不要让子 Agent 直接修改父 Agent 的 `fullMessages`
2. **写死逻辑**：不要在 Agent Core 里硬编码子 Agent 创建逻辑
3. **无限递归**：必须限制子任务嵌套深度
4. **上下文泄露**：不要传递父 Agent 的完整历史
5. **权限继承**：子 Agent 权限应低于或等于父 Agent

## 与现有系统集成

### 复用现有能力

- **Agent Core**：直接实例化 `PlainAgent`
- **HistoryManager**：压缩上下文传递给子 Agent
- **JobRegistry**：参考后台任务的生命周期管理
- **ToolContext**：扩展 `signal`、`jobs` 字段添加 `subagents`
- **SessionStorage**：扩展接口支持子任务存储

### 新增工具

```typescript
// tools/subagent.ts
export const spawnSubagentTool: Tool = {
  name: 'spawn_subagent',
  description: '创建子 Agent 执行独立子任务',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '子任务描述' },
      tools: { type: 'array', items: { type: 'string' } },
      wait: { type: 'boolean', description: '是否等待完成' },
    },
    required: ['task'],
  },
  execute: async (args, ctx) => {
    const runtime = ctx.subagentRuntime;
    const { runId } = await runtime.spawn({
      parentRunId: ctx.taskId,
      task: args.task,
      tools: args.tools,
    });
    
    if (args.wait) {
      const result = await runtime.wait(runId);
      return JSON.stringify(result);
    }
    
    return `子任务已创建，runId: ${runId}`;
  },
};
```

## 参考实现

类似的多 Agent 架构实现：
- **AutoGPT**：递归子任务，独立上下文
- **LangChain Agents**：可组合的 Agent 链
- **Microsoft AutoGen**：多 Agent 对话框架
- **Claude Code**：子 Agent 工具（`Agent` tool）

---

**最后更新**：2025-01-XX  
**状态**：设计阶段  
**负责人**：待定
