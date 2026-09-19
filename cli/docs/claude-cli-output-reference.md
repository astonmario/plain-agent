# Claude CLI 输出格式参考

> 基于真正的 Claude CLI（命令行工具），而非 IDE 集成的 Claude Code

## Claude CLI 概述

Claude CLI 是 Anthropic 提供的命令行工具，特点：
- 交互式会话（默认）或单次输出模式（`-p/--print`）
- 支持工具调用、多轮对话、会话恢复
- 简洁清晰的终端输出

---

## 输出模式

### 1. 交互式模式（默认）
```bash
claude
```

**特点：**
- 持续交互的 REPL 环境
- 实时流式输出
- 支持命令（/resume, /help 等）
- 会话自动保存

### 2. 打印模式（`-p`）
```bash
echo "What is 2+2?" | claude -p
```

**特点：**
- 单次问答，输出后退出
- 适合管道和脚本集成
- 无交互，无保存会话

### 3. 流式 JSON 模式
```bash
claude -p --output-format=stream-json
```

**特点：**
- 结构化事件流
- 适合程序化处理
- 包含工具调用、思考过程等元数据

---

## 交互式输出结构

### 基本对话流

```
┌─────────────────────────────────────────────┐
│ Claude (Opus 4.7)                          │
│ Session: abc123de                          │
│ /help for commands                         │
└─────────────────────────────────────────────┘

You: 帮我读取 package.json

● Assistant

  Let me read the package.json file.

  📖 Read package.json
     ✓ 45 lines · 1.2KB · 123ms

  This is a Node.js project with the following dependencies:
  - @anthropic-ai/sdk: ^0.20.0
  - ink: ^8.0.0
  ...

You: _
```

### 工具调用输出

**单个工具：**
```
📖 Read src/index.ts
   ✓ 234 lines · 8.9KB · 156ms
```

**多个工具（并行）：**
```
Running 3 tools...

📖 Read package.json
   ✓ 45 lines · 89ms

🔍 Grep "Agent" in src/
   ✓ 23 matches in 8 files · 234ms

⚙️  Bash: npm list
   ✓ completed · 567ms
```

**工具失败：**
```
📖 Read missing-file.ts
   ✗ Error: ENOENT: no such file or directory
```

### 状态指示

**思考中：**
```
⋯ Thinking...
```

**处理中：**
```
⚙️  Processing...
```

**流式文本：**
```
● Assistant

  Let me help you with that. First, I'll read the file
  to understand its structure...▌
```

### 系统消息

**会话信息：**
```
● Session restored: abc123de (15 messages)
```

**压缩历史：**
```
⚠️  Context limit approaching
   Compressing history...
   ✓ 45.2K → 12.8K tokens (saved 71%)
```

**错误：**
```
✗ Error: API request failed
  Rate limit exceeded. Please try again in 30s.
```

---

## 输出设计原则

### 1. 极简主义
- 默认输出尽可能简洁
- 避免不必要的装饰和噪音
- 关键信息突出，次要信息变暗

### 2. 渐进披露
```
📖 Read large-file.ts
   ✓ 2,340 lines · 89KB · 234ms
   
   [Press Enter to see excerpt]
```

### 3. 语义化图标
```
📖 Read      - 读文件
✏️  Edit      - 写/编辑文件
⚙️  Bash      - 执行命令
🔍 Grep      - 搜索
🌐 WebFetch  - 网络请求
❓ Ask       - 询问用户
✓ Success   - 成功
✗ Error     - 失败
⋯ Working   - 进行中
● Session   - 会话标记
⚠️  Warning  - 警告
```

### 4. 层次化信息
```
主操作（粗体、图标）
   └─ 结果摘要（缩进、次要色）
      └─ 详细信息（更深缩进、变暗）
```

---

## 颜色方案

Claude CLI 使用克制的颜色系统：

```
默认文本:  白色/默认终端色
用户输入:  蓝色 (#3B82F6)
Assistant: 绿色 (#10B981)
系统消息:  灰色 (#6B7280)
错误:      红色 (#EF4444)
警告:      黄色 (#F59E0B)
工具:      紫色 (#8B5CF6)
变暗文本:  dimColor (终端 dim 属性)
```

**特点：**
- 不会过度使用颜色
- 保持良好的可读性
- 支持浅色和深色终端

---

## 与你的项目对比

### 当前实现（plain-agent）

```
[10:23:45] ● USER
            帮我读取 package.json

[10:23:46] ● ASSISTANT
            让我读取文件

[10:23:46] ◈ TOOL
            🔧 readFile {"path":"package.json","limit":2000}
              ✅ {...长 JSON 内容...} 245ms

[10:23:47] ● ASSISTANT
            这是一个 Node.js 项目...
```

**问题：**
1. ✅ 时间戳占用太多空间（每行都有）
2. ⚠️  工具参数显示为 JSON（不直观）
3. ⚠️  工具结果直接输出全文（可能刷屏）
4. ⚠️  消息类型标签过于明显（USER, ASSISTANT, TOOL）
5. ✅ 整体信息密度偏高

### 改进方向

```
You: 帮我读取 package.json

● Assistant

  Let me read the file.
  
  📖 Read package.json
     ✓ 45 lines · 1.2KB · 245ms
  
  This is a Node.js project with these dependencies:
  - @anthropic-ai/sdk: ^0.20.0
  - ink: ^8.0.0
  ...

You: _
```

**改进点：**
1. 时间戳移除或仅在需要时显示（相对时间）
2. 工具调用语义化（显示文件路径而非 JSON）
3. 工具结果摘要化（行数、大小、耗时）
4. 简化角色标识（You / ● Assistant）
5. 降低整体视觉密度

---

## 关键输出组件

