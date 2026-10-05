/**
 * Skill Discovery - 技能发现和搜索
 *
 * 数据源：
 * 1. 本地官方索引（精选技能，离线可用）
 * 2. GitHub API（社区技能，实时搜索）
 *
 * 安全：
 * - 不自动执行下载的技能
 * - 用户需手动审查和安装
 * - 明确标识来源（官方 vs 社区）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SKILL_NAME_RE, globalSkillsDir, projectSkillsDir } from './skills';
import type { SkillCrudResult } from './skills';

// ============ 类型定义 ============

export interface RemoteSkill {
  id: string;              // repo full_name (e.g., "anthropics/skill-browser")
  name: string;            // 技能名称
  description: string;     // 描述
  author: string;          // 作者
  source: 'official' | 'community';
  sourceUrl: string;       // 仓库 URL
  stars?: number;          // GitHub stars
  topics?: string[];       // GitHub topics
  installable: boolean;    // 是否可以安装
}

export interface RemoteSkillDetail extends RemoteSkill {
  readme: string;          // README 内容
  skillMdUrl?: string;     // SKILL.md 下载 URL
}

export interface SkillSearchResult {
  skills: RemoteSkill[];
  total: number;
  source: string;
}

export interface SearchOptions {
  limit?: number;
  source?: 'all' | 'official' | 'community';
}

export interface SkillDiscoveryClient {
  search(query: string, options?: SearchOptions): Promise<SkillSearchResult>;
  getDetail(id: string): Promise<RemoteSkillDetail>;
}

// ============ GitHub API 客户端 ============

interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  topics: string[];
  owner: {
    login: string;
  };
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubRepo[];
}

export class GitHubSkillDiscovery implements SkillDiscoveryClient {
  private token?: string;
  private baseUrl = 'https://api.github.com';

  constructor(token?: string) {
    this.token = token;
  }

  private async fetch(url: string): Promise<any> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'plain-agent-skill-discovery',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const error = await response.text().catch(() => response.statusText);
      throw new Error(`GitHub API error: ${response.status} ${error}`);
    }

    return response.json();
  }

  async search(query: string, options?: SearchOptions): Promise<SkillSearchResult> {
    const limit = options?.limit || 30;

    // 构建搜索查询：搜索包含 SKILL.md 的仓库
    // topic:claude-skill OR topic:agent-skill OR "SKILL.md" in:path
    const searchQuery = `${query} topic:claude-skill OR topic:agent-skill filename:SKILL.md`;
    const url = `${this.baseUrl}/search/repositories?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=stars`;

    try {
      const data: GitHubSearchResponse = await this.fetch(url);

      const skills: RemoteSkill[] = data.items.map(repo => ({
        id: repo.full_name,
        name: this.extractSkillName(repo.name),
        description: repo.description || '(无描述)',
        author: repo.owner.login,
        source: 'community',
        sourceUrl: repo.html_url,
        stars: repo.stargazers_count,
        topics: repo.topics,
        installable: true,
      }));

      return {
        skills,
        total: data.total_count,
        source: 'github',
      };
    } catch (error) {
      console.error('GitHub search failed:', error);
      return {
        skills: [],
        total: 0,
        source: 'github',
      };
    }
  }

  async getDetail(id: string): Promise<RemoteSkillDetail> {
    // id 格式: owner/repo
    const url = `${this.baseUrl}/repos/${id}`;
    const repo: GitHubRepo = await this.fetch(url);

    // 获取 README
    let readme = '';
    try {
      const readmeUrl = `${this.baseUrl}/repos/${id}/readme`;
      const readmeData = await this.fetch(readmeUrl);
      readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
    } catch (e) {
      readme = '(无 README)';
    }

    // 检查是否有 SKILL.md
    let skillMdUrl: string | undefined;
    try {
      const contentsUrl = `${this.baseUrl}/repos/${id}/contents`;
      const contents = await this.fetch(contentsUrl);
      const skillMd = contents.find((f: any) => f.name === 'SKILL.md');
      if (skillMd) {
        skillMdUrl = skillMd.download_url;
      }
    } catch (e) {
      // 没有 SKILL.md
    }

    return {
      id: repo.full_name,
      name: this.extractSkillName(repo.name),
      description: repo.description || '(无描述)',
      author: repo.owner.login,
      source: 'community',
      sourceUrl: repo.html_url,
      stars: repo.stargazers_count,
      topics: repo.topics,
      installable: !!skillMdUrl,
      readme,
      skillMdUrl,
    };
  }

  private extractSkillName(repoName: string): string {
    // 从仓库名提取技能名：skill-browser -> browser, mcp-skill -> mcp
    return repoName
      .replace(/^skill-/, '')
      .replace(/-skill$/, '')
      .toLowerCase();
  }
}

// ============ 本地官方索引 ============

export class LocalSkillIndex implements SkillDiscoveryClient {
  private skills: RemoteSkill[] = [];

  constructor(indexPath?: string) {
    const path = indexPath || join(__dirname, 'official-skills-index.json');
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        this.skills = data.skills || [];
      } catch (e) {
        console.error('Failed to load official skills index:', e);
      }
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SkillSearchResult> {
    const lowerQuery = query.toLowerCase();
    const filtered = this.skills.filter(skill => {
      const matchesQuery =
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        skill.topics?.some(t => t.toLowerCase().includes(lowerQuery));

      const matchesSource =
        !options?.source ||
        options.source === 'all' ||
        skill.source === options.source;

      return matchesQuery && matchesSource;
    });

    const limit = options?.limit || 30;
    return {
      skills: filtered.slice(0, limit),
      total: filtered.length,
      source: 'local-index',
    };
  }

  async getDetail(id: string): Promise<RemoteSkillDetail> {
    const skill = this.skills.find(s => s.id === id);
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }

    return {
      ...skill,
      readme: '(官方精选技能，请访问仓库查看详情)',
      installable: true,
    };
  }
}

// ============ 组合客户端 ============

export class CompositeSkillDiscovery implements SkillDiscoveryClient {
  constructor(private clients: SkillDiscoveryClient[]) {}

  async search(query: string, options?: SearchOptions): Promise<SkillSearchResult> {
    // 优先本地索引，然后 GitHub
    for (const client of this.clients) {
      const result = await client.search(query, options);
      if (result.skills.length > 0) {
        return result;
      }
    }

    return {
      skills: [],
      total: 0,
      source: 'none',
    };
  }

  async getDetail(id: string): Promise<RemoteSkillDetail> {
    // 尝试所有客户端
    for (const client of this.clients) {
      try {
        return await client.getDetail(id);
      } catch (e) {
        continue;
      }
    }
    throw new Error(`Skill not found: ${id}`);
  }
}

// ============ 技能安装 ============

export interface SkillInstallOptions {
  target: 'global' | 'project';
  projectDir?: string;
}

export interface SkillInstallResult {
  ok: boolean;
  message: string;
  installedName?: string;
}

/**
 * 安装远程技能
 * 1. 下载 SKILL.md
 * 2. 验证格式
 * 3. 保存到目标目录
 */
