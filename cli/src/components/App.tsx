/**
 * TUI 顶层组件（架构借鉴 any-code/tui）
 *
 * - <Static> 放固化消息（ink 保证已渲染项不重渲）；流式文本累积在实时区，定稿后入 Static
 * - 会话切换/清屏交给 cli 层重建 Ink 实例：fullStaticOutput 是 append-only，
 *   同实例内无法清除已写入 scrollback 的旧消息（any-code 的教训）
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Box, Text, Static, useApp } from 'ink';
import type { AgentEvent, PlainAgent, SessionStorage, Session } from '@plain-agent/domain';
import { Message, MessageType, ToolCall } from '../types';
import { MessageItem } from './MessageList';
import Spinner from './Spinner';
import OptionsPicker from './OptionsPicker';
import { parseOptionsBlock } from '../options';
import InputBox, { Command } from './InputBox';
import SessionSelect from './SessionSelect';
import { InteractionWizard } from './InteractionWizard';
import { ToolCallDisplay } from './ToolCallDisplay';
import Logo from './Logo';

export interface TuiInfo {
  model: string;
  baseUrl?: string;
  toolCount: number;
  persisted: boolean;
  /** 当前项目目录（会话按项目隔离展示） */
  project?: string;
}

interface AppProps {
  createAgent: (sessionId?: string) => Promise<PlainAgent> | PlainAgent;
  /** 用于 /resume 列会话；null 表示无持久化 */
  storage: SessionStorage | null;
  info: TuiInfo;
  /** 恢复的会话 id；不传 = 新会话 */
  sessionId?: string;
  /** 恢复时是否回显历史消息（/clear 重建实例时为 false） */
  echoHistory?: boolean;
  /** cli 层重建 Ink 实例（unmount + 擦屏 + re-render） */
  onSwitchSession: (sessionId?: string) => void;
  /** cli 层擦屏重建（保留会话，清空消息显示） */
  onClearScreen: () => void;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export default function App(props: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [usage, setUsage] = useState<{ tokens: number; maxTokens: number } | null>(null);
  const [interaction, setInteraction] = useState<{ id: string; questions: any[] } | null>(null);
  const [sessionSelectMode, setSessionSelectMode] = useState(false);
  const [sessionList, setSessionList] = useState<Session[]>([]);
  /** 最新一条带 options 块的回复：接管输入，键盘选择后作为新任务提交 */
  const [pendingOptions, setPendingOptions] = useState<{ messageId: string; options: string[] } | null>(null);
  /** 当前批次的工具调用 */
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);

  const agentRef = useRef<PlainAgent | null>(null);
  const idRef = useRef(0);
  const streamRef = useRef('');
  const toolCallsRef = useRef<Map<string, ToolCall>>(new Map());
  const toolIdCounter = useRef(0);
  const initializedRef = useRef(false);

  const addMessage = useCallback((type: MessageType, content: string, options?: string[]): string => {
    idRef.current += 1;
    const msg: Message = { id: `msg-${idRef.current}`, type, content, timestamp: Date.now(), options };
    setMessages((prev) => [...prev, msg]);
    return msg.id;
  }, []);

  const flushTools = useCallback(() => {
    if (toolCallsRef.current.size > 0) {
      const calls = Array.from(toolCallsRef.current.values());
      setToolCalls(calls);
      toolCallsRef.current.clear();
    }
  }, []);

  const flushStream = useCallback(() => {
    if (streamRef.current) {
      const { text, options } = parseOptionsBlock(streamRef.current);
      const id = addMessage(MessageType.ASSISTANT, text, options ?? undefined);
      // 带可选项的回复：接管输入转键盘选择，直到选中/取消/下一条消息
      if (options) setPendingOptions({ messageId: id, options });
      streamRef.current = '';
      setStreamingText('');
    }
  }, [addMessage]);

