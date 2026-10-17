# 长任务验证闭环：下一阶段计划

## 0. 结论

**计划日期：2026-10-18**
**基线：`2a20331` feat: 实现长任务恢复与 checkpoint（P1/P2）**

P1/P2 已经把「任务可以恢复执行」做完了：任务/事件/租约/重试持久化、`blocked`、任务树恢复、task-scoped transcript、checkpoint、`runTurn()`/`resume()`、只读工具重放与副作用工具阻塞，全部落地并有测试。

`docs/long-task-persistence-next-plan.md` 已经把下一阶段拆成 P3-A（验证闭环）→ P3-B（后台进程）→ P3-C（审批）→ P3-D（唤醒器）→ P3-E（入口/调度）。

**本阶段只做 P3-A，即 `docs/long-task-persistence-next-plan.md` 的 Step 0 + Step 1**，理由是：

1. 它决定「`completed` 是否可信」，是后续所有等待/唤醒语义的前提；
2. 它不引入外部进程、审批、调度等跨平台高风险面；
3. 它能在不改变 CLI/Desktop 交互行为的前提下增量落地。

本阶段完成后：

```text
agent turn finished
  -> verifying（持有租约）
  -> 逐项执行显式注册的检查，逐项落库
  -> 全部通过 -> completed
  -> 任一失败 -> failed + 完整证据
  -> worker 崩溃 -> 重启后继续验证，不重跑 Agent turn
```

不变的原则：

> 模型说「做完了」不等于任务完成。`completed` 只能由验证结果驱动；没有验证策略的任务必须留下 `verification-skipped` 事件，不允许静默完成。

## 1. 现状核查（代码事实，不是推测）

### 1.1 已经有的

| 能力 | 位置 |
|---|---|
| 任务状态/事件/租约/重试 | `domain/src/tasks/{types,transitions,store,memory,sqlite}.ts` |
| checkpoint 原子提交 + attempt/lease guard | `domain/src/tasks/sqlite.ts:642`、`memory.ts:380` |
| 编排器 turn 循环、恢复、取消 | `domain/src/tasks/orchestrator.ts` |
| `verifying` 状态已在状态机里 | `domain/src/tasks/types.ts:10`、`transitions.ts:21` |
| `finishAttempt` / `blockAttempt` / `retryAttempt` / `cancelAttempt` owner guard | `sqlite.ts:234-378` |
| 增量建表 + `ensureColumn` 兼容旧库 | `sqlite.ts:19-87` |

### 1.2 真实缺口（本阶段必须一并修掉）

`verifying` 目前只是状态机里的一个空壳：没有任何代码把任务推进到它，也没有任何代码能把它推进出去。

| # | 缺口 | 代码位置 | 后果 |
|---|---|---|---|
| G1 | Agent 返回后直接 `finishAttempt(..., 'completed')`，没有 `verifying`、没有证据 | `orchestrator.ts:406-429` | 「完成」= 模型自述 |
| G2 | `renewLease` 只允许 `status='running'` | `sqlite.ts:495-509`、`memory.ts:279-291` | 任务一旦进入 `verifying`，续租立刻失败 → 续租定时器 `onLost()` → 停掉 Agent |
| G3 | `recoverExpiredTasks` 只扫 `queued/running`（`CLAIMABLE_STATUSES`） | `sqlite.ts:523-582`、`memory.ts:304-330` | 验证中途崩溃的任务永远不会被恢复，永久卡在 `verifying` |
| G4 | `claimRow` 把任何可认领任务 `attempt + 1` | `sqlite.ts:423-494` | 验证恢复如果走 `claimTask`，会把「验证」错当「新一次执行」，重跑 Agent turn |
| G5 | `updateAttemptStatus` 硬编码 `from='running'` | `sqlite.ts:327-378` | `verifying -> completed/failed/cancelled` 无原子路径 |
| G6 | `listRecoverableTasks` / `recover()` 的根任务过滤不含 `verifying` | `sqlite.ts:584`、`memory.ts:337`、`orchestrator.ts:151-156` | 即使 G3 修好，启动恢复也不会看它 |
| G7 | `scheduleLeaseRecovery` 只统计 `status === 'running'` | `orchestrator.ts:516-538` | `verifying` 任务的租约到期不会触发兜底恢复 |
| G8 | `verifying` 不能转 `cancelled` | `transitions.ts:21` | 验证期间用户取消会被 store 拒绝 |

这 8 条如果不先处理，验证闭环写出来就是「进得去出不来」的死状态。它们是本阶段的一部分，不是后续优化。

## 2. 阶段范围

### 2.1 做

