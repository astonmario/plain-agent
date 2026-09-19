# Claude Code 输出设计参考

## 核心设计原则

### 1. 渐进式信息披露（Progressive Disclosure）
- **默认视图**：简洁摘要，只显示关键信息
- **详细视图**：用户需要时展开查看完整内容
- **智能截断**：长文本自动截断，避免刷屏

### 2. 视觉层级（Visual Hierarchy）
```
主要动作（粗体、图标、颜色）
  └─ 次要信息（缩进、较小字号、变暗）
     └─ 辅助信息（时间、字节数、行数）
```

### 3. 语义化颜色系统
```
🔵 蓝色 - 信息/读操作      #3B82F6
🟢 绿色 - 成功/完成        #10B981
🟡 黄色 - 警告/写操作      #F59E0B
🔴 红色 - 错误/失败        #EF4444
🟣 紫色 - 执行/工具        #8B5CF6
⚪ 灰色 - 系统/元信息      #6B7280
```

### 4. 信息密度平衡
- 避免信息过载：一屏最多 3-5 个关键信息点
- 避免信息匮乏：关键状态必须可见
- 使用空白分隔逻辑块

---

## Claude Code 输出示例分析

### 工具调用显示

**简洁模式（默认）：**
```
📖 Read src/index.ts:1-50
   156ms · 2.3KB
   
✏️  Edit src/types.ts
   Replace 3 lines at :42-44
   ✓ Applied · 89ms
   
⚙️  Bash: npm test
   ✓ 12 passed · 1.2s
```

**详细模式（展开）：**
```
📖 Read src/index.ts:1-50
   Duration: 156ms
   Size: 2.3KB (2,347 bytes)
   
   ┌─ Content ──────────────────────
   │ 1  import { Agent } from './agent';
   │ 2  import { Loop } from './loop';
   │ ...
   └────────────────────────────────
```

### 多工具并行调用

```
Processing 3 tasks...

├─ 📖 Read package.json
│  ✓ 45 lines · 89ms
│
├─ 🔍 Search "Agent"
│  ✓ 23 matches in 8 files · 234ms
│
└─ 🌐 Fetch https://api.example.com
   ✓ 200 OK · 1.2KB · 567ms
```

### 迭代过程显示

```
Iteration 1
├─ 🤔 Thinking... (2.3s)
├─ 📖 Read src/agent.ts
│  ✓ 234 lines · 123ms
└─ ✏️  Edit src/agent.ts
   ✓ Modified 5 lines · 67ms

Iteration 2
├─ 🤔 Thinking... (1.8s)
└─ ⚙️  Bash: npm test
   ✗ 2 tests failed
   
   Test "agent.submit" failed:
   Expected 200, got 404
```

### 上下文信息显示

```
┌─ Session Info ─────────────────────┐
│ Model: claude-opus-4-7            │
│ Tokens: 12,450 / 200,000 (6.2%)  │
│ Tools: 8 available                │
│ History: 15 messages              │
└────────────────────────────────────┘
```

---

## 对比：当前实现 vs Claude Code

### 当前实现
```
🔧 readFile {"path":"src/index.ts","limit":50}
  ✅ [长文本内容直接输出...] 245ms
```

**问题：**
- 参数 JSON 不易读
- 结果直接输出导致刷屏
- 缺少信息摘要（文件大小、行数）
- 缺少视觉分组

### Claude Code 风格
```
📖 Read src/index.ts:1-50
   50 lines · 2.3KB · 245ms
   [Press Enter to expand]
```

**优点：**
- 参数语义化（文件路径 + 行范围）
- 结果摘要化（行数、大小、耗时）
- 可按需展开查看详情
- 视觉清晰，易扫描

---

## 改进方案

### 1. 工具调用重构

**新增数据结构：**
```typescript
interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;      // 人类可读描述
  result?: string;
  resultSummary?: string;   // 结果摘要
  duration?: number;
  status: 'running' | 'success' | 'error';
  expanded?: boolean;       // 是否展开详情
}
```

