# 长任务 Agent 调查报告

**调查日期**：2026-10-16  
**调查对象**：Hermes Agent、OpenClaw、OpenAI Codex、Claude Code、OpenHands  
**调查目标**：分析这些 Agent 如何执行持续数十分钟、数小时甚至跨进程/跨会话的任务，并提炼可在 plain-agent 中落地的实现。

> 说明：本文把“公开文档明确说明的能力”和“根据源码/架构文档做出的工程推断”分开。产品会快速变化，本文结论以 2026-10-16 能访问到的官方文档、官方仓库和官方示例为准。功能名称、默认值和产品边界应在实施前再次核对。

## 1. 结论摘要

长任务 Agent 的核心不是把 ReAct 循环的 `maxIterations` 从 50 改成 500，而是同时解决七个问题：

1. **执行可持续**：当前进程退出、网络中断或机器重启后，任务仍有明确状态。
2. **上下文可恢复**：不能把完整对话无限塞进模型上下文；需要摘要、检查点和可检索的原始记录。
3. **任务可调度**：任务可以排队、并发、等待子任务、等待用户、定时唤醒。
4. **副作用可控制**：写文件、执行命令、网络访问等操作要经过权限、沙箱和审批。
5. **结果可验证**：Agent 不能只说“完成”，必须运行测试、检查 diff、记录证据。
6. **过程可观察**：用户需要看到任务树、事件、耗时、失败原因和下一步。
7. **结果可通知**：后台任务完成后能够回到正确会话，或通过通知渠道告知用户。

五家方案的工程侧重点不同：

| 方案 | 最强能力 | 长任务主要手段 | 主要短板 |
|---|---|---|---|
| Hermes Agent | 本地个人 Agent 的持久记忆与自动化 | SQLite 会话/记忆、技能、后台委派、Cron/定时任务 | 更偏单机个人助手，企业级分布式调度和隔离需要自行补足 |
| OpenClaw | 常驻网关、多渠道消息、自动唤醒 | Gateway、Session/Lane、Heartbeat、Cron、子 Agent、记忆检索 | 系统面较宽，权限和部署复杂度高；需认真做信任边界 |
| OpenAI Codex | 受控的软件工程执行 | Thread/Turn、工具审批、事件流、App Server、子 Agent/云端任务 | 更像代码执行运行时，不是完整的通用日程调度器 |
| Claude Code | 交互式编程任务和子 Agent | 可恢复会话、上下文压缩、前台/后台子 Agent、Hooks | 长期后台运行和跨机器调度通常需要外部系统 |
| OpenHands | 开源工程 Agent 的可复用运行时 | 事件溯源、ConversationStore、pause/resume、Runtime 沙箱 | 组件多、运行成本高；生产化仍需补调度、配额和通知 |

**推荐组合**：

- 借鉴 **OpenHands** 的事件溯源和 pause/resume；
- 借鉴 **Hermes** 的本地记忆、技能和后台任务；
- 借鉴 **OpenClaw** 的 Gateway、Heartbeat、Cron 和会话路由；
- 借鉴 **Codex/Claude Code** 的权限审批、工具沙箱、子 Agent 和代码验证；
- 对 plain-agent 保留现有 `PlainAgent + ReAct + HistoryManager + SQLiteStorage`，新增一个独立的 `TaskOrchestrator`，不要把调度逻辑硬塞进 `agentLoop`。

## 2. 什么才算“长任务”

本文将长任务定义为满足以下任意一项的 Agent 任务：

- 运行时间超过一次模型请求或一次交互轮次；
- 需要多次工具调用、编译、测试、浏览器操作或外部进程；
- 需要并发执行多个子任务；
- 需要在用户离线时继续执行；
- 需要跨进程重启恢复；
- 需要跨越一个上下文窗口；
- 需要等待定时条件、外部事件或用户审批。

一个长任务的典型生命周期如下：

```text
queued
  -> planning
  -> running
  -> waiting_child / waiting_process / waiting_user
  -> running
  -> verifying
  -> completed

任何阶段都可能进入:
  failed / cancelled / paused / blocked
```

关键区别是：**“Agent 正在思考”不是持久化状态，“任务下一步应该做什么”才是持久化状态。**

## 3. 方案一：Hermes Agent

### 3.1 产品定位

Hermes Agent 是 Nous Research 的开源、终端优先的个人 Agent，强调本地运行、工具调用、记忆、技能、后台任务和多种消息渠道。官方材料将它描述为可以从终端、Telegram、Discord、Slack、WhatsApp 等入口使用的个人 Agent。

### 3.2 与长任务相关的机制

#### A. 本地会话和记忆

Hermes 把会话、长期记忆、用户偏好和 Agent 生成的知识放在本地数据层中。其意义不是“把所有历史重新发给模型”，而是：

```text
完整事件/消息
      -> 持久化
      -> 需要时按关键词/语义检索
      -> 只把相关片段重新注入上下文
```

这比单纯的摘要更可靠：摘要适合维持当前任务状态，检索适合找回某次工具输出、决策或旧任务结果。

