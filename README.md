# Plain Agent

一个通用型 AI Agent，采用**完全独立的 Agent Core + 适配器模式**架构。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ✨ 特性

- 🎯 **完全独立的 Agent Core**：纯业务逻辑，不依赖任何运行环境
- 🔌 **适配器模式**：支持 CLI、HTTP Server、Electron 等多种运行模式
- 💾 **可插拔存储**：SQLite、内存存储等（依赖倒置）
- 🔄 **ReAct 范式**：LLM → tool call → tool result → LLM 闭环
- 📡 **事件驱动**：基于 EventEmitter 的实时事件流
- 🛠️ **内置工具**：文件读写、命令执行、HTTP 请求、计算器等
- 🔒 **权限管理**：危险操作检测和权限控制

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
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
npm run cli
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
npm run dev:core
```

## 📦 项目结构

```
plain-agent/
├── src/
│   ├── agent-core/              # 核心业务逻辑（完全独立）
│   │   ├── types.ts            # 类型定义
│   │   ├── agent.ts            # Agent 主类（EventEmitter）
│   │   ├── llm.ts              # LLM 调用封装（OpenAI 兼容）
│   │   ├── loop.ts             # ReAct 循环引擎
│   │   ├── tools/              # 工具系统
│   │   │   ├── file.ts        # 文件读写工具
│   │   │   ├── bash.ts        # 命令执行工具
│   │   │   └── index.ts       # 工具注册表
│   │   └── storage/            # 存储适配器
│   │       ├── memory.ts      # 内存存储
│   │       ├── sqlite.ts      # SQLite 存储
│   │       └── index.ts       # 统一接口
│   ├── adapters/               # 适配层
│   │   └── cli/               # CLI 适配器 ✅
│   │       └── index.ts
│   └── cli.ts                  # CLI 入口
├── .env                        # 环境配置
├── package.json
└── README.md
```

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
| `bash` | 执行 shell 命令 | ⚠️ 是 |

## 📝 使用示例

### 作为 npm 包使用

```typescript
import { PlainAgent, MemoryStorage, getBuiltinTools } from './agent-core';

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
});

// 监听事件
agent.on('event', (event) => {
  console.log(event);
});

// 提交任务
const result = await agent.submit('读取 package.json');
console.log(result);

// 清理
agent.destroy();
```

## 🗺️ Roadmap

- [x] **M1-M2**: 项目初始化、类型系统、LLM 调用、存储层
- [x] **M3**: Agent Core（ReAct 循环、工具系统）
- [x] **M4**: CLI Adapter
- [ ] **M5**: HTTP Server Adapter
- [ ] **M6**: Electron Adapter + React UI
- [ ] **M7**: 更多工具（搜索、网络请求等）
- [ ] **M8**: 上下文压缩、长期记忆
- [ ] **M9**: 多 Agent 协作

## 🧪 开发

```bash
# 类型检查
npm run typecheck

# 测试 Agent Core
npm run dev:core

# 运行 CLI
npm run cli
```

## 📄 License

MIT

---

