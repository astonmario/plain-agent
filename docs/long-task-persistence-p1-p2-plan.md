# 长任务持久化 P1/P2 实施计划

## 0. 计划范围

本计划对应当前讨论中的两个阶段：

- **P1：Phase 1.5 恢复语义加固**
  - 让任务树、子 Agent、租约过期和恢复入口语义一致；
  - 不新增 Cron、Heartbeat、Server API 或复杂 DAG。
- **P2：Checkpoint/Resume**
  - 将一次性 `PlainAgent.submit()` 拆成可持久化的执行 turn；
  - worker 或 Agent 进程退出后，从最近稳定边界继续执行；
  - 保持现有 `submit()`、CLI 和 Desktop 公开行为兼容。

本计划只覆盖 P1/P2。后台进程恢复、验证闭环、审批恢复和调度器留到后续阶段。

## 1. 当前基线

Phase 1 已经具备：

- `TaskRecord`、`TaskStatus`、状态转换和 `task_events`；
- SQLite/Memory `TaskStore`；
- worker claim、lease renew、lease expiry recovery；
- `TaskOrchestrator`；
- CLI/Desktop 启动时恢复过期任务；
- 子 Agent 的任务记录、父子关系和结果持久化。

已验证：

```text
domain typecheck       passed
domain test:tasks      passed
domain test:subagent   26 passed
cli typecheck          passed
desktop typecheck      passed
desktop typecheck:web  passed
server typecheck       passed
```

当前缺口：

1. `TaskRecord.checkpointId` 已存在，但没有 checkpoint 数据模型、表或 `TaskStore` 接口。
2. `PlainAgent` 只在 `submit()` 返回后保存新增消息，执行中崩溃会丢失当前执行过程。
3. `agentLoop()` 是一次性循环，没有稳定的暂停/继续边界。
4. `TaskOrchestrator.recover()` 当前只自动恢复顶层 queued 任务。
5. `SubagentRuntime.recoverPending()` 只恢复 queued 子任务，且没有统一接入父任务恢复流程。
6. 当前 `TaskStatus` 没有 `blocked`，无法表达“自动重试不安全，需要人工确认”。
7. 同一 `PlainAgent` 实例共享 `fullMessages`，P2 不能继续依赖共享可变消息数组做恢复。

## 2. 目标架构

```text
                    +----------------------+
CLI / Desktop ----> | TaskOrchestrator     |
                    | claim / lease / run  |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PlainAgent           |
                    | runTurn / resume     |
                    +----------+-----------+
                               |
                 +-------------+-------------+
                 v                           v
        task-scoped transcript       checkpoint + task events
        messages/tool results        durable logical state
                 |                           |
                 +-------------+-------------+
                               v
                         SQLiteTaskStore

Recovery:
lease expired -> recover task tree -> restore checkpoint
              -> resume stable boundary -> continue / blocked
```

职责边界：

- `TaskOrchestrator`：任务生命周期、租约、恢复、重试和父子任务协调。
- `PlainAgent`：一个任务的 turn 执行、工具调用和上下文推进。
- `TaskStore`：任务、事件、checkpoint 和执行日志的持久化。
- `SessionStorage`：用户会话展示历史；不再作为长任务恢复的唯一事实源。

## 3. P1：恢复语义加固

### 3.1 状态模型

在 `TaskStatus` 中增加：

```ts
'blocked'
```

建议转换：

```text
queued
  -> running
running
  -> queued              lease recovery
  -> waiting_child
  -> waiting_process
  -> waiting_user
  -> blocked
  -> paused
  -> completed / failed / cancelled

waiting_child
  -> running             child completed
  -> blocked             child state cannot be reconstructed
  -> failed / cancelled

blocked
  -> queued              explicit retry
  -> running             external condition resolved
  -> cancelled
```

`blocked` 不代表普通失败。它表示系统无法安全地自动继续，例如：

- 一个有副作用的工具调用已经开始，但结果未知；
- 子 Agent 的执行上下文无法恢复；
- 外部进程状态无法确认。

### 3.2 任务树恢复

修改：

- `domain/src/tasks/types.ts`
- `domain/src/tasks/transitions.ts`
- `domain/src/tasks/store.ts`
- `domain/src/tasks/memory.ts`
- `domain/src/tasks/sqlite.ts`
- `domain/src/tasks/orchestrator.ts`
- `domain/src/subagent/runtime.ts`

新增能力：

```ts
interface TaskStore {
  listRecoverableTasks(now?: number): Promise<TaskRecord[]>;
  listChildren(parentId: string): Promise<TaskRecord[]>;
  recoverTaskTree(rootId: string, now?: number): Promise<TaskRecord[]>;
}
```

恢复流程：

