// bsrcfix-prefetch-20261007：createEngineAdapter 对物理 host 占位门拒绝的分类契约。
// 门错误 = 结构识别 error.code 严格为 HOST_OCCUPIED/HOST_OCCUPANCY_UNAVAILABLE（与
// scripts/engine-download.mjs isHostGateError 同口径，不认 message/status）：
// - 两码分别归 incomplete/source_unavailable + 窄枚举 retryCause（stage='request'），
//   不是 failure、也不是 missing_chapters/download_failed；
// - lease lost / budget / feedback 的原有优先级不变（门分类排在它们之后）；
// - 普通源失败与同文案无稳定 code 的错误不带 retryCause。
// 全部合成值、无网络、不依赖 PGlite（沿 download-worker.feedback.test.ts 的轻量夹具形态）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEngineAdapter, TaskLeaseLostError,
  type EngineDownloadLike, type SourceAdapterContext, type TaskRow,
} from './download-worker';

const PRIVATE_DETAIL = 'synthetic_private_host_detail';

const task: TaskRow = {
  id: 1, book_id: 1, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://book15.net/book', source_kind: 'engine', source_id: null, requested_by: 'system',
};

function context(overrides: Partial<SourceAdapterContext> = {}): SourceAdapterContext {
  return {
    signal: new AbortController().signal,
    progress: async () => {},
    ...overrides,
  };
}

function adapter(downloadBook: EngineDownloadLike) {
  return createEngineAdapter({
    downloadBook,
    modules: {},
    resolveSource: async () => ({}),
    readBookText: async () => { throw new Error('unexpected_text_read'); },
    outRoot: 'synthetic-out',
  });
}

/** 门错误原型：host 私有细节入 cause（断言不进 outcome），message 故意写成可误导文案。 */
function gateError(code: 'HOST_OCCUPIED' | 'HOST_OCCUPANCY_UNAVAILABLE') {
  return Object.assign(new Error(`host gate (${code})`), { code, cause: new Error(PRIVATE_DETAIL) });
}

function feedbackError() {
  return Object.assign(new Error('Limiter feedback persistence unavailable'), {
    code: 'LIMITER_FEEDBACK_UNAVAILABLE', origin: 'limiter-feedback', persistenceOutcome: 'unknown',
  });
}

/** downloadBook 以门错误 reject 的形态（downloadBook 已 rethrow，adapter catch 是第一现场）。 */
const rejecting = (error: unknown): EngineDownloadLike =>
  (async () => { throw error; }) as never as EngineDownloadLike;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected_network'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engine adapter 物理 host 占位门拒绝分类', () => {
  it.each(['HOST_OCCUPIED', 'HOST_OCCUPANCY_UNAVAILABLE'] as const)('%s ⇒ incomplete/source_unavailable + 对应 retryCause', async code => {
    const outcome = await adapter(rejecting(gateError(code))).download(task, context());
    expect(outcome).toEqual({
      kind: 'incomplete', reason: 'source_unavailable',
      chaptersTotal: 0, chaptersDone: 0, charsTotal: 0,
      stage: 'request', retryCause: code === 'HOST_OCCUPIED' ? 'host_occupied' : 'host_occupancy_unavailable',
    });
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_DETAIL);
  });

  it('signal 已被普通中断（reason 非失权/非预算）时按 interrupted 收口，不换源、不带 retryCause', async () => {
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));
    const outcome = await adapter(rejecting(gateError('HOST_OCCUPIED'))).download(task, context({ signal: controller.signal }));
    expect(outcome).toEqual({ kind: 'incomplete', reason: 'interrupted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 });
  });

  it('signal budget + 门错误：预算仍优先，归 budget_exhausted 不带 retryCause', async () => {
    const controller = new AbortController();
    controller.abort(new Error('budget_exhausted'));
    const outcome = await adapter(rejecting(gateError('HOST_OCCUPIED'))).download(task, context({ signal: controller.signal }));
    expect(outcome).toEqual({ kind: 'incomplete', reason: 'budget_exhausted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 });
  });

  it('lease lost 优先于门分类：失权错误仍抛 TaskLeaseLostError', async () => {
    await expect(adapter(rejecting(new TaskLeaseLostError())).download(task, context())).rejects.toBeInstanceOf(TaskLeaseLostError);
    // signal.reason 失权形态（downloadBook 内 onProgress 抛失权后 abort）同样升格，不被门分类吞掉
    const controller = new AbortController();
    controller.abort(new TaskLeaseLostError());
    await expect(adapter(rejecting(gateError('HOST_OCCUPIED'))).download(task, context({ signal: controller.signal })))
      .rejects.toBeInstanceOf(TaskLeaseLostError);
  });

  it('budget 优先于门分类：预算耗尽仍归 incomplete/budget_exhausted（不带 retryCause）', async () => {
    const outcome = await adapter(rejecting(new Error('budget_exhausted'))).download(task, context());
    expect(outcome).toEqual({ kind: 'incomplete', reason: 'budget_exhausted', chaptersTotal: 0, chaptersDone: 0, charsTotal: 0 });
  });

  it('feedback 优先于门分类：LIMITER_FEEDBACK_UNAVAILABLE 原样上抛并经回调上报', async () => {
    const error = feedbackError();
    const reports: unknown[] = [];
    await expect(adapter(rejecting(error)).download(task, context({
      onFeedbackFailure: reported => { reports.push(reported); },
    }))).rejects.toBe(error);
    expect(reports).toEqual([error]);
  });

  it('普通源失败不带 retryCause：failure 桶或不含该字段的 incomplete', async () => {
    const failure = await adapter(rejecting(new Error('synthetic_source_failure'))).download(task, context());
    expect(failure).toEqual({ kind: 'failure', code: 'synthetic_source_failure' });
    const partial = await adapter((async () => ({
      code: 1, manifest: { status: 'partial', errors: ['missing_chapters'], chapters_total: 3, chapters_done: 2, chars: 1620 },
    })) as never as EngineDownloadLike).download(task, context());
    expect(partial).toEqual({ kind: 'incomplete', reason: 'missing_chapters', chaptersTotal: 3, chaptersDone: 2, charsTotal: 1620 });
  });

  it('仅结构识别：同文案 message、带 status 或 code 近似的错误不归门分类', async () => {
    const lookalike = Object.assign(new Error('host gate (HOST_OCCUPIED)'), { status: 503 });
    // diag1031：adapter_runtime_error 带构造器名（白名单形态），原文仍不进结果。
    expect(await adapter(rejecting(lookalike)).download(task, context()))
      .toEqual({ kind: 'failure', code: 'adapter_runtime_error', detail: 'Error' });
    const wrongCode = Object.assign(new Error('host occupied'), { code: 'HOST_OCCUPANCY_UNAVAILABLE_TYPO' });
    expect(await adapter(rejecting(wrongCode)).download(task, context())).toMatchObject({ kind: 'failure' });
  });
});
