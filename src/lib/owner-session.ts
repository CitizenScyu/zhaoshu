import { mergeAbortSignals } from './abort-merge';
import { createOwnerRequest } from './owner-request';
import type { AuthTransport } from './owner-request';

export type { AuthTransport };

/** A credential generation owns every request, including calls from stale closures. */
export class OwnerSession {
  private readonly controller = new AbortController();

  constructor(
    readonly token: string,
    readonly id: number,
    readonly transport: AuthTransport = 'owner-header',
  ) {}

  close(): void {
    this.controller.abort(new DOMException('访问会话已结束。', 'AbortError'));
  }

  async fetch(input: RequestInfo | URL, init: RequestInit, origin: string): Promise<Response> {
    this.controller.signal.throwIfAborted();
    const request = createOwnerRequest(input, init, this.token, origin, this.transport);
    // 不用 AbortSignal.any:浏览器基线低于 Chrome 116 / Safari 17.4 时会直接抛。
    // 合并后的 signal 必须活过「拿到响应头」——登录态关闭时它还要去取消那条还没读完的
    // 响应体(下面的 body.cancel)。mergeAbortSignals 在中止时自动摘掉源监听,所以关上
    // 会话不会在这条长寿命 controller.signal 上留下悬空 listener。
    const merged = mergeAbortSignals([request.signal, this.controller.signal]);
    const signal = merged.signal;
    signal.throwIfAborted();
    const response = await fetch(new Request(request, { signal }));
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    return response;
  }
}
