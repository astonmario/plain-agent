/**
 * 技能发现页面
 * 搜索、查看和安装远程技能（仅在客户端实现了技能发现接口时使用）
 */

import { useState } from 'react';
import type { AgentClient, RemoteSkillSummary, RemoteSkillDetail } from './api-client';

interface SkillDiscoveryProps {
  client: AgentClient;
  /** 是否已选择工作区（决定能否安装到项目目录） */
  hasWorkspace: boolean;
}

export function SkillDiscovery({ client, hasWorkspace }: SkillDiscoveryProps) {
  const [query, setQuery] = useState('');
  /** 完整搜索结果；过滤在渲染时进行，切换过滤器无需重新搜索 */
  const [results, setResults] = useState<RemoteSkillSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<RemoteSkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [filter, setFilter] = useState<'all' | 'official' | 'community'>('all');

  const skills = results.filter(skill => filter === 'all' || skill.source === filter);

  // 搜索技能
  const handleSearch = async () => {
    if (!query.trim() || !client.searchRemoteSkills) return;

    setLoading(true);
    setError(null);
    setResults([]);

    try {
      setResults(await client.searchRemoteSkills(query));
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      setLoading(false);
    }
  };

  // 查看详情
  const handleViewDetail = async (skill: RemoteSkillSummary) => {
    if (!client.getRemoteSkillDetail) return;
    setDetailLoading(true);
    setSelectedSkill(null);

    try {
      setSelectedSkill(await client.getRemoteSkillDetail(skill.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  // 安装技能
  const handleInstall = async (id: string, target: 'global' | 'project') => {
    if (!client.installRemoteSkill) return;
    if (!confirm(`确认安装技能到 ${target === 'global' ? '全局' : '项目'} 目录？`)) {
      return;
    }

    setInstalling(true);

    try {
      const result = await client.installRemoteSkill(id, target);

      if (result.ok) {
        alert(`✅ ${result.message}`);
        setSelectedSkill(null);
      } else {
        alert(`❌ ${result.message}`);
      }
    } catch (err) {
      alert(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="skill-discovery">
      <div className="skill-discovery-header">
        <h2>技能发现</h2>
        <p className="subtitle">搜索和安装第三方技能包</p>
      </div>

      {/* 搜索框 */}
      <div className="search-section">
        <div className="search-bar">
          <input
            type="text"
            placeholder="搜索技能（例如：react, browser, mcp）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            disabled={loading}
          />
          <button onClick={handleSearch} disabled={loading || !query.trim()}>
            {loading ? '搜索中...' : '搜索'}
          </button>
        </div>

        {/* 过滤器 */}
        <div className="filter-tabs">
          <button
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            className={filter === 'official' ? 'active' : ''}
            onClick={() => setFilter('official')}
          >
            📦 官方
          </button>
          <button
            className={filter === 'community' ? 'active' : ''}
            onClick={() => setFilter('community')}
          >
            🌐 社区
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="error-message">
          ⚠️ {error}
        </div>
      )}
      {!error && searched && !loading && skills.length === 0 && (
        <div className="error-message">
          ⚠️ 未找到匹配的技能
        </div>
      )}

      {/* 技能列表 */}
      <div className="skill-discovery-list">
        {skills.map((skill) => (
          <div key={skill.id} className="skill-card" onClick={() => handleViewDetail(skill)}>
            <div className="skill-card-header">
              <span className="skill-source">
                {skill.source === 'official' ? '📦 官方' : '🌐 社区'}
              </span>
              {skill.stars !== undefined && (
                <span className="skill-stars">⭐ {skill.stars}</span>
              )}
            </div>
            <h3 className="skill-name">{skill.name}</h3>
            <p className="skill-description">{skill.description}</p>
            <div className="skill-meta">
              <span className="skill-author">作者: {skill.author}</span>
              {skill.topics && skill.topics.length > 0 && (
                <div className="skill-topics">
                  {skill.topics.slice(0, 3).map(topic => (
                    <span key={topic} className="topic-tag">{topic}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 技能详情弹窗 */}
      {selectedSkill && (
        <div className="modal-overlay" onClick={() => setSelectedSkill(null)}>
          <div className="modal-content skill-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {selectedSkill.source === 'official' ? '📦' : '🌐'} {selectedSkill.name}
              </h2>
              <button className="close-button" onClick={() => setSelectedSkill(null)}>
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="skill-detail-info">
                <p><strong>描述:</strong> {selectedSkill.description}</p>
                <p><strong>作者:</strong> {selectedSkill.author}</p>
                <p><strong>来源:</strong> <a href={selectedSkill.sourceUrl} target="_blank" rel="noopener noreferrer">{selectedSkill.sourceUrl}</a></p>
                <p><strong>类型:</strong> {selectedSkill.source === 'official' ? '官方技能' : '社区技能'}</p>
                {selectedSkill.stars !== undefined && (
                  <p><strong>星标:</strong> ⭐ {selectedSkill.stars}</p>
                )}
                {selectedSkill.topics && selectedSkill.topics.length > 0 && (
                  <p>
                    <strong>标签:</strong> {selectedSkill.topics.join(', ')}
                  </p>
                )}
              </div>

              <div className="skill-readme">
                <h3>README</h3>
                <div className="readme-content">
                  <pre>{selectedSkill.readme}</pre>
                </div>
              </div>

              {selectedSkill.installable && (
                <div className="install-actions">
                  <div className="security-warning">
                    ⚠️ <strong>安全提示:</strong> 请仔细审查技能来源和内容。第三方技能可能包含不安全的代码。
                  </div>
                  <div className="install-buttons">
                    <button
                      onClick={() => handleInstall(selectedSkill.id, 'global')}
                      disabled={installing}
                      className="install-button"
                    >
                      {installing ? '安装中...' : '安装到全局'}
                    </button>
                    {hasWorkspace && (
                      <button
                        onClick={() => handleInstall(selectedSkill.id, 'project')}
                        disabled={installing}
                        className="install-button secondary"
                      >
                        {installing ? '安装中...' : '安装到项目'}
                      </button>
                    )}
                  </div>
                  <p style={{ marginTop: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {hasWorkspace
                      ? '全局: ~/.plain-agent/skills/ | 项目: 当前工作区/.plain-agent/skills/'
                      : '技能将安装到: ~/.plain-agent/skills/'
                    }
                  </p>
                  {!hasWorkspace && (
                    <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      💡 提示: 选择工作区后可以安装到项目目录
                    </p>
                  )}
                </div>
              )}

              {!selectedSkill.installable && (
                <div className="not-installable">
                  ❌ 此技能不可安装（缺少 SKILL.md 文件）
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {detailLoading && (
        <div className="modal-overlay">
          <div className="loading-spinner">加载详情中...</div>
        </div>
      )}
    </div>
  );
}
