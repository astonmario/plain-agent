# Skill Discovery 实现计划

## 项目分析总结

### 现有能力
1. **Skill Runtime** (domain/src/skills.ts)
   - 从 3 个目录发现技能：project > global > claude
   - CRUD 操作：创建、读取、更新、删除技能
   - 技能格式：SKILL.md with frontmatter (name + description)

2. **CLI** (cli/src/cli.tsx)
   - 基于 Ink (React for CLI)
   - 参数解析：--sessions, --resume, --continue
   - 无现有的子命令系统

3. **Desktop** (desktop/src/)
   - Electron + React
   - IPC API 已有技能管理：listSkills, readSkill, saveSkill, deleteSkill
   - UI 组件：App.tsx, McpConfig.tsx

4. **数据源研究**
   - skills.sh：无法访问，可能需要 VPN
   - GitHub API：可用，支持 topic 搜索，限速 30 req/min (authenticated)
   - skills-api (mastra-ai)：无法访问详情，但存在

## 实现方案

### 架构设计

```
domain/src/skill-discovery.ts  (核心搜索逻辑)
    ↓
├─ cli/src/commands/skill.ts   (CLI 子命令)
└─ desktop IPC API             (Electron 接入)
    ↓
    desktop/src/renderer/SkillDiscovery.tsx (UI 页面)
```

### 数据源策略

**阶段 1: GitHub API (MVP)**
- 使用 GitHub REST API 搜索
- Topic 标签：`claude-skill`, `mcp-skill`, `agent-skill`
- 搜索字段：仓库名称、描述、README
- 返回：name, description, author, repo URL, stars

**阶段 2: 本地索引 (可选)**
- 维护一个精选技能列表 (JSON)
- 包含官方和社区推荐技能
- 支持离线搜索

**未来: skills.sh API (如果可用)**
- 集成 skills-api 或直接调用 skills.sh
- 提供更丰富的元数据

### 核心模块设计

#### 1. domain/src/skill-discovery.ts

```typescript
export interface RemoteSkill {
  id: string;              // repo full_name
  name: string;            // 技能名称
  description: string;     // 描述
  author: string;          // 作者
  source: 'github' | 'official' | 'community';
  sourceUrl: string;       // 仓库 URL
  stars?: number;          // GitHub stars
  topics?: string[];       // GitHub topics
  installable: boolean;    // 是否可以安装
}

export interface SkillSearchResult {
  skills: RemoteSkill[];
  total: number;
  source: string;
}

export interface SkillDiscoveryClient {
  search(query: string, options?: SearchOptions): Promise<SkillSearchResult>;
  getDetail(id: string): Promise<RemoteSkill & { readme: string }>;
}

// GitHub 实现
export class GitHubSkillDiscovery implements SkillDiscoveryClient {
  constructor(token?: string);
  search(query: string): Promise<SkillSearchResult>;
  getDetail(id: string): Promise<RemoteSkill & { readme: string }>;
}

// 本地索引实现（精选技能）
export class LocalSkillIndex implements SkillDiscoveryClient {
  constructor(indexPath: string);
  search(query: string): Promise<SkillSearchResult>;
  getDetail(id: string): Promise<RemoteSkill & { readme: string }>;
}

// 组合客户端（优先本地，回退 GitHub）
export class CompositeSkillDiscovery implements SkillDiscoveryClient {
  constructor(clients: SkillDiscoveryClient[]);
  search(query: string): Promise<SkillSearchResult>;
  getDetail(id: string): Promise<RemoteSkill & { readme: string }>;
}
```

#### 2. CLI 子命令 (cli/src/commands/skill.ts)

```bash
# 搜索技能
agent skill search <query>

# 查看技能详情
agent skill info <skill-id>

# 列出已安装技能
agent skill list

# 安装技能（如果实现）
agent skill install <skill-id>
```

实现：
- 解析子命令参数
- 调用 skill-discovery 模块
- 格式化输出（表格、详情）
- 彩色终端输出

#### 3. Desktop IPC API 扩展

新增 IPC 方法：
```typescript
interface DesktopAPI {
  // 现有方法...
  
  // 新增：技能发现
  searchRemoteSkills(query: string): Promise<RemoteSkill[]>;
  getRemoteSkillDetail(id: string): Promise<RemoteSkill & { readme: string }>;
  installRemoteSkill(id: string, targetDir: 'global' | 'project'): Promise<SkillSaveResult>;
}
```

#### 4. Desktop UI (desktop/src/renderer/SkillDiscovery.tsx)

组件结构：
```
<SkillDiscoveryPage>
  <SearchBar />
  <FilterTabs>
    - All
    - Official
    - Community
  </FilterTabs>
  <SkillList>
    <SkillCard
      name, description, author, stars, source
      onClick -> SkillDetailModal
    />
  </SkillList>
  <SkillDetailModal
    readme, metadata, install button
  />
</SkillDiscoveryPage>
```

### 安全设计

1. **路径验证**
   - 安装前验证技能名称（SKILL_NAME_RE）
   - 防止路径逃逸
   - 检查目标目录权限

2. **内容沙箱**
   - 查看详情时不执行技能脚本
   - README 渲染使用 markdown sanitizer
   - 显示来源 URL 供用户审查

3. **用户确认**
   - 安装前显示来源、作者、权限需求
   - 明确区分官方/社区来源
   - 可选：显示代码 diff

