import { describe, expect, it } from 'vitest';
import {
  consumeFindSSE,
  fetchFindResult,
  persistWarning,
  zeroResultNote,
  type SseEvent,
} from './find-sse';

// 用假 Response 驱动真实消费路径：node 22 自带 ReadableStream/Response/TextEncoder，
// 不需要 jsdom 也能把「SSE 超时」和「流结束但没有 result 帧」这两条走到 Promise 落地。
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// 服务端把 SSE 连接开着、却一个字节都不再发：这正是「纸面超时」暴露的场景。
function stallingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start() { /* 永不入队、永不关闭 */ } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

type Outcome = 'resolved' | 'rejected' | 'pending';

/** 在 ms 毫秒内看这个 Promise 有没有落地。永不落地就报 'pending'——这就是缺陷本身。 */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<Outcome> {
  return await Promise.race<Outcome>([
    promise.then(() => 'resolved', () => 'rejected'),
    new Promise<Outcome>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

async function rejectionOf(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return await Promise.race([
    promise.then(() => ({ kind: 'resolved' as const }), (e: unknown) => ({ kind: 'rejected' as const, e })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'pending' as const }), ms)),
  ]);
}

describe('SSE 超时 / 中止必须真的打断挂起的读取', () => {
  it('服务端停在开着的 SSE 上不发字节：到点必须失败，不能一直挂着', async () => {
    const outcome = await settleWithin(
      consumeFindSSE(stallingResponse(), new AbortController().signal, 60, () => {}),
      400,
    );
    // 旧实现在 read() 返回**之后**才 race.throwIfAborted()：read 永不返回 ⇒ 永不超时。
    expect(outcome).toBe('rejected');
  });

  it('超时给出带 TIMEOUT code 的可识别错误，页面才能显示失败与重试入口', async () => {
    const outcome = await rejectionOf(
      consumeFindSSE(stallingResponse(), new AbortController().signal, 60, () => {}),
      400,
    );
    expect(outcome).toMatchObject({ kind: 'rejected' });
    expect((outcome as { e: Error & { code?: string } }).e).toMatchObject({ code: 'TIMEOUT' });
  });

  it('用户主动中止（离开页面/重开一轮）同样不能挂住', async () => {
    const controller = new AbortController();
    const pending = consumeFindSSE(stallingResponse(), controller.signal, 60_000, () => {});
    setTimeout(() => controller.abort(), 30);
    expect(await settleWithin(pending, 400)).toBe('rejected');
  });

  it('正常流不受影响：帧照样送达，流结束即 resolve', async () => {
    const seen: SseEvent[] = [];
    await consumeFindSSE(
      sseResponse([frame({ type: 'phase', step: 'verify' }), frame({ type: 'result', items: [] })]),
      new AbortController().signal,
      1000,
      (e) => seen.push(e),
    );
    expect(seen.map((e) => e.type)).toEqual(['phase', 'result']);
  });
});

