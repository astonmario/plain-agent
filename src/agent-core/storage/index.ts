/**
 * 存储层接口定义和工厂函数
 */

export type { SessionStorage, Session } from '../types';
export { SQLiteStorage } from './sqlite';
export { MemoryStorage } from './memory';
