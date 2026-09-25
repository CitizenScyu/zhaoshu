import { describe, expect, it } from 'vitest';
import { buildFailureStatus, QUOTA_STATE, quotaGate } from './quota-gate';

const NOW = Date.parse('2026-09-25T04:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const quotaStatus = (lastFailedAtMs: number, retryAfterMs: number) => JSON.stringify({
  state: QUOTA_STATE, consecutive: 1, firstFailedAt: iso(lastFailedAtMs), lastFailedAt: iso(lastFailedAtMs),
  retryAfter: iso(retryAfterMs), reason: 'db_quota_exceeded',
});

describe('quotaGate（刷新运行器启动闸）', () => {
  it('无状态文件 / 空 / 损坏 / refresh-failed ⇒ 放行，无需补记', () => {
    for (const text of [null, '', '{bad json', '[]', JSON.stringify({ state: 'refresh-failed', retryAfter: iso(NOW + 60_000) })]) {
      expect(quotaGate(text, NOW)).toEqual({ skip: false, quotaSeenAt: null });
    }
  });

  it('配额态且未到 retryAfter ⇒ 跳过（不碰库）', () => {
    const seen = NOW - 10 * 60_000;
    expect(quotaGate(quotaStatus(seen, seen + 30 * 60_000), NOW)).toEqual({ skip: true, retryAt: iso(seen + 30 * 60_000) });
  });

  it('配额态且已过 retryAfter ⇒ 放行，并带回上次发现时刻供成功后补记', () => {
    const seen = NOW - 40 * 60_000;
    expect(quotaGate(quotaStatus(seen, seen + 30 * 60_000), NOW)).toEqual({ skip: false, quotaSeenAt: iso(seen) });
  });

  it('retryAfter 远超冷却上限（时钟回拨/手改）⇒ 不挡，照常放行', () => {
    expect(quotaGate(quotaStatus(NOW, NOW + 5 * 3_600_000), NOW).skip).toBe(false);
  });

  it('配额态但 retryAfter 缺失/非法 ⇒ 放行', () => {
    expect(quotaGate(JSON.stringify({ state: QUOTA_STATE }), NOW)).toEqual({ skip: false, quotaSeenAt: null });
    expect(quotaGate(JSON.stringify({ state: QUOTA_STATE, retryAfter: 'x', lastFailedAt: iso(NOW - 1) }), NOW))
      .toEqual({ skip: false, quotaSeenAt: iso(NOW - 1) });
  });
});

describe('buildFailureStatus', () => {
  it('普通失败保持原 refresh-failed 形态', () => {
    expect(buildFailureStatus(null, 'upstream 503', NOW, null)).toEqual({
      state: 'refresh-failed', consecutive: 1, firstFailedAt: iso(NOW), lastFailedAt: iso(NOW), reason: 'upstream 503',
    });
  });

  it('配额失败：原因码 + retryAfter，不写驱动原文', () => {
    const status = buildFailureStatus(null, 'Server error (HTTP status 402): {"message":"… Upgrade …"}', NOW, 30 * 60_000);
    expect(status).toEqual({
      state: QUOTA_STATE, consecutive: 1, firstFailedAt: iso(NOW), lastFailedAt: iso(NOW),
      retryAfter: iso(NOW + 30 * 60_000), reason: 'db_quota_exceeded',
    });
    expect(JSON.stringify(status)).not.toMatch(/HTTP status|Upgrade/);
  });

  it('连续失败计数跨两种失败态累计；写出的配额态能被 quotaGate 读回并挡住', () => {
    const prev = JSON.stringify({ state: 'refresh-failed', consecutive: 2, firstFailedAt: iso(NOW - 86_400_000) });
    const status = buildFailureStatus(prev, 'x', NOW, 30 * 60_000);
    expect(status.consecutive).toBe(3);
    expect(status.firstFailedAt).toBe(iso(NOW - 86_400_000));
    expect(quotaGate(JSON.stringify(status), NOW + 60_000)).toEqual({ skip: true, retryAt: iso(NOW + 30 * 60_000) });
  });
});
