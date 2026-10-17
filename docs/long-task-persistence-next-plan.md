# 长任务持久化：下一阶段计划

## 0. 计划结论

**计划日期：2026-10-17**

`docs/long-task-persistence-code-plan.md` 定义的第一阶段已经完成，当前工作区还进一步完成了 P1/P2 的恢复语义增强：

- 任务、任务事件、租约和失败重试已经持久化；
- `blocked`、任务树恢复和 stale worker 防护已经存在；
- task-scoped transcript、checkpoint、`runTurn()` / `resume()` 已接入；
- 只读工具可以安全重放，未知副作用工具会进入 `blocked`；
- Desktop 已使用 `TaskOrchestrator`，CLI/交互式 `submit()` 保持兼容。

下一阶段不再扩展 ReAct 循环本身，而是把“**可以恢复执行**”推进到“**可以安全等待、验证并完成**”：

```text
当前：
  task -> durable turn -> checkpoint -> resume

下一阶段：
  task -> wait external/user -> wakeup -> verify evidence -> completed
```

推荐顺序：

1. 验证证据闭环；
2. 后台进程的持久化观察和重启恢复；
3. 用户审批/问题的持久化恢复；
4. 统一事件唤醒；
5. 最后再接入 Server API、任务 UI、Cron/Heartbeat。

核心原则：

> `completed` 只能由验证结果驱动；等待外部条件的任务必须释放租约；无法证明安全恢复时进入 `blocked`，不能静默重跑。

## 1. 当前状态与缺口

### 1.1 已有能力

| 能力 | 当前实现 | 下一阶段处理 |
|---|---|---|
| 任务状态、事件、租约 | `domain/src/tasks/` | 复用并补充 owner/attempt guard |
| checkpoint/resume | `PlainAgent.runTurn()` / `resume()` | 复用，增加 wait 状态 |
| Task transcript | `SessionStorage` 的 `taskId` 维度 | 复用 |
| 子 Agent 任务记录 | `SubagentRuntime` + `TaskStore` | 复用，先不扩展复杂 DAG |
| 后台任务结果持久化 | `SQLiteStorage.jobs` | 与进程运行记录分层，不破坏兼容 |
| Desktop 任务执行 | `TaskOrchestrator` | 增加等待和验证事件 |
| Server SSE | `AgentManager` 内存事件历史 | 后续改为订阅 TaskStore 事件 |

### 1.2 需要补齐的真实缺口

1. `TaskOrchestrator.execute()` 在 Agent 返回完成后直接完成任务，没有经过 `verifying` 和验证证据。
2. `JobRegistry` 的运行态主要存在于内存 `Map` 中；目前只持久化了已结束结果，无法在重启后可靠判断一个仍在运行的进程。
3. `TaskOrchestrator.recover()` 遇到 `waiting_process` 或 `waiting_child` 时会阻塞任务，而不是建立可恢复的外部等待。
4. `permissionMode: 'ask'` 当前通过返回 `false` 拒绝工具，没有持久化审批请求；`ask_question` 的 pending 交互也只存在进程内。
5. Server 的 `AgentManager` 仍然是会话级内存队列，没有任务资源、任务查询和跨重启恢复入口。

## 2. 阶段目标

### 2.1 P3-A：验证闭环

将任务完成流程改为：

```text
agent turn finished
  -> verifying
  -> verification-started
  -> run checks / inspect artifacts
  -> verification-completed
  -> completed
```

模型输出只能表示 Agent 认为工作完成，不能直接把任务标记为 `completed`。

建议新增领域类型：

```ts
type VerificationStatus = 'passed' | 'failed' | 'skipped';

interface VerificationResult {
  status: VerificationStatus;
  checks: Array<{
    name: string;
    command?: string;
    exitCode?: number;
    outputRef?: string;
    summary: string;
  }>;
  changedFiles: string[];
  diffHash?: string;
  startedAt: number;
  finishedAt: number;
}
```

建议新增 `task_verifications` 表，保存每次 attempt 的验证结果：

```sql
CREATE TABLE task_verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  diff_hash TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_verifications_task
  ON task_verifications(task_id, attempt, started_at);
```

实现边界：