  const refreshUsage = useCallback(() => {
    try {
      const u = agentRef.current?.getHistoryUsage();
      if (u) setUsage({ tokens: u.tokens, maxTokens: u.maxTokens });
    } catch {
      /* 忽略 */
    }
  }, []);

  // 初始化 agent（含历史恢复）
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;

    const handler = (e: AgentEvent) => {
      switch (e.type) {
        case 'user':
          flushTools();
          addMessage(MessageType.USER, e.message);
          break;
        case 'text_delta':
          streamRef.current += e.delta;
          setStreamingText(streamRef.current);
          break;
        case 'assistant':
          flushStream();
          break;
        case 'thinking':
          addMessage(MessageType.THINKING, e.content);
          break;
        case 'tool_start':
          toolIdCounter.current += 1;
          const toolId = `tool-${toolIdCounter.current}`;
          toolCallsRef.current.set(toolId, {
            id: toolId,
            tool: e.tool,
            args: e.args,
            status: 'running',
          });
          setToolCalls(Array.from(toolCallsRef.current.values()));
          break;
        case 'tool_result':
          // 查找对应的 tool_start，更新结果（从后往前找最近的匹配项）
          const toolsArray = Array.from(toolCallsRef.current.values());
          let foundTool: ToolCall | undefined;
          for (let i = toolsArray.length - 1; i >= 0; i--) {
            if (toolsArray[i].tool === e.tool && toolsArray[i].status === 'running') {
              foundTool = toolsArray[i];
              break;
            }
          }
          if (foundTool) {
            foundTool.result = e.result;
            foundTool.duration = e.duration;
            foundTool.status = 'success';
            setToolCalls([...toolCallsRef.current.values()]);
          }
          break;
        case 'iteration':
          flushTools();
          flushStream();
          addMessage(MessageType.ITERATION, `迭代 ${e.index}`);
          break;
        case 'compression':
          addMessage(MessageType.SYSTEM, `历史压缩 Level ${e.level}: ${e.tokensBefore} → ${e.tokensAfter} tokens`);
          refreshUsage();
          break;
        case 'session-warning':
          addMessage(MessageType.WARNING, `会话警告: ${e.suggestion}`);
          break;
        case 'interaction':
          flushTools();
          flushStream();
          setInteraction({ id: e.id, questions: e.questions });
          break;
        case 'error':
          flushTools();
          flushStream();
          addMessage(MessageType.ERROR, e.error.message);
          setIsProcessing(false);
          setInteraction(null);
          break;
        case 'done':
        case 'task-end':
          flushTools();
          flushStream();
          setIsProcessing(false);
          setInteraction(null);
          refreshUsage();
          break;
        case 'stopped':
          flushTools();
          flushStream();
          addMessage(MessageType.SYSTEM, '⏹ 已停止');
          setIsProcessing(false);
          setInteraction(null);
          break;
        case 'task-start':
          setIsProcessing(true);
          break;
      }
    };

