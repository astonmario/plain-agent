/**
 * 可选项键盘选择器
 *
 * 模型按约定输出 ```options 代码块后，App 用它接管输入（替代 InputBox）：
 * ↑↓ 移动光标，回车把选中项作为新任务提交，Esc/Ctrl+C 返回手动输入。
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface OptionsPickerProps {
  options: string[];
  onSelect: (option: string) => void;
  onDismiss: () => void;
}

export default function OptionsPicker({ options, onSelect, onDismiss }: OptionsPickerProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setCursor((c) => (c + 1) % options.length);
    } else if (key.return) {
      onSelect(options[cursor]);
    } else if (key.escape || (key.ctrl && input === 'c')) {
      // Ctrl+C 误触不应直接退出程序，返回手动输入
      onDismiss();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{'  ↑↓ 选择 · 回车发送 · Esc 自定义输入'}</Text>
      {options.map((opt, i) => {
        const active = i === cursor;
        return (
          <Box key={i}>
            <Text color={active ? '#10B981' : undefined} bold={active}>
              {`  ${active ? '❯' : ' '} ${opt}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
