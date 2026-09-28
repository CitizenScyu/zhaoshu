import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PersonalRequest } from './personal-request';
import { DeadlineExceededError } from './deadline';

// M4（infrasyn-42 §9）：sse() 的 15s 心跳注释帧。假时钟下直接驱动 PersonalRequest.sse()，
// 不起路由——find/profile 的路由测试已覆盖 data: 帧逐字一致（改前/改后对照见各 route.test.ts）。
// 依赖 mock：authorize 走 requirePermission（真实现要查库），这里不走 authorize，
// 只构造 PersonalRequest 后直接调 sse()。

function makeRequest(signal?: AbortSignal): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: '{}',
  });
}

describe('sse() 心跳（M4）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('work 挂起 30s ⇒ 两帧 `: ping\\n\\n`；data: 帧与改前逐字一致', async () => {
    const req = makeRequest();
    const access = new PersonalRequest(req, 285_000);
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const res = access.sse(async (emit) => {
      emit({ type: 'phase', step: 'recall' });
      const value = await gate;
      emit({ type: 'result', value });
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    let pending = reader.read();
    await vi.advanceTimersByTimeAsync(30_000);
    release('done');
    // work 结束后流关闭，把剩余帧读尽
    for (let i = 0; i < 10; i += 1) {
      const r = await pending;
      if (r.done) break;
      text += decoder.decode(r.value, { stream: true });
      pending = reader.read();
    }
    text += decoder.decode();
    const pings = text.split(': ping\n\n').length - 1;
    expect(pings).toBe(2); // 15s、30s 各一帧
    expect(text).toContain('data: {"type":"phase","step":"recall"}\n\n');
    expect(text).toContain('data: {"type":"result","value":"done"}\n\n');
    access.finish();
  });

  it('work 结束后不再有 ping（再推 60s 无新帧、定时器已清）', async () => {
    const req = makeRequest();
    const access = new PersonalRequest(req, 285_000);
    const res = access.sse(async () => {});
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // start 返回、流关闭
    const before = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(60_000);
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true }>((r) => r({ done: true }))]);
    expect(chunk.done).toBe(true);
    expect(before).toBe(0); // work 正常结束路径的定时器已清（getTimerCount=0）
    access.finish();
  });

  it('work 抛错也清定时器；错误帧仍按 mapError 结算', async () => {
    const req = makeRequest();
    const access = new PersonalRequest(req, 285_000);
    const res = access.sse(async () => { throw new DeadlineExceededError(285_000); });
    const text = await new Response(res.body).text();
    expect(text).toContain('data: {"type":"error","code":"DEADLINE_EXCEEDED"');
    expect(vi.getTimerCount()).toBe(0);
    access.finish();
  });

  it('cancel 后不再有 ping（cancel 路径清定时器）', async () => {
    const req = makeRequest();
    const access = new PersonalRequest(req, 285_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const res = access.sse(async () => { await gate; });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(0); // start 起来
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0); // cancel 清了心跳
    release();
    await first;
    access.finish();
  });

  it('controller 已关闭时 enqueue 抛错被吞、定时器立即清', async () => {
    const req = makeRequest();
    const access = new PersonalRequest(req, 285_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const res = access.sse(async () => { await gate; });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // 先让流被消费方关闭（reader.cancel 触发 controller 侧 error，后续 enqueue 会抛），
    // 但 work 仍挂起：15s 后心跳 enqueue 撞上已关 controller，异常须被吞且定时器即清。
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(15_000); // 心跳到期：enqueue 抛错 → 吞掉 → 清定时器
    expect(vi.getTimerCount()).toBe(0);
    release();
    await first;
    access.finish();
  });
});