**工具元信息配置：**
```typescript
const TOOL_META = {
  readFile: {
    icon: '📖',
    label: 'Read',
    color: '#3B82F6',
    formatArgs: (args) => `${args.path}:${args.offset || 1}-${(args.offset || 0) + (args.limit || 50)}`,
    formatResult: (result) => `${result.split('\n').length} lines · ${formatBytes(result.length)}`,
  },
  writeFile: {
    icon: '✏️',
    label: 'Write',
    color: '#F59E0B',
    formatArgs: (args) => args.path,
    formatResult: (result) => `${formatBytes(result.length)} written`,
  },
  // ...
};
```

### 2. 消息类型分层

**一级消息（粗体、图标、高亮）：**
- 用户输入
- Assistant 回复
- 错误/警告

**二级消息（缩进、变暗）：**
- 工具调用
- 思考过程
- 系统通知

**三级消息（进一步缩进、更暗）：**
- 工具参数
- 工具结果摘要
- 耗时统计

### 3. 状态指示器改进

**当前：**
```
处理中…（图标旋转）
```

**改进为：**
```
⚙️  Processing iteration 2/5
    📖 Reading files... (0.3s)
    Tokens: 12.5K / 200K (6.2%)
```

### 4. 交互式展开（可选）

对于长输出，支持键盘交互：
```
📖 Read src/agent.ts
   234 lines · 8.9KB · 123ms
   ▼ Press ↓ to expand, ↑ to collapse
```

展开后：
```
📖 Read src/agent.ts
   234 lines · 8.9KB · 123ms
   ▲ Press ↑ to collapse
   
   ┌─ Content ────────────────────────
   │  1  import { Agent } from './types';
   │  2  import { Loop } from './loop';
   │  ...
   │ 234  export default Agent;
   └──────────────────────────────────
```

---

## 实施优先级

### P0 - 立即改进（观感提升明显）
1. ✅ 工具调用图标和语义化描述
2. ✅ 结果摘要而非全文输出
3. ✅ 统一的颜色系统
4. ✅ 层级缩进和视觉分组

### P1 - 短期改进（功能完善）
5. 工具调用批量分组显示
6. 状态指示器增强（token 计数、迭代进度）
7. 时间戳改为相对时间（"2s ago"）
8. 错误堆栈折叠显示

### P2 - 长期改进（高级特性）
9. 交互式展开/折叠
10. 搜索历史消息
11. 导出会话为 Markdown
12. 主题配置（颜色自定义）

---

## 参考实现

已创建组件：
- `cli/src/components/ToolCallDisplay.tsx` - 工具调用显示组件

下一步：
1. 在 `App.tsx` 中集成 `ToolCallDisplay`
2. 修改事件处理逻辑，累积工具调用对象而非文本
3. 为每个内置工具添加 `formatArgs` 和 `formatResult`
4. 优化 `MessageList.tsx` 的层级样式

---

## 附：Claude Code 其他细节

### Token 使用可视化
```
Tokens: ████████░░░░░░░░░░░░ 45.2K / 200K (22.6%)
        ↑ cached: 38K
```

### 压缩历史通知
```
⚠️  Context approaching limit
   Compressing 15 messages... ✓
   Before: 45.2K tokens
   After:  12.8K tokens (71.7% saved)
```

### 错误显示优化
```
❌ Tool execution failed: readFile

   Error: ENOENT: no such file or directory
   File: /path/to/missing/file.ts
   
   Suggestion: Check if the file path is correct
```

### 会话恢复
```
📂 Resuming session abc123de
   ├─ Model: claude-opus-4-7
   ├─ Created: 2 hours ago
   ├─ Messages: 18 (12 user, 6 assistant)
   └─ Last activity: 5 minutes ago
   
   [Showing last 3 messages...]
```
