/**
 * 会话级偏好（长期生效，按 session 存储）
 *
 * 只保留 4 个高信号维度：称呼、语气、语言、解释深度。
 * 写入途径：模型在用户明确表达偏好时调用 set_session_preferences 工具；
 * 读取途径：每次请求前注入 system prompt（不写回历史，避免污染与重复）。
 */

export type SessionTone = 'concise' | 'warm' | 'humorous' | 'formal';
export type SessionLanguage = 'zh' | 'en' | 'follow';
export type SessionDepth = 'brief' | 'balanced' | 'detailed';

export type SessionPreferenceKey =
  | 'address'
  | 'assistantName'
  | 'tone'
  | 'language'
  | 'depth';

export interface SessionPreferences {
  /** 用户希望被如何称呼 */
  address?: string;
  /** 用户给助手起的名字：助手指代自己时使用 */
  assistantName?: string;
  tone?: SessionTone;
  language?: SessionLanguage;
  depth?: SessionDepth;
  updatedAt?: number;
}

export const PREFERENCE_KEYS: readonly SessionPreferenceKey[] = [
  'address',
  'assistantName',
  'tone',
  'language',
  'depth',
];

const TONE_LABELS: Record<SessionTone, string> = {
  concise: '简洁直接，先给结论',
  warm: '温和耐心，多解释一步',
  humorous: '轻松幽默，可适度玩笑',
  formal: '严谨专业，避免口语化',
};

const LANGUAGE_LABELS: Record<SessionLanguage, string> = {
  zh: '中文',
  en: '英文',
  follow: '跟随用户当前使用的语言',
};

const DEPTH_LABELS: Record<SessionDepth, string> = {
  brief: '结论优先，省略推导',
  balanced: '结论 + 必要说明',
  detailed: '教学式，给推导和示例',
};

const ADDRESS_MAX = 40;
const ASSISTANT_NAME_MAX = 20;

export function isTone(value: unknown): value is SessionTone {
  return typeof value === 'string' && value in TONE_LABELS;
}

export function isLanguage(value: unknown): value is SessionLanguage {
  return typeof value === 'string' && value in LANGUAGE_LABELS;
}

export function isDepth(value: unknown): value is SessionDepth {
  return typeof value === 'string' && value in DEPTH_LABELS;
}

/** 合并一次工具调用的改动；非法值抛错，由工具转成可读提示 */
export function mergeSessionPreferences(
  current: SessionPreferences | null,
  patch: {
    address?: unknown;
    assistantName?: unknown;
    tone?: unknown;
    language?: unknown;
    depth?: unknown;
    clear?: unknown;
  },
): SessionPreferences {
  const next: SessionPreferences = { ...(current ?? {}) };
  delete next.updatedAt;

  if (patch.address !== undefined) {
    if (typeof patch.address !== 'string') throw new Error('address 必须是字符串');
    const address = patch.address.replace(/\s+/g, ' ').trim().slice(0, ADDRESS_MAX);
    if (address) next.address = address;
    else delete next.address;
  }
  if (patch.assistantName !== undefined) {
    if (typeof patch.assistantName !== 'string') throw new Error('assistantName 必须是字符串');
    const name = patch.assistantName.replace(/\s+/g, ' ').trim().slice(0, ASSISTANT_NAME_MAX);
    if (name) next.assistantName = name;
    else delete next.assistantName;
  }
  if (patch.tone !== undefined) {
    if (!isTone(patch.tone)) {
      throw new Error(`tone 必须是 ${Object.keys(TONE_LABELS).join(' / ')}`);
    }
    next.tone = patch.tone;
  }
  if (patch.language !== undefined) {
    if (!isLanguage(patch.language)) {
      throw new Error(`language 必须是 ${Object.keys(LANGUAGE_LABELS).join(' / ')}`);
    }
    next.language = patch.language;
  }
  if (patch.depth !== undefined) {
    if (!isDepth(patch.depth)) {
      throw new Error(`depth 必须是 ${Object.keys(DEPTH_LABELS).join(' / ')}`);
    }
    next.depth = patch.depth;
  }

  if (patch.clear !== undefined) {
    if (!Array.isArray(patch.clear)) throw new Error('clear 必须是数组');
    for (const key of patch.clear) {
      if (!PREFERENCE_KEYS.includes(key as SessionPreferenceKey)) {
        throw new Error(`clear 只能包含 ${PREFERENCE_KEYS.join(' / ')}`);
      }
      delete next[key as SessionPreferenceKey];
    }
  }

  return next;
}

export function hasPreferences(prefs: SessionPreferences | null): boolean {
  return Boolean(prefs && (prefs.address || prefs.assistantName || prefs.tone || prefs.language || prefs.depth));
}

/**
 * 生成要追加到 system prompt 的片段；没有偏好时返回空串。
 * 内容必须短：它是每轮请求的固定开销。
 */
export function renderPreferencesPrompt(prefs: SessionPreferences | null): string {
  if (!hasPreferences(prefs)) return '';
  const lines: string[] = [];
  if (prefs!.address) lines.push(`- 称呼用户：${prefs!.address}`);
  if (prefs!.assistantName) {
    lines.push(`- 你的自称：${prefs!.assistantName}（指代自己时使用这个名字）`);
  }
  if (prefs!.tone) lines.push(`- 回答语气：${TONE_LABELS[prefs!.tone]}`);
  if (prefs!.language) lines.push(`- 回复语言：${LANGUAGE_LABELS[prefs!.language]}`);
  if (prefs!.depth) lines.push(`- 解释深度：${DEPTH_LABELS[prefs!.depth]}`);
  return [
    '## 会话偏好（用户设定，长期有效）',
    ...lines,
    '- 用户当次要求与以上偏好冲突时，以当次要求为准。',
  ].join('\n');
}

/** 工具/CLI 展示用的一行摘要 */
export function describePreferences(prefs: SessionPreferences | null): string {
  if (!hasPreferences(prefs)) return '（未设置）';
  const parts: string[] = [];
  if (prefs!.address) parts.push(`称呼=${prefs!.address}`);
  if (prefs!.assistantName) parts.push(`自称=${prefs!.assistantName}`);
  if (prefs!.tone) parts.push(`语气=${prefs!.tone}`);
  if (prefs!.language) parts.push(`语言=${prefs!.language}`);
  if (prefs!.depth) parts.push(`深度=${prefs!.depth}`);
  return parts.join('，');
}