#### B. 技能和工具扩展

Hermes 将可复用行为抽象为技能/指令，而不是把所有规则塞进一个巨大 system prompt。长任务中可以把“部署项目”“分析日志”“定期检查”等工作固化为技能，降低每次规划成本。

#### C. 后台委派

Hermes 提供将长耗时工作委派到后台的能力，典型流程是：

```text
主 Agent:
  delegate_task(task, context)
       -> 创建后台任务
       -> 立即返回 task_id
       -> 后台 worker 独立运行

主 Agent 或用户:
  check_background_task(task_id)
       -> 查询状态
       -> 获取摘要/完整结果
```

后台任务与当前对话解耦，避免一个长任务阻塞消息入口。

#### D. Cron/定时自动化

Hermes 的自动化能力体现了“任务不一定由用户即时发起”的思路。定时任务需要记录：

- 触发规则；
- 使用的会话或工作目录；
- 任务提示词；
- 最大运行时间；
- 结果投递渠道；
- 最近一次运行和下一次运行时间。

### 3.3 适合借鉴的具体实现

```python
class BackgroundTask:
    id: str
    prompt: str
    session_id: str
    status: str                 # queued/running/completed/failed/cancelled
    created_at: int
    started_at: int | None
    finished_at: int | None
    result_summary: str | None
    result_ref: str | None

async def delegate_task(task: BackgroundTask):
    await task_store.insert(task)
    queue.put_nowait(task.id)
    return task.id

async def worker_loop():
    while True:
        task_id = await queue.get()
        task = await task_store.claim(task_id)
        if task is None:
            continue
        try:
            await task_store.mark_running(task.id)
            result = await run_agent(
                prompt=task.prompt,
                session_id=task.session_id,
                resume_from=task.checkpoint_id,
            )
            await task_store.complete(task.id, result.summary, result.ref)
            await notifier.notify(task, result)
        except Exception as exc:
            await task_store.fail(task.id, str(exc))
```

### 3.4 优势和限制

**优势**

- 本地优先，适合个人开发环境和隐私敏感任务；
- 记忆、技能、后台任务和消息渠道组合完整；
- 任务完成后主动通知的产品体验较好；
- 适合把 Agent 当成常驻个人助手。

**限制**

- “后台运行”不自动等于“可靠恢复”；必须确认任务状态、进程重启恢复和外部进程重连策略；
- 本地执行命令、浏览器和第三方消息渠道带来较大的权限面；
- 若要多租户、配额、审计和分布式 worker，需要在其上再建控制平面。

## 4. 方案二：OpenClaw

### 4.1 产品定位

OpenClaw 是一个 Gateway 中心的个人 Agent 平台。Gateway 常驻运行，负责消息渠道、会话、工具执行、定时器、心跳和 Agent 运行之间的协调。它的设计重点不是“一次 CLI 命令”，而是“一个长期在线的 Agent 服务”。

### 4.2 与长任务相关的机制

#### A. Gateway 作为常驻控制平面

OpenClaw 的基本形态可以抽象为：

```text
Telegram / Discord / Slack / Web / CLI
               |
               v
          Gateway
      /      |       \
 Session  Scheduler  Tools
    |        |        |
 Agent    Cron/     Browser/
 Loop    Heartbeat  Shell/MCP
```

Gateway 负责把事件路由到正确的 Agent/session，而不是让每个前端入口各自维护一套 Agent 状态。

#### B. Session/Lane 隔离

长任务不能和普通聊天共享一个无界上下文。OpenClaw 用会话和执行 lane 将不同来源的消息、并发执行和队列策略分开。工程上应至少隔离：

- 会话身份；
- 工作目录；
- 工具权限；
- 并发槽位；
- 上下文历史；
- 通知目标。

#### C. Heartbeat

Heartbeat 是“周期性唤醒 Agent 检查是否有工作”的机制。它适合处理：

- 读取 `HEARTBEAT.md` 或待办清单；
- 检查后台任务；
- 检查外部系统状态；
- 到点发提醒；
- 在无人交互时继续推进任务。

Heartbeat 不应每次都盲目调用 LLM。更稳妥的实现是先用确定性检查过滤：

```text
定时器触发
  -> 检查是否有待处理事件/到期任务
  -> 没有事件: 跳过模型调用
  -> 有事件: 生成最小上下文
  -> 调用 Agent
  -> 记录结果和下一次唤醒时间
```

#### D. Cron

Cron 适合确定时间触发的任务，Heartbeat 适合周期性检查。两者要区分：

| 机制 | 适合场景 | 是否需要每次调用模型 |
|---|---|---|
| Cron | “每天 9:00 生成报告” | 通常需要 |
| Heartbeat | “每 15 分钟看是否有事需要处理” | 有事件时才需要 |

#### E. 子 Agent 和结果回传

OpenClaw 的委派模型强调子 Agent 运行在独立 session 中，完成后将结果摘要回传到父任务。核心不是把父会话完整复制给子 Agent，而是传递：

- 任务目标；
- 相关文件/资源；
- 必要的上下文摘要；
- 工具和权限白名单；
- 结果回传目标。

