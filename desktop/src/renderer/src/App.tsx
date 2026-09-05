import { useEffect, useRef, useState, useCallback, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, Session, ChatMessage } from '@plain-agent/domain/types';
import type { AppSettings } from '../../shared/desktop-api';

// ============ SVG 图标组件 ============

const IconRobot = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="10" rx="2"/>
    <circle cx="12" cy="5" r="2"/>
    <path d="M12 7v4"/>
    <line x1="8" y1="16" x2="8" y2="16"/>
    <line x1="16" y1="16" x2="16" y2="16"/>
  </svg>
);

const IconPlus = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"/>
  </svg>
);

const IconMessage = () => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const IconAlert = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const IconDot = ({ color }: { color: string }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={color} stroke="none">
    <circle cx="12" cy="12" r="10"/>
  </svg>
);

const IconClose = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const IconUser = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const IconTool = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
);

const IconEdit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
);

const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

// ============ 类型定义 ============

/**
 * UI 展示条目（由 agent 事件映射而来）
 */
interface UIMessage {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tool-group' | 'system' | 'error' | 'warning';
  text: string;
  meta?: string;
  /** 一轮 loop 内的工具调用列表（kind = tool-group 时使用） */
  tools?: ToolCallItem[];
  timestamp: number;
}

/** 单次工具调用展示项 */
interface ToolCallItem {
  name: string;
  meta?: string;
  result?: string;
  duration?: number;
}

interface Config {
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  permissionMode: string;
}

interface HistoryUsage {
  tokens: number;
  maxTokens: number;
  percentage: number;
  needsCompression: boolean;
}

let messageSeq = 0;
function nextId(): string {
  return `ui-${++messageSeq}`;
}

