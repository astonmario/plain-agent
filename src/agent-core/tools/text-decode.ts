/**
 * 文件文本解码（read / edit 用）
 * UTF-8 优先；检出 U+FFFD（非法序列）时按 GBK 重解、取替换符更少的结果。
 * 返回实际使用的编码——edit 写回时按原编码 re-encode（否则 GBK 文件被编辑一次就变 UTF-8）。
 * 搬运自 any-code domain/src/textDecode.ts
 */

import iconv from 'iconv-lite';
import { StringDecoder } from 'node:string_decoder';

export function decodeFileText(buf: Buffer): {
  text: string;
  encoding: 'utf8' | 'gbk';
} {
  const utf8 = buf.toString('utf8'); // node utf8 非致命，非法序列→U+FFFD
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf8' };
  const gbk = iconv.decode(buf, 'gbk');
  const bad = (s: string) => (s.match(/�/g) ?? []).length;
  return bad(gbk) < bad(utf8)
    ? { text: gbk, encoding: 'gbk' }
    : { text: utf8, encoding: 'utf8' };
}

/**
 * 流式子进程输出解码器。优先 UTF-8（StringDecoder 处理跨 chunk 多字节截断），
 * 检出 U+FFFD 时按 GBK 重解该 chunk、取替换符更少的结果。
 * Windows 中文系统的控制台工具以 cp936 输出，UTF-8 硬解会满屏乱码。
 */
export function createStreamDecoder() {
  const utf8 = new StringDecoder('utf8');
  const badCount = (s: string) => (s.match(/�/g) ?? []).length;
  return {
    decode(chunk: Buffer): string {
      const text = utf8.write(chunk);
      if (!text.includes('�')) return text;
      const gbk = iconv.decode(chunk, 'gbk');
      return badCount(gbk) < badCount(text) ? gbk : text;
    },
    end(): string {
      return utf8.end();
    },
  };
}