### 4.3 适合借鉴的具体实现

```typescript
interface SessionLane {
  sessionKey: string;
  queueMode: 'serial' | 'parallel' | 'interrupt';
  runningTaskId?: string;
  pendingEvents: AgentEvent[];
  workspace: string;
  permissionProfile: string;
}

interface Wakeup {
  id: string;
  kind: 'cron' | 'heartbeat' | 'child-completed' | 'external-event';
  dueAt: number;
  sessionKey: string;
  payload: Record<string, unknown>;
}

async function gatewayTick(wakeup: Wakeup): Promise<void> {
  const lane = await laneStore.get(wakeup.sessionKey);
  if (!lane) return;

  const event = await eventStore.materialize(wakeup);
  if (wakeup.kind === 'heartbeat' && !event.requiresAgent) {
    return;
  }

  await scheduler.enqueue({
    sessionKey: wakeup.sessionKey,
    prompt: event.prompt,
    priority: wakeup.kind === 'child-completed' ? 100 : 50,
  });
}
```

### 4.4 优势和限制

**优势**

- 常驻 Gateway 适合多入口、多会话和后台自动化；
- Heartbeat/Cron/消息路由构成完整的“唤醒层”；
- 对个人助理、监控、提醒、定期报告特别合适；
- 子 Agent 的独立 session 有利于控制上下文爆炸。

**限制**

- Gateway 一旦拥有 shell、浏览器、消息渠道和长期凭据，安全边界非常关键；
- 事件路由、队列、会话和通知相互耦合，维护成本高；
- 需要明确“用户消息”和“后台自动事件”的优先级，避免后台任务抢占交互任务。

## 5. 方案三：OpenAI Codex

### 5.1 产品定位

Codex 更接近“受控的软件工程 Agent 运行时”：它在代码仓库、终端、测试和版本控制环境中执行任务，并通过线程、回合、工具事件和审批机制让用户监督过程。OpenAI 的 Agents API、Codex CLI、Codex App Server 和云端任务分别覆盖了嵌入式 Agent、终端 Agent、编辑器/客户端协议和托管执行场景。

### 5.2 与长任务相关的机制

#### A. Thread/Turn 分离

长任务需要把“任务身份”和“一次模型推进”分开：

```text
Thread = 持久化任务/会话
Turn   = 一次用户请求或一次 Agent 推进
Item   = 消息、工具调用、工具结果、审批、文件修改等事件
```

这样可以在一个 Thread 中进行多次 Turn，也可以在任务暂停后恢复，而不是把整个运行状态绑定在一次 HTTP 请求上。

#### B. App Server/事件流

Codex App Server 采用面向客户端的结构化协议。客户端订阅事件，Agent 运行时发出：

- turn started/completed；
- reasoning 或状态更新；
- command execution；
- patch/file change；
- approval request；
- error；
- task completion。

这种设计适合 IDE、CLI、桌面端和 Web UI 共享同一运行时。

#### C. 执行策略和审批

代码 Agent 的长任务副作用很强，因此 Codex 将命令执行、网络、写文件和审批作为一等概念。长期运行时必须记录：

- 使用了什么权限模式；
- 哪个命令被批准；
- 哪些命令被拒绝；
- 工作目录和沙箱；
- 产生了哪些文件变化。

#### D. 子 Agent/多 Agent

Codex 源码包含多 Agent 能力的实现痕迹：父 Agent 可以将独立分析、测试或审查工作委派给子 Agent，再收集结果。适合把一个软件任务分成：

```text
主 Agent: 规划和集成
  ├── 子 Agent: 代码搜索/架构分析
  ├── 子 Agent: 测试/复现
  └── 子 Agent: 独立代码审查
```

子任务应该拥有独立上下文和权限，而不是共享父 Agent 的可变消息数组。

#### E. 长任务的边界

Codex 强项是“软件工程任务执行”，不是完整的通用调度平台。要实现每天定时运行、跨渠道通知、事件驱动唤醒，通常仍需要外部 scheduler 或工作流平台。

### 5.3 适合借鉴的具体实现

```typescript
type TurnItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown }
  | { type: 'tool_result'; callId: string; output: string; exitCode?: number }
  | { type: 'approval'; approvalId: string; action: string; status: string }
  | { type: 'checkpoint'; snapshotId: string };

interface CodingThread {
  id: string;
  repoRoot: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  items: TurnItem[];
  permissionProfile: 'read-only' | 'workspace-write' | 'full';
  lastCheckpointId?: string;
}

async function runTurn(threadId: string, input: string) {
  const thread = await threadStore.load(threadId);
  await threadStore.append(threadId, {
    type: 'message',
    role: 'user',
    content: input,
  });

  for (let i = 0; i < MAX_TURN_STEPS; i++) {
    const snapshot = await contextBuilder.build(thread);
    const decision = await model.next(snapshot);

    if (decision.type === 'approval_required') {
      await threadStore.append(threadId, {
        type: 'approval',
        approvalId: decision.id,
        action: decision.description,
        status: 'pending',
      });
      return { status: 'waiting_user' };
    }

    if (decision.type === 'tool_call') {
      const result = await executeWithPolicy(thread, decision);
      await threadStore.append(threadId, result.item);
      continue;
    }

    await threadStore.append(threadId, {
      type: 'message',
      role: 'assistant',
      content: decision.content,
    });
    return { status: 'completed', output: decision.content };
  }

  await threadStore.createCheckpoint(threadId);
  return { status: 'paused', reason: 'step_budget' };
}
```

