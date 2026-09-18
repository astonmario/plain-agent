/**
 * options 代码块解析（与桌面端同一约定）
 *
 * 模型在回复末尾输出 ```options 代码块（每行一个选项），
 * TUI 解析后渲染为键盘可选项；桌面端渲染为可点击选项组。
 */

export interface ParsedOptions {
  /** 去掉 options 块后的正文 */
  text: string;
  /** 解析出的选项；无块或块为空时为 null */
  options: string[] | null;
}

export function parseOptionsBlock(content: string): ParsedOptions {
  const match = /```options\n([\s\S]*?)```/.exec(content);
  if (!match) return { text: content, options: null };
  const options = match[1]
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
  const text = content.replace(match[0], '').trimEnd();
  return { text, options: options.length > 0 ? options : null };
}