1. **验证策略落到任务上**：`TaskRecord.verification`（`off | required` + 显式检查列表），随任务一起持久化。
2. **验证证据落库**：`task_verifications` + `task_verification_checks` 两张表，逐检查项记录状态、exit code、输出尾部、日志路径、耗时。
3. **完成路径改造**：`running -> verifying -> completed | failed`，验证期间持续持有租约。
4. **验证恢复**：崩溃/重启后从 `verifying` 继续，**不重跑 Agent turn**；已通过的检查不重跑；不可安全重跑的检查被中断时进入 `failed`（证据说明原因）。
5. **最小检查器**（只允许宿主显式注册，模型不能生成）：
   - `command`：执行一条命令，exit code 0 通过；
   - `files-exist`：声明的产物路径全部存在；
   - `git-diff`：工作区存在变更（并可产出 changedFiles 证据）。
6. **两个真实消费者**：CLI `--verify`、Desktop `settings.verification`，避免出现「没人调用的 hook」。
7. **store 级完成守卫**：任务声明 `verification.mode='required'` 时，`finishAttempt(...,'completed')` 在没有 `passed` 验证记录的情况下必须被拒绝。

### 2.2 不做（明确留给后续阶段）

- 后台进程 `waiting_process` 的持久化观察与跨重启恢复（P3-B）；
- 审批 / `ask_question` 的 `waiting_user` 持久化（P3-C）；
- 统一唤醒器 `WakeupCoordinator`（P3-D）；
- Server 任务 HTTP/SSE API、Cron、Heartbeat（P3-E）；
- 让模型自己生成验证命令，或让验证绕过工具权限；
- 验证失败后的自动重试 / 自动修复循环（本阶段失败即 `failed`，证据可查，重试走显式动作）；
- 分布式 worker、多租户、exactly-once。

## 3. 设计决策

### D1：验证策略由宿主显式声明，不由模型生成

模型能影响的只有「结果文本」。检查项来自：

- CLI：`--verify "pnpm -r typecheck"`（可重复）；
- Desktop：`settings.json` 的 `verification.checks`；
- 编排器默认：`mode: 'off'`（保持现有交互行为不变）。

理由：验证器一旦能自由执行命令，就等于给模型开了第二条无审批的 shell。P3-C 之前不碰这个边界。

### D2：`off` 也留痕，但不写表

策略为 `off` 时只写 `verification-skipped` 事件（含 attempt），不写 `task_verifications` 行。理由：表只承载「真的跑过」的证据，避免几十万条空记录；事件足以回答「为什么这个任务是直接 completed 的」。

### D3：验证期间的租约必须续，且恢复不升 attempt

- `renewLease` 允许 `status IN ('running','verifying')`，其余 guard（owner/attempt/未过期）不变；
- 新增 `claimVerification(taskId, workerId)`：只接管租约，**不改 attempt、不改 status**；
- `recoverExpiredTasks` 对 `verifying`：清租约、把该 attempt 下 `running` 的验证行标为 `interrupted`、写 `verification-interrupted` 事件，**不计入 maxAttempts**。

理由：验证是确定性的后续动作，不是新的执行尝试；把它算成一次 attempt 会导致「验证三次失败 = 任务失败」。

### D4：检查项按 index 逐项落库，恢复粒度是「检查项」

`beginVerification` 时先写入全部检查项（`pending`），每项开始写 `running`、结束写 `passed/failed`。恢复时：`passed` 跳过；`pending` 正常跑；`running/interrupted` 只有 `rerunSafe !== false` 时重跑，否则整个验证失败，`error='check-interrupted-unsafe-rerun'`。

`command` 检查默认 `rerunSafe = true`（宿主声明的检查应可重跑）；宿主可显式设 `false`（例如 `deploy`）。这是契约，不是防御性代码。

### D5：验证失败 = 任务失败（本阶段）

`concludeVerification` 把 `passed: false` 落成 `verifying -> failed`，`error` 汇总失败项名称与 exit code，结果对象里带 `verificationId`。自动重试留给 P3-A.2，触发条件是「验证失败是否应该重新生成方案」，需要单独设计反馈注入，不在本阶段硬塞。

### D6：完成守卫放在 store，不放在编排器

`finishAttempt` 在 `task.verification?.mode === 'required'` 时校验存在 `(taskId, attempt)` 且 `status='passed'` 的验证行，否则返回 `false` 并写 `completion-rejected` 事件。

放 store 的理由：编排器只是调用方之一；守卫放编排器等于「以后再写一个调用方就绕过了」。子 Agent 任务默认无策略，因此不受影响。

## 4. 状态机与数据流

### 4.1 状态

```text
queued -> running -> verifying -> completed
                             \-> failed
running/verifying -> cancelled
running -> blocked / waiting_* / queued（既有语义不变）
```

变更点：

- `transitions.ts` 增加 `verifying: ['completed','running','failed','cancelled']`；
- `verifying` 不新增状态，避免迁移面扩大。

### 4.2 正常完成