### 5.4 优势和限制

**优势**

- 软件工程工具链、命令执行和审批模型成熟；
- 线程/回合/事件的分离适合客户端和后台运行；
- 子 Agent、代码变更和验证天然适合任务树；
- 对“修改仓库并证明结果”这类任务非常强。

**限制**

- 不是完整的 Cron/Heartbeat/消息网关系统；
- 具体云端任务、CLI、App Server、Agents API 的能力边界不同，不能混为一个产品；
- 生产环境仍需自己实现租约、队列、重试、通知、配额和多租户隔离。

## 6. 方案四：Claude Code

### 6.1 产品定位

Claude Code 是终端和代码仓库优先的编程 Agent。它的长任务能力主要来自：可恢复会话、上下文压缩、工具调用循环、子 Agent、Hooks 和人类审批。

### 6.2 与长任务相关的机制

#### A. 会话恢复

Claude Code 支持恢复已有会话，使“终端进程结束”不必等于“任务语义丢失”。工程上要保存至少：

- session id；
- 工作目录；
- 对话事件；
- 工具调用和结果；
- 当前任务摘要；
- 最近一次压缩点；
- 未完成的审批或外部进程。

#### B. 子 Agent 的前台/后台模式

官方子 Agent 文档明确区分前台和后台运行。前台子 Agent 阻塞主流程并直接返回结果；后台子 Agent 可以并行运行，主 Agent 继续处理其他工作，再查询或等待结果。

这对长任务的启示是：`spawn` 和 `wait` 必须是两个动作，不能把创建任务和等待任务绑定成一个阻塞工具。

#### C. 上下文压缩

Claude Code 在接近上下文限制时压缩对话，保留任务目标、关键决策、工作状态和最近交互。压缩是运行时的控制机制，不应替代原始事件存储。

正确的设计应是：

```text
Transcript/Event Store  = 真相源
Context Summary         = 当前模型视图
File/Artifact State     = 外部事实
```

#### D. Hooks

Hooks 使 Agent 生命周期中的关键节点可以接入外部逻辑，例如：

- 会话开始时恢复环境；
- 工具执行前做策略检查；
- 压缩前保存检查点；
- 工具执行后记录审计；
- Agent 停止时触发测试或通知。

Hooks 对长任务尤其重要，因为它把“恢复、审计、通知和策略”从模型提示词中拿出来。

### 6.3 适合借鉴的具体实现

```bash
# 伪命令：将生命周期事件发送给外部控制器
agent hooks on-session-start  -> taskctl restore --session "$SESSION_ID"
agent hooks pre-tool          -> taskctl policy-check --tool "$TOOL"
agent hooks pre-compact       -> taskctl checkpoint --session "$SESSION_ID"
agent hooks post-tool         -> taskctl audit --event "$EVENT_JSON"
agent hooks on-stop           -> taskctl verify --session "$SESSION_ID"
```

TypeScript 侧可抽象为：

```typescript
interface AgentHookContext {
  sessionId: string;
  taskId: string;
  event: AgentEvent;
  signal: AbortSignal;
}

interface AgentHooks {
  onSessionStart?(ctx: AgentHookContext): Promise<void>;
  beforeTool?(ctx: AgentHookContext, tool: ToolCall): Promise<'allow' | 'deny' | 'ask'>;
  beforeCompact?(ctx: AgentHookContext): Promise<void>;
  afterTool?(ctx: AgentHookContext, result: ToolResult): Promise<void>;
  onStop?(ctx: AgentHookContext): Promise<void>;
}
```

### 6.4 优势和限制

**优势**

- 编程任务的交互体验强；
- 子 Agent 的前台/后台模型简单清晰；
- Hooks 适合接入企业审计、测试和策略；
- 会话恢复和压缩适合长时间代码工作。

**限制**

- 通常仍是一个以交互会话为中心的 Agent；
- 复杂的跨天任务、任务依赖、定时触发和多渠道通知需要外部控制平面；
- 子 Agent 结果回传要控制长度，否则父上下文仍会膨胀。

## 7. 方案五：OpenHands

### 7.1 产品定位

OpenHands 是开源的软件工程 Agent 平台，适合作为研究和自建系统的架构参考。它的核心价值不是某个单一 prompt，而是将 Agent、Runtime、Action、Observation、ConversationStore 和事件流分层。

### 7.2 与长任务相关的机制

#### A. 事件溯源

OpenHands 把 Agent 与环境交互表示为 Action/Observation 事件序列：

