/**
 * 技能注册表（搬运自 any-code 的 skills 体系，路径/约定适配 plain-agent）
 * 技能 = <dir>/skills/<name>/SKILL.md（frontmatter: name + description）。
 * 发现目录：
 *  - 全局：~/.plain-agent/skills/（跨项目）
 *  - 项目：<cwd>/.plain-agent/skills/（仅本项目，覆盖同名全局技能）
 * agent 每次提交任务时重新扫描，写入 ctx.skills 并注入 <available_skills> 目录。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import type { SkillEntry } from './types';

const PROJECT_DIR = '.plain-agent';
const SKILLS_DIR = 'skills';

export function globalSkillsDir(): string {
  return join(homedir(), PROJECT_DIR, SKILLS_DIR);
}

export function projectSkillsDir(cwd: string): string {
  return join(cwd, PROJECT_DIR, SKILLS_DIR);
}

/** 解析 SKILL.md frontmatter（name / description）+ 正文 */
function parseSkillMd(raw: string): { name: string; description: string; content: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const front = m[1];
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
  if (!name) return null;
  return { name, description, content: m[2].trim() };
}

function scanSkillsDir(dir: string, origin: 'global' | 'project', out: Map<string, SkillEntry>): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    let parsed;
    try {
      parsed = parseSkillMd(readFileSync(skillFile, 'utf-8'));
    } catch {
      continue;
    }
    if (!parsed) continue;
    out.set(parsed.name, {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      dir: skillDir,
      origin,
    });
  }
}

/**
 * 发现全部可用技能。先扫描全局、后扫描项目——项目级同名覆盖全局。
 */
export function discoverSkills(cwd: string): Map<string, SkillEntry> {
  const out = new Map<string, SkillEntry>();
  scanSkillsDir(globalSkillsDir(), 'global', out);
  scanSkillsDir(projectSkillsDir(cwd), 'project', out);
  return out;
}

/** 生成注入 system prompt 的 <available_skills> 目录（无技能返回空串） */
export function skillsCatalogPrompt(skills: Map<string, SkillEntry>): string {
  if (skills.size === 0) return '';
  const lines = [...skills.values()].map(
    (s) => `- ${s.name}: ${s.description}${s.origin === 'project' ? '（项目级）' : ''}`,
  );
  return [
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '当任务匹配某个技能时，先用 use_skill 读取该技能全文，再按其指引执行。技能目录里的路径相对其 <dir>。',
  ].join('\n');
}

// ———— 技能的增删改查（桌面端管理界面用；root 缺省为全局目录，只操作用户自己建的技能） ————

/** 技能名规范：同时是目录名与 use_skill 调用名，防路径逃逸 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillCrudResult {
  ok: boolean;
  message: string;
}

function skillFileText(name: string, description: string, content: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
}

/** 列出目录下全部技能（默认全局技能目录） */
export function listUserSkills(root: string = globalSkillsDir()): SkillEntry[] {
  const map = new Map<string, SkillEntry>();
  scanSkillsDir(root, 'global', map);
  return [...map.values()];
}

/** 读取单个技能全文；不存在或名字非法返回 null */
export function readUserSkill(name: string, root: string = globalSkillsDir()): SkillEntry | null {
  if (!SKILL_NAME_RE.test(name)) return null;
  const dir = join(root, name);
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return null;
  try {
    const parsed = parseSkillMd(readFileSync(file, 'utf-8'));
    if (!parsed) return null;
    return { name: parsed.name, description: parsed.description, content: parsed.content, dir, origin: 'global' };
  } catch {
    return null;
  }
}

/** 新建技能；已存在则拒绝（修改走 updateUserSkill） */
export function createUserSkill(
  input: { name: string; description: string; content: string },
  root: string = globalSkillsDir(),
): SkillCrudResult {
  const name = (input.name ?? '').trim();
  const description = (input.description ?? '').trim().replace(/\s+/g, ' ');
  const content = (input.content ?? '').trim();
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, message: 'name 非法：只允许小写字母/数字/连字符（1-64 位）' };
  }
  if (!description) return { ok: false, message: 'description 不能为空' };
  if (!content) return { ok: false, message: 'content 不能为空' };
  const skillDir = join(root, name);
  if (existsSync(skillDir)) return { ok: false, message: `技能 "${name}" 已存在` };
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skillFileText(name, description, content), 'utf-8');
  } catch (e) {
    return { ok: false, message: String(e instanceof Error ? e.message : e) };
  }
  return { ok: true, message: `技能已创建：${name}` };
}

/** 更新技能的 description/content（名字即目录名，不可改） */
export function updateUserSkill(
  name: string,
  patch: { description?: string; content?: string },
  root: string = globalSkillsDir(),
): SkillCrudResult {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, message: 'name 非法' };
  const existing = readUserSkill(name, root);
  if (!existing) return { ok: false, message: `技能 "${name}" 不存在` };
  const description = patch.description !== undefined ? patch.description.trim().replace(/\s+/g, ' ') : existing.description;
  const content = patch.content !== undefined ? patch.content.trim() : existing.content;
  if (!description) return { ok: false, message: 'description 不能为空' };
  if (!content) return { ok: false, message: 'content 不能为空' };
  try {
    writeFileSync(join(existing.dir!, 'SKILL.md'), skillFileText(name, description, content), 'utf-8');
  } catch (e) {
    return { ok: false, message: String(e instanceof Error ? e.message : e) };
  }
  return { ok: true, message: `技能已更新：${name}` };
}

/** 删除技能（整目录移除）；名字非法或解析后越出 root 时拒绝 */
export function deleteUserSkill(name: string, root: string = globalSkillsDir()): SkillCrudResult {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, message: 'name 非法' };
  const skillDir = resolve(root, name);
  if (skillDir !== resolve(root) && !skillDir.startsWith(resolve(root) + sep)) {
    return { ok: false, message: '非法路径' };
  }
  if (!existsSync(skillDir)) return { ok: false, message: `技能 "${name}" 不存在` };
  try {
    rmSync(skillDir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, message: String(e instanceof Error ? e.message : e) };
  }
  return { ok: true, message: `技能已删除：${name}` };
}