```text
turn completed
  -> store.beginVerification(task, attempt, checks)   [running -> verifying，租约不动]
  -> event verification-started
  -> 逐项 startVerificationCheck / run / finishVerificationCheck
  -> 全部 passed
  -> store.concludeVerification({ passed: true, result })  [verifying -> completed]
  -> event verification-completed / status-changed
  -> orchestrator emit task-completed
```

### 4.3 失败

```text
任一检查 failed（stopOnFailure 默认 true）
  -> 剩余检查标 skipped
  -> store.concludeVerification({ passed: false, error })
  -> verifying -> failed，error 形如 `verify: typecheck(exit 2); verify: artifact missing: dist/app.js`
  -> event verification-failed / task-failed
  -> 调用方（CLI/Desktop）收到失败原因，remains 可查询
```

### 4.4 崩溃恢复

```text
worker 崩溃（验证中）
  -> 租约到期
  -> recoverExpiredTasks: verifying 保持状态、清租约、验证行 running -> interrupted
  -> recover(): 找到 verifying 根任务
  -> orchestrator.resumeVerification(taskId)
       -> store.claimVerification(taskId, workerId)   [只接管租约]
       -> 跳过 passed，重跑 interrupted/pending（受 rerunSafe 约束）
       -> concludeVerification
```

### 4.5 数据模型

```sql
CREATE TABLE IF NOT EXISTS task_verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,              -- running | passed | failed | interrupted
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  diff_hash TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_verification_checks (
  verification_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- command | files-exist | git-diff
  command TEXT,
  status TEXT NOT NULL,              -- pending | running | passed | failed | skipped | interrupted
  exit_code INTEGER,
  output_ref TEXT,
  output_tail TEXT,
  duration_ms INTEGER,
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (verification_id, idx),
  FOREIGN KEY (verification_id) REFERENCES task_verifications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_verifications_task
  ON task_verifications(task_id, attempt, started_at);
CREATE INDEX IF NOT EXISTS idx_task_verification_checks_status
  ON task_verification_checks(verification_id, status);
```

旧库兼容：沿用 `initTables()` 的 `CREATE TABLE IF NOT EXISTS` + `ensureColumn('verification_json','TEXT')`，不写数据迁移。

## 5. 事件与可观测性

新增事件：

```text
verification-skipped          策略为 off
verification-started          running -> verifying
verification-check-started    { index, name, kind }
verification-check-completed  { index, name, status, exitCode, durationMs }
verification-interrupted      worker 崩溃后租约回收
verification-completed        { verificationId, changedFiles, diffHash }
verification-failed           { verificationId, error, failedChecks }
completion-rejected           store 完成守卫拒绝
```

可查询面：`listVerifications(taskId)` + `listEvents(taskId)`。本阶段不做指标导出，但字段足够后续计算 `verification_pass_rate`、`verification_duration_p95`、`interrupted_check_rate`。

## 6. 测试矩阵

| 场景 | 断言 |
|---|---|
| 检查全部通过 | 先 `verifying`，再 `completed`；`task_verifications.status='passed'` |
| 检查失败 | 任务 `failed`；`exit_code`、`output_tail`、日志路径可查；不出现 `task-completed` |
| 验证器进程崩溃 | 重启后从 `verifying` 继续；Agent `runTurn` 调用次数不增加；已通过检查不重跑 |
| 不可重跑检查被中断 | 任务 `failed`，`error='check-interrupted-unsafe-rerun'` |
| stale worker 收尾 | 旧 attempt/旧 owner 无法 `concludeVerification` |
| 策略 off | 出现 `verification-skipped`，任务正常 `completed`（CLI/Desktop 行为不变） |
| 完成守卫 | `mode='required'` 且无 passed 记录时 `finishAttempt('completed')` 返回 false |
| 取消 | `verifying -> cancelled` 成功，且不触发 failed |
| 旧库迁移 | 删除新表后重开 storage，表重建，旧任务/消息可读 |
| Memory vs SQLite | 同一脚本两种 store 结果一致 |

## 7. 验收

```bash
pnpm --filter @plain-agent/domain typecheck
pnpm --filter @plain-agent/domain test:tasks
pnpm --filter @plain-agent/domain test:verification
pnpm --filter @plain-agent/domain test:subagent
pnpm --filter @plain-agent/domain test:loop
pnpm --filter @plain-agent/domain test:jobs
pnpm --filter @plain-agent/cli typecheck
pnpm --filter @plain-agent/desktop typecheck
pnpm --filter @plain-agent/desktop typecheck:web
pnpm --filter @plain-agent/server typecheck
```

功能验收（手工）：

