/**
 * 上下文用量的展示格式
 *
 * token 数动辄几十万，界面直接显示原始数字既占地方又难读，
 * 统一用「百分比 + k/M 紧凑单位」；精确值放 tooltip。
 */

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatUsagePercent(percentage: number): string {
  if (!Number.isFinite(percentage) || percentage <= 0) return '0%';
  if (percentage < 0.1) return '<0.1%';
  return `${percentage.toFixed(1)}%`;
}

/** 「12.3% · 24.6k/200k」，压缩后附「· 原 49.6k」 */
export function formatUsageBadge(usage: {
  tokens: number;
  maxTokens: number;
  percentage: number;
  rawTokens?: number;
  compressed?: boolean;
}): string {
  const base = `${formatUsagePercent(usage.percentage)} · ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.maxTokens)}`;
  return usage.compressed && usage.rawTokens !== undefined
    ? `${base} · 原 ${formatTokenCount(usage.rawTokens)}`
    : base;
}
