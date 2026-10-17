/**
 * 主题（强调色）管理
 *
 * 主题只影响渲染层的 CSS 变量，不参与 main 进程设置，因此用 localStorage 持久化，
 * Web 端与桌面端共用。
 */

export type ThemeId = 'forest' | 'ocean' | 'violet' | 'amber' | 'rose';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  /** 用于选择器色块展示，与 styles.css 中的 --accent 保持一致 */
  accent: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'forest', label: '森林绿', accent: '#28756b' },
  { id: 'ocean', label: '海蓝', accent: '#2f6fd0' },
  { id: 'violet', label: '紫罗兰', accent: '#7b5cd6' },
  { id: 'amber', label: '暖橙', accent: '#b96a1f' },
  { id: 'rose', label: '玫瑰', accent: '#c04b6b' },
];

const STORAGE_KEY = 'plain-agent:theme';

/** 读取已保存的主题；非法值回退到默认主题 */
export function getStoredTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) {
      return saved as ThemeId;
    }
  } catch {
    /* localStorage 不可用时使用默认值 */
  }
  return 'forest';
}

/** 应用主题并持久化；forest 是默认主题，不需要 data-theme 属性 */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id === 'forest') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', id);
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 忽略写入失败 */
  }
}