1. `pnpm cli --verify "node -e \"process.exit(0)\""`，任务完成路径出现 `verification-*` 事件；
2. `--verify "node -e \"process.exit(1)\""`，任务 failed，`task_verifications.error` 可读；
3. 验证执行中 `Ctrl+C`，重启 CLI 后任务进入 `verifying` 恢复并完成，Agent turn 不重跑；
4. Desktop 不配置 `verification` 时，行为与当前完全一致。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 验证命令本身有副作用 | 宿主显式声明；`rerunSafe:false` 时中断即失败，不重跑 |
| 验证耗时拖住租约 | 续租放宽到 `verifying`；总预算 `totalTimeoutMs` 默认 10 分钟，超时按失败处理并保留已有输出 |
| Windows shell 差异 | 复用 `domain/src/tools/shell.ts:resolveShell` 与 `createStreamDecoder`，与 bash 工具同一套解析/解码 |
| 旧库/旧任务 | 新列可空 + 新表 `IF NOT EXISTS`；无策略任务走 `off` 分支 |
| 验证失败后用户不知道下一步 | `verification-failed` 事件 + 失败项名称/exit code/日志路径；UI 展示留到 P3-E |
| 完成守卫影响子 Agent | 子任务无 `verification` 字段 → 不生效 |

## 9. 迭代路线（本阶段之后）

```text
P3-A 验证闭环        ← 本计划
P3-B 后台进程持久化观察 / waiting_process 恢复
P3-C 审批与问题持久化 / waiting_user 恢复
P3-D 统一事件唤醒器
P3-E Server 任务 API、Desktop 任务 UI、CLI task 子命令
P3-F Cron / Heartbeat
```

每一步开始前都要先复查上一阶段留下的 `blocked` 原因分布，避免用新功能掩盖旧状态机缺口。

## 10. 完成定义

- [x] 任务完成必须先经过 `verifying`，且 `completed` 有可查询的验证记录或 `verification-skipped` 事件；
- [x] 验证证据（检查项、exit code、输出尾部、日志路径、changedFiles、diffHash）可查询；
- [x] 验证期间租约可续，崩溃后可恢复且不重跑 Agent turn；
- [x] 不可安全重放的检查被中断时不会自动重跑；
- [x] stale worker 无法提交验证结论或完成状态；
- [x] `verification.mode='required'` 的任务无法绕过 store 完成守卫；
- [x] CLI/Desktop 默认行为不变，`--verify` / `settings.verification` 可用；
- [x] Memory/SQLite 行为一致，旧库可直接打开；
- [x] 上述验收命令全部通过。

## 11. 实施状态（2026-10-18）

P3-A 验证闭环已完成 coding 和回归验证。

### 已落地

- `TaskRecord.verification` + `verification_json` 列，Memory/SQLite 双实现；
- `task_verifications` / `task_verification_checks` 两张表，增量建表兼容旧库；
- `beginVerification` / `claimVerification` / `startVerificationCheck` / `finishVerificationCheck` / `concludeVerification`；
- `verifying` 期间租约可续期，`recoverExpiredTasks` 对 `verifying` 只回收租约、不升 attempt；
- `recover()` 识别 `verifying` 任务并恢复；租约未到期时推迟而不是误判 blocked；
- 检查器：`command`（超时/取消/日志尾部）、`files-exist`、`git-diff`（失败不影响证据采集）；
- 完成守卫：`mode='required'` 且无 passed 记录时 `finishAttempt('completed')` 被拒并写 `completion-rejected`；
- CLI `--verify` / `--verify-timeout`；Desktop `settings.verification`；
- 新增 `domain/test/test-task-verification.ts`（16 组用例，含崩溃恢复、不可重跑检查、stale worker、取消、旧库迁移、Memory/SQLite 一致性、真实 git 仓库的 `git-diff`）；
- 新增 `domain/test/test-task-verification-crash.ts`：真子进程 + `taskkill /T /F` 的跨进程崩溃恢复测试（验证 `attempt` 不变、Agent turn 不重跑）。

### 已验证

```text
domain typecheck               passed
domain test:tasks              passed（含 test-task-verification）
domain test:verification        passed
domain test:subagent            33 passed
domain test:loop                18 passed
domain test:jobs                12 passed
cli typecheck                  passed
server typecheck               passed
desktop typecheck              passed
desktop typecheck:web          passed
```

### 与计划的两点偏差

1. 事件持久化落在 store（`concludeVerification` 一次事务写 `verification-completed`/`verification-failed` + 终态），编排器的 `notify` 只做内存转发，避免同一事件写两遍。
2. 验证失败当前直接进入 `failed`（计划中的 `onFailure: 'retry'` 明确留给 P3-A.2），失败证据完整可查。

### 仍未实现（后续阶段）

- 后台进程持久化观察与 `waiting_process` 恢复（P3-B）；
- 审批与 `waiting_user` 恢复（P3-C）；
- 统一唤醒器（P3-D）；
- Server 任务 API / Desktop 任务 UI / Cron / Heartbeat（P3-E/F）。


