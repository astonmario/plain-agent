/**
 * Web 工具（搬运自 any-code domain/src/tools/functions/webFetchTool.ts + webSearchTool.ts）
 * web_fetch：抓取网页转 Markdown（仅 https，15s 超时，正文默认上限 50KB）
 * web_search：网页搜索（provider 可插拔：ddg 免 key 默认 / tavily / bing）
 *
 * 适配 plain-agent：
 * - handler 返回 string（any-code 返回 ToolResult 对象）
 * - 原生 fetch（any-code 用 undici 因其全局代理 dispatcher；plain-agent 无此层）
 * - 配置走环境变量：WEB_SEARCH_PROVIDER / TAVILY_API_KEY / BING_API_KEY
 */

import type { Tool } from '../types';

const TEXT_LIMIT = 50_000;
const TIMEOUT_MS = 15_000;

/** 超时感知的 fetch；超时抛 AbortError */
async function fetchWithTimeout(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '').trim();

/** HTML → Markdown（够用即可：标题/链接/段落结构，去 script/style） */
export function htmlToMarkdown(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|pre)>/gi, '\n')
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n: string, t: string) => `\n${'#'.repeat(Number(n))} ${stripTags(t)}\n`,
    )
    .replace(
      /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, u: string, t: string) => `[${stripTags(t)}](${u})`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return (title ? `# ${title}\n\n` : '') + body;
}

/**
 * 抓取网页转 Markdown
 */
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: '抓取网页并转成 Markdown 文本。仅 https；15s 超时；正文默认上限 50KB（可用 maxChars 调小）。',
  schema: {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description: 'Fetch a web page and convert it to markdown text. https only; 15s timeout; body capped at 50KB by default (maxChars may lower it).',
      parameters: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'https:// URL' },
          maxChars: { type: 'number', description: 'Optional: max returned chars (<=50000)' },
        },
        required: ['url'],
      },
    },
  },
  handler: async (args: { url?: string; maxChars?: number }): Promise<string> => {
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!url) return '[Error] url 不能为空';
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return '[Error] URL 非法';
    }
    if (u.protocol !== 'https:') {
      return '[Error] 仅支持 https://（明文 http 与本地协议已拒绝）';
    }
    try {
      const { status, text: raw } = await fetchWithTimeout(u.href);
      if (status !== 200) return `[Error] HTTP ${status}`;
      if (raw.length > TEXT_LIMIT * 4) return '[Error] 页面过大，拒绝读取';
      const md = htmlToMarkdown(raw);
      const max = Math.min(typeof args?.maxChars === 'number' ? args.maxChars : TEXT_LIMIT, TEXT_LIMIT);
      const out = md.length > max ? `${md.slice(0, max)}\n…(截断)` : md;
      return out || '(页面无可读文本)';
    } catch (e) {
      return `[Error] ${
        e instanceof Error && e.name === 'TimeoutError'
          ? `请求超时（${TIMEOUT_MS / 1000}s）`
          : String(e instanceof Error ? e.message : e)
      }`;
    }
  },
  meta: { readonly: true, concurrent: true },
};

// ============ web_search ============

interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 无 key 尽力模式：DuckDuckGo html 端点（可能被限流/反爬——best-effort） */
async function searchDdg(query: string, max: number): Promise<SearchItem[]> {
  const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { status, text: html } = await fetchWithTimeout(u, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (status !== 200) throw new Error(`DuckDuckGo HTTP ${status}`);
  const items: SearchItem[] = [];
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    let url = m[1];
    // DDG 跳转链接 uddg= 参数解包
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    items.push({ title, url, snippet: '' });
  }
  let i = 0;
  for (const m of html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (items[i]) items[i].snippet = m[1].replace(/<[^>]+>/g, '').trim();
    i++;
  }
  return items.slice(0, max);
}

async function searchTavily(query: string, max: number, apiKey: string): Promise<SearchItem[]> {
  if (!apiKey) throw new Error('tavily provider 需要环境变量 TAVILY_API_KEY');
  const { status, text } = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: max }),
    },
  );
  if (status !== 200) throw new Error(`Tavily HTTP ${status}`);
  const j = JSON.parse(text) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (j.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function searchBing(query: string, max: number, apiKey: string): Promise<SearchItem[]> {
  if (!apiKey) throw new Error('bing provider 需要环境变量 BING_API_KEY');
  const { status, text } = await fetchWithTimeout(
    `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${max}`,
    { headers: { 'Ocp-Apim-Subscription-Key': apiKey } },
  );
  if (status !== 200) throw new Error(`Bing HTTP ${status}`);
  const j = JSON.parse(text) as {
    webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> };
  };
  return (j.webPages?.value ?? []).map((w) => ({
    title: w.name ?? '',
    url: w.url ?? '',
    snippet: w.snippet ?? '',
  }));
}

/**
 * 网页搜索：返回 {title, url, snippet} 列表
 * provider：ddg（默认，免 key）/ tavily / bing（后两者需对应 API key）
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description: '网页搜索，返回 {title, url, snippet} 列表。优先用关键词组合或 site: 过滤；maxResults 默认 8。',
  schema: {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Web search returning a list of {title, url, snippet}. Prefer keyword combinations or site: filters; maxResults defaults to 8.',
      parameters: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'number', description: 'Optional: result count (1-20)' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args: { query?: string; maxResults?: number }): Promise<string> => {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return '[Error] query 不能为空';
    const max = Math.min(Math.max(typeof args?.maxResults === 'number' ? args.maxResults : 8, 1), 20);
    const provider = (process.env.WEB_SEARCH_PROVIDER || 'ddg').toLowerCase();
    try {
      const items =
        provider === 'tavily'
          ? await searchTavily(query, max, process.env.TAVILY_API_KEY || '')
          : provider === 'bing'
            ? await searchBing(query, max, process.env.BING_API_KEY || '')
            : await searchDdg(query, max);
      if (!items.length) return '(无结果——换个更具体的关键词重试)';
      return items
        .map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}${it.snippet ? `\n   ${it.snippet}` : ''}`)
        .join('\n\n');
    } catch (e) {
      // best-effort：搜索失败不终止 run——错误文案给模型自纠（换关键词/换 provider）
      return `[Error] ${String(e instanceof Error ? e.message : e)}`;
    }
  },
  meta: { readonly: true, concurrent: true },
};
