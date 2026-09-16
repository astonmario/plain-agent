/**
 * 输入框（借鉴 any-code/tui 的 InputBox）
 * - ink-text-input 负责单行编辑（光标移动/删除），其内部已忽略 ↑↓/Tab/Ctrl+C，这里安全接管
 * - 输入 / 时内联展示命令候选，Tab 补全、↑↓ 切换高亮
 * - 普通模式下 ↑↓ 翻历史输入
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

export interface Command {
  name: string;
  description: string;
  handler: () => void;
}

interface InputBoxProps {
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** 可用命令，输入 / 时内联展示候选 */
  commands?: Command[];
  placeholder?: string;
  /** 交互组件（提问向导/会话选择）激活时设为 false，让出键盘 */
  active?: boolean;
}

export default function InputBox({
  onSubmit,
  onCancel,
  commands = [],
  placeholder = '输入任务，回车执行；/help 查看命令',
  active = true,
}: InputBoxProps) {
  const [value, setValue] = React.useState('');
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [history, setHistory] = React.useState<string[]>([]);
  const [hIdx, setHIdx] = React.useState(-1);
  const draftRef = React.useRef('');

  const isCommand = value.startsWith('/');
  const matches = React.useMemo(() => {
    if (!isCommand) return [];
    const v = value.toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(v));
  }, [value, commands, isCommand]);

  // 输入变化时重置高亮到首项
  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [value]);

  useInput(
    (input, key) => {
      if (!active) return;
      if (key.escape || (key.ctrl && input === 'c')) {
        onCancel();
        return;
      }
      if (isCommand && matches.length > 0) {
        if (key.tab) {
          const m = matches[highlightedIndex] ?? matches[0];
          if (m) setValue(m.name);
          return;
        }
        if (key.upArrow) {
          setHighlightedIndex((prev) => (prev - 1 + matches.length) % matches.length);
        }
        if (key.downArrow) {
          setHighlightedIndex((prev) => (prev + 1) % matches.length);
        }
        return;
      }
      // 普通模式：↑↓ 翻历史
      if (key.upArrow) {
        if (history.length === 0) return;
        const next = hIdx === -1 ? history.length - 1 : Math.max(0, hIdx - 1);
        if (hIdx === -1) draftRef.current = value;
        setHIdx(next);
        setValue(history[next]);
        return;
      }
      if (key.downArrow) {
        if (hIdx === -1) return;
        if (hIdx >= history.length - 1) {
          setHIdx(-1);
          setValue(draftRef.current);
        } else {
          const next = hIdx + 1;
          setHIdx(next);
          setValue(history[next]);
        }
      }
    },
    { isActive: active },
  );

  const handleSubmit = () => {
    const v = value.trim();
    if (!v) return;
    setHistory((h) => [...h, v]);
    setHIdx(-1);
    draftRef.current = '';
    onSubmit(v);
    setValue('');
  };

  return (
    <Box flexDirection="column">
      {isCommand && matches.length > 0 && (
        <Box flexDirection="column">
          {matches.map((c, i) => {
            const isHighlighted = i === highlightedIndex;
            return (
              <Box key={c.name}>
                <Text
                  color={isHighlighted ? '#000' : '#4ECDC4'}
                  bold={isHighlighted}
                  inverse={isHighlighted}
                >
                  {'  '}
                  {c.name}
                </Text>
                {isHighlighted && (
                  <Text color="#000" bold inverse>
                    {' '}
                    {c.description}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="#4ECDC4" bold>
          {'>'}{' '}
        </Text>
        {active ? (
          <TextInput
            value={value}
            onChange={(v) => {
              setValue(v);
              setHIdx(-1);
            }}
            onSubmit={handleSubmit}
            placeholder={placeholder}
          />
        ) : (
          <Text color="#9CA3AF" dimColor>
            {placeholder}
          </Text>
        )}
      </Box>
    </Box>
  );
}
