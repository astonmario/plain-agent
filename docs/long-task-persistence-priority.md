# 长任务 Agent：第一阶段实施建议

## 结论

实现长任务时，第一步建议完善：

> **任务持久化、状态机与恢复租约。**

这是长任务系统的基础，优先级高于 Cron、Heartbeat、上下文压缩和复杂 DAG 调度。

当前项目已经具备：

- `SQLiteStorage`：会话、消息、事件持久化
- `HistoryManager`：上下文压缩
- `JobRegistry`：后台进程
- `SubagentRuntime`：子 Agent

但核心缺口是：**正在执行的任务本身没有可靠持久化。**

进程重启后，目前无法准确知道：

- 哪个任务正在运行；
- 任务已经执行到哪一步；
- 任务应该继续、重试还是取消；
- 子 Agent 是否仍未完成；
- 是否有审批或外部进程在等待；
- 两个 worker 是否会重复执行同一个任务。

## 为什么先做持久化

长任务不是把 ReAct 循环的 `maxIterations` 从 50 调大到 500。

真正的长任务需要支持：

```text
创建任务
  -> 执行一段
  -> 保存状态和事件
  -> 暂停/等待/失败
  -> 进程重启
  -> 从上次状态继续
  -> 验证结果
  -> 完成任务
```

如果任务没有持久化，后续功能都会变得不可靠：

- Cron 触发后不知道任务是否已经执行；
- Heartbeat 无法判断上一次任务是否卡住；
- 子 Agent 无法在父任务重启后恢复；
- 上下文压缩后无法确定恢复点；
- worker 崩溃后任务可能永久停留在 `running`；
- 后台命令可能重复执行。

## 第一阶段目标

第一阶段只解决一个问题：

> **Agent 进程或 worker 被杀掉后，任务不会丢失，并且可以继续、重试或明确进入失败状态。**

结合本项目的实际形态，第一阶段以 `domain`、CLI 和 Desktop 为主运行路径；Server 层暂不接入，待任务模型、TaskStore 和单机恢复流程稳定后再单独规划 HTTP/SSE 适配。

建议第一阶段暂时不实现：

- 复杂 DAG；
- 多渠道通知；
- Heartbeat；
- Cron；
- 分布式 worker；
- 多租户配额；
- 高级智能调度。

先把单机、单 worker、SQLite 持久化做可靠。

## 第一阶段实施顺序

### 1. 建立统一任务状态模型

新增统一任务状态：

```ts
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_child'
  | 'waiting_process'
  | 'waiting_user'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

状态含义：

| 状态 | 含义 |
|---|---|
| `queued` | 等待 worker 执行 |
| `running` | Agent 正在执行 |
| `waiting_child` | 等待子 Agent |
| `waiting_process` | 等待后台进程 |
| `waiting_user` | 等待用户审批或输入 |
| `verifying` | 执行测试、检查 diff 或验证结果 |
| `paused` | 主动暂停，等待后续恢复 |
| `completed` | 已完成且验证通过 |
| `failed` | 执行失败且无法继续 |
| `cancelled` | 被用户或系统取消 |

建议限制状态转换，避免任务状态被任意覆盖：

```ts
const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  queued: ['running', 'cancelled'],
  running: [
    'waiting_child',
    'waiting_process',
    'waiting_user',
    'verifying',
    'paused',
    'failed',
    'cancelled',
  ],
  waiting_child: ['running', 'failed', 'cancelled'],
  waiting_process: ['running', 'failed', 'cancelled'],
  waiting_user: ['running', 'cancelled'],
  verifying: ['completed', 'running', 'failed'],
  paused: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};