- `TaskStore` 增加验证记录和带 attempt/lease guard 的状态更新；
- `TaskOrchestrator` 在 Agent turn 完成后进入 `verifying`；
- 验证期间继续续租，验证超时按失败处理；
- 验证通过后才写入 `task-completed`；
- 验证失败回到 `running` 或进入 `failed`，由策略决定是否重试；
- 验证证据必须可查询，不能只存在日志。

第一版验证器只支持显式注册的检查器：

- 测试命令；
- 类型检查/构建命令；
- 工作区 diff 检查；
- 文件或 artifact 存在性检查。

暂不让模型自由生成任意验证命令并绕过工具权限。

### 2.2 P3-B：后台进程持久化观察与恢复

第一版不承诺跨重启重新接管 stdout/stderr 流，而是先实现**可证明的进程观察**：

```text
launch
  -> persist process metadata
  -> running / waiting_process
  -> process exits and writes terminal record
  -> persist result
  -> wake task
```

建议新增 `task_processes` 表，而不是把运行态硬塞进已有 `jobs` 表：

```sql
CREATE TABLE task_processes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER,
  log_path TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  output_tail TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  last_observed_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_task_process_call
  ON task_processes(task_id, attempt, call_id);
```

状态建议：

```text
starting -> running -> completed
                    -> failed
                    -> unknown
starting/running -> cancelled
```

实现要求：

1. `JobRegistry.launch()` 在 spawn 前后通过持久化适配器写入 process record。
2. 进程结束时先写 terminal record，再发 `process-completed` 事件。
3. 日志继续使用现有文件机制；数据库保存 log path、尾部输出和状态。
4. 重启时按 `pid + startedAt + command/cwd fingerprint` 观察进程，避免 PID 复用误认。
5. 进程仍存活：任务保持 `waiting_process`，释放 Agent lease，等待轮询或进程事件。
6. 进程已经结束且有 terminal record：恢复结果并唤醒任务。
7. 进程不存在且没有可信 terminal record：任务进入 `blocked`，不得直接重启命令。
8. `kill`、取消和重复完成必须使用 `taskId + attempt + callId` 幂等保护。

这一步的明确边界是：

- 支持重启后判断“仍在运行 / 已完成 / 状态未知”；
- 不保证跨平台 attach 到已存在进程的实时 stdout；
- 不承诺副作用命令 exactly-once；
- 状态未知时宁可 `blocked`，也不自动重复执行。

### 2.3 P3-C：用户审批与问题持久化

统一两类需要人类输入的场景：

- 危险工具的 permission approval；
- `ask_question` 的业务问题。

建议新增 `task_approvals` 表：

```sql
CREATE TABLE task_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  args_json TEXT,
  questions_json TEXT,
  status TEXT NOT NULL,
  answer_json TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_approvals_pending
  ON task_approvals(task_id, status, created_at);
```

交互流程：

```text
tool/question needs user
  -> persist approval pending
  -> task = waiting_user
  -> release lease
  -> emit approval-required
  -> user approves/rejects/answers
  -> persist decision
  -> enqueue wakeup
  -> resume from checkpoint
```

实现要求：

- `waiting_user` 必须保存 approval ID、问题内容和恢复所需的 tool call 信息；
- UI 重启后能重新查询 pending approval，不依赖进程内 `Map`；
- 同一个 approval 只能决策一次；
- stale worker 不能消费新 attempt 的 approval；
- rejection、过期和取消都要产生明确事件；
- 对副作用工具的审批恢复不能重新生成新的 tool call ID；
- `permissionCheck` 不再只返回 boolean，内部需要区分 `allow / wait / deny`。

### 2.4 P3-D：统一事件唤醒器

当 P3-A 至 P3-C 的状态和事件稳定后，增加轻量级单机 wakeup coordinator：

```text
task event / timer
  -> materialize wakeup
  -> claim task if eligible
  -> resume checkpoint
  -> renew lease
  -> append result
```

第一版只支持以下原因：

```ts
type WakeupReason =
  | 'manual'
  | 'child_completed'
  | 'process_completed'
  | 'approval_granted'
  | 'approval_rejected'
  | 'lease_expired';
```

要求：

