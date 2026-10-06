// Pure production template; no filesystem, environment or build dependencies.
export function wireDownloadExecutor(original) {
  const START = '  // ---- 执行器接缝（T3 交付后替换）----';
  const END = '\n  const loop = createDrainLoop({';
  const startAt = original.indexOf(START);
  const endAt = original.indexOf(END, startAt);
  if (startAt < 0 || endAt < 0 ||
      original.indexOf(START, startAt + START.length) !== -1 ||
      original.indexOf(END, endAt + END.length) !== -1) {
    throw new Error('main.mjs 执行器接缝锚点缺失或不唯一：shell 已变更，需人工复核（未生成 tar）');
  }
  // The selected limiter must be in the preserved prefix, never synthesized here.
  const prefix = original.slice(0, startAt);
  if (!prefix.includes('let rateLimiter = null;') ||
      !prefix.includes('rateLimiter = createSharedRateLimiter({') ||
      !prefix.includes('rateLimiter = new SourceRateLimiter({') ||
      !prefix.includes('await verifySharedRateStartup(config.sharedRate);') ||
      prefix.indexOf('await verifySharedRateStartup(config.sharedRate);') >
        prefix.indexOf('rateLimiter = createSharedRateLimiter({')) {
    throw new Error('main.mjs 已选限速器装配锚点失配：需人工复核（未生成 tar）');
  }
  const injection = `${START}
  let dummyTasks = 2;
  let productionRunOnce = null;
  const runOnce = async (signal) => {
    if (dummy) {
      if (dummyTasks <= 0) return LoopDecision.NO_TASK;
      const consumed = await budget.consume();
      if (!consumed.allowed) return LoopDecision.BUDGET_EXHAUSTED;
      dummyTasks -= 1;
      log('info', 'dummy 执行器完成一本（合成任务）', { used: consumed.used, limit: consumed.limit });
      return LoopDecision.TASK_DONE;
    }
    if (!productionRunOnce) {
      const { createDownloadExecutor } = await import('../executor/executor.mjs');
      const executor = await createDownloadExecutor({
        budget,
        // 与 createDailyBudget 同一文件和上限，保留源不可达退款与预算预检合同。
        budgetStatePath: join(stateDir, 'daily-budget.json'),
        budgetLimit: config.dailyBookLimit,
        workDir: join(stateDir, 'download'),
        rateLimiter,
        decisions: LoopDecision,
        log,
      });
      productionRunOnce = executor.runOnce;
    }
    return productionRunOnce(signal);
  };`;
  return prefix + injection + original.slice(endAt);
}
