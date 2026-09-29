import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_CHALLENGE_RETEST_MS, ADMISSION_HTTP_ERR_MAX_MS, ADMISSION_RETEST_INTERVAL_MS,
  runAdmissionBatch, rulesHash, searchAdmission,
  type AdmissionSourceRow, type AdmissionTransport,
} from './admission';
import type { RawSource } from './compile-smoke';

const url = 'https://recovery.example.com/';
const source: RawSource = {
  bookSourceUrl: url, bookSourceName: '合成恢复源', searchUrl: url + 'search?q={{key}}',
  ruleSearch: { bookList: '.book', name: '.name@text', bookUrl: 'a@href' },
  ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '.content@text' },
};
const nowMs = Date.parse('2026-09-29T00:00:00Z');
const hosts = new Set(['recovery.example.com']);
const success = '<div class="book"><span class="name">合成书</span><a href="/book/1">详情</a></div>';
const transport = (status: number, text: string) => vi.fn<AdmissionTransport>(async () =>
  new Response(text, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
function legacy(error = 'challenge_strike:3:503', age = ADMISSION_CHALLENGE_RETEST_MS): AdmissionSourceRow {
  return {
    source_url: url, tier: 'M1', compile_ok: true, core_field_mask: {}, search_ok: false,
    search_verdict: 'challenge', search_checked_at: new Date(nowMs - age).toISOString(),
    rules_hash: rulesHash(source), engine_semantics_version: 0, host: 'recovery.example.com',
    error, compile_diagnostics: [],
  };
}
function batch(previous: AdmissionSourceRow | undefined, fetchPage: AdmissionTransport, time = nowMs,
  options: { canProbe?: () => boolean; maxProbes?: number } = {}) {
  return runAdmissionBatch({
    candidates: [{ url, source }], declaredHosts: hosts,
    existing: new Map(previous ? [[url, previous]] : []), fetchPage,
    signal: new AbortController().signal, throttleMs: 0, now: () => new Date(time), ...options,
  });
}

describe('纯503与历史误分类恢复（SRCHEALTH53）', () => {
  it.each(['temporary unavailable', 'cloudflare unavailable', success])('503无强质询标记归入可重测5xx：%s', async (html) => {
    const result = await searchAdmission(source, { fetchPage: transport(503, html), declaredHosts: hosts,
      signal: new AbortController().signal, throttleMs: 0 });
    expect(result).toEqual({ verdict: 'http_5xx', candidateCount: 0, status: 503, error: '503' });
  });

  it.each(['just a moment', '人机验证'])('503强质询继续拒绝并保存可区分原因：%s', async (marker) => {
    const result = await batch(undefined, transport(503, success + marker));
    expect(result.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'challenge',
      error: 'challenge_strike:1:' + marker });
  });

  it('三次临时503之后仍按退避复测，恢复时自动回池', async () => {
    let previous: AdmissionSourceRow | undefined;
    let time = nowMs;
    for (let i = 0; i < 3; i += 1) {
      const result = await batch(previous, transport(503, 'temporarily unavailable'), time);
      expect(result.probed).toBe(1);
      expect(result.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'http_5xx' });
      previous = result.rows[0];
      const wait = ADMISSION_RETEST_INTERVAL_MS * 2 ** i;
      const tooSoon = transport(200, success);
      expect((await batch(previous, tooSoon, time + wait - 1)).probed).toBe(0);
      expect(tooSoon).not.toHaveBeenCalled();
      time += wait;
    }
    const result = await batch(previous, transport(200, success), time);
    expect(result.probed).toBe(1);
    expect(result.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok', error: '' });
  });

  it.each(['503', 'challenge_strike:3:503', 'challenge_strike:7:503'])('历史纯503到期可重新确认：%s', async (error) => {
    const result = await batch(legacy(error), transport(200, success));
    expect(result.probed).toBe(1);
    expect(result.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok', error: '' });
  });

  it('历史纯503仍遵守72h窗、预算与名额，未探测不改旧结论', async () => {
    for (const [previous, options] of [
      [legacy(undefined, ADMISSION_CHALLENGE_RETEST_MS - 1), {}],
      [legacy(), { canProbe: () => false }],
      [legacy(), { maxProbes: 0 }],
    ] as const) {
      const fetchPage = transport(200, success);
      const result = await batch(previous, fetchPage, nowMs, options);
      expect(result.probed).toBe(0);
      expect(result.rows).toEqual([]);
      expect(fetchPage).not.toHaveBeenCalled();
    }
  });

  it('历史纯503复核遇真质询，写标记后仍遵守终态上限', async () => {
    const result = await batch(legacy(), transport(503, 'Just a moment'));
    expect(result.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'challenge',
      error: 'challenge_strike:4:just a moment' });
    const next = transport(200, success);
    const capped = await batch(result.rows[0], next, nowMs + 30 * 24 * 3_600_000);
    expect(capped.probed).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it('历史纯503复核仍是临时503时转退避，后续恢复可用', async () => {
    const failed = await batch(legacy(), transport(503, 'temporarily unavailable'));
    expect(failed.rows[0]).toMatchObject({ search_ok: false, search_verdict: 'http_5xx', error: 'fail_count:2:503' });
    const early = transport(200, success);
    expect((await batch(failed.rows[0], early, nowMs + 2 * ADMISSION_RETEST_INTERVAL_MS - 1)).probed).toBe(0);
    expect(early).not.toHaveBeenCalled();
    const recovered = await batch(failed.rows[0], transport(200, success), nowMs + ADMISSION_HTTP_ERR_MAX_MS);
    expect(recovered.rows[0]).toMatchObject({ search_ok: true, search_verdict: 'ok', error: '' });
  });

  it.each([[403, 'challenge'], [500, 'http_5xx'], [404, 'http_4xx']] as const)
    ('其他错误状态%s不因强标记改桶', async (status, verdict) => {
      const result = await searchAdmission(source, { fetchPage: transport(status, success + 'just a moment'),
        declaredHosts: hosts, signal: new AbortController().signal, throttleMs: 0 });
      expect(result).toMatchObject({ verdict, status, error: String(status), candidateCount: 0 });
    });

  it('历史503复核不抢未测源名额，预算取消不改旧行', async () => {
    const freshUrl = 'https://fresh.example.com/';
    const fresh = { ...source, bookSourceUrl: freshUrl, searchUrl: freshUrl + 'search?q={{key}}' };
    const fetchPage = transport(200, success);
    const previous = legacy();
    const result = await runAdmissionBatch({
      candidates: [{ url, source }, { url: freshUrl, source: fresh }],
      declaredHosts: new Set([...hosts, 'fresh.example.com']), existing: new Map([[url, previous]]),
      fetchPage, signal: new AbortController().signal, throttleMs: 0, maxProbes: 1, now: () => new Date(nowMs),
    });
    expect(result.probed).toBe(1);
    expect(fetchPage.mock.calls.map(([input]) => new URL(input).hostname)).toEqual(['fresh.example.com']);
    expect(result.rows.map((row) => row.source_url)).toEqual([freshUrl]);
    expect(previous.error).toBe('challenge_strike:3:503');
  });

  it.each(['challenge_strike:3:403', 'challenge_strike:3:just a moment', 'challenge_strike:3:503:extra'])
    ('不扩张其他质询终态的重测资格：%s', async (error) => {
      const fetchPage = transport(200, success);
      const result = await batch(legacy(error), fetchPage);
      expect(result.probed).toBe(0);
      expect(fetchPage).not.toHaveBeenCalled();
    });
});
