# MCP (Model Context Protocol) 集成说明

## 概述

MCP 功能已成功集成到 plain-agent。现在可以通过配置文件连接 MCP 服务器，使用其提供的工具。

## 功能特性

- ✅ **连接池管理**：连接跨请求复用，引用计数 + 空闲回收
- ✅ **工具命名空间**：`mcp__<server>__<tool>` 格式，避免同名冲突
- ✅ **自动重连**：调用失败时自动重连一次
- ✅ **Resources/Prompts 支持**：自动注册 `mcp_resources`、`mcp_read_resource`、`mcp_prompts` 工具
- ✅ **Stdio 和 SSE 传输**：支持本地进程和远程 HTTP 服务器

## 配置文件

在项目根目录创建 `.plain-agent/mcp.yaml`：

```yaml
# Stdio 服务器示例
filesystem:
  type: stdio
  command: node
  args:
    - /path/to/mcp-server.js
  env:
    NODE_ENV: production

# SSE 服务器示例
remote-api:
  type: sse
  url: https://example.com/mcp
  headers:
    Authorization: Bearer your-token-here

# 禁用的服务器
disabled-server:
  type: stdio
  command: echo
  disabled: true
```

## 使用示例

```typescript
import { loadMcpTools, loadProjectMcp } from '@plain-agent/domain';

// 1. 从项目配置加载
const mcpConfig = loadProjectMcp(process.cwd());
const mcpManager = await loadMcpTools(mcpConfig);

// 2. 使用工具
const tools = [...builtinTools, ...mcpManager.tools];

// 3. Agent 运行后清理
await mcpManager.cleanup();
```

## API 文档

### `loadProjectMcp(projectRoot: string)`

从项目根目录加载 `.plain-agent/mcp.yaml` 配置。

### `loadMcpTools(config: Record<string, McpServerConfig>)`

加载 MCP 工具，返回 `McpManager`：

```typescript
interface McpManager {
  tools: Tool[];           // 加载的工具列表
  cleanup: () => Promise<void>;  // 释放连接引用
}
```

### 配置类型

```typescript
interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  enabled?: boolean;
}

interface SseServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  enabled?: boolean;
}
```

## 工具命名

MCP 工具使用命名空间防止冲突：

- 原始工具：`read_file`
- 注册后：`mcp__filesystem__read_file`

## 测试

运行测试验证功能：

```bash
pnpm --filter @plain-agent/domain test:mcp
```

## 连接池管理

连接自动复用和回收：

- 相同配置的连接跨请求复用
- 引用计数为 0 且空闲 5 分钟后自动关闭
- 失活连接自动重建

手动管理：

```typescript
import { closeIdleConnections, resetPool, poolStats } from '@plain-agent/domain';

// 查看池状态
const stats = poolStats();
console.log(`连接数: ${stats.size}`);

// 立即关闭空闲连接
closeIdleConnections(0);

// 清空整个池（测试用）
await resetPool();
```

## 实现完成

所有核心功能已实现：

- [x] MCP 连接类
- [x] 连接池管理
- [x] 工具加载和命名空间
- [x] Resources/Prompts 支持
- [x] 自动重连机制
- [x] 类型定义适配
- [x] 测试用例
- [x] 导出到主模块

## 注意事项

1. **配置文件路径**：`.plain-agent/mcp.yaml`
2. **Tool 接口**：已适配 plain-agent 的 Tool 类型
3. **依赖安装**：已添加 `@modelcontextprotocol/sdk` 和 `js-yaml`
