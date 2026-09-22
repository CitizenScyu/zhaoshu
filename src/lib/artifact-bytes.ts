// artifact 字节层:仓库 contents raw 取回的有界缓冲,以及路径编码 / git blob sha 判据。
//
// 读端(reader-server,按需取卷)与下载端(download file 路由,整本拼接)共用这一份实现,
// 判据只此一处:
//   - encodeArtifactPath:artifact 路径按段编码(段名在仓库里已百分号编码,先解码再编码,
//     避免二次编码;段内非转义 `%` 时保守按原样使用)。
//   - gitBlobSha:内容(git blob)sha40。发布侧登记、读端逐卷校验、下载端拼接前校验同一判据。
//   - readBoundedBody:raw 流有界缓冲 + 增量 UTF-8 校验 + 取消传播,绝不整包无界读进内存。
//
// 本模块不依赖任何错误类型:失败一律抛 BodyReadError(带 reason),由调用方翻译成自己的
// 错误类型(读端 ReaderError / 下载端 FileUpstreamError),消息措辞各归各的界面。

import { createHash } from 'node:crypto';

/**
 * 按段编码 artifact 路径。仓库里写入的段名已百分号编码(如 `%E6%B5%8B...`),
 * 因此先解码再编码,避免二次编码;段内非转义 `%` 时保守地按原样使用。
 */
export function encodeArtifactPath(path: string): string {
  return path.split('/').map((segment) => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment);
    }
  }).join('/');
}

/** 内容(git blob)sha40:字符串按 UTF-8 计字节。 */
export function gitBlobSha(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/** readBoundedBody 的失败类别;调用方据此翻成各自的错误类型与措辞。 */
export type BodyReadReason = 'empty' | 'too-large' | 'invalid-utf8' | 'timeout' | 'interrupted';

export class BodyReadError extends Error {
  constructor(readonly reason: BodyReadReason, options?: { cause?: unknown }) {
    super(`artifact body read failed: ${reason}`, options);
    this.name = 'BodyReadError';
  }
}

/**
 * 有界流式读 raw 响应体:`limit` 是**单文件**上限(卷与旧单文件 16 MiB,清单 4 MiB),
 * 防被篡改的内容让服务器去拉一个超大文件。增量 UTF-8 校验不保留解码副本;任一步失败都
 * 取消上游流并释放锁。返回 `Buffer` 而非流,是因为调用方都要在此后做 sha / JSON 校验。
 */
export async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new BodyReadError('empty');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > limit) {
    await response.body.cancel().catch(() => undefined);
    throw new BodyReadError('too-large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyReadError('too-large');
      // Validate incrementally without retaining a decoded copy of the file.
      try {
        decoder.decode(value, { stream: true });
      } catch {
        throw new BodyReadError('invalid-utf8');
      }
      chunks.push(value);
    }
    try {
      decoder.decode();
    } catch {
      throw new BodyReadError('invalid-utf8');
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof BodyReadError) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new BodyReadError('timeout', { cause: error });
    }
    throw new BodyReadError('interrupted', { cause: error });
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new BodyReadError('empty');
  return Buffer.concat(chunks, size);
}
