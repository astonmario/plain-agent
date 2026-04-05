/**
 * 文件操作工具
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool } from '../types';

/**
 * 读取文件工具
 */
export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容。返回文件的文本内容。',
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对或绝对路径）',
          },
        },
        required: ['path'],
      },
    },
  },
  handler: async (args) => {
    try {
      const filePath = resolve(args.path);
      const content = await readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      if (error instanceof Error) {
        return `读取文件失败: ${error.message}`;
      }
      return `读取文件失败: ${String(error)}`;
    }
  },
  meta: {
    readonly: true,
    concurrent: true,
    dangerous: false,
  },
};

/**
 * 写入文件工具
 */
export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入内容到文件。如果文件不存在会创建，如果存在会覆盖。',
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入内容到文件',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对或绝对路径）',
          },
          content: {
            type: 'string',
            description: '要写入的内容',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  handler: async (args) => {
    try {
      const filePath = resolve(args.path);
      await writeFile(filePath, args.content, 'utf-8');
      return `文件已写入: ${filePath}`;
    } catch (error) {
      if (error instanceof Error) {
        return `写入文件失败: ${error.message}`;
      }
      return `写入文件失败: ${String(error)}`;
    }
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: true,
  },
};
