# Plain Agent

一个通用型 AI Agent，采用**完全独立的 Agent Core + 适配器模式**架构。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange)](https://pnpm.io/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ✨ 特性

- 🎯 **完全独立的 Agent Core**：纯业务逻辑，不依赖任何运行环境
- 🔌 **适配器模式**：支持 CLI、HTTP Server、Electron 等多种运行模式
- 💾 **可插拔存储**：SQLite、内存存储等（依赖倒置）
- 🔄 **ReAct 范式**：LLM → tool call → tool result → LLM 闭环
- 📡 **事件驱动**：基于 EventEmitter 的实时事件流
- 🛠️ **内置工具**：文件读写、命令执行、HTTP 请求、计算器等
- 🔒 **权限管理**：危险操作检测和权限控制
- 🤖 **子 Agent 协作**：任务委派、并发执行、递归子任务（实验性）

## 🚀 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入配置：

```bash
BASE_URL=https://api.deepseek.com
API_KEY=your-api-key-here
MODEL=deepseek-chat
```

### 3. 运行

#### CLI 模式（交互式命令行）

```bash
pnpm cli
```

**使用示例**：
```
💬 你: 读取当前目录的 package.json 文件
🔧 调用工具: read_file({"path":"package.json"})
✅ 结果: {...}
🤖 Agent: 项目名称是 plain-agent，版本是 0.1.0
```

**CLI 命令**：
- `help` - 显示帮助
- `session` - 显示会话信息
- `clear` - 清屏
- `exit` / `quit` - 退出
- `Ctrl+C` - 停止当前任务

#### 测试模式

```bash
pnpm dev:core
```

#### HTTP Server 模式

```bash
pnpm server
```

#### 桌面端模式（Electron + React）

```bash
pnpm dev:desktop
```

## 📦 项目结构（pnpm monorepo）

```
plain-agent/
├── domain/                    # @plain-agent/domain —— 框架无关的 Agent 核心
│   ├── src/
│   │   ├── types.ts          # 类型定义
│   │   ├── agent.ts          # Agent 主类（EventEmitter）
│   │   ├── llm.ts            # LLM 调用封装（OpenAI 兼容）
│   │   ├── loop.ts           # ReAct 循环引擎
│   │   ├── history-manager.ts # 三层上下文压缩
│   │   ├── anchor.ts         # Anchor 结构化状态
│   │   ├── cliExample.ts     # 核心功能演示脚本
│   │   ├── tools/            # 工具系统（文件/命令/搜索/网络等）
│   │   └── storage/          # 存储适配器（内存 / SQLite）
│   └── test/                 # 核心测试脚本（tsx 直接运行）
├── cli/                       # @plain-agent/cli —— 命令行客户端
│   └── src/index.ts
├── server/                    # @plain-agent/server —— HTTP 服务（Hono + SSE）
│   └── src/index.ts
├── desktop/                   # @plain-agent/desktop —— Electron + React 桌面端
│   └── src/
│       ├── main/             # 主进程（窗口、IPC、Agent 服务）
│       ├── preload/          # 预加载脚本（contextBridge）
│       ├── renderer/         # React UI
│       └── shared/           # IPC 共享类型
├── docs/                      # 设计文档
├── pnpm-workspace.yaml
└── package.json               # root：脚本编排 + 公共 devDependencies
```

各包通过 `workspace:*` 互相引用；`domain` 直接以 TS 源码导出（无构建步骤），
tsx / esbuild / electron-vite 均可直接消费。

## 🏗️ 架构设计

### 核心理念：完全独立 + 适配器模式

```
┌─────────────────────────────────────┐
│       Adapters (适配层)              │
│  ┌─────────┐ ┌─────────┐ ┌────────┐│
│  │   CLI   │ │  HTTP   │ │Electron││
│  └────┬────┘ └────┬────┘ └───┬────┘│
└───────┼──────────┼──────────┼──────┘
        │          │          │
        └──────────┼──────────┘
                   │
┌──────────────────┴──────────────────┐
│     Agent Core (完全独立)            │
│  ┌────────────────────────────┐    │
│  │ PlainAgent (EventEmitter)  │    │
│  │ - submit(task)             │    │
│  │ - stop()                   │    │
│  │ - on('event', handler)     │    │
│  └────────────────────────────┘    │
│  ┌────────────────────────────┐    │
│  │ ReAct Loop Engine          │    │
│  │ LLM → tool → result → LLM  │    │
│  └────────────────────────────┘    │
│  ┌────────────────────────────┐    │
│  │ Tools (read/write/bash)    │    │
│  └────────────────────────────┘    │
└─────────────────────────────────────┘
                   │
┌──────────────────┴──────────────────┐
│     Storage (可插拔)                 │
│  ┌──────────┐  ┌──────────┐        │
│  │  Memory  │  │  SQLite  │        │
│  └──────────┘  └──────────┘        │
└─────────────────────────────────────┘
```

### Agent Core 特点

- ✅ **零依赖环境**：不依赖 Electron、HTTP、任何特定框架
- ✅ **纯 TypeScript**：类型安全，易于测试
- ✅ **事件驱动**：基于 Node.js EventEmitter
- ✅ **依赖倒置**：通过接口注入依赖（Storage、ToolContext）
- ✅ **可中断**：全流程支持 AbortSignal

## 🛠️ 内置工具

| 工具 | 功能 | 危险 |
|------|------|------|
| `read_file` | 读取文件内容 | ❌ |
| `write_file` | 写入文件内容 | ⚠️ 是 |
| `edit_file` | 编辑文件内容 | ⚠️ 是 |
| `bash` | 执行 shell 命令（支持后台任务） | ⚠️ 是 |
| `glob` | 文件名模式匹配搜索 | ❌ |
| `grep` | 文件内容搜索 | ❌ |
| `explore` | 探索目录结构 | ❌ |
| `list_directory` | 列出目录内容 | ❌ |
| `http_get` | 发送 HTTP GET 请求 | ❌ |
| `calculator` | 数学计算 | ❌ |
| `datetime` | 获取当前时间 | ❌ |
| `job_output` / `job_kill` | 查看 / 终止后台任务 | ❌ |
| `update_memory` | 更新 Agent 记忆 | ❌ |
| `lookup_history` / `search_history` | 历史消息追溯与搜索 | ❌ |
| `spawn_subagent` | 创建子 Agent 执行子任务 | ❌ |
| `wait_subagent` | 等待子任务完成 | ❌ |
| `cancel_subagent` | 取消子任务 | ❌ |
| `get_subagent_status` | 查询子任务状态 | ❌ |

## 📝 使用示例

### 作为 npm 包使用

```typescript
import { PlainAgent, MemoryStorage, getBuiltinTools } from '@plain-agent/domain';

const agent = new PlainAgent({
  llm: {
    provider: 'openai',
    apiKey: process.env.API_KEY!,
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
  },
  tools: getBuiltinTools(),
  storage: new MemoryStorage(),
  permissionMode: 'trust',
  // 启用子 Agent 功能（可选）
  enableSubagents: true,
  subagentConfig: {
    maxConcurrency: 5,
    maxDepth: 3,
  },
});

// 监听事件
agent.on('event', (event) => {
  console.log(event);
});

// 提交任务
const result = await agent.submit('读取 package.json');
console.log(result);

// 使用子 Agent（如果启用）
const result2 = await agent.submit(`
  创建一个子任务来分析项目结构：
  - 使用 spawn_subagent 工具
  - 限制只能使用只读工具
  - 等待完成后返回结果
`);

// 清理
agent.destroy();
```

## 🗺️ Roadmap

- [x] **M1-M2**: 项目初始化、类型系统、LLM 调用、存储层
- [x] **M3**: Agent Core（ReAct 循环、工具系统）
- [x] **M4**: CLI Adapter
- [x] **M5**: HTTP Server Adapter（Hono + SSE）
- [x] **M6**: Electron 桌面端 + React UI
- [x] **M7**: 更多工具（搜索 glob/grep、网络请求、后台任务等）
- [x] **M8**: 上下文压缩（三层压缩 + Anchor + 智能触发）
- [ ] **M9**: 多 Agent 协作
  - [x] 子 Agent 基础架构（SubagentRuntime）
  - [x] 子任务工具（spawn/wait/cancel/status）
  - [x] 独立状态隔离
  - [x] 工具白名单和权限控制
  - [x] 并发控制和递归深度限制
  - [ ] 高级上下文管理（智能摘要）
  - [ ] 任务持久化（SQLite）
  - [ ] 调度器（串行/并行/DAG）

## 🧪 开发

```bash
# 安装依赖
pnpm install

# 全部包类型检查
pnpm typecheck

# 测试 Agent Core
pnpm dev:core

# 运行 CLI
pnpm cli

# 启动 HTTP 服务
pnpm server

# 启动桌面端
pnpm dev:desktop
```

## 📄 License

MIT

---