### 实现步骤

#### Step 1: 实现核心搜索模块 (domain)
- [ ] 定义 RemoteSkill 类型和接口
- [ ] 实现 GitHubSkillDiscovery
- [ ] 实现 LocalSkillIndex (官方精选列表)
- [ ] 实现 CompositeSkillDiscovery
- [ ] 单元测试

#### Step 2: CLI 接入
- [ ] 创建 cli/src/commands/skill.ts
- [ ] 实现 search, info, list 子命令
- [ ] 修改 cli.tsx 主入口，支持子命令路由
- [ ] 格式化输出（chalk + table）
- [ ] 集成测试

#### Step 3: Desktop IPC 层
- [ ] 扩展 desktop-api.ts 类型定义
- [ ] 在 agent-service.ts 实现搜索方法
- [ ] 在 main/index.ts 注册 IPC handlers
- [ ] 在 preload/index.ts 暴露 API

#### Step 4: Desktop UI
- [ ] 创建 SkillDiscovery.tsx 页面
- [ ] 实现搜索框和过滤器
- [ ] 实现技能列表和卡片
- [ ] 实现详情弹窗
- [ ] 集成到 App.tsx 主路由
- [ ] 样式调整

#### Step 5: 安装功能（可选）
- [ ] 实现远程技能下载逻辑
- [ ] 验证 SKILL.md 格式
- [ ] 集成到 CLI 和 Desktop
- [ ] 添加安全检查

#### Step 6: 测试和文档
- [ ] 单元测试（domain）
- [ ] 集成测试（CLI + Desktop）
- [ ] 更新 README
- [ ] 编写使用示例

### 官方精选技能列表

创建 `domain/src/official-skills-index.json`:

```json
{
  "version": "1.0.0",
  "skills": [
    {
      "id": "anthropics/skill-browser",
      "name": "browser-skill",
      "description": "Claude Code 官方浏览器技能",
      "author": "Anthropic",
      "source": "official",
      "sourceUrl": "https://github.com/anthropics/skill-browser",
      "topics": ["browser", "web", "scraping"],
      "installable": true
    },
    {
      "id": "anthropics/skill-mcp-builder",
      "name": "mcp-builder",
      "description": "构建 MCP 服务器",
      "author": "Anthropic",
      "source": "official",
      "sourceUrl": "https://github.com/anthropics/skill-mcp-builder",
      "topics": ["mcp", "builder"],
      "installable": true
    }
  ]
}
```

### 数据源优先级

1. **官方索引** (official-skills-index.json)
   - 精选技能
   - 离线可用
   - 经过审查

2. **GitHub API**
   - 社区技能
   - 实时搜索
   - 需要网络

3. **skills.sh API** (未来)
   - 如果可用则集成
   - 提供更丰富的元数据

### 限制和权衡

**MVP 阶段不实现：**
- 技能评分和评论系统
- 自动更新检查
- 技能依赖管理
- 版本管理
- 发布/上传技能

**技术限制：**
- GitHub API 限速：30 req/min (authenticated), 10 req/min (unauthenticated)
- 搜索结果最多 1000 个（GitHub 限制）
- 无法保证所有搜索到的仓库都是合法技能

**安全考虑：**
- 不自动执行下载的技能
- 用户需手动审查和安装
- 明确标识来源（官方 vs 社区）

## 文件改动清单

### 新增文件
1. `domain/src/skill-discovery.ts` - 核心搜索逻辑
2. `domain/src/official-skills-index.json` - 官方精选技能
3. `cli/src/commands/skill.ts` - CLI 子命令
4. `desktop/src/renderer/src/SkillDiscovery.tsx` - UI 页面
5. `scripts/test-skill-discovery.js` - 集成测试脚本

### 修改文件
1. `cli/src/cli.tsx` - 添加子命令路由
2. `desktop/src/main/agent-service.ts` - 添加搜索方法
3. `desktop/src/main/index.ts` - 注册 IPC handlers
4. `desktop/src/preload/index.ts` - 暴露 API
5. `desktop/src/shared/desktop-api.ts` - 类型定义
6. `desktop/src/renderer/src/App.tsx` - 集成新页面
7. `domain/src/index.ts` - 导出新模块

## 测试计划

### 单元测试
- GitHubSkillDiscovery.search()
- LocalSkillIndex.search()
- CompositeSkillDiscovery 优先级逻辑

### 集成测试
- CLI: `agent skill search react`
- CLI: `agent skill info <id>`
- Desktop: 搜索 -> 查看详情 -> 安装

### 手动测试场景
1. 搜索热门关键词（react, browser, mcp）
2. 查看官方技能详情
3. 查看社区技能详情
4. 测试网络错误处理
5. 测试 GitHub API 限速

## 时间估算

- Step 1: 4-6 小时
- Step 2: 2-3 小时
- Step 3: 2-3 小时
- Step 4: 4-6 小时
- Step 5: 3-4 小时（可选）
- Step 6: 2-3 小时

**总计**: 约 17-25 小时（不含安装功能约 14-18 小时）

## 下一步

请确认以下决策：
1. 是否实现安装功能？还是只做发现和查看？
2. CLI 子命令语法是否合适？（`agent skill search <query>`）
3. GitHub API token 从哪里获取？（环境变量 GITHUB_TOKEN？）
4. 是否需要支持 skills.sh（目前无法访问）？
