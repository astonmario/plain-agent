/**
 * 会话恢复选择（借鉴 any-code/tui 的 SessionSelect）
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { Session } from '@plain-agent/domain';

interface SessionSelectProps {
  sessions: Session[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

export default function SessionSelect({ sessions, onSelect, onCancel }: SessionSelectProps) {
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (sessions.length > 0) {
        onSelect(sessions[highlightedIndex].id);
      }
      return;
    }
    if (key.upArrow) {
      setHighlightedIndex((prev) => (prev - 1 + sessions.length) % sessions.length);
    }
    if (key.downArrow) {
      setHighlightedIndex((prev) => (prev + 1) % sessions.length);
    }
  });

  if (sessions.length === 0) {
    return (
      <Box>
        <Text color="#6B7280">没有可恢复的会话。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="#6B7280" dimColor>
          选择要恢复的会话（Esc 取消）：
        </Text>
      </Box>
      {sessions.map((s, i) => {
        const isHighlighted = i === highlightedIndex;
        const when = new Date(s.updatedAt).toLocaleString();
        return (
          <Box key={s.id}>
            <Text
              color={isHighlighted ? '#000' : '#4ECDC4'}
              bold={isHighlighted}
              inverse={isHighlighted}
            >
              {isHighlighted ? '▸ ' : '  '}
              {s.title || '(未命名)'}
            </Text>
            {isHighlighted && (
              <Text color="#000" dimColor bold inverse>
                {' '}
                {when}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
