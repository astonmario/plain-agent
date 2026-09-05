/**
 * Memory —— 项目级 + 全局级两层记忆，纯 markdown。
 * 写入由 update_memory 工具触发（LLM 主动调用）。
 * 搬运自 any-code domain/src/memory.ts（路径适配 plain-agent）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export type MemoryScope = 'project' | 'global';

const PROJECT_DIR = '.plain-agent';

/** 项目级记忆文件：<cwd>/.plain-agent/memory.md */
function projectMemoryFile(cwd: string): string {
  return path.join(cwd, PROJECT_DIR, 'memory.md');
}

/** 全局记忆文件：~/.plain-agent/memory.md */
function globalMemoryFile(): string {
  return path.join(os.homedir(), PROJECT_DIR, 'memory.md');
}

function memoryFile(cwd: string, scope: MemoryScope): string {
  return scope === 'global' ? globalMemoryFile() : projectMemoryFile(cwd);
}

/** 保存一条记忆到指定层（默认项目级）。 */
export function saveMemory(cwd: string, content: string, scope: MemoryScope = 'project'): void {
  const file = memoryFile(cwd, scope);
  const dir = path.dirname(file);
  const timestamp = new Date().toISOString();
  const entry = `## ${timestamp}\n\n${content}\n\n---\n\n`;

  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    fs.appendFileSync(file, entry, 'utf-8');
  } else {
    fs.writeFileSync(file, '# Agent Memory\n\n' + entry, 'utf-8');
  }
}

/** 全量重写指定层的记忆文件。 */
export function rewriteMemory(cwd: string, content: string, scope: MemoryScope = 'project'): void {
  const file = memoryFile(cwd, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Agent Memory\n\n' + content.trim() + '\n', 'utf-8');
}

/** 合并加载全局 + 项目两层记忆，滑动窗口截断（默认 4000 字符）。 */
export function loadMemory(cwd: string, windowSize = 4000): string {
  const files = [globalMemoryFile(), projectMemoryFile(cwd)];
  let combined = '';
  for (const f of files) {
    if (fs.existsSync(f)) {
      combined += fs.readFileSync(f, 'utf-8') + '\n';
    }
  }
  if (!combined.trim()) return '';

  if (combined.length <= windowSize) {
    return combined;
  }
  // 滑动窗口末尾截取，从最近的 ## 标题开始避免截断条目
  const tail = combined.slice(-windowSize);
  const idx = tail.indexOf('## ');
  return idx > 0 ? tail.slice(idx) : tail;
}
