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
}
