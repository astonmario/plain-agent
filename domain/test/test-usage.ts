/**
 * 上下文用量展示契约测试
 *
 * 界面上的「已用/上限」来自 getHistoryUsage()：
 * - tokens 是下一轮请求实际会发送的历史估算值（压缩后为压缩版）
 * - rawTokens 是未压缩完整历史，用于展示压缩前数值
 * - compressed 表示当前 tokens 是否来自压缩版
 */

import { MemoryStorage, PlainAgent } from '../src';
import {
  formatTokenCount,
  formatUsageBadge,
  formatUsagePercent,
} from '../src';
import type { ChatMessage, LLMConfig } from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const llm: LLMConfig = {
  provider: 'openai',
  apiKey: 'k',
  model: 'm',
  baseUrl: 'https://usage.example.test/v1',
};

async function main(): Promise<void> {
  // 展示格式：原始 token 数太大，统一用百分比 + k/M
  assert(formatTokenCount(0) === '0', 'zero formats as 0');
  assert(formatTokenCount(999) === '999', 'under 1000 stays raw');
  assert(formatTokenCount(1_000) === '1.0k', 'thousands use k');
  assert(formatTokenCount(24_600) === '24.6k', 'ten-thousands keep one decimal');
  assert(formatTokenCount(150_000) === '150k', 'hundred-thousands drop decimals');
  assert(formatTokenCount(200_000) === '200k', 'budget formats compactly');
  assert(formatTokenCount(1_200_000) === '1.2M', 'millions use M');
  assert(formatUsagePercent(0) === '0%', 'zero percent');
  assert(formatUsagePercent(0.05) === '<0.1%', 'tiny percent keeps visibility');
  assert(formatUsagePercent(12.34) === '12.3%', 'percent keeps one decimal');
  assert(
    formatUsageBadge({
      tokens: 24_600,
      maxTokens: 200_000,
      percentage: 12.3,
      rawTokens: 49_530,
      compressed: true,
    }) === '12.3% · 24.6k/200k · 原 49.5k',
    'badge shows percent, compact used/max and pre-compression value',
  );

  const storage = new MemoryStorage();
  const sessionId = 'usage-session';
  const bigToolOutput = 'x'.repeat(4_000);
  const round: ChatMessage[] = [
    { role: 'user', content: '跑一个命令' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: bigToolOutput },
    { role: 'assistant', content: '完成' },
  ];
  for (let i = 0; i < 4; i++) {
    for (const message of round) await storage.saveMessage(sessionId, message);
  }

  const agent = new PlainAgent({
    llm,
    tools: [],
    storage,
    sessionId,
    permissionMode: 'trust',
    historyManagement: {
      enabled: true,
      maxTokens: 8_000,
      compressionThreshold: 200,
      aggressiveThreshold: 400,
      maxToolOutputLength: 200,
      keepRecentMessages: 2,
    },
  });

  await agent.loadHistory();
  const before = agent.getHistoryUsage();
  assert(before.compressed === false, 'uncompressed history reports compressed=false');
  assert(before.tokens === before.rawTokens, 'before compression tokens equals rawTokens');
  assert(before.maxTokens === 8_000, 'maxTokens comes from history config');

  await agent.compressHistory(true);
  const after = agent.getHistoryUsage();
  assert(after.compressed === true, 'compressed history reports compressed=true');
  assert(after.tokens < after.rawTokens, 'compressed tokens are smaller than raw tokens');
  assert(after.tokens < before.tokens, 'compression reduces the displayed token count');
  assert(after.rawTokens === before.tokens, 'rawTokens keeps the pre-compression value');

  // 不展示压缩版时，可以拿到完整历史的真实值
  const raw = agent.getHistoryUsage(false);
  assert(raw.tokens === after.rawTokens, 'getHistoryUsage(false) returns raw history');
  assert(raw.compressed === false, 'raw view is not marked compressed');

  console.log('history usage tests passed');
}

void main();