```

### 2. 增加任务记录

建议新增 `TaskRecord`：

```ts
export interface TaskRecord {
  id: string;
  parentId?: string;
  rootId: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
  checkpointId?: string;
  resultSummary?: string;
  resultRef?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
```

字段说明：

- `id`：任务唯一 ID；
- `parentId`：父任务 ID，用于子 Agent；
- `rootId`：根任务 ID，方便查询完整任务树；
- `sessionId`：关联 Agent 会话；
- `attempt`：当前执行次数；
- `maxAttempts`：最大重试次数；
- `leaseOwner`：当前 worker；
- `leaseUntil`：worker 租约过期时间；
- `checkpointId`：最近一次可恢复检查点；
- `resultRef`：完整结果或工件的存储引用。

### 3. 增加 SQLite TaskStore

第一版可以扩展现有 `SQLiteStorage`，也可以单独实现 `SQLiteTaskStore`。

建议至少提供以下接口：

```ts
export interface TaskStore {
  createTask(task: TaskRecord): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<void>;
  transition(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
  ): Promise<boolean>;
  claimNext(workerId: string): Promise<TaskRecord | null>;
  renewLease(taskId: string, workerId: string): Promise<boolean>;
  releaseLease(taskId: string, workerId: string): Promise<void>;
  listRecoverableTasks(): Promise<TaskRecord[]>;
  appendEvent(taskId: string, type: string, data: unknown): Promise<void>;
}
```

建议新增的表：

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  root_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  lease_owner TEXT,
  lease_until INTEGER,
  checkpoint_id TEXT,
  result_summary TEXT,
  result_ref TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_claimable
  ON tasks(status, lease_until, updated_at);

CREATE INDEX idx_task_events_task
  ON task_events(task_id, seq);
```

## Worker 租约

不能只把任务标记为 `running`。

如果 worker 在运行中崩溃，任务会永久停留在 `running`。因此任务执行必须带租约：

```text
worker claim task
  -> status = running
  -> leaseOwner = worker-1
  -> leaseUntil = 当前时间 + 60 秒
```

worker 执行期间定期续租：

```text
当前时间 < leaseUntil
  -> 继续执行

当前时间 >= leaseUntil
  -> 任务可以被其他 worker 重新领取
```

伪代码：

```ts
async function claimNext(workerId: string): Promise<TaskRecord | null> {
  return db.transaction(async tx => {
    const task = tx.findClaimableTask(Date.now());
    if (!task) return null;

    const leaseUntil = Date.now() + 60_000;
    const claimed = tx.updateTaskIf(
      {
        id: task.id,
        status: task.status,
        leaseUntil: task.leaseUntil,
      },
      {
        status: 'running',
        leaseOwner: workerId,
        leaseUntil,
        attempt: task.attempt + 1,
      },
    );

    return claimed ? tx.getTask(task.id) : null;
  });
}
```

必须使用条件更新，避免两个 worker 同时领取同一个任务。

## 任务事件

状态表只保存当前状态，事件表保存完整执行过程。

建议记录：

```text
task-created
task-claimed
task-started
iteration-started
tool-started
tool-completed
checkpoint-created
approval-required
child-created
child-completed
verification-started
verification-failed
task-completed
task-failed
task-cancelled
```

事件的用途：

- 调试；
- UI 展示任务时间线；
- 崩溃后恢复；
- 审计；
- 统计工具调用、耗时和重试；
- 重新构造任务状态。

建议原则：

> 先追加事件，再更新当前状态。

例如完成任务时：

```text
1. 写入 task-completed 事件
2. 更新 tasks.status = completed
3. 写入结果摘要和验证结果
```

## 子 Agent 持久化改造

当前 `SubagentRuntime` 存在两个问题：

1. 默认使用内存 `MemoryTaskStore`；
2. 子 Agent 使用 `storage: undefined`。

建议改造为：

- 默认使用 SQLite TaskStore；
- 每个子 Agent 有独立持久化 `sessionId`；
- 父任务重启时加载未完成子任务；
- 子任务结果只回传摘要和 artifact 引用；
- 完整子任务历史保留在自己的 session 中；
- 父任务取消时才级联取消子任务；
- `wait()` 超时区分“等待超时”和“任务失败”。

推荐的上下文回传格式：

```ts
interface SubagentResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  summary?: string;
  resultRef?: string;
  artifacts?: Array<{
    type: 'file' | 'data' | 'report';
    path?: string;
    ref?: string;
  }>;
}
```

父 Agent 不应该接收子 Agent 的完整消息历史，否则会重新造成上下文膨胀。

## 与现有模块的关系

### `PlainAgent`

继续负责：

- 一次 Agent 执行；
- ReAct 循环；
- 工具调用；
- 事件发射；
- 权限检查；
- 会话消息。

暂时不要让它负责：

- Cron；
- worker 调度；
- 租约；
- 全局重试；
- 通知；
- 多任务依赖。

### `HistoryManager`

继续负责：

- 工具输出截断；
- Anchor；
- 上下文压缩；
- 历史检索。

后续再将它接入 checkpoint/resume。

### `JobRegistry`

继续负责：

- 启动后台进程；
- 收集输出；
- 读取日志；
- 终止进程。

下一阶段再补充：

- 进程状态持久化；
- 进程恢复；
- `waiting_process` 状态；
- 完成后的验证。

### `SubagentRuntime`

负责：

- 创建子 Agent；
- 并发限制；
- 递归深度；
- 子任务生命周期；
- 持久化任务状态。

## 后续实现顺序

```text
P0.1  TaskRecord + TaskStatus
P0.2  SQLiteTaskStore
P0.3  状态转换和 task_events
P0.4  Worker claim/lease
P0.5  worker 崩溃恢复
P0.6  SubagentRuntime 使用持久化 TaskStore
P1.1  checkpoint/resume
P1.2  后台进程恢复
P1.3  verifying 和验证证据
P2.1  子 Agent DAG
P2.2  Heartbeat/Cron
P2.3  通知和多 worker
```

## 第一轮验收标准

第一阶段完成后，至少应通过以下场景：

### 场景 1：正常完成

```text
create task
  -> queued
  -> running
  -> completed
```

要求：

- 状态转换完整；
- 事件顺序正确；
- 结果摘要已保存；
- 任务可以通过 ID 查询。

### 场景 2：worker 崩溃

```text
running
  -> worker 被杀掉
  -> lease 过期
  -> 任务重新进入 queued
  -> 新 worker 继续执行
```

要求：

- 任务不会永久停留在 `running`；
- 不会同时出现两个有效 worker；
- 重启后可以找到任务；
- 失败原因和重试次数可查询。

### 场景 3：任务失败和重试

```text
running
  -> failed
  -> queued
  -> running
  -> completed
```

要求：

- 重试次数递增；
- 超过 `maxAttempts` 后不再自动重试；
- 最终错误被保存。

### 场景 4：子 Agent

```text
parent running
  -> child created
  -> parent waiting_child
  -> child completed
  -> parent running
```

要求：

- 子任务有独立 ID；
- 父子关系可查询；
- 子任务结果只以摘要形式回注；
- 父任务重启后可以找到未完成子任务。

## 第一阶段完成定义

以下条件全部满足，才算第一阶段完成：

- [ ] 有统一 `TaskStatus`；
- [ ] 有持久化 `TaskRecord`；
- [ ] 有 SQLite TaskStore；
- [ ] 有状态转换校验；
- [ ] 有 task event 记录；
- [ ] 有 worker claim/lease；
- [ ] 有租约过期恢复；
- [ ] 有失败重试策略；
- [ ] 子 Agent 状态不再只存在内存；
- [ ] 有 worker 崩溃恢复测试；
- [ ] 有正常完成、失败重试和子 Agent 测试。

## 最终建议

长任务实现建议从下面这个最小闭环开始：

```text
create
  -> persist
  -> claim
  -> run
  -> append events
  -> renew lease
  -> complete or retry
```

完成这个闭环后，再实现：

```text
checkpoint/resume
  -> 子 Agent DAG
  -> 后台进程恢复
  -> verifying
  -> Heartbeat/Cron
  -> 通知和多 worker
```

核心原则是：

> **先保证任务不会丢，再让任务运行得更久；先保证状态可恢复，再增加调度复杂度。**