### 1. 用户输入显示
```
You: 你的问题或指令
```

简单直接，蓝色高亮。

### 2. Assistant 回复
```
● Assistant

  回复内容，可能包含多段...
  
  工具调用在这里插入
  
  继续回复...
```

绿色圆点标识，内容缩进。

### 3. 工具调用卡片
```
📖 Read src/agent.ts:1-50
   ✓ 50 lines · 2.3KB · 156ms
```

或失败时：
```
📖 Read missing.ts
   ✗ ENOENT: no such file or directory
```

### 4. 系统通知
```
● Session started (id: abc123de)
  Model: claude-opus-4-7
  Tools: 8 available
```

灰色，简洁，信息性。

### 5. 错误提示
```
✗ Tool execution failed

  Error: Cannot read file
  File: /path/to/file.ts
  
  Suggestion: Check if the file exists
```

红色，结构化，带建议。

---

## 特殊场景输出

### 会话恢复
```
● Resuming session abc123de

  Created: 2 hours ago
  Messages: 18 (12 user, 6 assistant)
  Last activity: 5 minutes ago
  
  [Replaying last 3 messages...]
```

### 交互提问（Ask tool）
```
● Assistant needs your input

  ? Which approach do you prefer?
  
  ○ Option 1: Use TypeScript
  ○ Option 2: Use JavaScript
  ○ Option 3: Use both
  
  (Use arrow keys to select, Enter to confirm)
```

### Token 使用提示
```
⚠️  Token usage: 145.2K / 200K (72.6%)
```

或达到阈值时：
```
⚠️  Context approaching limit
   Consider compressing history with /compress
```

### 后台会话
```bash
claude --bg "帮我分析这个项目"

● Background session started
  ID: a3f9c1
  
  Use `claude attach a3f9c1` to view progress
  Use `claude logs a3f9c1` to see output
  Use `claude stop a3f9c1` to stop
```

---

## 实施建议

### P0 - 立即改进
1. **简化角色标识**
   - `[10:23:45] ● USER` → `You:`
   - `[10:23:46] ● ASSISTANT` → `● Assistant`
   
2. **工具调用语义化**
   ```typescript
   // 从这个
   🔧 readFile {"path":"src/index.ts","limit":50}
   
   // 改为这个
   📖 Read src/index.ts:1-50
   ```

3. **结果摘要化**
   ```typescript
   // 从这个
   ✅ [2000 字符的文件内容] 245ms
   
   // 改为这个
   ✓ 50 lines · 2.3KB · 245ms
   ```

4. **移除或简化时间戳**
   - 默认不显示
   - 或只在间隔 >5min 的消息显示相对时间
   - 或用 `/timestamp on` 命令开启

### P1 - 短期优化
5. **批量工具调用分组**
   ```
   Running 3 tools...
   
   📖 Read package.json
      ✓ 45 lines · 89ms
   
   🔍 Grep "Agent"
      ✓ 23 matches · 234ms
   
   ⚙️  Bash: npm list
      ✓ completed · 567ms
   ```

6. **流式文本光标**
   - 流式输出时末尾显示 `▌` 光标
   - 完成后移除

7. **错误信息结构化**
   - 错误类型
   - 错误详情
   - 建议操作

### P2 - 长期增强
8. **交互式展开/折叠**
   - 长内容默认折叠，按键展开
   
9. **输出主题配置**
   - 图标集（emoji / ASCII）
   - 颜色方案（明/暗/高对比）
   
10. **日志级别**
    - `--verbose`: 显示所有细节
    - 默认: 平衡模式
    - `--quiet`: 仅显示关键信息

---

## 示例：完整交互流

```
┌─────────────────────────────────────────────┐
│ Claude (Opus 4.7)                          │
│ New session · 8 tools available            │
└─────────────────────────────────────────────┘

You: 分析 src/ 目录下的 TypeScript 文件结构

● Assistant

  I'll analyze the TypeScript files in the src/ directory.
  
  🔍 Find *.ts files in src/
     ✓ 23 files found · 89ms
  
  📖 Read src/index.ts
     ✓ 45 lines · 1.8KB · 67ms
  
  📖 Read src/agent.ts  
     ✓ 234 lines · 8.9KB · 123ms
  
  Found 3 main modules:
  
  1. **Core** (src/agent.ts, src/loop.ts)
     - Agent orchestration
     - Event loop management
     
  2. **Tools** (src/tools/*.ts)
     - 8 built-in tools
     - Extensible tool system
     
  3. **Storage** (src/storage/*.ts)
     - SQLite and memory backends
     - Session persistence
  
  The codebase follows a clean modular structure. Would you like
  me to dive deeper into any specific module?

You: 看看 agent.ts 的主要类

● Assistant

  📖 Read src/agent.ts
     ✓ 234 lines · 8.9KB · 98ms
  
  The main class is `PlainAgent`:
  
  ```typescript
  class PlainAgent extends EventEmitter {
    constructor(config: AgentConfig)
    submit(message: string): Promise<void>
    stop(): void
    getSessionId(): string
    // ... 15 more methods
  }
  ```
  
  Key responsibilities:
  - Message handling and streaming
  - Tool execution coordination  
  - History management
  - Event emission for UI integration

You: _
```

---

## 参考

- Claude CLI 是官方的终端工具
- 注重实用性和可读性
- 平衡信息量和视觉清晰度
- 支持多种输出模式（交互/打印/JSON）

**你的 plain-agent 项目可以借鉴：**
1. 简化的角色标识（You / ● Assistant）
2. 语义化的工具调用（图标 + 人类可读描述）
3. 摘要化的结果（行数、大小、耗时）
4. 克制的颜色使用
5. 清晰的视觉层级
