/**
 * MCP 配置页面组件
 * 管理 MCP Server 配置
 */

import { useState, useEffect, useCallback } from 'react';
import type { McpServerConfig } from '@plain-agent/domain/types';

interface McpConfigModalProps {
  onClose: () => void;
}

export function McpConfigModal({ onClose }: McpConfigModalProps) {
  const [config, setConfig] = useState<Record<string, McpServerConfig>>({});
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [serverName, setServerName] = useState('');
  const [serverType, setServerType] = useState<'stdio' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [message, setMessage] = useState('');
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [toolCount, setToolCount] = useState(0);

  // 加载配置
  const loadConfig = useCallback(async () => {
    const cfg = await window.api.getMcpConfig();
    setConfig(cfg);
    const count = await window.api.getMcpToolCount();
    setToolCount(count);
    const toolList = await window.api.getMcpTools();
    setTools(toolList);
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // 新建 MCP
  const createServer = () => {
    setEditingServer('__new__'); // 使用特殊标记表示新建模式
    setServerName('');
    setServerType('stdio');
    setCommand('npx');
    setArgs('-y @modelcontextprotocol/server-filesystem /tmp');
    setUrl('');
    setHeaders('');
    setEnv('');
    setMessage('');
  };

  // 编辑 MCP
  const editServer = (name: string) => {
    const server = config[name];
    if (!server) return;

    setEditingServer(name);
    setServerName(name);
    setServerType(server.type || 'stdio');
    setMessage('');

    if (server.type === 'stdio') {
      setCommand(server.command || '');
      setArgs((server.args || []).join(' '));
      setEnv(server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : '');
    } else if (server.type === 'sse') {
      setUrl(server.url || '');
      setHeaders(server.headers ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '');
    }
  };

  // 保存 Server
  const saveServer = async () => {
    if (!serverName.trim()) {
      setMessage('服务器名称不能为空');
      return;
    }

    const newServer: McpServerConfig = serverType === 'stdio'
      ? {
          type: 'stdio',
          command: command.trim(),
          args: args.trim() ? args.trim().split(/\s+/) : undefined,
          env: env.trim()
            ? Object.fromEntries(
                env.split('\n')
                  .filter(line => line.includes('='))
                  .map(line => {
                    const [k, ...v] = line.split('=');
                    return [k.trim(), v.join('=').trim()];
                  })
              )
            : undefined,
        }
      : {
          type: 'sse',
          url: url.trim(),
          headers: headers.trim()
            ? Object.fromEntries(
                headers.split('\n')
                  .filter(line => line.includes(':'))
                  .map(line => {
                    const [k, ...v] = line.split(':');
                    return [k.trim(), v.join(':').trim()];
                  })
              )
            : undefined,
        };

    const newConfig = { ...config, [serverName]: newServer };

    try {
      await window.api.saveMcpConfig(newConfig);
      setMessage('保存成功！重新加载中...');
      await window.api.reloadMcp();
      await loadConfig();
      setEditingServer(null);
      setServerName('');
      setMessage('配置已生效');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(`保存失败: ${(err as Error).message}`);
    }
  };

  // 删除 Server
  const deleteServer = async (name: string) => {
    if (!confirm(`确定删除 MCP Server "${name}"？`)) return;

    const newConfig = { ...config };
    delete newConfig[name];

    try {
      await window.api.saveMcpConfig(newConfig);
      await window.api.reloadMcp();
      await loadConfig();
      setMessage('已删除');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(`删除失败: ${(err as Error).message}`);
    }
  };

  // 切换启用/禁用
  const toggleServer = async (name: string) => {
    const server = config[name];
    if (!server) return;

    const newConfig = {
      ...config,
      [name]: { ...server, disabled: !server.disabled },
    };

    try {
      await window.api.saveMcpConfig(newConfig);
      await window.api.reloadMcp();
      await loadConfig();
    } catch (err) {
      setMessage(`操作失败: ${(err as Error).message}`);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>MCP 配置</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body mcp-body">
          {/* 左侧：服务器列表 */}
          <div className="mcp-sidebar">
            <div className="mcp-stats">
              <div className="stat-item">
                <span className="stat-label">服务器</span>
                <span className="stat-value">{Object.keys(config).length}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">工具</span>
                <span className="stat-value">{toolCount}</span>
              </div>
            </div>

            <button className="btn-primary mcp-add-btn" onClick={createServer}>
              + 新建 MCP
            </button>

            <div className="mcp-server-list">
              {Object.entries(config).map(([name, server]) => (
                <div
                  key={name}
                  className={`mcp-server-item ${editingServer === name ? 'active' : ''} ${server.disabled ? 'disabled' : ''}`}
                  onClick={() => editServer(name)}
                >
                  <div className="server-info">
                    <div className="server-name">{name}</div>
                    <div className="server-type">{server.type || 'stdio'}</div>
                  </div>
                  <div className="server-actions">
                    <button
                      className="btn-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleServer(name);
                      }}
                      title={server.disabled ? '启用' : '禁用'}
                    >
                      {server.disabled ? '○' : '●'}
                    </button>
                    <button
                      className="btn-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteServer(name);
                      }}
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* 已加载的工具列表 */}
            {tools.length > 0 && (
              <div className="mcp-tools-section">
                <h3>已加载工具 ({tools.length})</h3>
                <div className="mcp-tools-list">
                  {tools.map((tool) => (
                    <div key={tool.name} className="mcp-tool-item" title={tool.description}>
                      <span className="tool-name">{tool.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 右侧：编辑表单 */}
          <div className="mcp-editor">
            {editingServer ? (
              <>
                <div className="form-field">
                  <label>服务器名称</label>
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder="my-server"
                    disabled={editingServer !== '__new__'}
                  />
                </div>

                <div className="form-field">
                  <label>传输类型</label>
                  <select value={serverType} onChange={(e) => setServerType(e.target.value as 'stdio' | 'sse')}>
                    <option value="stdio">Stdio (本地进程)</option>
                    <option value="sse">SSE (远程 HTTP)</option>
                  </select>
                </div>

                {serverType === 'stdio' ? (
                  <>
                    <div className="form-field">
                      <label>命令</label>
                      <input
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="npx"
                      />
                    </div>

                    <div className="form-field">
                      <label>参数</label>
                      <input
                        type="text"
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        placeholder="-y @modelcontextprotocol/server-filesystem /path"
                      />
                      <span className="form-hint">用空格分隔</span>
                    </div>

                    <div className="form-field">
                      <label>环境变量（可选）</label>
                      <textarea
                        value={env}
                        onChange={(e) => setEnv(e.target.value)}
                        placeholder="API_KEY=xxx&#10;DEBUG=true"
                        rows={3}
                      />
                      <span className="form-hint">每行一个，格式: KEY=VALUE</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="form-field">
                      <label>URL</label>
                      <input
                        type="text"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://example.com/mcp"
                      />
                    </div>

                    <div className="form-field">
                      <label>Headers（可选）</label>
                      <textarea
                        value={headers}
                        onChange={(e) => setHeaders(e.target.value)}
                        placeholder="Authorization: Bearer token&#10;X-Custom: value"
                        rows={3}
                      />
                      <span className="form-hint">每行一个，格式: Key: Value</span>
                    </div>
                  </>
                )}

                <div className="form-actions">
                  <button className="btn-primary" onClick={saveServer}>
                    保存
                  </button>
                  <button className="btn-secondary" onClick={() => {
                    setEditingServer(null);
                    setServerName('');
                    setMessage('');
                  }}>
                    取消
                  </button>
                </div>

                {message && <div className="form-message">{message}</div>}
              </>
            ) : (
              <div className="mcp-empty">
                <p>选择一个 MCP 服务器进行编辑，或点击"新建 MCP"创建新的服务器</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