```text
MessageAction
  -> CmdRunAction
  -> CmdOutputObservation
  -> FileEditAction
  -> FileReadObservation
  -> AgentFinishAction
```

事件序列可以用于：

- 重新构造当前状态；
- 回放和调试；
- 审计；
- 任务暂停与恢复；
- 重新生成上下文；
- 统计 token、工具调用和失败点。

#### B. ConversationStore 与 pause/resume

对长任务而言，ConversationStore 比“把内存中的 Agent 对象序列化”更稳健。恢复流程应是：

```text
load conversation events
  -> load task metadata
  -> attach/recreate runtime
  -> inspect last durable event
  -> decide resume point
  -> continue agent loop
```

这也允许在不同 Runtime 上恢复，例如本地 Docker、远程沙箱或 Kubernetes worker。

#### C. Runtime 抽象

Runtime 将 shell、文件、浏览器、网络等执行环境从 Agent 推理中分离。长任务可以更换 Runtime，而不必重写 Agent loop。

#### D. 并行和资源边界

工具调用可以并行，但有副作用的工具必须串行或加锁。运行环境、工作目录、网络和凭据应由 Runtime 管理，而不是任由模型直接继承宿主机权限。

### 7.3 适合借鉴的具体实现

```python
class EventStore(Protocol):
    async def append(self, conversation_id: str, event: Event) -> int: ...
    async def read_after(self, conversation_id: str, seq: int) -> list[Event]: ...
    async def snapshot(self, conversation_id: str, state: dict) -> str: ...

async def resume_conversation(conversation_id: str):
    metadata = await conversation_store.load_metadata(conversation_id)
    events = await event_store.read_all(conversation_id)
    state = reducer.rebuild(events)

    runtime = await runtime_factory.attach(
        workspace=metadata.workspace,
        container_id=metadata.container_id,
    )

    if state.status in {"completed", "failed", "cancelled"}:
        return state

    return await agent.run(
        state=state,
        runtime=runtime,
        event_sink=event_store,
    )
```

### 7.4 优势和限制

**优势**

- 事件溯源、暂停恢复、Runtime 隔离是最值得借鉴的工程模式；
- 适合测试、回放和问题定位；
- 能把本地执行与远程沙箱统一到一个接口；
- 对构建自有 Agent 平台非常有参考价值。

**限制**

- 组件和部署复杂度较高；
- 事件、快照、Runtime、任务调度之间需要严格定义一致性；
- 不应只复制界面或 prompt，而应先理解其持久化和恢复模型。

## 8. 横向比较：长任务能力拆解

| 能力 | Hermes | OpenClaw | Codex | Claude Code | OpenHands |
|---|---:|---:|---:|---:|---:|
| 多轮工具执行 | 强 | 强 | 强 | 强 | 强 |
| 上下文压缩/摘要 | 强 | 中强 | 强 | 强 | 强 |
| 原始事件可回放 | 中 | 中强 | 强 | 中 | 强 |
| 后台任务 | 强 | 强 | 中强 | 强 | 中 |
| Cron/Heartbeat | 强 | 很强 | 弱 | 弱 | 弱 |
| 子 Agent | 中强 | 强 | 强 | 强 | 中 |
| 跨进程恢复 | 中 | 中强 | 强 | 中 | 很强 |
| 代码仓库执行 | 中强 | 中 | 很强 | 很强 | 很强 |
| 工具审批/沙箱 | 中 | 中 | 很强 | 强 | 强 |
| 多渠道通知 | 强 | 很强 | 弱 | 弱 | 弱 |
| 适合作为自建底座 | 中强 | 中 | 中强 | 中 | 很强 |

表中“强弱”是本文基于公开能力和架构可验证性的工程判断，不是官方评分。

## 9. 共同架构模式

### 9.1 控制平面与执行平面分离

```text
Control Plane
  TaskStore / Scheduler / Lease / Policy / Notification
       |
       v
Execution Plane
  AgentLoop / ToolRuntime / Subagent / Process / Browser
       |
       v
Durable State
  Events / Messages / Checkpoints / Artifacts / Audit
```

不要让 `PlainAgent` 同时负责调度、通知、租约、重试和所有 UI 事件。Agent Core 只需要接受一个可恢复的 Task Context。

### 9.2 事件、快照、上下文视图三分法

```text
Event Store       不可变真相源，记录发生过什么
Snapshot          可快速恢复的结构化状态
Context View      给 LLM 的压缩视图
```

三者不能混为一谈：

- 删除旧消息不应删除审计事件；
- 更新摘要不应覆盖真实工具输出；
- LLM 看到的内容不代表系统事实；
- 文件、进程和测试结果应作为外部事实重新读取。

### 9.3 子任务必须是独立实体

每个子任务至少需要：

