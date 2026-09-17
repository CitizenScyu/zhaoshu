/**
 * 找书三步（召回/验证/重排）的纯逻辑：失败重试起点、进度文案、已耗时计时器。
 * 抽成不依赖 DOM 的模块，才能在 node 环境直接测——本仓 vitest 只收 *.test.ts 且没有 jsdom。
 */
export type FindStep = 'recall' | 'verify' | 'rerank';

/** 找书页面的阶段。idle/done 为静息态，error 为失败态（可带重试起点）。 */
export type FindPhase = 'idle' | FindStep | 'done' | 'error';

const STEP_NAME: Record<FindStep, string> = { recall: '召回', verify: '验证', rerank: '重排' };

export function stepName(step: FindStep): string {
  return STEP_NAME[step];
}

/**
 * 失败后该从哪一步重试。只有上一步的产物还在手里才能跳过它——跳过召回省一次召回 LLM 调用，
 * 跳过验证省一轮豆瓣/书源核验。产物缺失就一路退回召回：宁可重花钱，也不能拿对不上的数据往下跑。
 */
export function retryStep(
  failed: FindStep,
  products: { candidates: number; verified: number },
): FindStep {
  if (failed === 'rerank' && products.candidates > 0 && products.verified > 0) return 'rerank';
  if (failed === 'verify' && products.candidates > 0) return 'verify';
  return 'recall';
}

/** 重试按钮文案：退回召回就是整轮重跑，其余标明从哪步继续。 */
export function retryLabel(step: FindStep): string {
  return step === 'recall' ? '重试' : `从${STEP_NAME[step]}步重试`;
}

/** recall 没有阶段推进事件（后端只在开头发一帧 phase），只能报已耗时，与 verify 的 x/y 同款。 */
export function elapsedLabel(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `已等待 ${safe}s`;
}

/** 只有 recall 在跑时才把已耗时挂上；其他阶段连那个空格都不留，免得标签尾随空串。 */
export function recallProgressSuffix(phase: FindPhase, seconds: number): string {
  return phase === 'recall' ? ` ${elapsedLabel(seconds)}` : '';
}

/** 重试按钮只在失败态且拿到了可用重试起点时出现；两者缺一都不该给用户点。 */
export function showRetry(phase: FindPhase, retryFrom: FindStep | null): boolean {
  return phase === 'error' && retryFrom !== null;
}

export interface ElapsedTicker {
  start(): void;
  stop(): void;
}

/**
 * 已耗时秒数计时器。调度函数注入，方便在 node 里断言「stop 之后不再 tick 且定时器已清理」——
 * 本项目出过组件卸载后 timer 还在跑的缺陷。
 */
export function createElapsedTicker(options: {
  now: () => number;
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  onTick: (seconds: number) => void;
  intervalMs?: number;
}): ElapsedTicker {
  const intervalMs = options.intervalMs ?? 1000;
  let handle: unknown = null;
  return {
    start() {
      if (handle !== null) return; // 重复 start 不叠第二个定时器
      const startedAt = options.now();
      handle = options.setInterval(
        () => options.onTick(Math.floor((options.now() - startedAt) / 1000)),
        intervalMs,
      );
    },
    stop() {
      if (handle === null) return;
      options.clearInterval(handle);
      handle = null;
    },
  };
}
