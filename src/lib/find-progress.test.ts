import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createElapsedTicker,
  elapsedLabel,
  recallProgressSuffix,
  retryLabel,
  retryStep,
  showRetry,
  type FindPhase,
} from './find-progress';

// 回归护栏（T56-4）：失败重试必须从失败那步起，别把已经成功的召回/验证再跑一遍。
// 这段判断写错，用户每次重排失败都要多付一次召回 LLM 的钱。
describe('失败重试的起点', () => {
  it('重排失败且召回/验证产物都在：只重跑重排', () => {
    expect(retryStep('rerank', { candidates: 20, verified: 18 })).toBe('rerank');
  });

  it('验证失败且召回产物在：从验证起，召回结果直接复用', () => {
    expect(retryStep('verify', { candidates: 20, verified: 0 })).toBe('verify');
  });

  it('召回失败：只能从召回整体重跑', () => {
    expect(retryStep('recall', { candidates: 0, verified: 0 })).toBe('recall');
  });

  it('产物缺失时退回归召回，不拿对不上的数据往下跑', () => {
    expect(retryStep('rerank', { candidates: 20, verified: 0 })).toBe('recall');
    expect(retryStep('rerank', { candidates: 0, verified: 0 })).toBe('recall');
    expect(retryStep('verify', { candidates: 0, verified: 0 })).toBe('recall');
  });

  it('按钮文案标明从哪一步继续，退回召回时只说「重试」', () => {
    expect(retryLabel('rerank')).toBe('从重排步重试');
    expect(retryLabel('verify')).toBe('从验证步重试');
    expect(retryLabel('recall')).toBe('重试');
  });
});

// 回归护栏（T56-5）：recall 等 35-190s 期间至少让用户看到时间在走。
describe('recall 已耗时文案', () => {
  it('按秒呈现', () => {
    expect(elapsedLabel(0)).toBe('已等待 0s');
    expect(elapsedLabel(23)).toBe('已等待 23s');
  });

  it('小数、负数、NaN 都不致出丑数字', () => {
    expect(elapsedLabel(12.7)).toBe('已等待 12s');
    expect(elapsedLabel(-3)).toBe('已等待 0s');
    expect(elapsedLabel(Number.NaN)).toBe('已等待 0s');
  });

  // FindTab 里「什么时候挂这行字」的条件就靠这个函数，不再散在 JSX 三元里。
  it('只在 recall 阶段挂上耗时，其他阶段一个字都不加', () => {
    expect(recallProgressSuffix('recall', 23)).toBe(' 已等待 23s');
    for (const phase of ['idle', 'verify', 'rerank', 'done', 'error'] as FindPhase[]) {
      expect(recallProgressSuffix(phase, 23)).toBe('');
    }
  });
});

// 回归护栏：重试按钮的显示条件。失败态但没有可用起点（或反之）时露出按钮，
// 用户点下去要么没反应要么拿错数据重跑。
describe('重试按钮的显示条件', () => {
  it('失败且拿到重试起点时才显示', () => {
    expect(showRetry('error', 'rerank')).toBe(true);
    expect(showRetry('error', 'verify')).toBe(true);
    expect(showRetry('error', 'recall')).toBe(true);
  });

  it('非失败态一律不显示，即使还留着上次的重试起点', () => {
    for (const phase of ['idle', 'recall', 'verify', 'rerank', 'done'] as FindPhase[]) {
      expect(showRetry(phase, 'rerank')).toBe(false);
    }
  });

  it('失败但没算出起点时不显示', () => {
    expect(showRetry('error', null)).toBe(false);
  });
});

// 回归护栏（T56-5 的清理面）：本项目出过组件卸载后 timer 仍在跑的缺陷。
// stop 必须真的把定时器清掉，否则离开页面后还在 setState。
describe('已耗时计时器', () => {
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const ticks: number[] = [];
    const cleared: unknown[] = [];
    const ticker = createElapsedTicker({
      now: () => Date.now(),
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => { cleared.push(handle); clearInterval(handle as NodeJS.Timeout); },
      onTick: (seconds) => ticks.push(seconds),
      intervalMs: 1000,
    });
    return { ticker, ticks, cleared };
  }

  it('每秒把已等待秒数报出去', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
    const { ticker, ticks } = setup();
    ticker.start();
    vi.advanceTimersByTime(3000);
    expect(ticks).toEqual([1, 2, 3]);
  });

  it('stop 清掉定时器，之后不再有任何 tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
    const { ticker, ticks, cleared } = setup();
    ticker.start();
    vi.advanceTimersByTime(2000);
    ticker.stop();
    expect(cleared).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual([1, 2]);
  });

  it('重复 start 不叠第二个定时器，重复 stop 只清一次', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
    const { ticker, ticks, cleared } = setup();
    ticker.start();
    ticker.start();
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1]);
    ticker.stop();
    ticker.stop();
    expect(cleared).toHaveLength(1);
  });
});