export async function installRemoteSkill(
  detail: RemoteSkillDetail,
  options: SkillInstallOptions,
): Promise<SkillInstallResult> {
  // 验证技能名称
  if (!SKILL_NAME_RE.test(detail.name)) {
    return {
      ok: false,
      message: `技能名称不合法: ${detail.name}`,
    };
  }

  // 检查是否可安装
  if (!detail.installable || !detail.skillMdUrl) {
    return {
      ok: false,
      message: '此技能没有 SKILL.md 文件，无法安装',
    };
  }

  // 下载 SKILL.md
  let skillContent: string;
  try {
    const response = await fetch(detail.skillMdUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    skillContent = await response.text();
  } catch (e) {
    return {
      ok: false,
      message: `下载 SKILL.md 失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 验证格式
  const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return {
      ok: false,
      message: 'SKILL.md 格式错误，缺少 frontmatter',
    };
  }

  // 简单验证 frontmatter 包含 name 和 description
  const frontmatter = frontmatterMatch[1];
  if (!frontmatter.includes('name:') || !frontmatter.includes('description:')) {
    return {
      ok: false,
      message: 'SKILL.md 格式错误，缺少 name 或 description',
    };
  }

  // 确定目标目录
  const targetDir = options.target === 'global'
    ? globalSkillsDir()
    : projectSkillsDir(options.projectDir || process.cwd());

  const skillDir = join(targetDir, detail.name);

  // 检查是否已存在
  if (existsSync(skillDir)) {
    return {
      ok: false,
      message: `技能已存在: ${detail.name}`,
    };
  }

  // 创建目录并保存
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      message: `保存失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    message: `技能已安装: ${detail.name}`,
    installedName: detail.name,
  };
}

// ============ 工厂函数 ============

/**
 * 创建默认的技能发现客户端
 * 优先级：本地索引 > GitHub API
 */
export function createSkillDiscovery(githubToken?: string): SkillDiscoveryClient {
  const clients: SkillDiscoveryClient[] = [
    new LocalSkillIndex(),
  ];

  // 如果有 GitHub Token，添加 GitHub 客户端
  if (githubToken) {
    clients.push(new GitHubSkillDiscovery(githubToken));
  }

  return new CompositeSkillDiscovery(clients);
}