- 唤醒请求持久化或可由状态重建；
- 同一个 `(taskId, reason, sourceId, attempt)` 幂等；
- 优先处理用户显式决策，其次是子任务/进程完成，再处理租约恢复；
- 任务不满足恢复条件时保持等待，不消耗重试次数；
- 唤醒器不直接执行 Agent，只调用 `TaskOrchestrator.resume()`。

## 3. 实施顺序

```text
Step 0  固化 TaskStore 扩展契约
   |
   +--> Step 1  VerificationRunner + verifying 状态闭环
   |
   +--> Step 2  DurableProcessRegistry + waiting_process 恢复
   |
   +--> Step 3  ApprovalStore + waiting_user 恢复
              |
              +--> Step 4  WakeupCoordinator
                            |
                            +--> Step 5  Desktop/Server 任务 API
                                          |
                                          +--> Step 6  Cron/Heartbeat
```

### Step 0：先固定公共契约

涉及模块：

- `domain/src/tasks/types.ts`
- `domain/src/tasks/store.ts`
- `domain/src/tasks/sqlite.ts`
- `domain/src/tasks/memory.ts`
- `domain/src/tasks/transitions.ts`

内容：

- 增加 verification/process/approval/wakeup 的类型和接口；
- 所有外部等待记录包含 `taskId + attempt + leaseOwner/callId`；
- 增加带 owner guard 的 `transitionOwned()` 或等价 API；
- 明确 `waiting_*` 状态释放 lease 的规则；
- 为 SQLite migration 增加旧数据库兼容测试。

验收：

- Memory/SQLite 行为一致；
- stale attempt 无法推进状态；
- 事务失败不会留下孤立指针或事件。

### Step 1：验证闭环

涉及模块：

- `domain/src/tasks/`
- `domain/src/tasks/orchestrator.ts`
- 新增 `domain/src/tasks/verification.ts`
- 新增 `domain/test/test-task-verification.ts`

验收：

1. Agent 返回结果后任务先进入 `verifying`。
2. 验证通过后才进入 `completed`。
3. 测试失败时保留完整证据，并回到 `running` 或 `failed`。
4. 验证器崩溃后能从 `verifying` 恢复，不重复执行已完成检查。
5. stale worker 不能覆盖新 attempt 的验证结果。

### Step 2：后台进程恢复

涉及模块：

- `domain/src/tools/jobs.ts`
- `domain/src/storage/sqlite.ts`
- `domain/src/tasks/`
- `domain/src/tasks/orchestrator.ts`
- `domain/test/test-job-persistence.ts`
- 新增 `domain/test/test-task-process-recovery.ts`

验收：

1. spawn 前已经有可查询的 process record。
2. 进程完成后数据库和日志都可读取。
3. worker 重启后，仍运行进程进入 `waiting_process`，不重复启动。
4. 已结束进程的结果只被回注一次。
5. PID 复用或状态不明时进入 `blocked`。
6. 取消、超时、kill 和进程自然退出的事件可区分。

### Step 3：审批和问题恢复

涉及模块：

- `domain/src/agent.ts`
- `domain/src/loop.ts`
- `domain/src/tools/ask.ts`
- `domain/src/interactions.ts`
- `domain/src/tasks/`
- `domain/test/test-task-approval.ts`

验收：

1. ask 模式下危险工具产生持久化 approval，而不是静默返回 false。
2. 进程重启后 pending approval 仍能显示。
3. 用户决策后任务只恢复一次。
4. approval 超时、拒绝、取消和 stale answer 都有明确结果。
5. `ask_question` 恢复后不会重复发送原始 prompt 或生成第二个问题。

### Step 4：统一唤醒器

涉及模块：

- `domain/src/tasks/orchestrator.ts`
- 新增 `domain/src/tasks/wakeup.ts`
- `domain/test/test-task-wakeup.ts`

验收：

1. child/process/approval 事件都能唤醒对应父任务。
2. 重复事件不会重复 claim 或重复 resume。
3. 唤醒期间租约失效时，旧 worker 无法提交结果。
4. 服务重启后可以从持久化等待状态重建待唤醒任务。

### Step 5：入口适配

只在 Step 0-4 稳定后进行：

- Desktop：任务列表、任务详情、事件时间线、pending approval；
- Server：任务创建、查询、取消、恢复、审批决策和 SSE 任务事件；
- CLI：`task list/status/resume/cancel`，保持交互式 `submit()` 不变。

