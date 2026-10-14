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
  const anchors = [
    'let rateLimiter = null;',
    'await startSharedRateSupervisor({ sharedRate: config.sharedRate',
    'verifyStartup: verifySharedRateStartup,',
    'createLimiter:',
    'createSharedRateLimiter({',
    'if (!startup.allowed) {',
    /process\.exitCode = startup\.exitCode;\r?\n[^\S\n]*return;/g,
    'rateLimiter = startup.limiter;',
    'rateLimiter = new SourceRateLimiter({',
  ];
  let previous = -1;
  for (const anchor of anchors) {
    const positions = [];
    if (typeof anchor === 'string') {
      let at = original.indexOf(anchor);
      while (at !== -1) { positions.push(at); at = original.indexOf(anchor, at + anchor.length); }
    } else {
      for (const match of original.matchAll(anchor)) positions.push(match.index);
    }
    if (positions.length !== 1 || positions[0] >= startAt || positions[0] <= previous) {
      throw new Error('main.mjs 共享限速 supervisor 装配锚点失配：需人工复核（未生成 tar）');
    }
    previous = positions[0];
  }
  const prefix = original.slice(0, startAt);
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