    (async () => {
      const agent = await props.createAgent(props.sessionId);
      if (cancelled) {
        agent.destroy();
        return;
      }
      agentRef.current = agent;
      agent.on('event', handler);

      if (props.sessionId) {
        const count = await agent.loadHistory();
        if (cancelled) return;
        const sessId = agent.getSessionId();
        addMessage(MessageType.SYSTEM, `已恢复会话 ${sessId.slice(0, 8)}（${count} 条历史）`);
        if (props.echoHistory !== false) {
          const history = agent
            .getMessages()
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: typeof m.content === 'string' ? m.content : '',
            }));
          for (const h of history) {
            if (h.role === 'user') {
              addMessage(MessageType.USER, h.content);
            } else {
              const { text, options } = parseOptionsBlock(h.content);
              addMessage(MessageType.ASSISTANT, text, options ?? undefined);
            }
          }
        }
      } else {
        addMessage(
          MessageType.SYSTEM,
          `新会话 ${agent.getSessionId().slice(0, 8)} · ${props.info.model} · ${props.info.toolCount} 个工具${props.info.persisted ? '' : ' · 内存模式'}${props.info.project ? `\n项目: ${props.info.project}` : ''}`,
        );
      }
      refreshUsage();
    })().catch((err) => {
      if (!cancelled) {
        addMessage(MessageType.ERROR, `初始化 agent 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    return () => {
      cancelled = true;
      const agent = agentRef.current;
      if (agent) {
        agent.off('event', handler);
        agent.destroy();
        agentRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+C：运行中停止，空闲退出（InputBox/向导把 Esc/Ctrl+C 都路由到这里或自己处理）
  const handleCancel = useCallback(() => {
    if (isProcessing && agentRef.current) {
      addMessage(MessageType.SYSTEM, 'Stopping agent...');
      agentRef.current.stop();
    } else {
      exit();
    }
  }, [isProcessing, addMessage, exit]);

  const switchSession = useCallback(
    (sessionId?: string) => {
      setSessionSelectMode(false);
      setSessionList([]);
      props.onSwitchSession(sessionId);
    },
    [props],
  );

  const getCommands = useCallback((): Command[] => {
    return [
      {
        name: '/help',
        description: '显示帮助',
        handler: () => {
          addMessage(
            MessageType.SYSTEM,
            [
              '可用命令:',
              '  /history  查看历史会话列表',
              '  /resume   恢复历史会话',
              '  /new      开新会话',
              '  /clear    清屏',
              '  /usage    历史 token 用量',
              '  /compress 手动压缩历史',
              '  /stop     停止当前任务',
              '  /exit     退出',
            ].join('\n'),
          );
        },
      },
      {
        name: '/history',
        description: '查看历史会话列表',
        handler: () => {
          void (async () => {
            if (!props.storage) {
              addMessage(MessageType.SYSTEM, '内存模式：无历史会话。');
              return;
            }
            const sessions = await props.storage.listSessions();
            if (sessions.length === 0) {
              addMessage(MessageType.SYSTEM, '没有历史会话。');
              return;
            }
            const currentId = agentRef.current?.getSessionId();
            const lines: string[] = [];
            for (let i = 0; i < sessions.length; i++) {
              const s = sessions[i];
              const msgs = await props.storage!.loadMessages(s.id).catch(() => [] as unknown[]);
              const mark = s.id === currentId ? '●' : ' ';
              const time = new Date(s.updatedAt).toLocaleString();
              lines.push(
                ` ${mark} ${String(i + 1).padStart(2)}. ${s.title || '(未命名)'}  ${msgs.length} 条消息  ${time}`,
              );
            }
            lines.push('', '用 /resume 选择恢复并查看对话内容');
            addMessage(MessageType.SYSTEM, lines.join('\n'));
          })();
        },
      },
      {
        name: '/resume',
        description: '恢复历史会话',
        handler: () => {
          void (async () => {
            const sessions = props.storage ? await props.storage.listSessions() : [];
            if (sessions.length === 0) {
              addMessage(MessageType.SYSTEM, '没有可恢复的会话。');
              return;
            }
            if (sessions.length === 1) {
              switchSession(sessions[0].id);
              return;
            }
            setSessionList(sessions);
            setSessionSelectMode(true);
          })();
        },
      },
      {
        name: '/new',
        description: '开新会话',
        handler: () => switchSession(undefined),
      },
      {
        name: '/clear',
        description: '清屏',
        handler: () => props.onClearScreen(),
      },
      {
        name: '/usage',
        description: '历史 token 用量',
        handler: () => {
          refreshUsage();
          if (usage) {
            addMessage(MessageType.SYSTEM, `历史用量: ${usage.tokens}/${usage.maxTokens} tokens (${((usage.tokens / usage.maxTokens) * 100).toFixed(1)}%)`);
          }
        },
      },
      {
        name: '/compress',
        description: '手动压缩历史',
        handler: () => {
          void (async () => {
            try {
              await agentRef.current?.compressHistory();
              addMessage(MessageType.SYSTEM, '压缩完成');
            } catch (err) {
              addMessage(MessageType.ERROR, `压缩失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            refreshUsage();
          })();
        },
      },
      {
        name: '/stop',
        description: '停止当前任务',
        handler: () => agentRef.current?.stop(),
      },
      {
        name: '/exit',
        description: '退出',
        handler: () => exit(),
      },
    ];
  }, [addMessage, exit, props, refreshUsage, switchSession, usage]);

  /** 提交任务（用户消息由 agent 的 'user' 事件渲染，这里不本地添加，避免重复） */
  const runTask = useCallback(
    (value: string) => {
      if (!agentRef.current) {
        addMessage(MessageType.ERROR, 'Agent 未就绪，请稍后再试。');
        return;
      }
      setPendingOptions(null);
      setIsProcessing(true);
      agentRef.current.submit(value).catch((err) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          addMessage(MessageType.ERROR, `提交失败: ${err.message}`);
        }
      });
    },
    [addMessage],
  );

  const handleSubmit = (value: string) => {
    if (sessionSelectMode) return;

    if (isProcessing) {
      addMessage(MessageType.ERROR, '请等待当前任务完成。');
      return;
    }

    // 斜杠命令（候选已在 InputBox 内联展示，这里处理 Enter 提交）
    if (value.startsWith('/')) {
      const query = value.slice(1).trim();
      const cmds = getCommands();
      const exact = cmds.find((c) => c.name === '/' + query);
      if (exact) {
        Promise.resolve(exact.handler()).catch((err) => {
          addMessage(MessageType.ERROR, `命令执行失败: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      const partial = cmds.filter((c) => c.name.startsWith('/' + query.toLowerCase()));
      if (partial.length === 1) {
        Promise.resolve(partial[0].handler()).catch((err) => {
          addMessage(MessageType.ERROR, `命令执行失败: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      if (partial.length > 1) {
        addMessage(MessageType.SYSTEM, `多个命令匹配 "/${query}"，按 Tab 补全`);
        return;
      }
      addMessage(MessageType.SYSTEM, `未知命令: /${query}`);
      return;
    }

    runTask(value);
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* Logo - 仅在消息为空时显示 */}
      {messages.length === 0 && <Logo />}

      <Static items={messages}>
        {(message) => (
          <MessageItem
            key={message.id}
            message={message}
            showTimestamp={false}
          />
        )}
      </Static>

      {/* 工具调用显示 */}
      {toolCalls.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {toolCalls.map((call) => (
            <ToolCallDisplay key={call.id} call={call} />
          ))}
        </Box>
      )}

      {isProcessing && (
        <Box>
          <Spinner color="#F59E0B" />
          <Text color="#F59E0B">{' 处理中… '}</Text>
          {usage && (
            <Text dimColor>
              {usage.tokens}/{usage.maxTokens} tok
            </Text>
          )}
        </Box>
      )}

      {streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="#10B981" bold>
            ● Assistant
          </Text>
          <Box paddingLeft={0}>
            <Text wrap="wrap">{streamingText}</Text>
          </Box>
        </Box>
      ) : null}

      {sessionSelectMode && (
        <SessionSelect
          sessions={sessionList}
          onSelect={(sid) => switchSession(sid)}
          onCancel={() => {
            setSessionSelectMode(false);
            setSessionList([]);
          }}
        />
      )}

      {interaction ? (
        <InteractionWizard
          id={interaction.id}
          questions={interaction.questions}
          onDone={() => setInteraction(null)}
        />
      ) : pendingOptions && !isProcessing && !sessionSelectMode ? (
        <OptionsPicker
          options={pendingOptions.options}
          onSelect={(opt) => runTask(opt)}
          onDismiss={() => setPendingOptions(null)}
        />
      ) : (
        <InputBox
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          commands={getCommands()}
          active={!sessionSelectMode}
          placeholder={isProcessing ? '处理中…（Ctrl+C 停止）' : '输入任务，回车执行；/help 查看命令'}
        />
      )}
    </Box>
  );
}
