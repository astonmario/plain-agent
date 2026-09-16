/**
 * ask_question 提问向导
 * 与 agent 同进程：提交直接调 domain 的 submitInteractionAnswer
 * 单选=回车/空格确认当前项；多选=空格切换、回车提交；文本=直接输入
 * Ctrl+C = 全部留空提交（与桌面端「跳过」一致），让 loop 继续
 */

import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { submitInteractionAnswer } from '@plain-agent/domain';
import type { InteractionQuestion } from '@plain-agent/domain';

export function InteractionWizard({ id, questions, onDone }: {
  id: string;
  questions: InteractionQuestion[];
  onDone: () => void;
}) {
  const [qi, setQi] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<string[][]>(questions.map(() => []));
  const [text, setText] = useState('');
  const answersRef = useRef<string[]>(questions.map(() => ''));

  const q = questions[qi];
  const options = q.options ?? [];
  const hasOptions = options.length > 0;

  const finish = useCallback(
    (answers: string[]) => {
      submitInteractionAnswer(id, answers);
      onDone();
    },
    [id, onDone],
  );

  const advance = useCallback(
    (answer: string) => {
      answersRef.current[qi] = answer;
      if (qi + 1 < questions.length) {
        setQi(qi + 1);
        setCursor(0);
        setText('');
      } else {
        finish(answersRef.current);
      }
    },
    [qi, questions.length, finish],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      finish(questions.map((_, i) => answersRef.current[i] || ''));
      return;
    }
    if (hasOptions) {
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(options.length - 1, c + 1));
        return;
      }
      if (input === ' ') {
        if (q.multiSelect) {
          setPicked((prev) => {
            const next = [...prev];
            const set = new Set(next[qi]);
            const opt = options[cursor];
            if (set.has(opt)) set.delete(opt);
            else set.add(opt);
            next[qi] = [...set];
            return next;
          });
        } else {
          advance(options[cursor]);
        }
        return;
      }
      if (key.return) {
        if (q.multiSelect) {
          const sel = picked[qi];
          if (sel.length > 0) advance(sel.join(', '));
        } else {
          advance(options[cursor]);
        }
        return;
      }
    } else {
      if (key.return) {
        if (text.trim()) advance(text.trim());
        return;
      }
      if (key.backspace || key.delete) {
        setText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setText((t) => t + input.replace(/[\r\n]+/g, ' '));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#EAB308" paddingX={1} marginBottom={1}>
      <Text color="#EAB308" bold>
        Agent 提问（{qi + 1}/{questions.length}）
      </Text>
      {q.header && <Text dimColor>{q.header}</Text>}
      <Text wrap="wrap">{q.question}</Text>
      {hasOptions ? (
        <Box flexDirection="column" marginTop={1}>
          {options.map((opt, i) => {
            const active = i === cursor;
            const mark = q.multiSelect
              ? picked[qi].includes(opt)
                ? '[x]'
                : '[ ]'
              : active
                ? '(●)'
                : '( )';
            return (
              <Text key={i} color={active ? '#4ECDC4' : undefined} dimColor={!active}>
                {active ? '❯ ' : '  '}
                {mark} {opt}
              </Text>
            );
          })}
          <Text dimColor>{q.multiSelect ? '空格切换选中，回车提交' : '回车/空格选择'}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="#4ECDC4" bold>{'> '}</Text>
          <Text>{text}</Text>
          <Text color="#6B7280">▍</Text>
        </Box>
      )}
    </Box>
  );
}