```typescript
interface TaskRecord {
  id: string;
  parentId?: string;
  rootId: string;
  sessionId: string;
  status: TaskStatus;
  prompt: string;
  contextSummary?: string;
  allowedTools: string[];
  workspace: string;
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

### 9.4 失败恢复要按类型处理

| 失败类型 | 是否自动重试 | 恢复方式 |
|---|---|---|
| LLM 网络超时 | 是，指数退避 | 继续当前 Turn |
| 工具进程退出 | 视命令类型 | 从进程/日志状态恢复 |
| 权限拒绝 | 否 | 等待用户批准或调整策略 |
| 上下文超限 | 是 | 创建 checkpoint 后压缩 |
| 模型重复调用 | 通常否 | 触发反思/换策略/升级 |
| worker 崩溃 | 是 | 租约过期后重新 claim |
| 外部依赖不可用 | 有限重试 | 进入 blocked，等待唤醒 |

### 9.5 验证闭环

长任务完成事件必须携带证据：

```typescript
interface VerificationResult {
  status: 'passed' | 'failed' | 'skipped';
  checks: Array<{
    name: string;
    command?: string;
    exitCode?: number;
    outputRef?: string;
    summary: string;
  }>;
  changedFiles: string[];
  diffHash?: string;
}
```

“模型回答完成”只能产生 `agent_finished`，通过测试和检查后才能产生 `task_completed`。

## 10. 对 plain-agent 的现状评估

当前项目已经具备一批非常好的基础：

- `domain/src/loop.ts`：ReAct 主循环、AbortSignal、工具批次并发和串行控制；
- `domain/src/agent.ts`：多任务、事件发射、会话消息、权限检查、后台 job 回注；
- `domain/src/history-manager.ts`：工具输出截断、Anchor、激进摘要；
- `domain/src/compression-trigger.ts`：按 token、消息数、工具输出和重复行为决定压缩；
- `domain/src/tools/jobs.ts`：后台进程、日志文件、输出上限、结束回调；
- `domain/src/subagent/runtime.ts`：子 Agent、并发上限、递归深度、超时、取消和结果摘要；
- `domain/src/storage/sqlite.ts`：会话、消息、事件和后台 job 的 SQLite 持久化。

### 10.1 当前最重要的缺口

1. **子 Agent 默认没有持久化会话**：`SubagentRuntime` 当前为子 Agent 设置 `storage: undefined`，进程重启后不能恢复其完整推理状态。
2. **TaskStore 仍是内存实现**：虽然接口已经存在，但默认 `MemoryTaskStore` 无法支撑 worker 崩溃恢复。
3. **没有真正的 Scheduler**：当前支持 `spawn/wait/cancel/status`，还没有定时触发、依赖、租约、队列和唤醒。
4. **后台进程恢复有限**：`JobRegistry` 可以写日志并在重启后读取历史输出，但不能自动重新连接一个仍在运行的进程，也没有持久化 pid/进程所有权/启动参数的完整恢复协议。
5. **Agent Loop 是一次调用模型的长循环**：达到 `maxIterations` 后返回失败式结果，缺少 checkpoint、暂停、继续和分段执行。
6. **权限 ask 模式未闭环**：`agent.ts` 中 ask 模式目前只能拒绝，需要持久化审批请求并支持恢复。
7. **验证不是一等状态**：测试和 diff 可以由模型调用，但没有统一的 `verifying -> completed` 状态和证据结构。
8. **父任务与子任务之间没有完整 DAG**：目前有 parentRunId，但缺少依赖、失败传播、聚合进度和结果去重。

## 11. 推荐的 plain-agent 实现

### 11.1 目标架构

```text
PlainAgent
  - 负责一次可恢复的 Agent Turn
  - 不负责 Cron、租约、通知和全局调度

TaskOrchestrator
  - 创建任务
  - 维护状态机
  - 调度 worker
  - 处理重试、依赖和唤醒

DurableTaskStore
  - SQLite 任务、事件、检查点、审批、工件

Scheduler
  - queue
  - cron
  - heartbeat
  - child-completed wakeup

Worker
  - claim task
  - restore checkpoint
  - run PlainAgent
  - append events
  - checkpoint/verify/complete
```

### 11.2 建议的 SQLite 表

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  root_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  context_summary TEXT,
  workspace TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
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

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  message_cursor INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  task_id_template TEXT NOT NULL,
  cron_expr TEXT,
  next_run_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
```

### 11.3 任务状态机

```typescript
type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_child'
  | 'waiting_process'
  | 'waiting_user'
  | 'blocked'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  queued: ['planning', 'cancelled'],
  planning: ['running', 'waiting_user', 'failed', 'cancelled'],
  running: [
    'waiting_child',
    'waiting_process',
    'waiting_user',
    'blocked',
    'verifying',
    'paused',
    'failed',
    'cancelled',
  ],
  waiting_child: ['running', 'failed', 'cancelled'],
  waiting_process: ['running', 'blocked', 'failed', 'cancelled'],
  waiting_user: ['running', 'cancelled'],
  blocked: ['queued', 'running', 'cancelled'],
  verifying: ['completed', 'running', 'failed'],
  paused: ['queued', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};
```

所有状态变化必须先写 `task_events`，再更新 `tasks.status`。更新应当带条件，避免两个 worker 同时完成同一个任务。

### 11.4 Worker 租约