Server 端不再复制一套任务状态机。`AgentManager` 只负责会话和 SSE 连接，任务状态以共享 `TaskStore` 为准。

### Step 6：Cron/Heartbeat

这是下一轮产品能力，不属于本阶段核心可靠性闭环：

- Cron 保存 schedule、next run 和去重 key；
- Heartbeat 只在存在可处理事件时调用模型；
- 调度触发统一创建任务，不直接调用 `PlainAgent.submit()`；
- 通知通过 task event subscriber 实现。

## 4. 数据流与状态机

### 4.1 任务主流程

```text
queued
  -> running
  -> waiting_process ---- process_completed ----+
  -> waiting_user   ---- approval_decided -----+--> running
  -> waiting_child  ---- child_completed ------+
  -> paused
  -> verifying
       -> completed
       -> running
       -> failed

running / verifying / waiting_*
  -> cancelled
  -> blocked
```

规则：

- `waiting_*` 不持有 worker lease；
- `running` 和 `verifying` 必须持有有效 lease；
- `blocked` 只能由显式恢复、人工处理或安全条件确认后转回 `queued/running`；
- `completed` 必须存在验证记录，除非任务策略明确声明 `verification=skipped`；
- 所有状态推进都必须检查 `attempt` 和 `leaseOwner`。

### 4.2 完成语义

```text
Agent says "done"
  -> store agent result
  -> transition running -> verifying
  -> run deterministic checks
  -> persist VerificationResult
  -> if passed: verifying -> completed
  -> if failed: verifying -> running/failed
```

### 4.3 外部等待语义

```text
before side effect:
  persist intent + callId + attempt
  spawn / request approval
  persist running or pending

after restart:
  inspect durable record
  known completed -> replay result
  known running -> wait and observe
  unknown outcome -> blocked
```

## 5. 测试矩阵

| 场景 | 必须验证的结果 |
|---|---|
| Agent 声称完成但检查失败 | 不进入 `completed` |
| 验证器中途崩溃 | 从 `verifying` 恢复，不丢证据 |
| 进程启动前 worker 崩溃 | 不产生重复进程，任务可重试 |
| 进程运行中 worker 崩溃 | 新 worker 观察原进程，不重启 |
| 进程结果未知 | 进入 `blocked`，显示人工处理原因 |
| 进程自然退出和 kill | 状态、exit code、事件可区分 |
| approval pending 时重启 | approval 仍可查询和回答 |
| approval 重复回答 | 只有一次生效 |
| approval 对应旧 attempt | 被拒绝，不影响新 attempt |
| child/process/approval 重复事件 | 只触发一次 resume |
| 两个 worker 争抢恢复 | 只有一个 attempt 能提交 |
| SQLite 迁移 | 旧数据库可打开，旧会话消息不受影响 |
| Memory/SQLite | 公开 API 和状态结果一致 |
| Server 重挂 SSE | 从持久化事件游标继续，不丢不重 |

每个新故障路径都要同时检查：

1. 是否有测试；
2. 是否有错误处理；
3. 用户是否看到明确状态，而不是静默卡住。

任何“没有测试、没有错误处理、用户又看不到”的路径都视为阻塞发布的缺口。

## 6. 可观测性与运维指标

新增事件至少包括：

```text
verification-started
verification-completed
verification-failed
process-started
process-observed
process-completed
process-unknown
approval-required
approval-decided
task-wakeup-enqueued
task-wakeup-deduplicated
```

建议记录：

- task/attempt/callId；
- workerId；
- 状态转换耗时；
- 验证命令耗时和 exit code；
- 外部进程 PID 与日志路径；
- waiting 时长；
- blocked 原因；
- resume 次数和重复事件数量。

首批指标：

- `verification_precision`；
- `resume_success_rate`；
- `duplicate_process_rate`；
- `unknown_process_rate`；
- `approval_recovery_rate`；
- `mean_time_to_recovery`；
- `blocked_task_rate`。

## 7. 非目标

本阶段明确不实现：

