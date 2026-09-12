/**
 * 技能工具（搬运自 any-code skill.ts + createSkillTool.ts，路径适配 plain-agent）
 * use_skill：按 name 返回技能全文（只读，不改文件）
 * create_skill：把可复用经验固化为 <scope>/skills/<name>/SKILL.md
 */

import type { Tool } from '../types';
import { SKILL_NAME_RE, createUserSkill, globalSkillsDir, projectSkillsDir } from '../skills';

/**
 * 按名读取技能全文。内置技能带 dir（SKILL.md 所在目录）：附在结果里，
 * 供 agent 用 read/glob/bash 读取 references/scripts/assets 等技能目录资源。
 */
export const useSkillTool: Tool = {
  name: 'use_skill',
  description: '按名称读取技能全文（含步骤、注意事项、脚本用法）。任务匹配某个技能时先调用它，再按技能指引执行。',
  schema: {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Read a skill by name and return its full content (steps, caveats, script usage). Call this first when a task matches a skill, then follow its instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（<available_skills> 目录里的名字）' },
        },
        required: ['name'],
      },
    },
  },
  handler: async (args: { name?: string }, ctx): Promise<string> => {
    const name = args?.name?.trim();
    if (!name) return 'Error: name 不能为空';
    const entry = ctx.skills?.get(name);
    if (!entry) {
      const available = ctx.skills ? [...ctx.skills.keys()].join(', ') : '';
      return `Error: 技能 "${name}" 不存在。可用技能：${available || '（无）'}`;
    }
    const dirLine = entry.dir ? `\n<dir>${entry.dir}</dir>` : '';
    return `<skill_content>\n<name>${entry.name}</name>\n<origin>${entry.origin}</origin>${dirLine}\n${entry.content}\n</skill_content>`;
  },
  meta: { readonly: true, concurrent: true },
};

const NAME_RE = SKILL_NAME_RE;

/**
 * 创建技能：写入 <scope>/skills/<name>/SKILL.md（frontmatter 齐全、拒绝覆盖、名字防路径逃逸）。
 * 写入后下一条任务即可用（skills 每任务重新扫描）。
 */
export const createSkillTool: Tool = {
  name: 'create_skill',
  description:
    '把可复用经验固化为技能（写入 <scope>/skills/<name>/SKILL.md）。当某次工作流被证明可复用时使用。下一条任务即可用，不要自己猜安装路径。',
  schema: {
    type: 'function',
    function: {
      name: 'create_skill',
      description:
        'Create a reusable skill from experience (writes <scope>/skills/<name>/SKILL.md). Use when a workflow proves repeatable. Takes effect on the next task; never guess install paths yourself.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '技能名：小写字母/数字/连字符（如 pdf-merge）。也是目录名与 use_skill 的调用名',
          },
          description: {
            type: 'string',
            description: '一句话说明何时该用这个技能（会注入 <available_skills> 目录供模型判断）',
          },
          content: { type: 'string', description: '技能正文（Markdown）：步骤、注意事项、脚本用法' },
          scope: {
            type: 'string',
            enum: ['global', 'project'],
            description:
              'global=~/.plain-agent/skills（跨项目，缺省）；project=<cwd>/.plain-agent/skills（仅本项目）',
          },
        },
        required: ['name', 'description', 'content'],
      },
    },
  },
  handler: async (args: { name?: string; description?: string; content?: string; scope?: string }): Promise<string> => {
    const scope = args?.scope === 'project' ? 'project' : 'global';
    // 落盘逻辑与桌面端技能管理共用（skills.ts 的 CRUD），保证两处行为一致
    const result = createUserSkill(
      { name: args?.name ?? '', description: args?.description ?? '', content: args?.content ?? '' },
      scope === 'project' ? projectSkillsDir(process.cwd()) : globalSkillsDir(),
    );
    if (!result.ok) {
      const suffix = result.message.includes('已存在') ? '。如需修改：用 edit_file 工具直接编辑其 SKILL.md' : '';
      return `[Error] ${result.message}${suffix}`;
    }
    return `${result.message}（scope: ${scope}）\n下一条任务即可用：use_skill "${args?.name?.trim()}"`;
  },
  meta: { readonly: false, concurrent: false, dangerous: true },
};