```typescript
async function claimNext(workerId: string): Promise<TaskRecord | null> {
  return db.transaction(async tx => {
    const task = tx.findClaimableTask(Date.now());
    if (!task) return null;

    const leaseUntil = Date.now() + 60_000;
    const updated = tx.updateTaskIf(
      { id: task.id, status: task.status, leaseUntil: task.leaseUntil },
      {
        status: 'running',
        leaseOwner: workerId,
        leaseUntil,
        attempt: task.attempt + 1,
      },
    );
    return updated ? tx.getTask(task.id) : null;
  });
}

async function worker(workerId: string): Promise<void> {
  while (true) {
    const task = await taskStore.claimNext(workerId);
    if (!task) {
      await sleep(1000);
      continue;
    }

    try {
      await runTask(task, workerId);
    } catch (error) {
      await taskStore.failOrRetry(task.id, serializeError(error));
    }
  }
}
```

租约续期和 worker 崩溃恢复比“保存一个 running 标记”更重要。`running` 但租约过期的任务必须能够重新进入队列。

### 11.5 可恢复的 Agent Turn

```typescript
async function runTask(task: TaskRecord, workerId: string): Promise<void> {
  const checkpoint = task.checkpointId
    ? await taskStore.loadCheckpoint(task.checkpointId)
    : undefined;

  const agent = new PlainAgent({
    ...configFromTask(task),
    sessionId: task.sessionId,
    storage: durableSessionStorage,
    maxIterations: 25,
    historyManagement: {
      enabled: true,
      maxTokens: 12_000,
      compressionThreshold: 9_000,
      aggressiveThreshold: 11_000,
    },
  });

  if (checkpoint) {
    await agent.restoreCheckpoint(checkpoint);
  } else {
    await agent.loadHistory();
  }

  agent.on('event', async event => {
    await taskStore.appendEvent(task.id, event);
    if (event.type === 'compression' || event.type === 'iteration') {
      await taskStore.maybeCheckpoint(task.id, agent);
    }
  });

  const result = await agent.submit(task.prompt, task.id);
  await taskStore.transition(task.id, 'verifying');
  const verification = await verifyTask(task, agent, result);

  if (verification.status === 'passed') {
    await taskStore.complete(task.id, result, verification);
  } else {
    await taskStore.transition(task.id, 'running');
    await taskStore.appendEvent(task.id, {
      type: 'verification_failed',
      verification,
    });
  }
}
```

建议将当前 `PlainAgent` 的“单次 submit”拆成两个公开层次：

- `runTurn()`：推进有限步数，可能返回 `paused`；
- `resume()`：从 checkpoint 继续；
- `submit()`：为交互式短任务提供兼容封装。

### 11.6 子 Agent 持久化

对当前 `SubagentRuntime` 的最小改造：

1. 将默认 `MemoryTaskStore` 替换为 `SQLiteTaskStore`；
2. 为每个子 Agent 分配持久化 `sessionId`；
3. 子 Agent 使用受限的 `SessionStorage`，而不是 `storage: undefined`；
4. `wait()` 超时不应默认把子任务标成失败，应区分“等待超时”和“任务失败”；
5. 父任务重启时，根据 `parentId` 加载未完成子任务；
6. 只有在父任务取消时才级联取消子任务；
7. 子任务结果通过 `result_ref` 指向完整结果，父上下文只注入摘要。

### 11.7 调度器

第一版不需要复杂工作流引擎，支持四类唤醒即可：

```typescript
type WakeupReason =
  | 'manual'
  | 'cron'
  | 'heartbeat'
  | 'child_completed'
  | 'process_completed'
  | 'approval_granted'
  | 'lease_expired';
```

调度优先级建议：

1. 用户显式请求；
2. 审批完成；
3. 子任务完成；
4. 进程完成；
5. 租约过期恢复；
6. Heartbeat；
7. 普通 Cron。

Heartbeat 的确定性过滤必须在调用 LLM 前执行，以避免每次心跳都产生费用。

### 11.8 权限审批恢复

当前 ask 模式需要从“返回 false”升级为：

```typescript
const approval = await approvalStore.create({
  taskId,
  tool: tool.name,
  args,
  reason: describeRisk(tool, args),
});

await taskStore.transition(taskId, 'waiting_user');
emit({
  type: 'approval_required',
  approvalId: approval.id,
  taskId,
});

// 外部 UI 调用 approve/reject
// Scheduler 监听 approval_granted，再恢复 task
```

审批不能只存在于内存回调中，否则 UI 刷新或服务重启后任务会永久卡住。

## 12. 实施优先级

### P0：可恢复任务基础

- `SQLiteTaskStore`；
- 任务状态机和状态转换校验；
- task event append；
- worker claim/lease；
- checkpoint schema；
- 子 Agent 的持久化状态。

**验收**：杀掉 worker，重启后任务可以从最近 checkpoint 继续；同一任务不会被两个 worker 同时完成。

### P1：后台进程和验证闭环

- 将 `JobRegistry` 的运行状态持久化；
- 保存命令、cwd、环境摘要、pid、日志路径和退出状态；
- 增加 `waiting_process`；
- 增加统一 `verifyTask()`；
- 只有验证通过才进入 `completed`。

