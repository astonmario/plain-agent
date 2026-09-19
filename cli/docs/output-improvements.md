# 输出改进说明

参照 Claude CLI 的输出风格，对 plain-agent TUI 进行了以下改进：

## 改进内容

### 1. 简化角色标识

**之前：**
```
[10:23:45] ● USER
            你的消息

[10:23:46] ● ASSISTANT  
            回复内容
```

**之后：**
```
You: 你的消息

● Assistant

回复内容
```

**改进点：**
- 移除了时间戳（减少视觉噪音）
- 简化角色标签（`You:` 和 `● Assistant`）
- 减少缩进层级

### 2. 工具调用结构化显示

**之前：**
```
[10:23:46] ◈ TOOL
            🔧 readFile {"path":"src/index.ts","limit":50}
              ✅ [2000字符的文件内容...] 245ms
```

**之后：**
```
  📖 Read src/index.ts:1-50
     ✓ 50 lines · 2.3KB · 245ms
```

**改进点：**
- 语义化参数显示（文件路径 + 行范围）
- 结果摘要化（行数、大小、耗时）
- 更清晰的图标和颜色
- 紧凑的布局

### 3. 工具类型图标

| 工具 | 图标 | 标签 | 颜色 |
|------|------|------|------|
| readFile | 📖 | Read | 蓝色 |
| writeFile | ✏️ | Write | 黄色 |
| bash | ⚙️ | Bash | 紫色 |
| webSearch | 🔍 | Search | 绿色 |
| webFetch | 🌐 | Fetch | 青色 |
| askQuestion | ❓ | Ask | 粉色 |
| browserUse | 🌐 | Browser | 青色 |
| useSkill | ⚡ | Skill | 紫色 |

### 4. 消息类型优化

**系统消息：**
```
● 新会话 abc123de · claude-opus-4-7 · 8 个工具
项目: d:\code\plain-agent
```

**思考过程：**
```
◆ Thinking

思考内容...
```

**错误提示：**
```
✗ ERROR

错误信息...
```

## 文件修改清单

1. **cli/src/components/MessageList.tsx**
   - 移除时间戳显示
   - 简化角色标签
   - 工具消息改为不在此显示（由 ToolCallDisplay 接管）
   - 优化缩进和布局

2. **cli/src/types.ts**
   - 新增 `ToolCall` 接口
   - 新增 `ToolCallStatus` 类型

3. **cli/src/components/App.tsx**
   - 导入 `ToolCallDisplay` 组件
   - 将工具调用从文本缓冲改为结构化对象
   - 在 `tool_start` 事件时创建工具调用对象
   - 在 `tool_result` 事件时更新状态
   - 渲染工具调用列表

4. **cli/src/components/ToolCallDisplay.tsx**（新增）
   - 工具元数据配置（图标、标签、颜色）
   - 参数格式化函数
   - 结果摘要函数
   - 显示组件

## 效果对比

### 完整对话示例

**改进前：**
```
[10:23:45] ● USER
            分析 src/ 目录下的 TypeScript 文件

[10:23:46] ● ASSISTANT
            让我分析一下

[10:23:46] ◈ TOOL
            🔧 bash {"command":"find src -name '*.ts'"}
              ✅ src/index.ts\nsrc/agent.ts\n... 89ms

[10:23:47] ◈ TOOL
            🔧 readFile {"path":"src/agent.ts","limit":2000}
              ✅ [长文件内容...] 123ms

[10:23:48] ● ASSISTANT
            找到了 3 个主要模块...
```

**改进后：**
```
You: 分析 src/ 目录下的 TypeScript 文件

● Assistant

Let me analyze the TypeScript files.

  ⚙️  Bash: find src -name '*.ts'
     ✓ 3 lines · 89ms

  📖 Read src/agent.ts:1-100
     ✓ 234 lines · 8.9KB · 123ms

Found 3 main modules:
- Core (agent.ts, loop.ts)
- Tools (tools/*.ts)
- Storage (storage/*.ts)
```

## 未来改进方向

### P1 - 短期
- [ ] 相对时间戳（可选显示，如 "2m ago"）
- [ ] 工具批量分组（同一迭代的工具统一显示）
- [ ] 流式文本光标（`▌`）

### P2 - 中期
- [ ] 长输出交互式展开/折叠
- [ ] 错误信息结构化显示（类型、详情、建议）
- [ ] Token 使用可视化进度条

### P3 - 长期
- [ ] 主题配置（颜色方案、图标集）
- [ ] 输出日志级别（verbose/normal/quiet）
- [ ] 历史消息搜索
- [ ] 导出会话为 Markdown

## 参考

- [claude-cli-output-reference.md](./claude-cli-output-reference.md) - Claude CLI 完整输出格式参考
- [output-design.md](./output-design.md) - 输出设计原则和模式
