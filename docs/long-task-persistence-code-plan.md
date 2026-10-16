# 长任务持久化：代码修改计划

## 目标

第一阶段实现任务的可持久化生命周期：

```text
create -> persist -> claim -> run -> append events
       -> renew lease -> complete or retry
```

目标是 worker 或 Agent 进程异常退出后，任务不会永久停留在 `running`，而是能够重新领取、重试或进入明确的失败状态。

## 本阶段范围

本项目当前以 CLI 和 Desktop 为主要运行入口，因此第一阶段只接入：

- `domain`：任务模型、TaskStore、状态机、租约和任务编排器；
- CLI：保持现有交互和 `PlainAgent.submit()` 兼容，在任务执行入口接入持久化生命周期；
- Desktop：由主进程统一创建 TaskStore 和任务编排器，保持现有 Session、消息和事件 API 兼容。

本阶段暂不修改 `server`。HTTP API、SSE、服务端任务队列和服务端重启恢复统一放到后续阶段，避免在核心持久化模型尚未稳定时维护第二套调度入口。

## 设计决策

- 新增独立 `TaskStore`，不破坏既有 `SessionStorage` 接口。
- SQLite TaskStore 与现有 `SQLiteStorage` 共用同一个数据库连接。
- Memory TaskStore 用于测试和内存运行模式。
- 租约默认 60 秒，建议每 20 秒续租。
- `wait(timeout)` 只表示调用方停止等待，不自动取消真实任务。
- 第一阶段保存任务、状态、事件和结果；完整 checkpoint/resume 放到下一阶段。
- `completed` 表示 Agent 正常结束，不代表测试验证已经通过。

## 代码改动

### Domain 类型和导出

新增 `domain/src/tasks/`：

- `types.ts`：`TaskStatus`、`TaskRecord`、`TaskEventRecord`
- `store.ts`：`TaskStore` 接口
- `transitions.ts`：状态转换规则
- `memory.ts`：内存实现
- `sqlite.ts`：SQLite 实现
- `index.ts`：统一导出

修改：

- `domain/src/index.ts`
- `domain/src/storage/index.ts`
- `domain/src/storage/sqlite.ts`
- `domain/src/storage/memory.ts`

### SQLite 数据

新增表：

- `tasks`
- `task_events`

新增字段：

- 任务父子关系：`parent_id`、`root_id`
- 当前状态：`status`
- 重试：`attempt`、`max_attempts`
- 租约：`lease_owner`、`lease_until`
- 结果：`result_summary`、`result_ref`、`result_json`

任务表通过 `session_id` 关联现有 `sessions`，删除 Session 时级联删除任务和任务事件。

### SubagentRuntime

修改 `domain/src/subagent/runtime.ts`：

- 使用持久化 `TaskStore`；
- 子 Agent 使用独立的 session storage；
- 保存父子任务关系；
- 结束时保存摘要、结果和统计；
- `wait(timeout)` 超时不再自动停止子 Agent；
- 增加恢复未完成子任务的入口。

修改 `domain/src/subagent/types.ts`：

- 使用新的 `TaskStore` 类型；
- 为结果增加 `wait_timeout` 观察超时状态；
- 保持原有 `spawn/wait/cancel/getStatus` API 兼容。

### TaskOrchestrator

新增 `domain/src/tasks/orchestrator.ts` 任务编排器，负责：

- 创建顶层任务；
- claim/lease/renew/release；
- 创建 Agent；
- 转发关键 Agent 事件；
- 处理完成、失败、重试和取消；
- 触发任务完成事件。

`PlainAgent` 仍然负责 ReAct、工具调用和会话历史，不负责全局调度。

### CLI/Desktop

#### CLI

修改 CLI 的 Agent 创建和任务提交入口：

- 从 `MemoryStorage` 或 `SQLiteStorage` 获取对应的 TaskStore；
- CLI 启动时恢复租约已过期的任务；
- `PlainAgent.submit()` 的公开签名保持不变；
- `--resume` 和 `--continue` 仍然按 Session 恢复；
- 任务 ID、状态和失败原因写入 TaskStore，但不强制改变当前终端交互格式。

#### Desktop

修改 Desktop 主进程的 AgentService：

- 复用现有 `SQLiteStorage` 的数据库连接创建 TaskStore；
- 在主进程创建并启动单机 TaskOrchestrator；
- 将当前会话提交映射为持久化顶层任务；
- Agent 事件继续走现有 IPC 和事件监听机制；
- Session、消息和已有 Desktop API 保持兼容；
- 应用重启时恢复 queued 和租约已过期的任务。

第一阶段保留现有用户交互行为：

- `PlainAgent.submit()` 不变；
- `--resume` 和 `--continue` 仍然恢复 Session；
- Desktop 现有 Session 和消息 API 不变。

任务列表、任务时间线和显式恢复 UI 后续再增加，不作为第一阶段阻塞项。

### Server（后续阶段）

第一阶段不修改以下文件：

- `server/src/manager.ts`
- `server/src/app.ts`
- `server/src/index.ts`
- `server/test/smoke-server.ts`

后续接入时再处理：

- HTTP 任务创建和 `taskId` 返回；
- SSE 与持久化任务事件对齐；
- 服务端重启恢复；
- 任务查询、取消、暂停和恢复接口；
- 多请求并发下的队列兼容性。

## 测试

新增：

- `domain/test/test-task-store.ts`
- `domain/test/test-task-orchestrator.ts`
- `domain/test/test-task-recovery.ts`

覆盖：

- 正常完成；
- 非法状态转换；
- lease claim/renew/release；
- lease 过期恢复；
- 失败重试；
- worker 崩溃恢复；
- 子 Agent 持久化；
- 父子任务关联；
- SQLite 与 Memory 行为一致；
- 删除 Session 的级联清理。

更新：

- `domain/test/test-subagent-runtime.ts`
- CLI 任务提交或恢复相关测试；
- Desktop `AgentService` 任务恢复相关测试。

验收命令：

```bash
pnpm --filter @plain-agent/domain typecheck
pnpm --filter @plain-agent/domain test:tasks
pnpm --filter @plain-agent/domain test:subagent
pnpm --filter @plain-agent/cli typecheck
pnpm --filter @plain-agent/desktop typecheck
```

## 影响范围

### 行为影响

- 子 Agent 的 `wait(timeout)` 不再默认取消真实任务；
- CLI 和 Desktop 的任务状态从进程内状态升级为 TaskStore 状态；
- CLI 和 Desktop 重启后可以恢复 queued 和租约已过期任务；
- 删除 Session 会同时取消并清理关联任务；
- SQLite 不可用时继续使用 Memory TaskStore，但不保证跨进程恢复。

### 兼容性

- 保持 `PlainAgent.submit()` 签名；
- 保持现有 CLI 参数和 Desktop Session/消息 API；
- 旧数据库无需迁移已有消息、事件和 job 数据；
- 新表使用 `CREATE TABLE IF NOT EXISTS` 创建。

### 暂不实现

- Cron/Heartbeat；
- 分布式 worker；
- Server 任务 API 和 SSE 持久化接入；
- PostgreSQL/Redis；
- 完整 checkpoint/resume；
- 复杂 DAG；
- 验证证据和 `verifying -> completed` 闭环；
- 多渠道通知。

