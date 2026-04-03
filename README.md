# Plain Agent

一个通用型 AI Agent 桌面助手，采用 Electron + React + TypeScript + SQLite 技术栈。

## 架构特点

- **独立 Agent Core**：纯业务逻辑，可运行在多种环境
- **适配器模式**：支持 Electron、HTTP Server、CLI 等多种运行模式
- **可插拔存储**：支持 SQLite、PostgreSQL、内存存储等
- **ReAct 范式**：LLM → tool call → tool result → LLM 闭环
- **事件驱动**：基于 EventEmitter 的实时事件流

## 项目结构

```
src/
├── agent-core/          # 核心业务逻辑（完全独立）
│   ├── types.ts        # 类型定义
│   ├── agent.ts        # Agent 主类
│   ├── llm.ts          # LLM 调用封装
│   ├── loop.ts         # ReAct 循环引擎
│   ├── tools/          # 工具系统
│   └── storage/        # 存储适配器
├── adapters/           # 适配层
│   ├── electron/       # Electron 适配器
│   ├── http/           # HTTP Server 适配器
│   └── cli/            # CLI 适配器
└── main.ts             # Electron 主进程入口
```

## 开发

```bash
# 安装依赖
npm install

# 测试 Agent Core
npm run dev:core

# 开发 Electron 应用
npm run dev:electron

# 构建
npm run build
```

## 技术栈

- **Electron** - 桌面应用框架
- **TypeScript** - 类型安全
- **SQLite** - 本地数据库
- **OpenAI SDK** - LLM 调用
- **Zod** - 运行时类型校验

## License

MIT
