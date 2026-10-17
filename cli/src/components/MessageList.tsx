/**
 * 消息渲染组件（借鉴 any-code/tui 的 MessageItem 风格）
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Message, MessageType } from '../types';
import type { ToolCall } from '../types';
import { ToolCallBatch } from './ToolCallDisplay';

const TYPE_COLORS: Record<MessageType, string> = {
  [MessageType.SYSTEM]: '#6B7280',
  [MessageType.USER]: '#3B82F6',
  [MessageType.TOOL]: '#8B5CF6',
  [MessageType.ITERATION]: '#6B7280',
  [MessageType.ASSISTANT]: '#10B981',
  [MessageType.ERROR]: '#EF4444',
  [MessageType.WARNING]: '#EAB308',
};

const TYPE_LABELS: Record<MessageType, string> = {
  [MessageType.SYSTEM]: '●',
  [MessageType.USER]: 'You:',
  [MessageType.TOOL]: '',
  [MessageType.ITERATION]: '↺',
  [MessageType.ASSISTANT]: '● Assistant',
  [MessageType.ERROR]: '✗',
  [MessageType.WARNING]: '⚠',
};

export function MessageItem({ message, showTimestamp = false }: {
  message: Message;
  showTimestamp?: boolean;
}) {
  const color = TYPE_COLORS[message.type];
  const label = TYPE_LABELS[message.type];

  // 工具消息：解析 JSON 渲染为卡片批次
  if (message.type === MessageType.TOOL) {
    try {
      const calls: ToolCall[] = JSON.parse(message.content);
      return <ToolCallBatch calls={calls} />;
    } catch {
      // JSON 解析失败时降级为纯文本（兼容旧数据）
      return (
        <Box marginBottom={1}>
          <Text dimColor>{message.content}</Text>
        </Box>
      );
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 用户和 Assistant 消息显示角色标识 */}
      {(message.type === MessageType.USER || message.type === MessageType.ASSISTANT) && (
        <Text color={color} bold>
          {label}
        </Text>
      )}

      {/* 系统、错误、警告等其他消息类型 */}
      {message.type !== MessageType.USER && message.type !== MessageType.ASSISTANT && (
        <Text color={color} bold>
          {label} {message.type !== MessageType.SYSTEM ? message.type : ''}
        </Text>
      )}

      {/* 消息内容 */}
      <Box paddingLeft={message.type === MessageType.USER || message.type === MessageType.ASSISTANT ? 0 : 3}>
        <Text wrap="wrap" dimColor={message.type === MessageType.SYSTEM}>
          {message.content}
        </Text>
      </Box>

      {/* 可选项列表 - 始终显示，不再隐藏 */}
      {message.options?.map((opt, i) => (
        <Box key={i} paddingLeft={2}>
          <Text dimColor>○ {opt}</Text>
        </Box>
      ))}
    </Box>
  );
}
