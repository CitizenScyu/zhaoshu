import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LLM_USAGE_PHASES, type TokenStats } from '@/lib/llm-usage';
import { TokenStatTile, TokenUsageDetails } from './TokenStats';

const zero = { prompt: 0, completion: 0, total: 0, cache: 0, calls: 0, missingUsageCalls: 0 };
const empty: TokenStats = { total: zero, last24h: zero, byPhase: LLM_USAGE_PHASES.map((phase) => ({ phase, ...zero })) };
const tokens: TokenStats = {
  total: { prompt: 1200, completion: 300, total: 1500, cache: 500, calls: 4, missingUsageCalls: 1 },
  last24h: { prompt: 200, completion: 100, total: 300, cache: 50, calls: 1, missingUsageCalls: 0 },
  byPhase: empty.byPhase,
};

describe('token stats display and deployment compatibility', () => {
  it.each([null, undefined])('accepts legacy tokens=%s without treating it as measured zero', (legacy) => {
    const tile = renderToStaticMarkup(createElement(TokenStatTile, { tokens: legacy }));
    expect(tile).toContain('暂未统计');
    expect(tile).not.toContain('已记录 0 次调用');
    expect(renderToStaticMarkup(createElement(TokenUsageDetails, { tokens: legacy }))).toBe('');
  });

  it('renders measured zero with all four phases after the new endpoint becomes available', () => {
    const tile = renderToStaticMarkup(createElement(TokenStatTile, { tokens: empty, available: true }));
    expect(tile).toContain('已记录 0 次调用');
    expect(tile).not.toContain('暂未统计');
    const details = renderToStaticMarkup(createElement(TokenUsageDetails, { tokens: empty }));
    for (const phase of ['找书 · 召回', '找书 · 重排', '生成画像', '反馈更新']) expect(details).toContain(phase);
  });

  it('shows unavailable rather than zero when the new usage partition fails', () => {
    const tile = renderToStaticMarkup(createElement(TokenStatTile, { tokens: null, available: false }));
    expect(tile).toContain('不可用');
    expect(tile).toContain('请刷新重试');
    expect(tile).not.toContain('已记录 0 次调用');
  });

  it('shows total, recent, input/output, cache and missing counts with readable formatting', () => {
    const tile = renderToStaticMarkup(createElement(TokenStatTile, { tokens, available: true }));
    expect(tile).toContain('1,500');
    expect(tile).toContain('近 24 小时 300 · 已记录 4 次调用');
    const details = renderToStaticMarkup(createElement(TokenUsageDetails, { tokens }));
    expect(details).toContain('1,200');
    expect(details).toContain('500');
    expect(details).toContain('未完整上报');
    expect(details).toContain('未上报的用量按 0 记录');
  });
});