```text
startup
  -> recover expired leases
  -> 找到 root task
  -> 加载 root 的所有 child task
  -> 根据状态分类
  -> 可安全继续: queued/running-expired
  -> 等待外部事件: waiting_child/waiting_process
  -> 无法判断: blocked
  -> 只启动一次 root recovery
```

要求：

- `recover()` 必须幂等，多次调用不能重复启动同一个任务。
- 父任务恢复前先加载子任务状态。
- 父任务取消时才级联取消子任务。
- `wait(timeout)` 仍然只是观察超时，不改变真实任务。
- 子任务的 `delegation`、`depth`、`sessionId` 必须足以重建运行时。
- 恢复失败必须落 `task-recovery-failed` 事件，不能只打印日志。

### 3.3 P1 测试

新增或扩展：

- `domain/test/test-task-recovery.ts`
- `domain/test/test-subagent-runtime.ts`
- `domain/test/test-task-store.ts`

必须覆盖：

1. root task lease 过期后只恢复一次。
2. root task 有 queued child 时，重启后 child 可以继续执行。
3. child 已完成、父任务 waiting_child 时，父任务可以被唤醒。
4. child 状态无法重建时，父任务进入 blocked。
5. 父任务取消会取消未完成 child，普通 recovery 不会误取消 child。
6. Memory 与 SQLite 的恢复结果一致。
7. stale worker 不能覆盖新的 attempt。

## 4. P2：Checkpoint/Resume

### 4.1 数据模型

新增 `domain/src/tasks/checkpoints.ts`：

```ts
export interface TaskCheckpoint {
  id: string;
  taskId: string;
  attempt: number;
  iteration: number;
  transcriptCursor: number;
  state: {
    phase: 'ready' | 'after_llm' | 'after_tools' | 'paused';
    nextAction: 'continue' | 'complete' | 'wait_child' | 'wait_user' | 'blocked';
    pendingChildIds: string[];
    pendingJobIds: string[];
    contextSummary?: string;
  };
  summary: string;
  createdAt: number;
}
```

新增 SQLite 表：

```sql
CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  transcript_cursor INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_checkpoints_task
  ON task_checkpoints(task_id, created_at);
```

新增 `TaskStore` 接口：

```ts
createCheckpoint(checkpoint: TaskCheckpoint): Promise<void>;
getCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null>;
getLatestCheckpoint(taskId: string): Promise<TaskCheckpoint | null>;
commitCheckpoint(
  taskId: string,
  checkpoint: TaskCheckpoint,
  event: { type: string; data: unknown },
): Promise<boolean>;
```

`commitCheckpoint()` 必须在同一事务中完成：

```text
写 checkpoint
  -> 更新 tasks.checkpoint_id
  -> 写 task event
  -> commit
```

事务失败时，不能只更新 `checkpoint_id`。

### 4.2 任务级 transcript

长任务恢复不能只读取 session 的共享历史。新增任务级消息关联：

- SQLite `messages` 增加可空 `task_id`；
- 增加 `(session_id, task_id, id)` 索引；
- `SessionStorage.saveMessage()` 增加可选 `taskId`；
- `SessionStorage.loadMessages()` 增加可选 `taskId`；
- MemoryStorage 使用 `sessionId + taskId` 作为消息空间。

兼容规则：

- `taskId` 为空：保持现有交互式 Session 行为；
- `taskId` 有值：用于可恢复任务的 transcript；
- 旧数据库中的消息全部视为 session 级历史，不需要迁移内容。

这样可以避免两个任务共享同一个可变 `fullMessages`，也避免恢复时把别的任务消息重新发给模型。

### 4.3 Agent 执行 API

在 `PlainAgent` 中增加任务级执行上下文：

```ts
interface TaskExecutionContext {
  taskId: string;
  messages: ChatMessage[];
  iteration: number;
  checkpointId?: string;
}
```

新增：

```ts
runTurn(
  taskId: string,
  prompt: string,
  options?: { maxIterations?: number },
): Promise<AgentTurnResult>;

resume(
  taskId: string,
  checkpointId?: string,
): Promise<AgentTurnResult>;
```

`AgentTurnResult` 至少包含：

```ts
type AgentTurnResult =
  | { status: 'paused'; checkpointId: string }
  | { status: 'completed'; output: string }
  | { status: 'waiting_child'; childIds: string[] }
  | { status: 'waiting_user'; approvalId: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; error: SerializedError };
```

执行边界：

```text
开始 turn
  -> LLM response 持久化
  -> 执行一批工具
  -> 工具结果持久化
  -> 创建 checkpoint
  -> 达到 step budget: paused
  -> 无工具调用: completed
```

稳定 checkpoint 只在完整的 LLM response 和工具批次完成后创建。不要保存无法恢复的：

