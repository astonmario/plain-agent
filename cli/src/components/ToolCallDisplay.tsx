/**
 * 工具调用结构化显示组件（参考 Claude Code 风格）
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  duration?: number;
  status?: 'running' | 'success' | 'error';
}

const TOOL_META: Record<string, { icon: string; label: string; color: string }> = {
  read_file: { icon: '📖', label: 'Read', color: '#3B82F6' },
  write_file: { icon: '✏️', label: 'Write', color: '#F59E0B' },
  edit_file: { icon: '✏️', label: 'Edit', color: '#F59E0B' },
  bash: { icon: '⚙️', label: 'Bash', color: '#8B5CF6' },
  web_search: { icon: '🔍', label: 'Search', color: '#10B981' },
  web_fetch: { icon: '🌐', label: 'Fetch', color: '#06B6D4' },
  ask_question: { icon: '❓', label: 'Ask', color: '#EC4899' },
  browser_use: { icon: '🌐', label: 'Browser', color: '#06B6D4' },
  use_skill: { icon: '⚡', label: 'Skill', color: '#8B5CF6' },
  create_skill: { icon: '✨', label: 'Create Skill', color: '#8B5CF6' },
  list_directory: { icon: '📂', label: 'List Dir', color: '#3B82F6' },
  explore: { icon: '🔎', label: 'Explore', color: '#10B981' },
  glob: { icon: '🔍', label: 'Glob', color: '#10B981' },
  grep: { icon: '🔍', label: 'Grep', color: '#10B981' },
  update_memory: { icon: '🧠', label: 'Memory', color: '#8B5CF6' },
  lookup_history: { icon: '📜', label: 'Lookup', color: '#3B82F6' },
  search_history: { icon: '📜', label: 'Search History', color: '#3B82F6' },
  spawn_subagent: { icon: '🤖', label: 'Spawn Agent', color: '#8B5CF6' },
  wait_subagent: { icon: '⏳', label: 'Wait Agent', color: '#8B5CF6' },
  get_subagent_status: { icon: '📊', label: 'Agent Status', color: '#3B82F6' },
  cancel_subagent: { icon: '🚫', label: 'Cancel Agent', color: '#EF4444' },
};

const DEFAULT_TOOL_META = { icon: '🔧', label: 'Tool', color: '#6B7280' };

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 从工具参数提取人类可读的描述
 */
function formatToolDescription(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
      const readPath = args.path as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      if (offset !== undefined && limit !== undefined) {
        return `${readPath}:${offset}-${offset + limit}`;
      }
      return readPath;
    case 'write_file':
    case 'edit_file':
      return `${args.path}`;
    case 'bash':
      return truncate(args.command as string, 60);
    case 'web_search':
      return `"${truncate(args.query as string, 50)}"`;
    case 'web_fetch':
      return truncate(args.url as string, 60);
    case 'ask_question':
      return truncate((args.question || (args.questions as any)?.[0]?.question || '') as string, 50);
    case 'browser_use':
      return truncate((args.action || args.instruction || '') as string, 60);
    case 'use_skill':
      return `/${args.skill}${args.args ? ' ' + truncate(args.args as string, 40) : ''}`;
    case 'create_skill':
      return args.name as string;
    case 'list_directory':
      return args.path as string;
    case 'glob':
      return truncate(args.pattern as string, 50);
    case 'grep':
      return `"${truncate(args.pattern as string, 40)}"${args.path ? ' in ' + args.path : ''}`;
    case 'explore':
    case 'lookup_history':
    case 'search_history':
      return truncate(args.query as string, 50);
    case 'spawn_subagent':
      return truncate(args.task as string, 50);
    case 'wait_subagent':
    case 'get_subagent_status':
    case 'cancel_subagent':
      return `runId: ${args.runId}`;
    default:
      return truncate(JSON.stringify(args), 60);
  }
}

/**
 * 从工具结果提取摘要信息
 */
function formatResultSummary(tool: string, result: string): string {
  const len = result.length;

  switch (tool) {
    case 'readFile':
      const lines = result.split('\n').length;
      return `${lines} lines · ${formatBytes(len)}`;
    case 'writeFile':
      return `${formatBytes(len)} written`;
    case 'bash':
      if (len === 0) return 'no output';

      // 清理结果：移除首尾空白，统一换行符
      const cleaned = result.trim().replace(/\r\n/g, '\n');
      const allLines = cleaned.split('\n');
      const nonEmptyLines = allLines.filter(line => line.trim());

      // 单行输出：直接显示内容
      if (nonEmptyLines.length === 1) {
        return truncate(nonEmptyLines[0], 80);
      }

      // 多行输出：显示统计 + 首行预览
      const firstLine = nonEmptyLines[0];
      return `${nonEmptyLines.length} lines${firstLine ? ' · ' + truncate(firstLine, 40) : ''}`;

    case 'webSearch':
      return `${formatBytes(len)} results`;
    case 'webFetch':
      return formatBytes(len);
    default:
      return truncate(result, 100);
  }
}

export function ToolCallDisplay({ call }: { call: ToolCall }) {
  const meta = TOOL_META[call.tool] || DEFAULT_TOOL_META;
  const description = formatToolDescription(call.tool, call.args);

  return (
    <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
      <Box>
        <Text color={meta.color} bold>
          {meta.icon} {meta.label}
        </Text>
        <Text dimColor> ({call.tool}) {description}</Text>
      </Box>

      {call.status === 'running' && (
        <Box paddingLeft={3}>
          <Text dimColor>⋯ running</Text>
        </Box>
      )}

      {call.status === 'success' && call.result && (
        <Box paddingLeft={3}>
          <Text color="#10B981">✓</Text>
          <Text dimColor> {formatResultSummary(call.tool, call.result)}</Text>
          {call.duration && (
            <Text dimColor> · {formatDuration(call.duration)}</Text>
          )}
        </Box>
      )}

      {call.status === 'error' && call.result && (
        <Box paddingLeft={3}>
          <Text color="#EF4444">✗ {truncate(call.result, 100)}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * 批量工具调用（同一轮迭代）
 */
export function ToolCallBatch({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>
        ┌─ {calls.length} tool call{calls.length > 1 ? 's' : ''}
      </Text>
      {calls.map((call, i) => (
        <Box key={i} paddingLeft={2}>
          <ToolCallDisplay call={call} />
        </Box>
      ))}
      <Text dimColor>└─</Text>
    </Box>
  );
}
