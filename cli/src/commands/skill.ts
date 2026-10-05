/**
 * CLI 子命令：skill
 *
 * 命令：
 * - agent skill search <query>     搜索技能
 * - agent skill info <skill-id>    查看技能详情
 * - agent skill list               列出已安装技能
 * - agent skill install <skill-id> 安装技能
 */

import { createSkillDiscovery, installRemoteSkill, listUserSkills, readUserSkill } from '@plain-agent/domain';
import type { RemoteSkill, RemoteSkillDetail, SkillInstallOptions } from '@plain-agent/domain';

/**
 * 格式化技能列表输出
 */
function formatSkillList(skills: RemoteSkill[]): void {
  if (skills.length === 0) {
    console.log('未找到技能。');
    return;
  }

  console.log(`\n找到 ${skills.length} 个技能:\n`);

  for (const skill of skills) {
    const source = skill.source === 'official' ? '📦 官方' : '🌐 社区';
    const stars = skill.stars ? ` ⭐ ${skill.stars}` : '';
    console.log(`${source}  ${skill.name}${stars}`);
    console.log(`    ${skill.description}`);
    console.log(`    作者: ${skill.author}`);
    console.log(`    来源: ${skill.sourceUrl}`);
    console.log(`    ID: ${skill.id}`);
    console.log();
  }
}

/**
 * 格式化技能详情输出
 */
function formatSkillDetail(detail: RemoteSkillDetail): void {
  const source = detail.source === 'official' ? '📦 官方' : '🌐 社区';
  const stars = detail.stars ? ` ⭐ ${detail.stars}` : '';
  const installable = detail.installable ? '✅ 可安装' : '❌ 不可安装';

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${source}  ${detail.name}${stars}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`描述: ${detail.description}`);
  console.log(`作者: ${detail.author}`);
  console.log(`来源: ${detail.sourceUrl}`);
  console.log(`状态: ${installable}`);

  if (detail.topics && detail.topics.length > 0) {
    console.log(`标签: ${detail.topics.join(', ')}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('README');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 显示 README 前 50 行
  const lines = detail.readme.split('\n').slice(0, 50);
  console.log(lines.join('\n'));

  if (detail.readme.split('\n').length > 50) {
    console.log('\n... (更多内容请访问仓库)');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

/**
 * 格式化已安装技能列表
 */
function formatInstalledSkills(): void {
  const skills = listUserSkills();

  if (skills.length === 0) {
    console.log('未安装任何技能。');
    return;
  }

  console.log(`\n已安装 ${skills.length} 个技能:\n`);

  for (const skill of skills) {
    console.log(`📦  ${skill.name}`);
    console.log(`    ${skill.description}`);
    console.log();
  }
}

/**
 * skill search 命令
 */
export async function skillSearchCommand(query: string, githubToken?: string): Promise<void> {
  console.log(`\n🔍 搜索技能: "${query}"\n`);

  const client = createSkillDiscovery(githubToken);

  try {
    const result = await client.search(query, { limit: 10 });
    formatSkillList(result.skills);

    if (result.total > result.skills.length) {
      console.log(`(共 ${result.total} 个结果，仅显示前 ${result.skills.length} 个)`);
    }
  } catch (error) {
    console.error('搜索失败:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * skill info 命令
 */
export async function skillInfoCommand(skillId: string, githubToken?: string): Promise<void> {
  console.log(`\n📄 获取技能详情: ${skillId}\n`);

  const client = createSkillDiscovery(githubToken);

  try {
    const detail = await client.getDetail(skillId);
    formatSkillDetail(detail);

    if (detail.installable) {
      console.log(`安装命令: agent skill install ${skillId}`);
      console.log();
    }
  } catch (error) {
    console.error('获取详情失败:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * skill list 命令
 */
export function skillListCommand(): void {
  console.log('\n📚 已安装的技能\n');
  formatInstalledSkills();
}

/**
 * skill install 命令
 */
export async function skillInstallCommand(
  skillId: string,
  options: { target?: 'global' | 'project'; projectDir?: string },
  githubToken?: string,
): Promise<void> {
  const target = options.target || 'global';
  console.log(`\n📥 安装技能: ${skillId} (目标: ${target})\n`);

  const client = createSkillDiscovery(githubToken);

  try {
    // 获取详情
    console.log('正在获取技能详情...');
    const detail = await client.getDetail(skillId);

    if (!detail.installable) {
      console.error('❌ 此技能不可安装（缺少 SKILL.md 文件）');
      process.exit(1);
    }

    // 显示安全信息
    console.log('\n⚠️  安全提示:');
    console.log(`   技能名称: ${detail.name}`);
    console.log(`   作者: ${detail.author}`);
    console.log(`   来源: ${detail.sourceUrl}`);
    console.log(`   类型: ${detail.source === 'official' ? '官方技能' : '社区技能'}`);
    console.log();

    // 确认安装
    console.log('请仔细审查技能来源，确认后继续安装。');
    console.log('(按 Ctrl+C 取消)\n');

    // 等待 3 秒
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 安装
    console.log('正在安装...');
    const installOptions: SkillInstallOptions = {
      target,
      projectDir: options.projectDir,
    };

    const result = await installRemoteSkill(detail, installOptions);

    if (result.ok) {
      console.log(`✅ ${result.message}`);
      console.log(`\n现在可以使用 /use_skill ${result.installedName} 调用此技能。`);
    } else {
      console.error(`❌ ${result.message}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('安装失败:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * 解析 skill 子命令
 */
export async function handleSkillCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const githubToken = process.env.GITHUB_TOKEN;

  if (!subcommand || subcommand === 'help') {
    console.log(`
Plain Agent - 技能管理

用法:
  agent skill search <query>      搜索技能
  agent skill info <skill-id>     查看技能详情
  agent skill list                列出已安装技能
  agent skill install <skill-id>  安装技能

示例:
  agent skill search react
  agent skill info anthropics/skill-browser
  agent skill install anthropics/skill-browser
  agent skill list

环境变量:
  GITHUB_TOKEN  GitHub Personal Access Token (可选，用于提高 API 限速)
`);
    return;
  }

  switch (subcommand) {
    case 'search': {
      const query = args[1];
      if (!query) {
        console.error('错误: 缺少搜索关键词');
        console.log('用法: agent skill search <query>');
        process.exit(1);
      }
      await skillSearchCommand(query, githubToken);
      break;
    }

    case 'info': {
      const skillId = args[1];
      if (!skillId) {
        console.error('错误: 缺少技能 ID');
        console.log('用法: agent skill info <skill-id>');
        process.exit(1);
      }
      await skillInfoCommand(skillId, githubToken);
      break;
    }

    case 'list': {
      skillListCommand();
      break;
    }

    case 'install': {
      const skillId = args[1];
      if (!skillId) {
        console.error('错误: 缺少技能 ID');
        console.log('用法: agent skill install <skill-id>');
        process.exit(1);
      }

      const target = args.includes('--project') ? 'project' : 'global';
      await skillInstallCommand(skillId, { target }, githubToken);
      break;
    }

    default:
      console.error(`错误: 未知子命令 "${subcommand}"`);
      console.log('运行 "agent skill help" 查看可用命令');
      process.exit(1);
  }
}
