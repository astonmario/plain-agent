import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

/**
 * 全局出网代理：所有需要联网的操作统一走一个 proxy——
 * LLM 调用、web_fetch / web_search、MCP SSE 远端。
 * 实现经 undici setGlobalDispatcher：全局 fetch（含流式）在 socket 层转发，
 * 一次设置全部生效；CDP 连本地浏览器（127.0.0.1）由 noProxy 默认豁免。
 *
 * 优先级：config.proxy > 标准环境变量（https_proxy/HTTPS_PROXY…EnvHttpProxyAgent 内读）> 直连。
 */

/** 本地回环永远直连（CDP / 本机服务）——与用户配置的 noProxy 合并。 */
const LOCAL_BYPASS = "localhost,127.0.0.1,::1";

let appliedKey: string | null = null;

/**
 * 按解析后的代理设置安装全局 dispatcher。幂等：key 未变化时不重建
 * （per-request agent 每次 create 都会调用，避免反复换 dispatcher）。
 */
export function applyProxyConfig(proxy?: string, noProxy?: string): void {
  const envProxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    "";
  const key = `${proxy ?? ""}|${noProxy ?? ""}|${envProxy}`;
  if (key === appliedKey) return;
  appliedKey = key;
  const httpsProxy = proxy || envProxy || undefined;
  const bypass = [noProxy, LOCAL_BYPASS].filter(Boolean).join(",");
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpsProxy,
      httpProxy: httpsProxy,
      noProxy: bypass,
    })
  );
}
