# Skill Discovery 功能测试指南

## 功能概述

Skill Discovery 是一个技能发现和安装功能，允许用户搜索、查看和安装第三方技能包。

## 数据源

1. **本地官方索引** (`domain/src/official-skills-index.json`)
   - 包含 Anthropic 官方精选技能
   - 离线可用
   - 优先级最高

2. **GitHub API** (可选)
   - 搜索社区技能
   - 需要 GITHUB_TOKEN 环境变量
   - 限速：30 req/min (authenticated), 10 req/min (unauthenticated)

## CLI 测试

### 1. 搜索技能

```bash
# 搜索技能
agent skill search browser

# 搜索技能（使用 GitHub Token）
GITHUB_TOKEN=your_token agent skill search react
```

预期输出：
- 显示匹配的技能列表
- 包含技能名称、描述、作者、来源、星标数

### 2. 查看技能详情

```bash
# 查看技能详情
agent skill info anthropics/skill-browser
```

预期输出：
- 显示技能完整信息
- 包含 README 内容
- 显示是否可安装

### 3. 列出已安装技能

```bash
# 列出已安装技能
agent skill list
```

预期输出：
- 显示所有已安装的技能
- 包含技能名称和描述

### 4. 安装技能

```bash
# 安装技能到全局目录
agent skill install anthropics/skill-browser

# 安装技能到项目目录
agent skill install anthropics/skill-browser --project
```

预期输出：
- 显示安全提示
- 等待 3 秒确认
- 下载并安装技能
- 显示安装成功消息

## Desktop 测试

### 1. 启动 Desktop 应用

```bash
cd desktop
pnpm dev
```

### 2. 打开技能发现页面

- 点击侧边栏的"技能发现"按钮（🔍 图标）
- 应该打开技能发现弹窗

### 3. 搜索技能

- 在搜索框中输入关键词（如 "browser"）
- 点击"搜索"按钮
- 应该显示匹配的技能卡片

### 4. 过滤技能

- 点击过滤器标签：全部、📦 官方、🌐 社区
- 结果应该根据过滤器更新

### 5. 查看技能详情

- 点击任意技能卡片
- 应该打开详情弹窗
- 显示技能信息和 README

### 6. 安装技能

- 在详情弹窗中点击"安装到全局"或"安装到项目"
- 确认安装对话框
- 等待安装完成
- 显示成功提示

## 配置 GitHub Token

### 方式 1: 环境变量（CLI）

```bash
export GITHUB_TOKEN=ghp_your_token_here
agent skill search react
```

### 方式 2: Desktop 设置

1. 打开 Desktop 应用
2. 点击"设置"按钮
3. 找到"GitHub Token"字段
4. 输入你的 Personal Access Token
5. 保存设置

获取 GitHub Token：
1. 访问 https://github.com/settings/tokens
2. 点击 "Generate new token (classic)"
3. 选择 `public_repo` 权限
4. 生成并复制 token

## 测试检查清单

### CLI 功能
- [ ] `agent skill search <query>` 正常工作
- [ ] `agent skill info <skill-id>` 正常工作
- [ ] `agent skill list` 正常工作
- [ ] `agent skill install <skill-id>` 正常工作
- [ ] 安装技能后可以在 `agent skill list` 中看到
- [ ] 环境变量 GITHUB_TOKEN 生效

### Desktop 功能
- [ ] 技能发现按钮可见且可点击
- [ ] 搜索框正常工作
- [ ] 过滤器正常工作
- [ ] 技能卡片正确显示
- [ ] 点击卡片打开详情弹窗
- [ ] 详情弹窗显示完整信息
- [ ] 安装按钮正常工作
- [ ] 安装成功后显示提示
- [ ] GitHub Token 配置生效

### 错误处理
- [ ] 空搜索关键词显示错误提示
- [ ] 网络错误显示友好提示
- [ ] GitHub API 限速显示提示
- [ ] 安装失败显示错误消息
- [ ] 重复安装提示已存在

### 安全性
- [ ] 显示技能来源（官方/社区）
- [ ] 安装前显示安全警告
- [ ] 安装前等待用户确认
- [ ] README 内容安全渲染（不执行脚本）
- [ ] 技能名称验证（防止路径逃逸）

## 已知限制

1. **GitHub API 限速**
   - 未认证：10 请求/分钟
   - 已认证：30 请求/分钟
   - 建议配置 GITHUB_TOKEN

2. **技能格式**
   - 只能安装包含 SKILL.md 的技能
   - SKILL.md 必须有正确的 frontmatter

3. **搜索范围**
   - GitHub 搜索结果最多 1000 个
   - 只搜索包含特定 topic 或文件的仓库

4. **不支持的功能**
   - 技能评分和评论
   - 自动更新检查
   - 版本管理
   - 依赖管理

## 故障排除

### CLI 错误：找不到命令

```bash
# 确保在项目根目录
cd /path/to/plain-agent

# 重新链接 CLI
cd cli
pnpm link --global
```

### Desktop 错误：无法搜索技能

1. 检查网络连接
2. 检查 GitHub Token 是否正确
3. 查看控制台错误日志
4. 尝试搜索不同的关键词

### 安装失败：权限错误

```bash
# 检查目标目录权限
ls -la ~/.plain-agent/skills/

# 创建目录
mkdir -p ~/.plain-agent/skills/
```

### GitHub API 限速

- 等待限速重置（每分钟重置）
- 配置 GITHUB_TOKEN 提高限速
- 使用本地官方索引搜索

## 测试数据

### 推荐测试关键词

- `browser` - 应该找到浏览器相关技能
- `mcp` - 应该找到 MCP 相关技能
- `skill` - 应该找到通用技能
- `react` - 测试 GitHub API 搜索

### 推荐测试技能 ID

- `anthropics/skill-browser` - 官方浏览器技能
- `anthropics/skill-mcp-builder` - 官方 MCP 构建器
- `anthropics/skill-creator` - 官方技能创建器

## 反馈和报告

如果发现问题，请记录：
1. 操作步骤
2. 预期结果
3. 实际结果
4. 错误消息
5. 环境信息（OS、Node 版本、是否配置 GitHub Token）