/** 将历史 ChatMessage 转换为 UI 消息（system prompt 不外显） */
function historyToUI(msg: ChatMessage): UIMessage | null {
  if (msg.role === 'system') return null;
  if (!msg.content && !msg.tool_calls) return null;
  const kindMap: Record<string, UIMessage['kind']> = {
    user: 'user',
    assistant: 'assistant',
    tool: 'tool',
    system: 'system',
  };
  return {
    id: nextId(),
    kind: kindMap[msg.role] || 'system',
    text: msg.content || (msg.tool_calls ? '[调用工具]' : ''),
    timestamp: Date.now(),
  };
}

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [usage, setUsage] = useState<HistoryUsage | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<AppSettings | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  /** 当前正在流式输出的文本（在 ref 中累积，不放进 messages，避免高频 setState 竞争） */
  const streamRef = useRef<{ text: string; timestamp: number } | null>(null);
  /** 流式内容变化计数，用于触发重渲染 */
  const [streamVersion, setStreamVersion] = useState(0);
  /** 当前聚合工具卡片的消息 id（同一轮 loop 的 tool_start/tool_result 归为一组） */
  const toolGroupIdRef = useRef<string | null>(null);
  /** 防止 StrictMode 双跑 effect 导致重复初始化会话 */
  const initializedRef = useRef(false);

  // 滚动到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // 初始化：加载配置、会话列表，订阅事件
  useEffect(() => {
    window.api.getConfig().then(setConfig);

    // StrictMode 下 effect 会执行两次，用 ref 保证会话初始化只跑一次
    // （注意：只守卫 initialize，事件订阅必须照常建立/清理）
    if (!initializedRef.current) {
      initializedRef.current = true;
      initialize();
    }

    const unsubscribe = window.api.onEvent(handleAgentEvent);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshUsage = useCallback(async () => {
    const u = await window.api.getHistoryUsage();
    setUsage(u);
  }, []);

  /** 刷新会话列表（不切换） */
  const refreshSessions = useCallback(async () => {
    const list = await window.api.listSessions();
    setSessions(list);
  }, []);

  /** 切换到指定会话（加载历史消息） */
  const switchToSession = useCallback(async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
    setIsRunning(false);
    streamRef.current = null;
    toolGroupIdRef.current = null;
    await window.api.switchSession(sessionId);
    const history = await window.api.getMessages(true);
    const uiMessages = history.map(historyToUI).filter((m): m is UIMessage => m !== null);
    setMessages(uiMessages);
    refreshUsage();
  }, [refreshUsage]);

  /** 新建会话并切换过去 */
  const createNewSession = useCallback(async () => {
    const session = await window.api.createSession('新会话');
    setCurrentSessionId(session.id);
    setMessages([]);
    setUsage(null);
    streamRef.current = null;
    toolGroupIdRef.current = null;
    await refreshSessions();
  }, [refreshSessions]);

  /** 首次启动：有历史会话则切换，否则新建 */
  const initialize = useCallback(async () => {
    const list = await window.api.listSessions();
    if (list.length > 0) {
      setSessions(list);
      await switchToSession(list[0].id);
    } else {
      await createNewSession();
    }
  }, [switchToSession, createNewSession]);

  /** 打开设置弹窗（加载当前配置） */
  const openSettings = useCallback(async () => {
    const settings = await window.api.getSettings();
    setSettingsForm(settings);
    setShowSettings(true);
  }, []);

  /** 保存设置 */
  const saveSettings = useCallback(async () => {
    if (!settingsForm) return;
    await window.api.updateSettings(settingsForm);
    setShowSettings(false);
    window.api.getConfig().then(setConfig);
  }, [settingsForm]);

  /** 开始编辑会话标题 */
  const startEditSession = useCallback((sessionId: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(sessionId);
    setEditingTitle(currentTitle);
  }, []);

  /** 保存会话标题 */
  const saveSessionTitle = useCallback(async (sessionId: string) => {
    const newTitle = editingTitle.trim();
    if (!newTitle) return;
    await window.api.renameSession(sessionId, newTitle);
    setEditingSessionId(null);
    await refreshSessions();
  }, [editingTitle, refreshSessions]);

  /** 取消编辑 */
  const cancelEdit = useCallback(() => {
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  /** 删除会话 */
  const deleteSession = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定要删除这个会话吗？')) return;

    await window.api.deleteSession(sessionId);
    await refreshSessions();

    // 如果删除的是当前会话，切换到第一个会话或新建
    if (sessionId === currentSessionId) {
      const list = await window.api.listSessions();
      if (list.length > 0) {
        await switchToSession(list[0].id);
      } else {
        await createNewSession();
      }
    }
  }, [currentSessionId, refreshSessions, switchToSession, createNewSession]);

  /**
   * 把累积的流式文本固化成一条 assistant 消息
   * @returns 是否有内容被固化
   */
  const flushStreaming = useCallback((): boolean => {
    const cur = streamRef.current;
    streamRef.current = null;
    if (cur && cur.text) {
      appendMessage({ kind: 'assistant', text: cur.text, timestamp: cur.timestamp });
      return true;
    }
    return false;
  }, []);

  /**
   * 结束当前工具聚合组：后续 tool_start 将开新卡片
   */
  const closeToolGroup = useCallback(() => {
    toolGroupIdRef.current = null;
  }, []);

  /**
   * 将 agent 事件转换为 UI 消息
   */
  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'user':
        flushStreaming();
        closeToolGroup();
        appendMessage({ kind: 'user', text: event.message, timestamp: event.timestamp });
        break;

      case 'text_delta': {
        // 文本输出开始后，工具组收尾
        closeToolGroup();
        // 在 ref 中累积（事件处理器中写 ref 是安全的；
        // 不放进 setState updater，避免 React 重放/丢弃 updater 时 ref 与列表失配）
        if (!streamRef.current) {
          streamRef.current = { text: '', timestamp: event.timestamp };
        }
        streamRef.current.text += event.delta;
        setStreamVersion((v) => v + 1);
        break;
      }

      case 'assistant':
        // 流式文本固化进消息列表（无流式内容时兜底追加）
        closeToolGroup();
        if (!flushStreaming()) {
          appendMessage({ kind: 'assistant', text: event.message, timestamp: event.timestamp });
        }
        break;

      case 'thinking':
        appendMessage({ kind: 'thinking', text: event.content, timestamp: event.timestamp });
        break;

      case 'tool_start': {
        // 文本段落（如思考过程）在工具卡片前收尾
        flushStreaming();
        // 同一轮 loop 的多个工具调用聚合到一张卡片
        const gid = toolGroupIdRef.current;
        const item: ToolCallItem = {
          name: event.tool,
          meta: JSON.stringify(event.args, null, 2).slice(0, 300),
        };
        if (!gid) {
          const id = nextId();
          toolGroupIdRef.current = id;
          appendMessage({ kind: 'tool-group', text: '', tools: [item], timestamp: event.timestamp });
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === gid ? { ...m, tools: [...(m.tools ?? []), item] } : m,
            ),
          );
        }
        break;
      }

      case 'tool_result': {
        // 结果挂载到组内同名且尚无结果的最后一个工具；无匹配则补一条（如工具未找到/参数解析失败）
        const gid = toolGroupIdRef.current;
        if (!gid) break;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== gid || !m.tools) return m;
            const idx = [...m.tools].map((t, i) => ({ t, i }))
              .filter(({ t }) => t.name === event.tool && !t.result)
              .pop()?.i;
            if (idx === undefined) {
              return {
                ...m,
                tools: [...m.tools, {
                  name: event.tool,
                  result: event.result.slice(0, 500),
                  duration: event.duration,
                }],
              };
            }
            return {
              ...m,
              tools: m.tools.map((t, i) =>
                i === idx ? { ...t, result: event.result.slice(0, 500), duration: event.duration } : t,
              ),
            };
          }),
        );
        break;
      }

      case 'iteration':
        // 新一轮迭代开始，结束上一轮的流式段落和工具组
        flushStreaming();
        closeToolGroup();
        appendMessage({ kind: 'system', text: `第 ${event.index} 轮迭代`, timestamp: event.timestamp });
        break;

      case 'compression':
        appendMessage({
          kind: 'system',
          text: `历史压缩 Level ${event.level}: ${event.tokensBefore} → ${event.tokensAfter} tokens`,
          timestamp: event.timestamp,
        });
        refreshUsage();
        break;

      case 'session-warning':
        appendMessage({
          kind: 'warning',
          text: `会话警告: ${event.suggestion}`,
          timestamp: event.timestamp,
        });
        break;

      case 'error':
        flushStreaming();
        closeToolGroup();
        appendMessage({
          kind: 'error',
          text: `错误: ${event.error.message}`,
          timestamp: event.timestamp,
        });
        // 保险：出错即复位运行状态（正常路径依赖 submit 的 reject，这里兜底）
        setIsRunning(false);
        break;

      case 'done':
        flushStreaming();
        closeToolGroup();
        setIsRunning(false);
        refreshUsage();
        break;

      case 'stopped':
        flushStreaming();
        closeToolGroup();
        appendMessage({ kind: 'system', text: '任务已停止', timestamp: event.timestamp });
        setIsRunning(false);
        break;

      case 'task-start':
        setIsRunning(true);
        break;

      case 'task-end':
        flushStreaming();
        closeToolGroup();
        setIsRunning(false);
        break;
    }
  }, [refreshUsage, flushStreaming, closeToolGroup]);

  const appendMessage = (msg: Omit<UIMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: nextId() }]);
  };

  /** 提交任务文本（输入框和选项点击共用） */
  const submitTask = async (task: string) => {
    try {
      await window.api.submit(task);
      // 任务完成后刷新会话列表（updatedAt 变化）
      await refreshSessions();
    } catch (error) {
      appendMessage({
        kind: 'error',
        text: `提交失败: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      });
      setIsRunning(false);
    }
  };

  /** 点击可选项芯片：直接作为用户消息提交 */
  const handleSelectOption = (option: string) => {
    if (isRunning) return;
    void submitTask(option);
  };

  const handleSubmit = async () => {
    const task = input.trim();
    if (!task || isRunning) return;
    setInput('');
    await submitTask(task);
  };

  const handleStop = async () => {
    await window.api.stop();
  };

  const handleCompress = async () => {
    await window.api.compressHistory(false);
    refreshUsage();
  };

  return (
    <div className="app">
      {/* 会话侧边栏 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="logo"><IconRobot /> Plain Agent</span>
          <button className="btn-new-session" onClick={createNewSession} title="新建会话">
            <IconPlus />
          </button>
        </div>
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="session-empty">暂无会话</div>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
              onClick={() => switchToSession(session.id)}
            >
              {editingSessionId === session.id ? (
                <div className="session-edit" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveSessionTitle(session.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    onBlur={() => saveSessionTitle(session.id)}
                    autoFocus
                    className="session-input"
                  />
                </div>
              ) : (
                <>
                  <div className="session-info">
                    <span className="session-title">{session.title || '未命名会话'}</span>
                    <span className="session-time">
                      {new Date(session.updatedAt).toLocaleDateString('zh-CN')}
                    </span>
                  </div>
                  <div className="session-actions">
                    <button
                      className="btn-icon"
                      onClick={(e) => startEditSession(session.id, session.title, e)}
                      title="重命名"
                    >
                      <IconEdit />
                    </button>
                    <button
                      className="btn-icon btn-danger"
                      onClick={(e) => deleteSession(session.id, e)}
                      title="删除"
                    >
                      <IconTrash />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* 主区域 */}
      <div className="main-area">
        {/* 顶部栏 */}
        <header className="header">
          <div className="header-title">
            {config && (
              <span className="config-info">
                {config.model} {config.hasApiKey ? <><IconCheck /> 已配置 Key</> : <><IconAlert /> 未配置 Key</>}
              </span>
            )}
          </div>
          <div className="header-actions">
            {usage && (
              <button
                className="usage-badge"
                onClick={handleCompress}
                title={`Token: ${usage.tokens}/${usage.maxTokens} (${usage.percentage.toFixed(1)}%)`}
              >
                <IconDot color={usage.percentage >= 75 ? '#ef4444' : usage.percentage >= 60 ? '#f59e0b' : '#22c55e'} />
                {usage.tokens}/{usage.maxTokens}
              </button>
            )}
            {currentSessionId && (
              <span className="session-badge" title={currentSessionId}>
                {currentSessionId.slice(0, 8)}
              </span>
            )}
            <button className="btn-settings" onClick={openSettings} title="设置">
              <IconSettings />
            </button>
          </div>
        </header>

        {/* 消息列表 */}
        <main className="message-list" ref={listRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon"><IconMessage /></div>
              <h2>开始对话</h2>
              <p>输入任务描述，Agent 会执行工具并返回结果</p>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              onSelectOption={handleSelectOption}
              disabled={isRunning}
            />
          ))}
          {/* 流式输出气泡：文本累积在 ref 中，streamVersion 变化触发重渲染；done 后 flushStreaming 固化成正式消息 */}
          {streamRef.current && (
            <div className="message message-assistant">
              <div className="message-row">
                <div className="avatar avatar-ai"><IconRobot /></div>
                <div className="message-body markdown-body">
                  <AssistantMarkdown
                    text={streamRef.current.text}
                    onSelectOption={handleSelectOption}
                    disabled={isRunning}
                  />
                  <span className="streaming-cursor">▍</span>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* 输入栏 */}
        <footer className="input-bar">
          <div className="input-container">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="输入任务，Enter 发送，Shift+Enter 换行"
              rows={1}
              disabled={isRunning}
            />
            <div className="input-actions">
              {isRunning ? (
                <button className="btn btn-stop" onClick={handleStop}>■ 停止</button>
              ) : (
                <button className="btn btn-send" onClick={handleSubmit} disabled={!input.trim()}>
                  发送
                </button>
              )}
            </div>
          </div>
          <div className="input-hint">内容由 AI 生成，请谨慎判断</div>
        </footer>
      </div>

      {/* 设置弹窗 */}
      {showSettings && settingsForm && (
        <SettingsModal
          settings={settingsForm}
          onChange={setSettingsForm}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/**
 * AI 回复的 Markdown 渲染（options 代码块渲染为可点击选项组）
 */
function AssistantMarkdown({ text, onSelectOption, disabled }: {
  text: string;
  onSelectOption: (option: string) => void;
  disabled?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // options 代码块渲染为可点击选项组，其余保持原样
        code: ({ className, children, ...rest }) => {
          const match = /language-(\w+)/.exec(className || '');
          if (match?.[1] === 'options') {
            const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
            return (
              <OptionsBlock
                text={raw.replace(/\n$/, '')}
                onSelect={onSelectOption}
                disabled={disabled}
              />
            );
          }
          return <code className={className} {...rest}>{children}</code>;
        },
        // options 块去掉 pre 外壳（OptionsBlock 自带容器样式）
        pre: ({ children }) => {
          if (
            isValidElement<{ className?: string }>(children) &&
            /language-options/.test(children.props?.className || '')
          ) {
            return <>{children}</>;
          }
          return <pre>{children}</pre>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * 可选项组组件
 * 模型按约定输出 ```options 代码块（每行一个选项），这里渲染成可点击的 chips
 */
function OptionsBlock({ text, onSelect, disabled }: {
  text: string;
  onSelect: (option: string) => void;
  disabled?: boolean;
}) {
  const options = text
    .split('\n')
    .map((line) =>
      line
        .trim()
        // 容错：模型偶尔会给选项加列表符号或序号
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.、)]\s*/, '')
        .trim(),
    )
    .filter(Boolean);

  if (options.length === 0) return null;

  return (
    <div className="options-block">
      {options.map((opt, i) => (
        <button
          key={i}
          type="button"
          className="option-chip"
          disabled={disabled}
          onClick={() => onSelect(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/**
 * 消息气泡组件
 */
function MessageBubble({ msg, onSelectOption, disabled }: {
  msg: UIMessage;
  onSelectOption: (option: string) => void;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  /** 复制回复原文（Markdown 源文本）到剪贴板 */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(msg.text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  // AI 消息：左侧头像 + Markdown 渲染内容 + 复制按钮
  if (msg.kind === 'assistant') {
    return (
      <div className="message message-assistant">
        <div className="message-row">
          <div className="avatar avatar-ai"><IconRobot /></div>
          <div className="message-body markdown-body">
            <AssistantMarkdown text={msg.text} onSelectOption={onSelectOption} disabled={disabled} />
          </div>
        </div>
        <div className="message-actions">
          <button
            type="button"
            className={`btn-action ${copied ? 'copied' : ''}`}
            onClick={handleCopy}
            title="复制回复内容"
          >
            {copied ? <><IconCheck /> 已复制</> : <><IconCopy /> 复制</>}
          </button>
          <span className="message-time">{time}</span>
        </div>
      </div>
    );
  }

  // 用户消息：右侧蓝色气泡
  if (msg.kind === 'user') {
    return (
      <div className="message message-user">
        <div className="message-body">{msg.text}</div>
      </div>
    );
  }

  // 工具调用组：一轮 loop 的多个工具聚合成一张折叠卡片
  if (msg.kind === 'tool-group') {
    const [expanded, setExpanded] = useState(false);
    const tools = msg.tools ?? [];
    const names = tools.map((t) => t.name);
    const summary = names.length <= 2
      ? names.join('、')
      : `${names.slice(0, 2).join('、')} 等 ${names.length} 个`;
    return (
      <div className="message message-tool">
        <div className="tool-card">
          <div className="tool-header" onClick={() => setExpanded(!expanded)}>
            <IconTool />
            <span>调用工具 {summary}</span>
            <span className="tool-toggle">{expanded ? '▼' : '▶'}</span>
          </div>
          {expanded && (
            <div className="tool-group-items">
              {tools.map((t, i) => (
                <div key={i} className="tool-group-item">
                  <div className="tool-group-item-head">
                    <IconTool />
                    <span className="tool-group-item-name">{t.name}</span>
                    {t.duration != null && <span className="tool-group-item-time">{t.duration}ms</span>}
                  </div>
                  {t.meta && <pre className="tool-params">{t.meta}</pre>}
                  {t.result && <pre className="tool-params tool-result">{t.result}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 工具调用：带折叠的卡片（历史消息）
  if (msg.kind === 'tool') {
    const [expanded, setExpanded] = useState(false);
    return (
      <div className="message message-tool">
        <div className="tool-card">
          <div className="tool-header" onClick={() => setExpanded(!expanded)}>
            <IconTool />
            <span>{msg.text}</span>
            <span className="tool-toggle">{expanded ? '▼' : '▶'}</span>
          </div>
          {expanded && msg.meta && (
            <pre className="tool-params">{msg.meta}</pre>
          )}
        </div>
      </div>
    );
  }

  // 其他类型（thinking/system/error/warning）
  return (
    <div className={`message message-${msg.kind}`}>
      <div className="message-body">{msg.text}</div>
      <div className="message-meta">
        <span className="message-time">{time}</span>
      </div>
    </div>
  );
}

/**
 * 设置弹窗组件
 */
function SettingsModal({
  settings,
  onChange,
  onSave,
  onClose,
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const update = <K extends keyof AppSettings>(field: K, value: AppSettings[K]) => {
    onChange({ ...settings, [field]: value });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="modal-close" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-field">
            <label>API Key</label>
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => update('apiKey', e.target.value)}
              placeholder="sk-..."
              autoFocus
            />
            <span className="form-hint">你的 API Key 仅保存在本地</span>
          </div>

          <div className="form-field">
            <label>模型</label>
            <input
              type="text"
              value={settings.model}
              onChange={(e) => update('model', e.target.value)}
              placeholder="deepseek-chat"
            />
          </div>

          <div className="form-field">
            <label>Base URL</label>
            <input
              type="text"
              value={settings.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
              placeholder="https://api.deepseek.com"
            />
          </div>

          <div className="form-field">
            <label>Max Tokens（可选）</label>
            <input
              type="number"
              value={settings.maxTokens ?? ''}
              onChange={(e) => update('maxTokens', e.target.value ? parseInt(e.target.value, 10) : undefined)}
              placeholder="留空使用默认"
            />
          </div>

          <div className="form-field">
            <label>权限模式</label>
            <select
              value={settings.permissionMode}
              onChange={(e) => update('permissionMode', e.target.value as AppSettings['permissionMode'])}
            >
              <option value="standard">标准（危险操作需确认）</option>
              <option value="trust">信任（全部允许）</option>
              <option value="ask">询问（危险操作询问用户）</option>
            </select>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-cancel" onClick={onClose}>取消</button>
          <button className="btn btn-send" onClick={onSave}>保存</button>
        </div>
      </div>
    </div>
  );
}

export default App;
