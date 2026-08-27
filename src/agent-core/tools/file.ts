/**
 * 文件操作工具（搬运自 any-code）
 * read_file：分页 + 行号 + GBK 编码兜底
 * write_file：原子写（temp + rename，崩溃不留半写）
 * edit_file：精确字符串替换 + CRLF 归一化 + 唯一性校验
 */

import { readFile, writeFile, rename, unlink, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import type { Tool } from '../types';
import { decodeFileText } from './text-decode';
import { resolvePath } from './paths';
import iconv from 'iconv-lite';

/**
 * 读取文件工具（分页 + 行号）
 */
export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容（支持分页）。返回带行号的文件文本，超长自动截断并提示继续读取的 offset。',
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容（支持分页）',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对或绝对路径）',
          },
          offset: {
            type: 'number',
            description: '起始行号（1 起，默认 1）',
          },
          limit: {
            type: 'number',
            description: '读取行数（默认 2000）',
          },
        },
        required: ['filePath'],
      },
    },
  },
  handler: async (args) => {
    try {
      const { filePath, offset = 1, limit = 2000 } = args;
      const abs = resolvePath(filePath);
      const { text: content } = decodeFileText(await readFile(abs));

      const lines = content.split('\n');
      const totalLines = lines.length;
      const start = Math.max(1, offset);
      const end = Math.min(start - 1 + limit, totalLines);
      const selected = lines.slice(start - 1, end);
      const numbered = selected
        .map((line, i) => `${start + i}\t${line}`)
        .join('\n');

      if (end < totalLines) {
        return `${numbered}\n\n[... Truncated - ${totalLines - end} more lines. Use offset=${end + 1} to continue reading.]`;
      }
      if (start > 1) {
        return `[... Lines ${start}-${end} of ${totalLines} total lines]\n\n${numbered}`;
      }
      return numbered;
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

/**
 * 写入文件工具（原子写）
 */
export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入内容到文件（原子写）。如果文件不存在会创建，存在会覆盖。',
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入内容到文件（原子写）',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对或绝对路径）',
          },
          content: {
            type: 'string',
            description: '要写入的内容',
          },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  handler: async (args) => {
    let tmp: string | null = null;
    try {
      const { filePath, content } = args;
      const abs = resolvePath(filePath);
      await mkdir(dirname(abs), { recursive: true });

      // 原子写：同目录 temp + rename，同文件系统原子发布，崩溃不留半写
      tmp = `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, content, 'utf-8');
      await rename(tmp, abs);
      tmp = null;

      return `Successfully wrote ${content.length} characters to ${filePath}`;
    } catch (error) {
      if (tmp) {
        try { await unlink(tmp); } catch { /* 清理失败忽略 */ }
      }
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: true,
  },
};

/**
 * 编辑文件工具（精确字符串替换）
 */
export const editFileTool: Tool = {
  name: 'edit_file',
  description: '精确字符串替换编辑文件。oldString 必须唯一匹配（不存在或多次出现则报错、不落盘）。',
  schema: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确字符串替换编辑文件',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对或绝对路径）',
          },
          oldString: {
            type: 'string',
            description: '要被替换的原文（必须唯一匹配）',
          },
          newString: {
            type: 'string',
            description: '替换后的新文本',
          },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
  },
  handler: async (args) => {
    try {
      const { filePath, oldString, newString } = args;
      const abs = resolvePath(filePath);

      // 按文件实际编码解码（GBK 兜底），写回时保持原编码
      const { text: content, encoding } = decodeFileText(await readFile(abs));

      const edit = applyEdit(content, oldString, newString);
      if (!edit.ok) {
        return `Error: ${edit.error}`;
      }

      await writeFile(
        abs,
        encoding === 'gbk' ? iconv.encode(edit.content, 'gbk') : Buffer.from(edit.content, 'utf8'),
      );

      return `Successfully edited file.\n--- Removed:\n${oldString}\n--- Added:\n${newString}`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: true,
  },
};

/**
 * 编辑核心（纯函数，可单测）：
 * - CRLF 文件先把内容与 old/new 归一化为 LF 再匹配替换，写回前还原 CRLF；
 * - 唯一性校验：0 次或多次命中都报错。
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string
): { ok: boolean; content: string; crlf: boolean; error?: string } {
  const crlf = content.includes('\r\n');
  const norm = (t: string) => (crlf ? t.replace(/\r\n/g, '\n') : t);
  const body = norm(content);
  const oldN = norm(oldString);
  const newN = norm(newString);

  if (!body.includes(oldN)) {
    return { ok: false, content, crlf, error: 'oldString not found in file. Cannot perform replacement.' };
  }
  const occurrences = (
    body.match(new RegExp(oldN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []
  ).length;
  if (occurrences > 1) {
    return {
      ok: false,
      content,
      crlf,
      error: `oldString appears ${occurrences} times in the file. Please make the oldString more specific to match only once.`,
    };
  }
  let result = body.replace(oldN, newN);
  if (crlf) result = result.replace(/\n/g, '\r\n');
  return { ok: true, content: result, crlf };
}
