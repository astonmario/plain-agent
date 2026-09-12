/**
 * 挂起交互注册表（搬运自 any-code domain/src/pendingInteractions.ts）
 * ask_question 工具阻塞 agent loop 等人类答案：
 * 工具注册 pending → 发 interaction 事件 → UI 弹窗 → 用户提交 → submitInteractionAnswer 唤醒 resolve。
 * 进程级单例：桌面端主进程内所有 agent 会话共享。
 */

export interface PendingInteraction {
  resolve: (answers: string[]) => void;
}

const pending = new Map<string, PendingInteraction>();

export function registerInteraction(id: string, entry: PendingInteraction): void {
  pending.set(id, entry);
}

export function unregisterInteraction(id: string): void {
  pending.delete(id);
}

/**
 * UI 提交答案：唤醒对应挂起的 ask_question。
 * id 不存在（已超时/已取消/已回答）时静默忽略。
 */
export function submitInteractionAnswer(id: string, answers: string[]): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.resolve(answers);
}

/** 测试/清理用：当前挂起数量 */
export function pendingInteractionCount(): number {
  return pending.size;
}
