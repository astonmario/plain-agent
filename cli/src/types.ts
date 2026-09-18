/**
 * TUI 消息类型定义
 */

export enum MessageType {
  SYSTEM = 'SYSTEM',
  USER = 'USER',
  TOOL = 'TOOL',
  ITERATION = 'ITERATION',
  ASSISTANT = 'ASSISTANT',
  THINKING = 'THINKING',
  ERROR = 'ERROR',
  WARNING = 'WARNING',
}

export interface Message {
  id: string;
  type: MessageType;
  content: string;
  timestamp: number;
  /** 回复中解析出的可选项（options 代码块），仅 ASSISTANT 消息可能有 */
  options?: string[];
}
