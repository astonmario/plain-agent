import { useEffect, useRef, useState, useCallback, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, Session, ChatMessage, InteractionQuestion } from '@plain-agent/domain/types';
import type { AgentClient, AppSettings, SkillDetail, SkillSummary, AppConfig, HistoryUsage, Workspace } from './api-client';
import { McpConfigModal } from './McpConfig';
import { SkillDiscovery } from './SkillDiscovery';
import { THEMES, applyTheme, getStoredTheme, type ThemeId } from './theme';
import './styles.css';
import './extensions.css';

interface AppProps {
  client: AgentClient;
}

// 与 domain/src/skills.ts 的 SKILL_NAME_RE 保持一致（渲染端不引 domain 运行时，避免打包 node 模块）
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

const IconSkills = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
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
  kind: 'user' | 'assistant' | 'tool' | 'tool-group' | 'system' | 'error' | 'warning';
  text: string;
  meta?: string;
  /** 一轮 loop 内的工具调用列表（kind = tool-group 时使用） */
  tools?: ToolCallItem[];
  timestamp: number;
}

/** 单次工具调用展示项 */
interface ToolCallItem {
  name: string;
  /** LLM 的 tool_call.id，用于并发工具的 start/result 精确配对 */
  callId?: string;
  meta?: string;
  result?: string;
  duration?: number;
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

function App({ client }: AppProps) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  /** 正在等待模型首个 token：瞬时状态，不写入消息列表 */
  const [thinking, setThinking] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [usage, setUsage] = useState<HistoryUsage | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showSkillDiscovery, setShowSkillDiscovery] = useState(false);
  const [showMcpConfig, setShowMcpConfig] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [settingsForm, setSettingsForm] = useState<AppSettings | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  /** ask_question 待回答的交互（agent 阻塞等答案，模态展示） */
  const [interaction, setInteraction] = useState<{ id: string; questions: InteractionQuestion[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 当前正在流式输出的文本（在 ref 中累积，不放进 messages，避免高频 setState 竞争） */
  const streamRef = useRef<{ text: string; timestamp: number } | null>(null);
  /** 流式内容变化计数，用于触发重渲染 */
  const [streamVersion, setStreamVersion] = useState(0);
  /** 当前聚合工具卡片的消息 id（同一轮 loop 的 tool_start/tool_result 归为一组） */
  const toolGroupIdRef = useRef<string | null>(null);
  /** 防止 StrictMode 双跑 effect 导致重复初始化会话 */
  const initializedRef = useRef(false);
  /** EventSource 引用，用于订阅 SSE 事件 */
  const eventSourceRef = useRef<EventSource | null>(null);
  /** 当前主题（仅渲染层，持久化在 localStorage） */
  const [theme, setTheme] = useState<ThemeId>(() => getStoredTheme());

  // 主题变化时立即应用到根节点
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 可选能力：客户端未实现对应接口时不显示入口（如 Web 端无技能发现/工作区）
  const supportsSkillDiscovery = Boolean(
    client.searchRemoteSkills && client.getRemoteSkillDetail && client.installRemoteSkill
  );
  const supportsWorkspace = Boolean(client.getWorkspace && client.selectWorkspace && client.clearWorkspace);

  // 滚动到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  // 初始化：加载配置、会话列表，订阅事件
  useEffect(() => {
    client.getConfig?.().then(setConfig);
    client.getWorkspace?.().then(setWorkspace);

    // StrictMode 下 effect 会执行两次，用 ref 保证会话初始化只跑一次
    // （注意：只守卫 initialize，事件订阅必须照常建立/清理）
    if (!initializedRef.current) {
      initializedRef.current = true;
      initialize();
    }

    const unsubscribe = client.onEvent?.(handleAgentEvent);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshUsage = useCallback(async () => {
    const u = await client.getHistoryUsage?.();
    setUsage(u ?? null);
  }, [client]);

  /** 刷新会话列表（不切换） */
  const refreshSessions = useCallback(async () => {
    const list = await client.listSessions();
    setSessions(list);
  }, []);

  /** 切换到指定会话（加载历史消息） */
  const switchToSession = useCallback(async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
    setIsRunning(false);
    setThinking(false);
    streamRef.current = null;
    toolGroupIdRef.current = null;
    await client.switchSession?.(sessionId);
    // 会话级工作区：切换会话时同步刷新
    const ws = await client.getWorkspace?.();
    setWorkspace(ws ?? null);
    const history = await client.getMessages(sessionId, true);
    const uiMessages = history.map(historyToUI).filter((m): m is UIMessage => m !== null);
    setMessages(uiMessages);
    refreshUsage();
  }, [client, refreshUsage]);

  /** 新建会话并切换过去 */
  const createNewSession = useCallback(async () => {
    const session = await client.createSession('新会话');
    setCurrentSessionId(session.sessionId);
    setMessages([]);
    setUsage(null);
    setIsRunning(false);
    setThinking(false);
    streamRef.current = null;
    toolGroupIdRef.current = null;
    // 新会话绑定当前工作区
    const ws = await client.getWorkspace?.();
    setWorkspace(ws ?? null);
    await refreshSessions();
  }, [refreshSessions]);

  /** 首次启动：有历史会话则切换，否则新建 */
  const initialize = useCallback(async () => {
    const list = await client.listSessions();
    if (list.length > 0) {
      setSessions(list);
      await switchToSession(list[0].id);
    } else {
      await createNewSession();
    }
  }, [switchToSession, createNewSession]);

  /** 打开设置弹窗（加载当前配置） */
  const openSettings = useCallback(async () => {
    const settings = await client.getSettings();
    setSettingsForm(settings);
    setShowSettings(true);
  }, []);

  /** 保存设置 */
  const saveSettings = useCallback(async () => {
    if (!settingsForm) return;
    await client.updateSettings(settingsForm);
    setShowSettings(false);
    client.getConfig?.().then((cfg) => cfg && setConfig(cfg));
    // 默认文件夹可能在此次保存后生效，同步当前工作区
    const ws = await client.getWorkspace?.();
    if (ws !== undefined) setWorkspace(ws ?? null);
  }, [client, settingsForm]);

  /** 选择工作区（用户取消对话框时保持原状） */
  const selectWorkspace = useCallback(async () => {
    const ws = await client.selectWorkspace?.();
    if (ws) {
      setWorkspace(ws);
    }
  }, [client]);

  /** 清除工作区：回到默认文件夹 */
  const clearWorkspace = useCallback(async () => {
    if (!confirm('确定要清除当前工作区吗？将回到默认文件夹。')) return;
    await client.clearWorkspace?.();
    const ws = await client.getWorkspace?.();
    setWorkspace(ws ?? null);
  }, [client]);

  /** 选择默认文件夹（仅桌面端；不改变当前工作区） */
  const pickDefaultFolder = useCallback(async () => {
    if (!client.pickFolder) return;
    const path = await client.pickFolder();
    if (path) {
      setSettingsForm((prev) => (prev ? { ...prev, defaultWorkspace: path } : prev));
    }
  }, [client]);

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
    await client.renameSession(sessionId, newTitle);
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

    await client.deleteSession(sessionId);
    await refreshSessions();

    // 如果删除的是当前会话，切换到第一个会话或新建
    if (sessionId === currentSessionId) {
      const list = await client.listSessions();
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
        setThinking(false);
        appendMessage({ kind: 'user', text: event.message, timestamp: event.timestamp });
        break;

      case 'text_delta': {
        // 文本输出开始后，工具组收尾
        closeToolGroup();
        setThinking(false);
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
        setThinking(false);
        if (!flushStreaming()) {
          appendMessage({ kind: 'assistant', text: event.message, timestamp: event.timestamp });
        }
        break;

      case 'thinking':
        // 瞬时提示：回答/工具/结束事件都会清掉，不写入消息列表
        setThinking(true);
        break;

      case 'tool_start': {
        // 文本段落（如思考过程）在工具卡片前收尾
        flushStreaming();
        setThinking(false);
        // 同一轮 loop 的多个工具调用聚合到一张卡片
        const gid = toolGroupIdRef.current;
        const item: ToolCallItem = {
          name: event.tool,
          callId: event.callId,
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
        // 结果挂载到组内对应工具：有 callId 按其精确配对（同轮工具可能并发），否则取同名且尚无结果的最后一个；
        // 无匹配则补一条（如工具未找到/参数解析失败）
        const gid = toolGroupIdRef.current;
        if (!gid) break;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== gid || !m.tools) return m;
            const idx = [...m.tools].map((t, i) => ({ t, i }))
              .filter(({ t }) => !t.result && (event.callId ? t.callId === event.callId : t.name === event.tool))
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
        setThinking(false);
        setInteraction(null);
        break;

      case 'done':
        flushStreaming();
        closeToolGroup();
        setIsRunning(false);
        setThinking(false);
        setInteraction(null);
        refreshUsage();
        break;

      case 'stopped':
        flushStreaming();
        closeToolGroup();
        appendMessage({ kind: 'system', text: '任务已停止', timestamp: event.timestamp });
        setIsRunning(false);
        setThinking(false);
        setInteraction(null);
        break;

      case 'task-start':
        setIsRunning(true);
        setThinking(false);
        break;

      case 'interaction':
        // ask_question：弹出提问模态，阻塞等用户回答
        setThinking(false);
        setInteraction({ id: event.id, questions: event.questions });
        break;

      case 'task-end':
        flushStreaming();
        closeToolGroup();
        setIsRunning(false);
        setThinking(false);
        setInteraction(null);
        break;
    }
  }, [refreshUsage, flushStreaming, closeToolGroup]);

  const appendMessage = (msg: Omit<UIMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: nextId() }]);
  };

  /** 提交任务文本（输入框和选项点击共用） */
  const submitTask = async (task: string) => {
    try {
      // 使用 submitTask 而不是 submit，传入 currentSessionId
      const eventSource = client.submitTask(currentSessionId, task);

      eventSource.onmessage = (e) => {
        try {
          const frame = JSON.parse(e.data);
          handleAgentEvent(frame.event);
        } catch (err) {
          console.error('Failed to parse SSE message:', err);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
      };

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

  // 只有最后一条 assistant 消息的选项可点，历史问答里的选项全部禁用
  const lastAssistantId = [...messages].reverse().find((m) => m.kind === 'assistant')?.id;

  const handleSubmit = async () => {
    const task = input.trim();
    if (!task || isRunning) return;
    setInput('');
    await submitTask(task);
  };

  const handleStop = async () => {
    await client.stopTask(currentSessionId);
  };

  const handleCompress = async () => {
    if (isRunning) return; // 正在运行时禁止压缩
    await client.compactHistory(currentSessionId, false);
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

        {/* 工作区选择 */}
        {supportsWorkspace && (
          <div className="workspace-section">
            {workspace ? (
              <div className="workspace-active">
                <div className="workspace-info">
                  <span className="workspace-icon">📁</span>
                  <div className="workspace-details">
                    <span className="workspace-name">{workspace.name}</span>
                    <span className="workspace-path">{workspace.path}</span>
                  </div>
                </div>
                <button className="btn-workspace-clear" onClick={clearWorkspace} title="清除工作区">
                  ✕
                </button>
              </div>
            ) : (
              <button className="btn-select-workspace" onClick={selectWorkspace}>
                <span className="workspace-icon">📁</span>
                <span>选择工作区</span>
              </button>
            )}
          </div>
        )}

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
                className={`usage-badge ${isRunning ? 'disabled' : ''}`}
                onClick={handleCompress}
                disabled={isRunning}
                title={isRunning
                  ? '正在处理中，请稍候...'
                  : `Token: ${usage.tokens}/${usage.maxTokens} (${usage.percentage.toFixed(1)}%) - 点击手动压缩`}
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
            <button className="btn-settings" onClick={() => setShowSkills(true)} title="技能管理">
              <IconSkills />
            </button>
            {supportsSkillDiscovery && (
              <button className="btn-settings" onClick={() => setShowSkillDiscovery(true)} title="技能发现">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/>
                  <path d="m21 21-4.35-4.35"/>
                </svg>
              </button>
            )}
            <button className="btn-settings" onClick={() => setShowMcpConfig(true)} title="MCP 配置">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7"/>
                <rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/>
              </svg>
            </button>
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
              disabled={isRunning || msg.id !== lastAssistantId}
            />
          ))}
          {/* 思考中的瞬时提示：不进消息列表，回答/工具/结束事件到达即消失 */}
          {thinking && isRunning && !streamRef.current && (
            <div className="message message-thinking thinking-indicator">
              <div className="message-body">思考中...</div>
            </div>
          )}
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
          theme={theme}
          onThemeChange={setTheme}
          supportsWorkspace={supportsWorkspace}
          onPickFolder={client.pickFolder ? pickDefaultFolder : undefined}
        />
      )}

      {/* 技能管理弹窗 */}
      {showSkills && (
        <SkillsModal client={client} onClose={() => setShowSkills(false)} />
      )}

      {/* 技能发现弹窗 */}
      {showSkillDiscovery && (
        <div className="modal-overlay" onClick={() => setShowSkillDiscovery(false)}>
          <div className="modal skill-discovery-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowSkillDiscovery(false)}>
              <IconClose />
            </button>
            <SkillDiscovery client={client} hasWorkspace={workspace !== null} />
          </div>
        </div>
      )}

      {/* MCP 配置弹窗 */}
      {showMcpConfig && (
        <McpConfigModal client={client} onClose={() => setShowMcpConfig(false)} />
      )}

      {/* ask_question 提问模态（agent 阻塞等答案） */}
      {interaction && (
        <InteractionModal
          questions={interaction.questions}
          onSubmit={(answers) => {
            void client.answerInteraction(interaction.id, answers);
            setInteraction(null);
          }}
          onSkip={() => {
            // 全部留空提交 → 工具侧 formatAnswers 记为 (no answer)，loop 继续
            void client.answerInteraction(interaction.id, interaction.questions.map(() => ''));
            setInteraction(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * 技能管理弹窗：左侧列表 + 右侧编辑表单；只操作用户全局技能
 */
function SkillsModal({ client, onClose }: { client: AgentClient; onClose: () => void }) {
  const [list, setList] = useState<SkillSummary[]>([]);
  /** 当前选中的技能名；null = 新建模式 */
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [message, setMessage] = useState('');
  const nameValid = SKILL_NAME_RE.test(name.trim());

  const refresh = useCallback(async () => {
    setList(await client.listSkills());
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = async (s: SkillSummary) => {
    const detail = await client.readSkill?.(s.name);
    if (!detail) return;
    setSelected(detail.name);
    setName(detail.name);
    setDescription(detail.description || '');
    setContent(detail.content);
    setMessage('');
  };

  const startNew = () => {
    setSelected(null);
    setName('');
    setDescription('');
    setContent('');
    setMessage('');
  };

  const canSave = nameValid && description.trim().length > 0 && content.trim().length > 0;

  const save = async () => {
    try {
      await client.saveSkill(name.trim(), content.trim());
      setMessage('保存成功');
      await refresh();
      if (selected === null) {
        // 新建成功才清空输入框，便于接着填下一个；提示信息保留让用户确认结果
        setName('');
        setDescription('');
        setContent('');
      } else {
        setSelected(name.trim());
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`确定删除技能 "${selected}"？此操作不可恢复。`)) return;
    try {
      await client.deleteSkill(selected);
      setMessage('删除成功');
      await refresh();
      startNew();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal skills-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>技能管理</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="skills-layout">
          <aside className="skills-manager-list">
            <button className="skills-new" onClick={startNew}>＋ 新建技能</button>
            {list.map((s) => (
              <button
                key={s.name}
                className={`skills-item ${selected === s.name ? 'active' : ''}`}
                onClick={() => select(s)}
                title={s.description}
              >
                <span className="skills-item-name">{s.name}</span>
                <span className="skills-item-desc">{s.description}</span>
              </button>
            ))}
            {list.length === 0 && <div className="skills-empty">还没有技能</div>}
          </aside>
          <div className="skills-form">
            <div className="form-field">
              <label>技能名（小写字母/数字/连字符，创建后不可改）</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={selected !== null}
                placeholder="如 pdf-merge"
              />
              {!nameValid && name.length > 0 && (
                <div className="form-hint" style={{ color: 'var(--danger, #ef4444)' }}>
                  只允许小写字母、数字、连字符（1-64 位）
                </div>
              )}
            </div>
            <div className="form-field">
              <label>一句话描述（会注入技能目录，供 Agent 判断何时使用）</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="如：合并多个 PDF 文件"
              />
            </div>
            <div className="form-field skills-content-field">
              <label>技能正文（Markdown：步骤、注意事项、脚本用法）</label>
              <textarea
                className="skills-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={'## 步骤\n1. …\n\n## 注意事项\n- …'}
              />
            </div>
            {message && <div className="form-hint">{message}</div>}
            <div className="modal-actions">
              {selected && (
                <button className="btn btn-cancel" onClick={remove}>删除</button>
              )}
              <button className="btn btn-send" onClick={save} disabled={!canSave}>
                {selected ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * ask_question 提问模态：选项题渲染单选/多选，开放题渲染文本框
 */
function InteractionModal({ questions, onSubmit, onSkip }: {
  questions: InteractionQuestion[];
  onSubmit: (answers: string[]) => void;
  onSkip: () => void;
}) {
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ''));
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));

  const allAnswered = questions.every((q, i) =>
    q.options?.length ? picked[i].length > 0 : texts[i].trim().length > 0,
  );

  const submit = () => {
    onSubmit(questions.map((q, i) => (q.options?.length ? picked[i].join(', ') : texts[i].trim())));
  };

  return (
    <div className="modal-overlay">
      <div className="modal interaction-modal">
        <div className="modal-title">Agent 提问</div>
        <div className="interaction-questions">
          {questions.map((q, i) => (
            <div key={i} className="interaction-question">
              {q.header && <div className="interaction-header">{q.header}</div>}
              <div className="interaction-q">{q.question}</div>
              {q.options?.length ? (
                <div className="interaction-options">
                  {q.options.map((opt) => {
                    const checked = picked[i].includes(opt);
                    return (
                      <label key={opt} className={`interaction-option ${checked ? 'checked' : ''}`}>
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`q-${i}`}
                          checked={checked}
                          onChange={() => {
                            setPicked((prev) => {
                              const next = [...prev];
                              if (q.multiSelect) {
                                next[i] = checked ? next[i].filter((o) => o !== opt) : [...next[i], opt];
                              } else {
                                next[i] = [opt];
                              }
                              return next;
                            });
                          }}
                        />
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <input
                  className="interaction-input"
                  value={texts[i]}
                  onChange={(e) => setTexts((prev) => prev.map((t, j) => (j === i ? e.target.value : t)))}
                  placeholder="输入回答…"
                />
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onSkip}>跳过</button>
          <button className="btn btn-send" onClick={submit} disabled={!allAnswered}>提交</button>
        </div>
      </div>
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

  // 其他类型（system/error/warning）
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
  theme,
  onThemeChange,
  supportsWorkspace,
  onPickFolder,
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onSave: () => void;
  onClose: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  supportsWorkspace?: boolean;
  onPickFolder?: () => void;
}) {
  const update = <K extends keyof AppSettings>(field: K, value: AppSettings[K] | undefined) => {
    onChange({ ...settings, [field]: value });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="modal-close" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-field">
            <label>外观主题</label>
            <div className="theme-picker">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`theme-swatch${theme === t.id ? ' active' : ''}`}
                  onClick={() => onThemeChange(t.id)}
                  title={t.label}
                >
                  <span className="theme-dot" style={{ background: t.accent }} />
                  <span className="theme-label">{t.label}</span>
                </button>
              ))}
            </div>
            <span className="form-hint">仅影响本机界面，选择后立即生效并自动保存</span>
          </div>

          <div className="form-field">
            <label>API Key</label>
            <input
              className="api-key-input"
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

          {supportsWorkspace && (
            <div className="form-field">
              <label>默认文件夹（可选）</label>
              <div className="folder-input-row">
                <input
                  type="text"
                  value={settings.defaultWorkspace ?? ''}
                  onChange={(e) => update('defaultWorkspace', e.target.value || undefined)}
                  placeholder="例如 D:\code\my-project"
                />
                {onPickFolder && (
                  <button type="button" className="btn-browse" onClick={onPickFolder}>
                    选择…
                  </button>
                )}
              </div>
              <span className="form-hint">
                启动时若未选择工作区，将自动使用该目录；留空则使用「文档\plain-agent-default-workspace」
              </span>
            </div>
          )}

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
              value={settings.permissionMode ?? 'standard'}
              onChange={(e) => update('permissionMode', e.target.value as AppSettings['permissionMode'])}
            >
              <option value="standard">标准（危险操作需确认）</option>
              <option value="trust">信任（全部允许）</option>
              <option value="ask">询问（危险操作询问用户）</option>
            </select>
          </div>

          <div className="form-field">
            <label>HTTP 代理（可选）</label>
            <input
              type="text"
              value={settings.proxy ?? ''}
              onChange={(e) => update('proxy', e.target.value || undefined)}
              placeholder="http://127.0.0.1:7890"
            />
            <span className="form-hint">用于 web 工具、MCP SSE、LLM API 等网络请求</span>
          </div>

          <div className="form-field">
            <label>代理白名单（可选）</label>
            <input
              type="text"
              value={settings.noProxy ?? ''}
              onChange={(e) => update('noProxy', e.target.value || undefined)}
              placeholder="localhost,127.0.0.1"
            />
            <span className="form-hint">逗号分隔的域名/IP，这些地址直连不走代理</span>
          </div>

          {/* GitHub Token（技能发现用） */}
          <div className="form-section">
            <h3>GitHub Token（可选）</h3>
            <div className="form-group">
              <label>Personal Access Token</label>
              <input
                type="password"
                value={(settings as any).githubToken ?? ''}
                onChange={(e) => update('githubToken', e.target.value || undefined)}
                placeholder="ghp_..."
              />
              <span className="form-hint">用于技能发现搜索社区技能，无 Token 时仅返回官方索引。生成地址: <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">github.com/settings/tokens</a></span>
            </div>
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

export { App };
