/**
 * 搜索工具（explore/glob/grep）
 * explore：目录树（搬运自 any-code）
 * glob：文件名模式匹配（纯 Node 实现，输出对齐 any-code）
 * grep：内容正则搜索（纯 Node 实现，输出对齐 any-code）
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, resolve } from 'path';
import type { Tool } from '../types';
import { resolvePath, isIgnored, DEFAULT_IGNORED_PATTERNS } from './paths';
import { decodeFileText } from './text-decode';

// ============ 目录树 explore ============

interface DirectoryNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: DirectoryNode[];
}

async function exploreDirectory(
  dirPath: string,
  currentDepth: number,
  maxDepth: number,
  ignorePatterns: string[]
): Promise<DirectoryNode> {
  const node: DirectoryNode = {
    name: basename(dirPath),
    type: 'directory',
    path: dirPath,
    children: [],
  };

  if (currentDepth > maxDepth) return node;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnored(entry.name, ignorePatterns)) continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        node.children!.push(await exploreDirectory(fullPath, currentDepth + 1, maxDepth, ignorePatterns));
      } else {
        node.children!.push({ name: entry.name, type: 'file', path: fullPath });
      }
    }
  } catch {
    node.children = undefined;
  }

  return node;
}

function formatTree(
  node: DirectoryNode,
  indent = '',
  isLast = true,
  isRoot = false
): string {
  const prefix = isRoot
    ? ''
    : indent === ''
      ? ''
      : indent.slice(0, -2) + (isLast ? '└─ ' : '├─ ');
  let result = isRoot
    ? ''
    : prefix + node.name + (node.type === 'directory' ? '/' : '') + '\n';

  if (node.children && node.children.length > 0) {
    const newIndent = isRoot ? '' : indent + (isLast ? '   ' : '│  ');
    for (let i = 0; i < node.children.length; i++) {
      result += formatTree(node.children[i], newIndent, i === node.children.length - 1);
    }
  }

  return result;
}

export const exploreTool: Tool = {
  name: 'explore',
  description: '浏览目录树结构。返回指定目录的文件和子目录树状结构。',
  schema: {
    type: 'function',
    function: {
      name: 'explore',
      description: '浏览目录树结构',
      parameters: {
        type: 'object',
        properties: {
          directoryPath: {
            type: 'string',
            description: '目录路径（默认当前工作目录）',
          },
          maxDepth: {
            type: 'number',
            description: '最大递归深度（默认 3）',
          },
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const { maxDepth = 3, directoryPath } = args;
      const abs = directoryPath ? resolvePath(directoryPath) : process.cwd();
      const ignorePatterns = DEFAULT_IGNORED_PATTERNS;

      const rootNode = await exploreDirectory(abs, 0, maxDepth, ignorePatterns);

      let output = `Directory Structure: ${abs}\n`;
      output += `Max Depth: ${maxDepth}\n`;
      output += `Ignored: ${ignorePatterns.join(', ')}\n\n`;
      output += formatTree(rootNode, '', true, true);

      return output;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  meta: {
    readonly: true,
    concurrent: true,
    dangerous: false,
  },
};

// ============ 通用文件遍历 ============

/** glob 模式转正则（支持 * 与 **） */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义正则特殊字符
    .replace(/\*\*/g, '\u0000') // 临时占位 **
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** 递归遍历文件（跳过 ignore 目录），返回匹配 pattern 的相对路径 */
async function walkFiles(
  dir: string,
  base: string,
  pattern: RegExp,
  ignorePatterns: string[],
  results: string[],
  limit: number
): Promise<void> {
  if (results.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (isIgnored(entry.name, ignorePatterns)) continue;
    const full = join(dir, entry.name);
    const rel = join(base, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      await walkFiles(full, rel, pattern, ignorePatterns, results, limit);
    } else if (pattern.test(rel) || pattern.test(entry.name)) {
      results.push(rel);
    }
  }
}

// ============ glob ============

const MAX_RESULTS = 100;