- `AbortController`
- Promise
- `ChildProcess`
- MCP 连接
- 流式响应中间状态

现有 `submit()` 保持兼容：

```text
TaskOrchestrator
  -> 对持久化任务使用 runTurn() / resume()

submit()
  -> 保留交互式一次性循环语义
  -> 同时双写 Session 展示历史和 task transcript
```

CLI/Desktop 仍调用原有 `submit()`，TaskOrchestrator 使用 `runTurn/resume`。

### 4.4 工具执行语义

P2 不承诺 exactly-once。副作用工具采用至少一次执行：

```text
tool-started
  -> tool-completed
  -> checkpoint
```

新增任务事件：

- `turn-started`
- `message-persisted`
- `tool-call-started`
- `tool-call-completed`
- `checkpoint-created`
- `turn-paused`
- `resume-started`
- `resume-replayed`
- `task-blocked`

恢复规则：

- 只读工具：未完成时可以自动重试；
- 可识别幂等键的工具：使用 `taskId + callId` 去重；
- 未知副作用工具：发现 `started` 但没有 `completed` 时进入 `blocked`；
- 禁止把所有工具调用都无条件重放。

### 4.5 TaskOrchestrator 流程

```text
claim task
  -> load latest checkpoint
  -> create task-scoped agent context
  -> runTurn
  -> commit checkpoint
  -> completed: finishAttempt
  -> paused: renew lease and continue
  -> blocked/waiting: release lease and wait for wakeup
  -> worker crash: lease expiry -> recover -> resume
```

`TaskOrchestrator.execute()` 不再直接依赖一次 `agent.submit()` 完成整个任务。

### 4.6 P2 测试

新增：

- `domain/test/test-task-checkpoint.ts`
- `domain/test/test-task-resume.ts`
- `domain/test/test-task-transcript.ts`
- 工具重放安全测试已合并在 `domain/test/test-task-resume.ts`

覆盖：

1. checkpoint 正确保存 iteration、transcript cursor 和状态。
2. checkpoint 事务失败时，task 不会指向不存在的 checkpoint。
3. worker 在 LLM 完成后崩溃，重启后从最近边界继续。
4. worker 在工具完成后、checkpoint 前崩溃，读工具重试，副作用工具进入 blocked。
5. resume 不会重复注入用户 prompt。
6. 两个 task 的 transcript 不互相污染。
7. `submit()` 的现有返回值和事件行为保持不变。
8. 达到 turn budget 后任务不会被误标记为 failed。
9. 压缩后的上下文仍能从完整 task transcript 找回关键工具结果。
10. SQLite 与 Memory 行为一致。

## 5. 实施顺序

### Step 1：P1 状态和恢复

先改任务模型、恢复入口和子任务恢复，不改 Agent Loop。

验收：

```bash
pnpm --filter @plain-agent/domain typecheck
pnpm --filter @plain-agent/domain test:tasks
pnpm --filter @plain-agent/domain test:subagent
```

### Step 2：任务级 transcript

先让任务拥有独立消息空间，再实现 checkpoint。否则 checkpoint 恢复仍然可能读取错误历史。

验收重点：

```text
同一个 session 中创建两个 task
  -> 分别写入消息
  -> 各自恢复
  -> 两边看不到对方的 task 消息
```

### Step 3：checkpoint store

实现 SQLite/Memory checkpoint、事务提交、事件记录和迁移测试。

### Step 4：`runTurn/resume`

改造 `agentLoop` 和 `PlainAgent`，保留 `submit()` 兼容封装。

### Step 5：Orchestrator 接入

将 `TaskOrchestrator.execute()` 切换到 turn 级执行，并加入恢复测试。

### Step 6：CLI/Desktop 回归

确认：

- CLI 仍能正常对话；
- Desktop 事件仍能正常显示；
- `--resume`、`--continue` 和 Session 切换不受影响；
- 已有任务 ID、取消、重试行为保持兼容。

## 6. 非目标

P1/P2 不实现：

- Cron、Heartbeat、Scheduler；
- Server HTTP/SSE 任务接口；
- 后台进程的跨重启 attach；
- `verifying -> completed` 验证闭环；
- 持久化审批；
- 复杂 DAG、依赖表达式和多 worker；
- Redis/PostgreSQL；
- 多渠道通知；
- exactly-once 副作用执行。

这些能力依赖 P1/P2 提供的可恢复任务和 transcript 基础。

## 7. 生产失败模式

