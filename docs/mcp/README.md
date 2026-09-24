# MCP (Model Context Protocol) 文档

## 📚 用户文档

### [MCP 集成指南](./MCP-INTEGRATION.md)
MCP 核心实现的完整技术文档
- API 参考
- 配置说明  
- 连接池管理
- 高级用法

### [CLI MCP 使用指南](./CLI-MCP-USAGE.md)
CLI 端使用 MCP 的详细说明
- 快速开始
- 配置文件格式
- 常见 MCP 服务器示例
- 调试技巧

### [Desktop MCP 集成](./desktop-integration.md)
Desktop 客户端 MCP 功能说明
- 主进程集成
- 可视化配置页面
- IPC 通信接口
- 使用方式

### [全局代理支持](./proxy-support.md)
解决 web 工具和 MCP 被墙问题
- 问题分析
- 实现方案
- 使用方式
- 测试验证

## 🎯 功能特性

### 支持的传输协议
- ✅ **Stdio** - 本地进程通信
- ✅ **SSE** - 远程 HTTP 服务器

### 核心功能
- ✅ 连接池管理（跨请求复用）
- ✅ 自动重连（失败重试）
- ✅ 工具命名空间（避免冲突）
- ✅ Resources/Prompts 支持
- ✅ 全局代理支持

### 平台支持
- ✅ CLI（自动加载）
- ✅ Desktop（可视化配置）

## 🚀 快速开始

### CLI 使用

```bash
# 1. 创建配置文件
mkdir -p .plain-agent
cat > .plain-agent/mcp.yaml << 'EOF'
filesystem:
  type: stdio
  command: npx
  args:
    - -y
    - @modelcontextprotocol/server-filesystem
    - /tmp
EOF

# 2. 启动 CLI（自动加载 MCP）
pnpm cli
```

### Desktop 使用

1. 启动 Desktop：`pnpm desktop`
2. 点击顶部工具栏的 MCP 配置按钮（方块图标）
3. 点击"新建 MCP"，填写配置
4. 保存后自动生效

## 📖 配置示例

### Stdio 服务器
```yaml
filesystem:
  type: stdio
  command: npx
  args:
    - -y
    - @modelcontextprotocol/server-filesystem
    - /tmp
  env:
    DEBUG: "true"
```

### SSE 服务器
```yaml
remote:
  type: sse
  url: https://example.com/mcp
  headers:
    Authorization: Bearer token
```

### 禁用服务器
```yaml
disabled-server:
  type: stdio
  command: node
  args: [server.js]
  disabled: true
```

## 🔧 代理配置

```bash
# 设置环境变量
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export no_proxy=localhost,127.0.0.1

# 启动即可，自动生效
pnpm cli  # 或 pnpm desktop
```

## 🌟 已实现功能

- ✅ MCP 核心协议（domain 层）
- ✅ CLI 自动加载
- ✅ Desktop 可视化配置
- ✅ 全局代理支持
- ✅ 连接池管理
- ✅ 工具命名空间
- ✅ 类型完整、测试通过

## 📝 参考

- [MCP 官方文档](https://modelcontextprotocol.io)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
