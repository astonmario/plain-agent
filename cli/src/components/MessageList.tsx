/**
 * 消息渲染组件（借鉴 any-code/tui 的 MessageItem 风格）
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Message, MessageType } from '../types';

const TYPE_COLORS: Record<MessageType, string> = {
  [MessageType.SYSTEM]: '#6B7280',
  [MessageType.USER]: '#3B82F6',
  [MessageType.TOOL]: '#8B5CF6',
  [MessageType.ITERATION]: '#6B7280',
  [MessageType.ASSISTANT]: '#10B981',
  [MessageType.THINKING]: '#F59E0B',
  [MessageType.ERROR]: '#EF4444',
  [MessageType.WARNING]: '#EAB308',
};

const TYPE_LABELS: Record<MessageType, string> = {
  [MessageType.SYSTEM]: '●',
  [MessageType.USER]: '你',
  [MessageType.TOOL]: '◈',
  [MessageType.ITERATION]: '↺',
  [MessageType.ASSISTANT]: '●',
  [MessageType.THINKING]: '◆',
  [MessageType.ERROR]: '✖',
  [MessageType.WARNING]: '⚠',
};

function formatTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function MessageItem({ message, showTimestamp = true }: {
  message: Message;
  showTimestamp?: boolean;
}) {
  const color = TYPE_COLORS[message.type];
  const label = TYPE_LABELS[message.type];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {showTimestamp && (
          <Text color="#9CA3AF" dimColor>
            [{formatTimestamp(message.timestamp)}]
          </Text>
        )}
        <Text color={color} bold>
          {' '}
          {label} {message.type}
        </Text>
      </Box>
      <Box paddingLeft={showTimestamp ? 12 : 0}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    </Box>
  );
}