- Cron、Heartbeat 和复杂调度表达式；
- 分布式 worker、Redis/PostgreSQL、多租户配额；
- 跨平台进程 stdout 实时 attach；
- side effect exactly-once；
- 自动猜测未知进程结果；
- 复杂 DAG、条件分支和聚合策略；
- 多渠道通知；
- 让模型绕过权限策略自行验证；
- 完全替换 Server 当前会话 SSE 架构。

理由是这些能力都依赖本阶段稳定的等待、验证、审批和唤醒语义；提前实现会把不一致的状态机复制到多个入口。

## 8. 复用现有代码

- 复用 `TaskStore`、`SQLiteTaskStore`、`MemoryTaskStore` 的状态、事件、checkpoint 和 attempt guard。
- 复用 `TaskOrchestrator` 的 claim、lease renewal、recovery 和 `resume()`。
- 复用 `JobRegistry` 的 spawn、日志文件、输出截断和 kill 能力，只增加持久化观察适配器。
- 复用 `SQLiteStorage.jobs` 作为已完成后台结果的兼容回注记录；新的进程生命周期写入 `task_processes`。
- 复用 Desktop 现有 `AgentService` 的 TaskStore 初始化和恢复入口。
- 保留 CLI/Desktop 交互式 `submit()` 行为，不把新的任务 API 强行塞进短交互路径。
- Server 后续订阅 TaskStore 事件，不重新实现任务状态机。

## 9. 并行开发建议

核心代码会共享 `domain/src/tasks/` 和 `TaskOrchestrator`，因此主实现应顺序推进：

```text
Lane A: Step 0 -> Step 1 -> Step 4
Lane B: Step 2
Lane C: Step 3
Lane D: 测试夹具、文档和故障注入
Lane E: Step 5（等待 Step 4）
```

依赖关系：

| 工作流 | 触及模块 | 依赖 |
|---|---|---|
| 公共 TaskStore 契约 | `domain/src/tasks/` | 无 |
| 验证闭环 | `domain/src/tasks/`, orchestrator | 公共契约 |
| 进程恢复 | `domain/src/tools/`, storage, tasks | 公共契约 |
| 审批恢复 | agent, loop, ask, interactions, tasks | 公共契约 |
| 唤醒器 | tasks, orchestrator | 验证/进程/审批事件契约 |
| Desktop/Server API | desktop, server, domain | 唤醒器稳定 |
| 测试与故障注入 | domain/test, test utilities | 可与单个实现步骤并行 |

并行冲突提示：

- Lane B、Lane C 都会修改 `domain/src/tasks/`，如果使用独立 worktree，建议先合并 Step 0，再分别开发，最后顺序合并 orchestrator 改动。
- Step 5 不应与核心状态机同时开发，否则 API 很容易固化错误的等待语义。

## 10. 完成定义

下一阶段只有满足以下条件才算完成：

- [ ] `completed` 只由验证结果驱动；
- [ ] 验证结果、失败原因和 artifact 引用可查询；
- [ ] `waiting_process` 能区分运行中、已完成和未知；
- [ ] 未知副作用结果默认进入 `blocked`；
- [ ] pending approval 可跨重启恢复；
- [ ] waiting 状态释放 lease，唤醒时重新 claim；
- [ ] child/process/approval wakeup 幂等；
- [ ] stale worker 无法覆盖新 attempt；
- [ ] Desktop/CLI 仍保持现有交互式兼容；
- [ ] SQLite/Memory、正常路径和崩溃恢复测试全部通过；
- [ ] Server API 只在共享 TaskStore 之上提供适配，不复制状态机。

## 11. 建议的第一批 coding 任务

建议下一次 coding 只做 **Step 0 + Step 1**，控制变更面：

1. 增加 `VerificationResult`、verification store 和 SQLite migration；
2. 增加带 attempt/lease guard 的 `verifying` 状态推进；
3. 将 `TaskOrchestrator` 的完成路径改为 `running -> verifying -> completed`；
4. 实现最小验证器：测试命令、diff 检查和 artifact 存在性；
5. 增加成功、失败、验证器崩溃、stale worker 四组测试；
6. 运行现有 domain/CLI/Desktop/Server typecheck 和任务测试。

这样可以先把“任务完成是否可信”固定下来，再进入 OS 进程恢复这一块风险更高的工作。
