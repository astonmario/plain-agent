# 会话级偏好（Session Preferences）

会话级偏好是「用户在对话中表达、之后长期生效」的少量设置。它按 `sessionId` 存储，
每轮请求时注入 system prompt，不写入对话消息，因此不会污染历史、也不会在压缩后丢失。

## 只保留 5 个维度

| 属性 | 取值 | 说明 |
|---|---|---|
| `address` | 自由文本（≤40 字） | 用户本人希望被如何称呼 |
| `assistantName` | 自由文本（≤20 字） | 用户给助手起的名字，助手指代自己时使用 |
| `tone` | `concise` / `warm` / `humorous` / `formal` | 回答语气：简洁直接 / 温和耐心 / 轻松幽默 / 严谨专业 |
| `language` | `zh` / `en` / `follow` | 回复语言；`follow` = 跟随用户当前语言 |
| `depth` | `brief` / `balanced` / `detailed` | 解释深度：结论优先 / 结论+必要说明 / 教学式 |

不收录：性格设定、长期目标、项目事实。这些要么是全局记忆（`update_memory`），
要么属于任务上下文，放进会话偏好会让 prompt 膨胀且难以维护。

## 写入：模型通过工具保存

用户在对话中明确表达偏好时（「你叫大肥鱼」「以后叫我老板」「回答简洁点」「用英文回我」），
模型调用 `set_session_preferences`：

```json
{ "assistantName": "大肥鱼", "address": "老板", "tone": "concise" }
```

`address` 是「怎么称呼用户」，`assistantName` 是「助手怎么自称」，两者不能混用。

只传变化的字段；`clear: ["tone"]` 清除单项；全部清空等价于恢复默认。
非法枚举值会被拒绝且不修改任何已有偏好。

工具定义在 `domain/src/tools/session-preferences.ts`，默认注册进 `getBuiltinTools()`，
CLI / 桌面端 / Server 三端自动可用。默认系统提示词里有一段说明，要求模型「存下来，
不要只在回复里口头答应」。

## 读取：每轮注入 system prompt

`PlainAgent.withSessionPreferences()` 在每次请求前读取存储，把非空偏好追加到
**本次请求的 system prompt 副本**：

```text
## 会话偏好（用户设定，长期有效）
- 称呼用户：老板
- 你的自称：大肥鱼（指代自己时使用这个名字）
- 回答语气：简洁直接，先给结论
- 用户当次要求与以上偏好冲突时，以当次要求为准。
```

要点：

- 只改发送副本，`fullMessages` / task transcript 不写回 —— 否则偏好文本会在历史里累积；
- 同一轮内工具改了偏好，本轮仍用旧快照，**下一轮生效**（工具返回值里会说明）；
- 子 Agent 默认只有只读工具，拿不到 `set_session_preferences`，不会改父会话偏好。

## 存储

`SessionStorage` 新增两个**可选**方法，未实现的后端退化为「无偏好」：

```ts
getSessionPreferences?(sessionId: string): Promise<SessionPreferences | null>;
saveSessionPreferences?(sessionId: string, preferences: SessionPreferences): Promise<void>;
```

- SQLite：`sessions.preferences_json`（新库建表自带，旧库用 `ensureSessionColumn` 补列）；
- Memory：进程内 Map，`deleteSession` 时一起清理。

## 测试

```bash
pnpm --filter @plain-agent/domain test:prefs
```

覆盖：合并与校验、Memory/SQLite 往返、会话隔离、注入不多不少、工具写入后下一轮生效、
非法参数不改动已有值、清空、旧库补列。
