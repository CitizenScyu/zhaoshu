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
