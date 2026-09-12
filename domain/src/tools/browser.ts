/**
 * browser_use 工具（搬运自 any-code domain/src/tools/functions/browserUseTool.ts）
 * 通过 CDP 驱动用户真实浏览器（playwright-core connectOverCDP，零配置不下载浏览器）：
 * 需先以 chrome --remote-debugging-port=9222 启动浏览器。
 *
 * 适配 plain-agent：
 * - handler 返回 string（any-code 返回 ToolResult）
 * - cdpUrl 配置走环境变量 BROWSER_CDP_URL（默认 http://127.0.0.1:9222）
 * - playwright-core 懒加载：模块被引用时不 import，调用时才加载——
 *   未安装该依赖时其它工具不受影响，调用本工具才报连接/依赖错误
 */

import type { Tool } from '../types';

const NAV_TIMEOUT_MS = 15_000;
const TEXT_LIMIT = 20_000;
const ACT_TIMEOUT_MS = 8_000;

function cdpUrlOf(): string {
  return (process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222').replace(/\/+$/, '');
}

// ———— 连接缓存（按 cdpUrl 记忆；context 取第一个，页面取最近活跃页） ————
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let conn: { url: string; browser: any } | null = null;

/** CDP 端点探活分类：refused=端口无服务；http=有服务但响应异常；ok=是 CDP 端点 */
async function probeCdp(cdpUrl: string): Promise<'refused' | 'http' | 'ok'> {
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return 'http';
    const body = (await res.json().catch(() => null)) as { webSocketDebuggerUrl?: string } | null;
    return body?.webSocketDebuggerUrl ? 'ok' : 'http';
  } catch {
    return 'refused';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function browserOf(cdpUrl: string): Promise<any> {
  if (conn && conn.url === cdpUrl) {
    // 连接可能已被浏览器侧断开：轻量探测
    try {
      conn.browser.contexts()[0]?.pages();
      return conn.browser;
    } catch {
      try {
        await conn.browser.close();
      } catch {
        // 已断开，忽略
      }
      conn = null;
    }
  }
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error(
      'playwright-core 未安装（domain 包依赖）。请运行 pnpm install 后重试',
    );
  }
  try {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
    conn = { url: cdpUrl, browser };
    return browser;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const kind = await probeCdp(cdpUrl);
    if (kind === 'refused') {
      throw new Error(
        `浏览器未运行：${cdpUrl} 无服务监听。请先用远程调试模式启动：chrome --remote-debugging-port=9222（端口不同则相应修改 BROWSER_CDP_URL）`,
      );
    }
    if (kind === 'http') {
      throw new Error(
        `cdpUrl 可能配置错误：${cdpUrl} 有服务但不是浏览器调试端点（/json/version 响应异常）。请确认指向浏览器的 --remote-debugging-port`,
      );
    }
    throw new Error(`CDP 连接失败（端点可达，握手错误）: ${raw}。尝试重启浏览器后再试`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function contextOf(cdpUrl: string, browser: any): Promise<any> {
  const ctx = browser.contexts()[0];
  if (ctx) return ctx;
  // 无上下文 = 调试端口活着但没有任何页面目标。经 CDP HTTP 端点自开一个空白页。
  try {
    await fetch(`${cdpUrl}/json/new?about:blank`, { method: 'PUT' });
  } catch {
    // 开页失败走下方报错
  }
  const retry = browser.contexts()[0];
  if (retry) return retry;
  throw new Error(
    'CDP 端点没有可用页面：浏览器处于调试模式但没有任何窗口。请至少保留一个窗口，或重启浏览器并打开任意页面',
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function activePage(cdpUrl: string, browser: any): Promise<any> {
  const pages = (await contextOf(cdpUrl, browser)).pages();
  // 取最后一个非 about:blank 页；全空白则取最后一页
  const real = pages.filter((p: any) => !p.url().startsWith('about:'));
  return real[real.length - 1] ?? pages[pages.length - 1];
}

/** ref（ariaSnapshot ai 模式生成，形如 s1e3）→ aria-ref 定位器；否则按 CSS 选择器。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function target(page: any, refOrSelector: string) {
  const v = refOrSelector.trim();
  return /^\w+\d*e?\d+$/.test(v) && /e\d+$/.test(v) && !v.startsWith('.') && !v.startsWith('#')
    ? page.locator(`aria-ref=${v}`)
    : page.locator(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageInfo(page: any, selector?: string): Promise<string> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const text = selector
    ? await page
        .locator(selector)
        .first()
        .innerText({ timeout: ACT_TIMEOUT_MS })
        .catch(() => '(selector matched no elements)')
    : await page.evaluate('document.body ? document.body.innerText : ""');
  const full = text ?? '';
  const clipped =
    full.length > TEXT_LIMIT
      ? `${full.slice(0, TEXT_LIMIT)}\n\n(content clipped to ${TEXT_LIMIT} chars — use the selector param to scope, or eval for targeted reading)`
      : full;
  return `URL: ${url}\nTitle: ${title || '(untitled)'}\n\n${clipped || '(no readable text)'}`;
}

// ———— actions（签名保持 any-code 原样，返回值统一 string） ————

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function navigate(args: { url?: string }, cdpUrl: string, browser: any): Promise<string> {
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) return 'Error: url is required';
  if (!/^https?:\/\//i.test(url)) return 'Error: only http(s) URLs are supported';
  const page = await activePage(cdpUrl, browser);
  // load 超时不报错：SPA 异步渲染不会触发 load——照常返回页面状态
  let note = 'load completed';
  try {
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  } catch {
    note = 'network load timed out; page state below (SPA may still be rendering — retry with content later)';
  }
  const info = await pageInfo(page);
  return `Navigated to ${url} (${note})\n${info}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function content(args: { selector?: string }, cdpUrl: string, browser: any): Promise<string> {
  const page = await activePage(cdpUrl, browser);
  const selector = typeof args?.selector === 'string' ? args.selector : undefined;
  return pageInfo(page, selector);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evalJs(args: { js?: string }, cdpUrl: string, browser: any): Promise<string> {
  const js = typeof args?.js === 'string' ? args.js : '';
  if (!js) return 'Error: js is required';
  const page = await activePage(cdpUrl, browser);
  // page.evaluate 对返回 Promise 自动 await
  try {
    const v = await page.evaluate(js);
    return typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function snapshot(_args: unknown, cdpUrl: string, browser: any): Promise<string> {
  const page = await activePage(cdpUrl, browser);
  // 无障碍树 + ref：模型"看快照 → 引用 ref 点击"，复杂样式/iframe/shadow DOM 都能覆盖
  const snap = await page
    .locator('body')
    .ariaSnapshot({ mode: 'ai' })
    .catch(() => '');
  if (!snap) return '(snapshot is empty — the page may not be loaded or has no accessible content)';
  return `Accessibility snapshot (refs look like s1e3; use them with click/fill):\n\n${snap}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function click(args: { ref?: string; selector?: string }, cdpUrl: string, browser: any): Promise<string> {
  const t = args?.ref || args?.selector;
  if (!t) return 'Error: ref (from snapshot) or selector is required';
  const page = await activePage(cdpUrl, browser);
  try {
    await target(page, t).click({ timeout: ACT_TIMEOUT_MS });
    return `Clicked ${t}`;
  } catch (e) {
    return `Error: click ${t} failed: ${e instanceof Error ? e.message : String(e)} (run snapshot first for a fresh ref)`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fill(args: { ref?: string; selector?: string; text?: string }, cdpUrl: string, browser: any): Promise<string> {
  const t = args?.ref || args?.selector;
  const text = typeof args?.text === 'string' ? args.text : undefined;
  if (!t || text === undefined) return 'Error: ref/selector and text are required';
  const page = await activePage(cdpUrl, browser);
  try {
    await target(page, t).fill(text, { timeout: ACT_TIMEOUT_MS });
    return `Filled ${t}`;
  } catch (e) {
    return `Error: fill ${t} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cookies(args: { op?: string; name?: string; value?: string; url?: string }, cdpUrl: string, browser: any): Promise<string> {
  const ctx = await contextOf(cdpUrl, browser);
  const op = args?.op ?? 'get';
  if (op === 'get') {
    const all = await ctx.cookies();
    const list = args?.name ? all.filter((c: any) => c.name === args.name) : all;
    return JSON.stringify(list, null, 2);
  }
  if (op === 'set') {
    if (!args?.name || args?.value === undefined || !args?.url) {
      return 'Error: set requires name / value / url';
    }
    await ctx.addCookies([{ name: args.name, value: args.value, url: args.url }]);
    return `Cookie ${args.name} set`;
  }
  if (op === 'clear') {
    await ctx.clearCookies();
    return 'All cookies cleared';
  }
  return 'Error: cookies op must be get / set / clear';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tabs(args: { op?: string; index?: number; url?: string }, cdpUrl: string, browser: any): Promise<string> {
  const ctx = await contextOf(cdpUrl, browser);
  const op = args?.op ?? 'list';
  const pages = ctx.pages();
  if (op === 'list') return pages.map((p: any, i: number) => `${i}: ${p.url()}`).join('\n');
  if (op === 'new') {
    const page = await ctx.newPage();
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    if (url) await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    return `New tab #${pages.length}${url ? ` navigated to ${url}` : ''}`;
  }
  if (op === 'select') {
    const page = pages[args?.index ?? -1];
    if (!page) return 'Error: index out of range (see tabs op=list)';
    await page.bringToFront();
    return `Switched to tab ${args?.index}: ${page.url()}`;
  }
  if (op === 'close') {
    const page = pages[args?.index ?? -1];
    if (!page) return 'Error: index out of range';
    await page.close();
    return `Closed tab ${args?.index}`;
  }
  return 'Error: tabs op must be list / new / select / close';
}

/**
 * 浏览器自动化工具
 */
export const browserUseTool: Tool = {
  name: 'browser_use',
  description:
    '通过 CDP 驱动真实浏览器（连接已运行的 Chrome/Edge，不下载浏览器）。actions: navigate(打开网页), content(读页面，可 selector 圈区域), eval(执行 JS，Promise 自动 await), snapshot(无障碍树+ref，推荐先做这个拿 ref), click/fill(按 ref 或 CSS 选择器), cookies(get/set/clear), tabs(list/new/select/close)。',
  schema: {
    type: 'function',
    function: {
      name: 'browser_use',
      description:
        'Drive the real browser via CDP (connects to your already-running browser). Actions: navigate, content (optionally scoped by CSS selector), eval (JS, promises auto-awaited), snapshot (accessibility tree with refs — the reliable way to target elements), click / fill (by snapshot ref or CSS selector), cookies (get/set/clear), tabs (list/new/select/close).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'content', 'eval', 'snapshot', 'click', 'fill', 'cookies', 'tabs'],
            description:
              'navigate=打开网页；content=读页面（可 selector 圈区域）；eval=执行 JS；snapshot=无障碍树（推荐先做，拿 ref）；click/fill=按 ref 或选择器操作；cookies=读写 cookie；tabs=页签管理',
          },
          url: { type: 'string', description: 'action=navigate / tabs(new)：目标 URL（http/https）' },
          js: { type: 'string', description: 'action=eval 时必填：要执行的 JavaScript（返回 Promise 自动 await）' },
          selector: { type: 'string', description: 'action=content/click/fill：CSS 选择器' },
          ref: { type: 'string', description: 'action=click/fill：来自 snapshot 的元素 ref（如 s1e3）' },
          text: { type: 'string', description: 'action=fill 时必填：要填入的文本' },
          op: { type: 'string', description: 'action=cookies：get/set/clear；action=tabs：list/new/select/close' },
          name: { type: 'string', description: 'action=cookies(set/get)：cookie 名' },
          value: { type: 'string', description: 'action=cookies(set)：cookie 值' },
          index: { type: 'number', description: 'action=tabs(select/close)：页签下标（tabs list 查看）' },
        },
        required: ['action'],
      },
    },
  },
  handler: async (args: {
    action?: string;
    url?: string;
    js?: string;
    selector?: string;
    ref?: string;
    text?: string;
    op?: string;
    name?: string;
    value?: string;
    index?: number;
  }): Promise<string> => {
    const ACTIONS = ['navigate', 'content', 'eval', 'snapshot', 'click', 'fill', 'cookies', 'tabs'];
    if (!ACTIONS.includes(args?.action ?? '')) {
      return 'Error: action must be one of navigate / content / eval / snapshot / click / fill / cookies / tabs';
    }
    const cdpUrl = cdpUrlOf();
    let browser;
    try {
      browser = await browserOf(cdpUrl);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    switch (args?.action) {
      case 'navigate':
        return navigate(args, cdpUrl, browser);
      case 'content':
        return content(args, cdpUrl, browser);
      case 'eval':
        return evalJs(args, cdpUrl, browser);
      case 'snapshot':
        return snapshot(args, cdpUrl, browser);
      case 'click':
        return click(args, cdpUrl, browser);
      case 'fill':
        return fill(args, cdpUrl, browser);
      case 'cookies':
        return cookies(args, cdpUrl, browser);
      case 'tabs':
        return tabs(args, cdpUrl, browser);
      default:
        return 'Error: 未知 action'; // 不可达（上方已校验），仅为收窄类型
    }
  },
  meta: { readonly: false, concurrent: false },
};
