# 架构重构完成总结

## 🎯 目标

将桌面端和 Web 端的 UI 代码抽离到共享的 `web` 包，实现代码复用。

---

## 📦 新增的 web 包

### 目录结构

```
web/
├── package.json
├── tsconfig.json
└── src/
    ├── index.tsx              # 导出入口
    ├── api-client.ts          # AgentClient 接口定义
    ├── desktop-client.ts      # 桌面端实现（Electron IPC）
    ├── web-client.ts          # Web 端实现（HTTP + SSE）
    ├── App.tsx                # 主界面组件（共享）
    └── McpConfig.tsx          # MCP 配置组件（共享）
```

---

## 🔧 核心改动

### 1. 抽象 API 层（api-client.ts）

定义了统一的 `AgentClient` 接口，包含：

- **会话管理**：createSession、listSessions、renameSession、deleteSession
- **任务执行**：submitTask、stopTask、compactHistory、answerInteraction
- **配置管理**：getSettings、updateSettings、getConfig、getHistoryUsage
- **技能管理**：listSkills、getSkill、saveSkill、deleteSkill
- **MCP 配置**：getMcpConfig、saveMcpConfig、reloadMcp
- **事件订阅**：onEvent（桌面端特有）

**可选方法**（用 `?` 标记）：
- 桌面端特有：`switchSession`、`getSessionId`、`getConfig`、`getHistoryUsage`、`onEvent`、`readSkill`
- MCP 特有：`getMcpToolCount`、`getMcpTools`、`reloadMcp`

---

### 2. 桌面端客户端（desktop-client.ts）

**DesktopClient** 实现了 `AgentClient` 接口，将 `window.desktopAPI` 的 IPC 调用包装成统一接口。

**关键点**：
- `submitTask` 返回模拟的 EventSource（桌面端用 IPC 事件，不是真正的 SSE）
- `getMessages` 会自动切换到目标会话
- 实现了所有可选的桌面端特有方法

---

### 3. Web 端客户端（web-client.ts）

**WebClient** 实现了 `AgentClient` 接口，通过 HTTP + SSE 与服务端通信。

**关键点**：
- `submitTask` 返回真正的 EventSource（SSE 流）
- `reconnect` 支持断线续传（`since` 参数）
- 部分接口需要服务端后续添加（如 `/api/settings`、`/api/skills`）

---

### 4. 共享 UI 组件

#### App.tsx
- 接受 `client: AgentClient` 作为 prop（依赖注入）
- 所有 `window.api.*` 调用改为 `client.*`
- 类型引用从 `api-client.ts` 导入（`AppConfig`、`HistoryUsage`）

#### McpConfig.tsx
- 接受 `client: AgentClient` 作为 prop
- 所有 `window.api.*` 调用改为 `client.*`

---

### 5. 桌面端集成

#### package.json
```json
{
  "dependencies": {
    "@plain-agent/domain": "workspace:*",
    "@plain-agent/web": "workspace:*",  // 新增
    ...
  }
}
```

#### main.tsx
```typescript
import { App, DesktopClient } from '@plain-agent/web';

const client = new DesktopClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App client={client} />
  </React.StrictMode>
);
```

---

## 📊 代码复用率

| 层级 | 桌面端 | Web 端 | 复用率 |
|------|--------|--------|--------|
| **UI 组件** | App.tsx (1310 行) + McpConfig.tsx (350 行) | 完全共享 | **100%** |
| **状态管理** | useState、useEffect、useCallback | 完全共享 | **100%** |
| **类型定义** | @plain-agent/domain/types | 完全共享 | **100%** |
| **API 调用** | DesktopClient (200 行) | WebClient (180 行) | **仅接口不同** |

**总计**：~1660 行 UI 代码完全共享，仅 ~380 行 API 适配层需要分别实现。

---

## 🚀 未来扩展：纯 Web 应用

### 目录结构（待创建）

```
web-app/              # 纯 Web 应用（Vite 项目）
├── index.html
├── package.json
├── vite.config.ts
└── src/
    └── main.tsx      # 入口文件
```

### web-app/src/main.tsx

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, WebClient } from '@plain-agent/web';
import './styles.css';

const client = new WebClient('http://localhost:3000'); // 连接到 server

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App client={client} />
  </React.StrictMode>
);
```

---

## ✅ 完成的工作

- [x] 创建 `web` 包目录结构
- [x] 定义 `AgentClient` 统一接口
- [x] 实现 `DesktopClient`（Electron IPC）
- [x] 实现 `WebClient`（HTTP + SSE）
- [x] 抽离 `App.tsx` 到 web 包，注入 client
- [x] 抽离 `McpConfig.tsx` 到 web 包，注入 client
- [x] 更新桌面端 `main.tsx` 使用共享组件
- [x] 更新 `pnpm-workspace.yaml` 添加 web 包
- [x] 更新桌面端 `package.json` 添加 web 包依赖

---

## 🔄 下一步

### 1. 安装依赖并测试

```bash
cd d:/code/plain-agent
pnpm install
cd desktop
pnpm dev  # 测试桌面端是否正常工作
```

### 2. 创建独立的 Web 应用（可选）

```bash
cd d:/code/plain-agent
mkdir web-app
cd web-app
pnpm init
# 配置 Vite + React
# 引用 @plain-agent/web
```

### 3. 补全服务端 API（Web 端需要）

服务端需要添加以下接口（当前缺失）：
- `GET /api/settings` - 获取设置
- `PATCH /api/settings` - 更新设置
- `GET /api/skills` - 列出技能
- `GET /api/skills/:name` - 获取技能详情
- `PUT /api/skills/:name` - 保存技能
- `DELETE /api/skills/:name` - 删除技能

---

## 🎉 架构优势

1. **高复用**：1660 行 UI 代码 100% 共享
2. **类型安全**：统一的 `AgentClient` 接口，编译期检查
3. **解耦清晰**：UI 层与 API 层完全分离
4. **易于测试**：可以 mock `AgentClient` 做单元测试
5. **独立迭代**：桌面端和 Web 端可以独立发布
6. **扩展友好**：未来可以轻松添加移动端、CLI 界面等

---

## 📝 注意事项

1. **EventSource 兼容性**：桌面端用 `EventTarget` 模拟 `EventSource`，行为略有差异
2. **会话管理**：桌面端是单会话模式（需要 `switchSession`），Web 端是多会话模式
3. **文件系统**：桌面端可直接访问本地文件，Web 端需通过服务端 API
4. **MCP 配置**：桌面端存在本地（`~/.plain-agent/mcp.json`），Web 端需存在服务端

---

架构重构已完成！现在桌面端和 Web 端可以共用一套 UI 代码。