**验收**：启动一个长测试命令，重启 Agent 后可读取完整日志并正确判断退出状态。

### P2：子 Agent DAG 和结果回传

- 持久化 parent/child/dependencies；
- 子 Agent 并发上限和递归深度；
- 子任务完成事件唤醒父任务；
- 父任务只接收摘要和 artifact 引用；
- 子任务失败传播策略。

**验收**：三个子任务并行运行，其中一个失败时父任务能按策略重试、降级或停止。

### P3：Heartbeat/Cron/通知

- Cron 表和 next_run_at；
- Heartbeat 确定性过滤；
- 任务完成、失败、阻塞通知；
- CLI/HTTP/Electron 统一订阅 task event。

**验收**：服务重启后不会丢失到期任务；同一个 Cron 不会重复执行。

### P4：安全和生产化

- workspace 沙箱；
- 命令白名单和网络策略；
- 凭据最小权限；
- 审计日志；
- token、时间、并发、磁盘和费用预算；
- 任务级熔断和人工接管。

## 13. 测试和评估方案

不要只测试“短 prompt 能否返回答案”。建议建立以下长任务基准：

1. **长编译**：运行 10 分钟以上的测试/构建，期间继续接收用户查询。
2. **服务启动**：后台启动服务，Agent 继续处理其他任务，服务完成后回注结果。
3. **进程重启**：工具执行中重启 worker，验证任务恢复和日志完整性。
4. **上下文压力**：生成大量工具输出，验证压缩后仍能找回原始结果。
5. **重复行为**：模拟反复运行相同失败命令，验证能停止并请求升级。
6. **并发子任务**：并行分析多个模块，验证父任务聚合结果。
7. **审批等待**：危险命令触发审批，重启 UI 后仍能继续。
8. **外部依赖恢复**：模拟网络错误、限流和暂时不可用。
9. **定时任务**：服务重启后补偿到期 Cron，且不重复运行。
10. **验证失败**：Agent 宣称完成但测试失败，验证任务回到 running 而不是 completed。

核心指标：

| 指标 | 定义 |
|---|---|
| Resume success rate | worker 崩溃后成功继续的任务比例 |
| Duplicate execution rate | 同一副作用被重复执行的比例 |
| Lost event rate | 任务事件/工具结果丢失比例 |
| Context recovery accuracy | 压缩/恢复后能找回关键事实的比例 |
| Verification precision | 标记 completed 的任务中真实通过的比例 |
| Mean time to recovery | 崩溃到恢复运行的平均时间 |
| Notification delivery rate | 完成/失败通知成功送达比例 |
| Cost per completed task | 含压缩、重试和子 Agent 的总成本 |

## 14. 最终建议

如果目标是把 plain-agent 做成可靠的长任务 Agent，优先顺序应是：

1. 先补 `SQLiteTaskStore + 状态机 + 事件溯源 + 租约`；
2. 再把现有 `HistoryManager` 接入 checkpoint/resume；
3. 将 `SubagentRuntime` 改成真正可持久化的任务树；
4. 把后台 job 从“能查输出”升级为“可恢复、可验证的外部执行单元”；
5. 最后加 Heartbeat、Cron、通知和多渠道适配；
6. 对所有写操作保留审批、审计和验证证据。

最值得采用的组合不是复制某一家，而是：

```text
OpenHands: 事件溯源 + Runtime + pause/resume
Hermes:    本地记忆 + 技能 + 后台任务
OpenClaw:  Gateway + Heartbeat + Cron + 消息路由
Codex:     工具审批 + 代码执行 + 事件协议 + 子 Agent
Claude:    前后台子 Agent + Hooks + 会话压缩/恢复
```

plain-agent 已经有 ReAct、后台 job、历史压缩、Anchor、SQLite 会话和基础子 Agent，最短路径不是换框架，而是把这些能力统一到一个可恢复的任务控制平面。

## 15. 参考资料

以下优先使用官方文档、官方仓库或官方示例：

- [Hermes Agent 官方仓库](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent 官方文档](https://hermes-agent.nousresearch.com/docs/)
- [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)
- [OpenClaw Architecture](https://docs.openclaw.ai/concepts/architecture)
- [OpenClaw Agent Loop](https://docs.openclaw.ai/concepts/agent-loop)
- [OpenClaw Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)
- [OpenClaw Automation](https://docs.openclaw.ai/automation)
- [OpenClaw Delegate Architecture](https://docs.openclaw.ai/concepts/delegate-architecture)
- [OpenAI Agents API 概览](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [OpenAI Agents API Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
- [OpenAI Codex 官方仓库](https://github.com/openai/codex)
- [OpenAI Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Claude Code Sub-agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Anthropic Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)
- [OpenHands 官方仓库](https://github.com/All-Hands-AI/OpenHands)
- [OpenHands SDK Architecture](https://docs.openhands.dev/sdk/arch/sdk)
- [OpenHands Conversation Pause/Resume](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume)
- [OpenHands Conversation Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)

