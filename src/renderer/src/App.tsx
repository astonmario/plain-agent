import { useEffect, useRef, useState, useCallback } from 'react';
import type { AgentEvent, Session, ChatMessage } from '../../agent-core/types';
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

// ============ 类型定义 ============

/**
 * UI 展示条目（由 agent 事件映射而来）
 */
interface UIMessage {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error' | 'warning';
  text: string;
  meta?: string;
  timestamp: number;
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

/** 将历史 ChatMessage 转换为 UI 消息 */
function historyToUI(msg: ChatMessage): UIMessage | null {
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

  // 滚动到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // 初始化：加载配置、会话列表，订阅事件
  useEffect(() => {
    window.api.getConfig().then(setConfig);
    initialize();

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
   * 将 agent 事件转换为 UI 消息
   */
  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'user':
        appendMessage({ kind: 'user', text: event.message, timestamp: event.timestamp });
        break;

      case 'assistant':
        appendMessage({ kind: 'assistant', text: event.message, timestamp: event.timestamp });
        break;

      case 'thinking':
        appendMessage({ kind: 'thinking', text: event.content, timestamp: event.timestamp });
        break;

      case 'tool_start':
        appendMessage({
          kind: 'tool',
          text: `调用工具: ${event.tool}`,
          meta: JSON.stringify(event.args, null, 2).slice(0, 300),
          timestamp: event.timestamp,
        });
        break;

      case 'tool_result':
        appendMessage({
          kind: 'tool',
          text: `${event.tool} 返回 (${event.duration}ms): ${event.result.slice(0, 300)}`,
          timestamp: event.timestamp,
        });
        break;

      case 'iteration':
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
        appendMessage({
          kind: 'error',
          text: `错误: ${event.error.message}`,
          timestamp: event.timestamp,
        });
        break;

      case 'done':
        setIsRunning(false);
        refreshUsage();
        break;

      case 'stopped':
        appendMessage({ kind: 'system', text: '任务已停止', timestamp: event.timestamp });
        setIsRunning(false);
        break;

      case 'task-start':
        setIsRunning(true);
        break;

      case 'task-end':
        setIsRunning(false);
        break;
    }
  }, [refreshUsage]);

  const appendMessage = (msg: Omit<UIMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: nextId() }]);
  };

  const handleSubmit = async () => {
    const task = input.trim();
    if (!task || isRunning) return;
    setInput('');
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
            <MessageBubble key={msg.id} msg={msg} />
          ))}
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
 * 消息气泡组件
 */
function MessageBubble({ msg }: { msg: UIMessage }) {
  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  // AI 消息：左侧头像 + 内容
  if (msg.kind === 'assistant') {
    return (
      <div className="message message-assistant">
        <div className="message-row">
          <div className="avatar avatar-ai"><IconRobot /></div>
          <div className="message-body">{msg.text}</div>
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

  // 工具调用：带折叠的卡片
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