| 失败场景 | P1/P2 处理 | 用户可见结果 |
|---|---|---|
| checkpoint 写入失败 | 保留旧 checkpoint，任务重试或失败 | 任务显示明确错误 |
| worker 在 turn 中崩溃 | lease 过期后恢复旧 checkpoint | 可能重放一个稳定边界后的步骤 |
| 副作用工具结果未知 | 进入 `blocked`，禁止自动重放 | 用户需要确认下一步 |
| child task 无法重建 | 父任务进入 `blocked` | 显示 child recovery error |
| 两个 worker 同时恢复 | 条件 claim + attempt 校验 | stale worker 不能覆盖结果 |
| transcript 写入部分失败 | checkpoint 事务失败，不推进 cursor | 任务保持可恢复状态 |
| 旧数据库没有新列 | 启动迁移增加 nullable 列 | 旧 Session 继续可读 |

每个失败模式都必须有单元测试，涉及 SQLite 事务或 worker 崩溃的场景增加集成测试。

## 8. 并行开发建议

```text
Lane A: domain/tasks P1
  -> transcript storage
  -> checkpoint store
  -> PlainAgent runTurn/resume
  -> TaskOrchestrator integration

Lane B: CLI integration
  waits for Lane A public API

Lane C: Desktop integration
  waits for Lane A public API
```

Lane B 和 Lane C 可以在 Lane A 的 domain API 稳定后并行。Lane A 内部必须顺序执行，因为状态模型、存储接口、Agent 上下文和编排器互相依赖。

## 9. P1/P2 完成定义

- [x] P1 恢复 root/child task 语义一致；
- [x] P1 recovery 幂等；
- [x] P1 增加 `blocked` 并覆盖不可安全重放场景；
- [x] task transcript 与 session history 隔离；
- [x] SQLite/Memory checkpoint 可用；
- [x] checkpoint、task pointer、event 原子提交；
- [x] `runTurn()` 可以在有限步骤后暂停；
- [x] `resume()` 可以从最近稳定边界继续；
- [x] 副作用工具不会被无条件自动重放；
- [x] `submit()`、CLI、Desktop 兼容；
- [x] worker 崩溃恢复测试通过；
- [x] P1/P2 相关 typecheck 和测试全部通过。

完成以上清单后，才进入 coding 的下一阶段：后台进程恢复和验证闭环。

## 10. 实施状态（2026-10-17）

P1/P2 已完成当前范围内的 coding 和回归验证。

### 已完成

- P1 `blocked` 状态、任务树快照、租约过期恢复和恢复幂等；
- P1 子 Agent 的 `delegation`、`depth`、独立 session 和恢复失败落事件；
- P2 `TaskCheckpoint`、Memory/SQLite 存储和事务式 checkpoint 提交；
- checkpoint 提交的 `taskId + attempt + lease` 校验，防止 stale worker 覆盖；
- task-scoped transcript，兼容旧数据库 `messages.task_id` 迁移；
- `PlainAgent.runTurn()` / `resume()`；
- LLM 响应、工具批次、消息和 checkpoint 的持久化边界；
- 只读工具自动重放，未知副作用工具进入 `blocked`；
- `TaskOrchestrator` 的 turn 循环、租约续期和 checkpoint 恢复；
- 子 Agent 使用 durable turn，保留轻量 Agent 的 `submit()` fallback；
- Session 展示历史和 task transcript 双写，避免 CLI/Desktop 重启后历史消失；
- transcript、checkpoint、resume、SQLite migration、stale worker 和 blocked lease 测试。
- durable turn 的 CLI/Desktop 生命周期事件兼容：预算暂停不再发终态 `stopped`，开始、完成和 checkpoint 快速恢复都有对应事件。
- 提交 Promise 最终失败时，CLI 清除 processing 状态，避免界面永久显示运行中。

### 兼容性决定

`TaskOrchestrator` 对持久化任务使用 `runTurn/resume`。交互式 `PlainAgent.submit()` 保留原有一次性循环语义，但新增 task transcript 双写；这样可以保持现有 CLI/Desktop 的事件、Session 历史和返回值行为，同时让长任务走可恢复执行路径。

### 已验证命令

```text
pnpm --filter @plain-agent/domain typecheck
pnpm --filter @plain-agent/domain test:tasks
pnpm --filter @plain-agent/domain test:subagent
pnpm --filter @plain-agent/domain test:loop
pnpm --filter @plain-agent/domain test:history
pnpm --filter @plain-agent/domain test:jobs
pnpm --filter @plain-agent/cli typecheck
pnpm --filter @plain-agent/desktop typecheck
pnpm --filter @plain-agent/desktop typecheck:web
pnpm --filter @plain-agent/server typecheck
```

### 明确未实现

以下内容仍按本计划的非目标保留到后续阶段：

- 后台进程跨重启 attach 和 `waiting_process` 唤醒；
- `verifying -> completed` 验证证据闭环；
- 持久化审批和 `waiting_user` 恢复；
- Cron、Heartbeat、Scheduler、通知和 Server HTTP/SSE 任务 API；
- exactly-once 副作用执行和复杂 DAG 调度。
