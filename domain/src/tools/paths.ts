/**
 * 路径解析与忽略模式（工作区简化版）
 * plain-agent 用 process.cwd() 作为工作区根（对标 any-code 的 workspace.rootPath）
 */

import { resolve, isAbsolute } from 'path';

/** 检索/遍历默认忽略模式（减噪，与安全无关） */
export const DEFAULT_IGNORED_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.DS_Store',
];

/** 工作区根路径（当前进程工作目录） */
export function workspaceRoot(): string {
  return process.cwd();
}

/**
 * 将工具参数里的路径解析为绝对路径。
 * 相对路径相对工作区根解析，绝对路径原样返回。
 */
export function resolvePath(filePath: string): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return resolve(workspaceRoot(), filePath);
}

/** 判断给定名称是否命中忽略模式 */
export function isIgnored(name: string, patterns: string[] = DEFAULT_IGNORED_PATTERNS): boolean {
  return patterns.some((p) => {
    if (p.startsWith('*')) return name.endsWith(p.slice(1));
    return name === p;
  });
}
