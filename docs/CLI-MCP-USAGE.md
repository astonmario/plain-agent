# CLI MCP 使用指南

## 快速开始

### 1. 创建 MCP 配置

在项目根目录创建 `.plain-agent/mcp.yaml`：

```yaml
# 示例：文件系统 MCP 服务器
filesystem:
  type: stdio
  command: npx
  args:
    - -y
    - @modelcontextprotocol/server-filesystem
    - /path/to/allowed/directory
```

### 2. 启动 CLI

```bash
pnpm cli
```

CLI 会自动：
- ✅ 加载 `.plain-agent/mcp.yaml` 配置
- ✅ 连接 MCP 服务器
- ✅ 将 MCP 工具添加到可用工具列表
- ✅ 在退出时清理连接

### 3. 使用 MCP 工具

MCP 工具会自动添加到 Agent 的工具列表中，使用命名空间格式：

```
mcp__<server-name>__<tool-name>
```

例如：
- `mcp__filesystem__read_file`
- `mcp__filesystem__write_file`
- `mcp__filesystem__list_directory`

## 常见 MCP 服务器示例

### 文件系统服务器

```yaml
filesystem:
  type: stdio
  command: npx
  args:
    - -y
    - @modelcontextprotocol/server-filesystem
    - /Users/username/projects
```

### GitHub 服务器

```yaml
github:
  type: stdio
  command: npx
  args:
    - -y
    - @modelcontextprotocol/server-github
  env:
    GITHUB_TOKEN: your-github-token
```

### SQLite 服务器

```yaml
sqlite:
  type: stdio
  command: npx
  args:
    - -y
    - @modelcontextprotocol/server-sqlite
    - /path/to/database.db
```

### 远程 SSE 服务器

```yaml
remote-api:
  type: sse
  url: https://example.com/mcp
  headers:
    Authorization: Bearer your-token
```

## 配置选项

### 禁用服务器

```yaml
my-server:
  type: stdio
  command: node
  args: [server.js]
  disabled: true  # 或 enabled: false
```

### 环境变量

```yaml
my-server:
  type: stdio
  command: node
  args: [server.js]
  env:
    API_KEY: your-key
    DEBUG: "true"
```

## 启动日志

成功加载 MCP 时，CLI 会显示：

```
🔌 加载 MCP 服务器...
✅ 已加载 15 个 MCP 工具
```

如果加载失败，会显示警告但不会阻止 CLI 启动：

```
⚠️  MCP 加载失败: Connection failed
```

## 调试

### 查看可用工具

启动 CLI 后，可以看到工具总数（包括内置工具 + MCP 工具）。

### 检查配置

确保 `.plain-agent/mcp.yaml` 文件存在且格式正确：

```bash
cat .plain-agent/mcp.yaml
```

### 测试 MCP 服务器

可以单独测试 MCP 服务器是否工作：

```bash
npx -y @modelcontextprotocol/server-filesystem /tmp
```

## 注意事项

1. **MCP 工具在所有会话间共享**
   - 启动时加载一次
   - 所有 agent 实例使用相同的 MCP 工具集

2. **自动清理**
   - 正常退出（Ctrl+C）会自动清理连接
   - 异常退出可能导致连接未释放

3. **配置热重载**
   - 修改 `mcp.yaml` 后需要重启 CLI

4. **权限模式**
   - 默认使用 `trust` 模式
   - 可通过 `.env` 设置：`PERMISSION_MODE=ask`

## 实现细节

### 代码位置

- **MCP 核心**: `domain/src/mcp.ts`
- **CLI 集成**: `cli/src/cli.tsx`
- **类型定义**: `domain/src/types.ts`

### 集成方式

```typescript
// 1. 启动时加载
const mcpConfig = loadProjectMcp(process.cwd());
const mcpManager = await loadMcpTools(mcpConfig);

// 2. 合并工具
tools: [...getBuiltinTools(), ...mcpManager.tools]

// 3. 退出时清理
await mcpManager.cleanup();
```

### 工具数量统计

启动信息中的 `toolCount` 包括：
- 内置工具（文件、Bash、Web 等）
- MCP 工具

## 下一步

- [ ] Desktop 集成 MCP
- [ ] MCP 配置 UI
- [ ] 常用 MCP 服务器预设
- [ ] MCP 工具使用统计
