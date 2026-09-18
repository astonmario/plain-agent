/**
 * TUI 组件级冒烟测试（renderToString，不需要 TTY）
 * 运行：node ../node_modules/tsx/dist/cli.mjs test/smoke-tui.tsx
 */
import React from 'react';
import { renderToString } from 'ink';
import { Message, MessageType } from '../src/types';
import { MessageItem } from '../src/components/MessageList';
import SessionSelect from '../src/components/SessionSelect';
import { InteractionWizard } from '../src/components/InteractionWizard';
import Spinner from '../src/components/Spinner';
import OptionsPicker from '../src/components/OptionsPicker';
import { parseOptionsBlock } from '../src/options';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// 转圈指示器：renderToString 至少吐出一个 braille 帧字符
const spinOut = renderToString(<Spinner />);
check('Spinner 渲染', /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(spinOut), spinOut.slice(0, 40));

// options 代码块解析
const p1 = parseOptionsBlock('好的，可以这样做。\n\n```options\nA 方案\n- B 方案\n1. C 方案\n```');
check('options 解析', p1.options?.length === 3 && p1.options[1] === 'B 方案' && p1.options[2] === 'C 方案', JSON.stringify(p1));
check('options 块从正文剥离', !p1.text.includes('```') && p1.text.includes('好的'));
check('无块返回原文', parseOptionsBlock('普通回复').options === null);
check('空块视为无选项', parseOptionsBlock('x\n```options\n```').options === null);

// options 列表渲染（历史区 dimmed 展示）
const optMsg: Message = { id: 'm2', type: MessageType.ASSISTANT, content: p1.text, timestamp: Date.now(), options: p1.options! };
const optOut = renderToString(<MessageItem message={optMsg} />);
check('MessageItem 渲染选项列表', optOut.includes('○') && optOut.includes('A 方案'));
const hiddenOut = renderToString(<MessageItem message={optMsg} hideOptions />);
check('hideOptions 隐藏选项列表', !hiddenOut.includes('○ A 方案'));

// 选项选择器
const pickerOut = renderToString(
  <OptionsPicker options={['甲', '乙']} onSelect={() => {}} onDismiss={() => {}} />,
);
check('OptionsPicker 渲染', pickerOut.includes('❯ 甲') && pickerOut.includes('  乙') && pickerOut.includes('Esc'));

// 消息渲染（各类型）
for (const t of [MessageType.USER, MessageType.ASSISTANT, MessageType.TOOL, MessageType.ERROR]) {
  const out = renderToString(
    <MessageItem message={{ id: 'm1', type: t, content: '测试内容', timestamp: Date.now() }} />,
  );
  check(`MessageItem ${t}`, out.includes('测试内容') && out.includes(t), out.slice(0, 60));
}

// 会话选择
const sessOut = renderToString(
  <SessionSelect
    sessions={[
      { id: 'a1', title: '会话A', createdAt: 1, updatedAt: 1, status: 'active' },
      { id: 'b2', title: '会话B', createdAt: 2, updatedAt: 2, status: 'active' },
    ]}
    onSelect={() => {}}
    onCancel={() => {}}
  />,
);
check('SessionSelect 渲染', sessOut.includes('会话A') && sessOut.includes('会话B') && sessOut.includes('选择'));

// 空会话
const emptyOut = renderToString(<SessionSelect sessions={[]} onSelect={() => {}} onCancel={() => {}} />);
check('SessionSelect 空态', emptyOut.includes('没有可恢复'));

// 提问向导（单选 + 多选 + 文本）
const q1 = renderToString(
  <InteractionWizard id="i1" questions={[{ question: '选哪个方案？', header: '方案', options: ['A', 'B'] }]} onDone={() => {}} />,
);
check('向导标题', q1.includes('Agent 提问') && q1.includes('1/1'));
check('问题与选项', q1.includes('选哪个方案？') && q1.includes('A') && q1.includes('B'));

const q2 = renderToString(
  <InteractionWizard
    id="i2"
    questions={[
      { question: '你的名字？' },
      { question: '选颜色', options: ['红', '蓝'], multiSelect: true },
    ]}
    onDone={() => {}}
  />,
);
check('多题进度与文本行', q2.includes('1/2') && q2.includes('▍'));

// 多选标记（首题即多选时直接可见）
const q3 = renderToString(
  <InteractionWizard id="i3" questions={[{ question: '选颜色', options: ['红', '蓝'], multiSelect: true }]} onDone={() => {}} />,
);
check('多选标记', q3.includes('[ ]') && q3.includes('空格切换选中'));

const m: Message = { id: 'x', type: MessageType.SYSTEM, content: '', timestamp: 0 };
check('types 导出', m.type === 'SYSTEM');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