export const globTool: Tool = {
  name: 'glob',
  description: '文件名模式匹配。用 glob 模式（如 *.ts、src/**/*.ts）查找文件。',
  schema: {
    type: 'function',
    function: {
      name: 'glob',
      description: '文件名模式匹配查找文件',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'glob 模式（如 *.ts、src/**/*.tsx）',
          },
          path: {
            type: 'string',
            description: '搜索根目录（默认当前工作目录）',
          },
        },
        required: ['pattern'],
      },
    },
  },
  handler: async (args) => {
    try {
      const { pattern, path } = args;
      const cwd = path ? resolvePath(path) : process.cwd();
      const regex = globToRegExp(pattern);
      const results: string[] = [];
      await walkFiles(cwd, '', regex, DEFAULT_IGNORED_PATTERNS, results, MAX_RESULTS);

      if (results.length === 0) {
        return `No files found matching pattern: ${pattern}`;
      }
      return results.sort().join('\n');
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  meta: {
    readonly: true,
    concurrent: true,
    dangerous: false,
  },
};

// ============ grep ============

const MAX_MATCHES = 250;

export const grepTool: Tool = {
  name: 'grep',
  description: '内容正则搜索。在文件中搜索匹配 pattern 的内容，返回 file:line:content 格式。',
  schema: {
    type: 'function',
    function: {
      name: 'grep',
      description: '内容正则搜索',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '正则表达式模式',
          },
          path: {
            type: 'string',
            description: '搜索路径（目录或文件，默认当前工作目录）',
          },
          glob: {
            type: 'string',
            description: '文件名过滤（如 *.ts）',
          },
          output_mode: {
            type: 'string',
            enum: ['files_with_matches', 'content', 'count'],
            description: '输出模式（默认 content）',
          },
          case_insensitive: {
            type: 'boolean',
            description: '忽略大小写（默认 false）',
          },
        },
        required: ['pattern'],
      },
    },
  },
  handler: async (args) => {
    try {
      const {
        pattern,
        path,
        glob: globPattern,
        output_mode = 'content',
        case_insensitive = false,
      } = args;

      const target = path ? resolvePath(path) : process.cwd();
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, case_insensitive ? 'gi' : 'g');
      } catch {
        return `Error: invalid regex pattern: ${pattern}`;
      }

      // 定位搜索目标：文件 or 目录
      let isFile = false;
      let searchDir = target;
      try {
        const s = await stat(target);
        isFile = s.isFile();
        if (isFile) searchDir = resolve(target, '..');
      } catch {
        return `Error: path not found: ${target}`;
      }

      const fileGlob = globPattern ? globToRegExp(globPattern) : null;

      // 收集匹配文件
      const files: string[] = [];
      if (isFile) {
        files.push(target);
      } else {
        await walkFiles(searchDir, '', /.*/, DEFAULT_IGNORED_PATTERNS, files, 100000);
      }

      const matches = new Map<string, { line: number; content: string }[]>();
      const matchCounts = new Map<string, number>();

      for (const file of files) {
        if (fileGlob && !fileGlob.test(basename(file)) && !fileGlob.test(file)) continue;
        try {
          const { text } = decodeFileText(await readFile(file));
          const lines = text.split('\n');
          let count = 0;
          for (let i = 0; i < lines.length; i++) {
            if (matches.size >= MAX_MATCHES && output_mode !== 'files_with_matches') break;
            const line = lines[i];
            if (regex.test(line)) {
              count++;
              if (!matches.has(file)) matches.set(file, []);
              matches.get(file)!.push({ line: i + 1, content: line.trim() });
            }
          }
          if (count > 0) matchCounts.set(file, count);
        } catch {
          // 二进制或读取失败忽略
        }
      }

      if (output_mode === 'files_with_matches') {
        if (matches.size === 0) return `No files found matching pattern: ${pattern}`;
        return [...matches.keys()].join('\n');
      }

      if (output_mode === 'count') {
        if (matchCounts.size === 0) return `No matches found for pattern: ${pattern}`;
        return [...matchCounts.entries()]
          .map(([file, count]) => `${file}: ${count} matches`)
          .join('\n');
      }

      if (matches.size === 0) return `No matches found for pattern: ${pattern}`;

      const output: string[] = [];
      for (const [file, hits] of matches) {
        output.push(`\n${file}:`);
        for (const h of hits) {
          output.push(`  ${h.line}: ${h.content}`);
        }
      }
      return output.join('\n').trim();
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  meta: {
    readonly: true,
    concurrent: true,
    dangerous: false,
  },
};