describe('流结束却没收到 result 帧时必须落地成失败', () => {
  it('只发了 phase/progress 就断流：Promise 必须 reject，而不是永不 settle', async () => {
    const res = sseResponse([
      frame({ type: 'phase', step: 'verify', total: 3 }),
      frame({ type: 'progress', step: 'verify', done: 1, total: 3 }),
    ]);
    const outcome = await settleWithin(
      fetchFindResult(new AbortController().signal, () => Promise.resolve(res), 1000, () => {}),
      400,
    );
    // 旧实现：consumeFindSSE 正常 resolve，但没人 resolve/reject 外层 Promise ⇒ 按钮永久「寻径中…」。
    expect(outcome).toBe('rejected');
  });

  it('断流的错误是可理解的中文文案，能直接进 role=alert', async () => {
    const res = sseResponse([frame({ type: 'phase', step: 'verify' })]);
    const outcome = await rejectionOf(
      fetchFindResult(new AbortController().signal, () => Promise.resolve(res), 1000, () => {}),
      400,
    );
    expect(outcome).toMatchObject({ kind: 'rejected' });
    const e = (outcome as { e: Error }).e;
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/^[一-龥]/);
  });

  it('收到 result 帧时正常 resolve，progress 帧交给 onProgress', async () => {
    const res = sseResponse([
      frame({ type: 'progress', step: 'verify', done: 2, total: 5 }),
      frame({ type: 'result', step: 'rerank', items: [{ title: 'x' }], persisted: true }),
    ]);
    const progress: SseEvent[] = [];
    const event = await fetchFindResult(
      new AbortController().signal, () => Promise.resolve(res), 1000, (e) => progress.push(e),
    );
    expect(event.type).toBe('result');
    expect(event.items).toEqual([{ title: 'x' }]);
    expect(progress).toHaveLength(1);
  });

  it('error 帧照样 reject，并带上后端 code', async () => {
    const res = sseResponse([frame({ type: 'error', code: 'LLM_ERROR', message: '模型调用失败' })]);
    await expect(
      fetchFindResult(new AbortController().signal, () => Promise.resolve(res), 1000, () => {}),
    ).rejects.toMatchObject({ code: 'LLM_ERROR' });
  });

  it('非 event-stream 的失败响应仍按 JSON error 抛出（迁移不能改这条契约）', async () => {
    const res = new Response(JSON.stringify({ error: '数据库未配置' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
    await expect(
      fetchFindResult(new AbortController().signal, () => Promise.resolve(res), 1000, () => {}),
    ).rejects.toThrow('数据库未配置');
  });
});

describe('写库失败必须对用户可见', () => {
  it('persisted 为 false 时给出可见提示', () => {
    expect(persistWarning({ type: 'result', persisted: false })).toBeTruthy();
  });

  it('persisted 为 true / 字段缺失时不打扰用户', () => {
    expect(persistWarning({ type: 'result', persisted: true })).toBeNull();
    expect(persistWarning({ type: 'result' })).toBeNull();
    expect(persistWarning({ type: 'progress', step: 'verify' })).toBeNull();
  });

  it('提示说的是「没保存」，不把 persisted/数据库这类技术细节抛给用户', () => {
    const message = persistWarning({ type: 'result', persisted: false });
    expect(message).toBeTruthy();
    expect(message).toContain('保存');
    expect(message).not.toMatch(/persisted|database|DATABASE|SQL|stack|500/i);
  });

  it('端到端：result 帧里 persisted:false 经真实消费路径后，提示确实可见', async () => {
    const res = sseResponse([
      frame({ type: 'result', step: 'rerank', items: [{ title: '诡秘之主' }], persisted: false }),
    ]);
    const event = await fetchFindResult(
      new AbortController().signal, () => Promise.resolve(res), 1000, () => {},
    );
    expect(persistWarning(event)).toBeTruthy();
  });
});

// F13：合法零结果（items 为空）与写库失败是两回事——前者是正常结局，只讲清为什么没结果，
// 不套用「未能保存」的警告；后者走 persistWarning。
describe('合法零结果给出排除摘要而不是保存警告', () => {
  it('空 items 且带摘要时拼出原因 + 建议', () => {
    const note = zeroResultNote({
      type: 'result', items: [], zeroReason: '本轮 3 本候选全被重排淘汰。', zeroSuggestion: '没有自动放宽任何硬约束。',
    });
    expect(note).toContain('全被重排淘汰');
    expect(note).toContain('没有自动放宽');
  });

  it('items 非空 / 非 result 帧 / 缺摘要都不误报', () => {
    expect(zeroResultNote({ type: 'result', items: [{ title: '书' }] })).toBeNull();
    expect(zeroResultNote({ type: 'result', items: [] })).toBeNull();
    expect(zeroResultNote({ type: 'progress', step: 'verify' })).toBeNull();
  });

  it('零结果不触发「未能保存」的写库警告（persisted 缺省）', () => {
    const event: SseEvent = { type: 'result', items: [], zeroReason: '全被淘汰。', zeroSuggestion: '重新试。' };
    expect(persistWarning(event)).toBeNull();
    expect(zeroResultNote(event)).toBeTruthy();
  });
});
