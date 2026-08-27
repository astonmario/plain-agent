/**
 * Shell 解析（搬运自 any-code domain/src/shell.ts）
 * Windows 上查找 Git Bash（bash.exe），POSIX 用 /bin/sh
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const SYSTEM_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

/** Windows Git Bash 探测候选：扫描 PATH 环境变量。 */
export function windowsGitBashCandidates(): string[] {
  const out: string[] = [];
  for (const raw of (process.env.PATH ?? '').split(';')) {
    const base = raw.trim().replace(/[/\\]+$/, '');
    if (!base || !isAbsolute(base)) continue;
    out.push(join(base, 'bash.exe'));
    out.push(join(base, 'sh.exe'));
    out.push(join(base, 'bin', 'bash.exe'));
    out.push(join(base, 'usr', 'bin', 'bash.exe'));
    out.push(join(base, '..', 'bin', 'bash.exe'));
    out.push(join(base, '..', 'usr', 'bin', 'bash.exe'));
  }
  return out;
}

/** Windows bash 候选序（优先完整 GNU 工具链）。 */
export function bashCandidates(gitBashPath?: string): string[] {
  const detected = process.platform === 'win32' ? windowsGitBashCandidates() : [];
  return [
    gitBashPath,
    ...detected,
    SYSTEM_GIT_BASH,
    process.env.ANYCODE_BASH_PATH,
    '/bin/bash',
    '/bin/sh',
  ].filter((x): x is string => !!x && existsSync(x));
}

/** 解析执行 shell：Windows 找 bash.exe，POSIX 用 /bin/sh。 */
export function resolveShell(
  cwd: string,
  gitBashPath?: string
): { binary: string; cwd: string } {
  if (process.platform !== 'win32') return { binary: '/bin/sh', cwd };
  const binary = bashCandidates(gitBashPath)[0];
  if (!binary) {
    throw new Error(
      'Windows 未找到 Git Bash（请安装 Git for Windows，或设置 gitBashPath）'
    );
  }
  return { binary, cwd };
}
