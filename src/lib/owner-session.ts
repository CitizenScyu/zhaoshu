import { createOwnerRequest } from './owner-request';

/** A credential generation owns every request, including calls from stale closures. */
export class OwnerSession {
  private readonly controller = new AbortController();

  constructor(readonly token: string, readonly id: number) {}

  close(): void {
    this.controller.abort(new DOMException('访问会话已结束。', 'AbortError'));
  }

  async fetch(input: RequestInfo | URL, init: RequestInit, origin: string): Promise<Response> {
    this.controller.signal.throwIfAborted();
    const request = createOwnerRequest(input, init, this.token, origin);
    const signal = AbortSignal.any([request.signal, this.controller.signal]);
    signal.throwIfAborted();
    const response = await fetch(new Request(request, { signal }));
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    return response;
  }
}
