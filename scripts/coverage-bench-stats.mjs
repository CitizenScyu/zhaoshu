// 换源覆盖率基准：纯统计模块（无 IO、无网络、无 DB）。
// 输入是每本书 × 每源的探测结果，输出覆盖率/分层/每源/单点依赖度/对比。
// probeSourceForBook 的 status：ok | similar | ambiguous | no_candidates | miss | timeout |
//   unreachable | compile_failed（另有采集侧的 threw）。覆盖判定只认「可切换」：status==='ok' 且 readable===true。
// 与生产面板同口径：ok 表示搜索→详情→身份校验→目录可取（可切换到该源阅读）；不额外取正文。

/**
 * 一个「可读且 probe=ok」的 (源,书) 对的命中档：
 * - exact：数据库权威键 canonicalBookKey 相等（idExact===true）；
 * - identity：过了阅读面板身份判定 sourceBookMatches（probe 判 ok）但权威键不等（idExact!==true，
 *   典型是繁体站、作者带「作者：」「著」前后缀）；
 * - fuzzy：走了模糊降级（raw 里 fuzzy===true）。
 * 旧 raw.json 没有 idExact/fuzzy 字段时，idExact 缺失按 identity、fuzzy 缺失按非模糊处理。
 */
export function matchTier(s) {
  if (s.fuzzy === true) return 'fuzzy';
  return s.idExact === true ? 'exact' : 'identity';
}

/** 一本书是否被覆盖：至少一个「可读且 probe=ok」的源。 */
export function isCovered(book) {
  return (book.perSource || []).some((s) => s.status === 'ok' && s.readable === true);
}

/** 一本书是否「可信覆盖」：至少一个 exact 或 identity 档的可读 ok 源（模糊降级不算可信）。 */
export function isTrusted(book) {
  return (book.perSource || []).some((s) => s.status === 'ok' && s.readable === true && matchTier(s) !== 'fuzzy');
}

/** 一本书里「可读且 ok」的源主机列表（去重，保序）。 */
export function okHosts(book) {
  const seen = new Set();
  const out = [];
  for (const s of book.perSource || []) {
    if (s.status === 'ok' && s.readable === true && !seen.has(s.host)) { seen.add(s.host); out.push(s.host); }
  }
  return out;
}

function rate(covered, total) {
  return total > 0 ? Number((covered / total).toFixed(4)) : 0;
}

function groupBy(results, key) {
  /** @type {Record<string, { books: number, covered: number, coverageRate: number, exact: number, identity: number, fuzzy: number, trusted: number, trustedCoverageRate: number }>} */
  const groups = {};
  for (const b of results) {
    const g = b[key] || '(未分组)';
    (groups[g] ||= { books: 0, covered: 0, coverageRate: 0, exact: 0, identity: 0, fuzzy: 0, trusted: 0, trustedCoverageRate: 0 });
    groups[g].books += 1;
    if (isCovered(b)) groups[g].covered += 1;
    if (isTrusted(b)) groups[g].trusted += 1;
    for (const s of b.perSource || []) {
      if (s.status === 'ok' && s.readable === true) groups[g][matchTier(s)] += 1;
    }
  }
  for (const g of Object.values(groups)) {
    g.coverageRate = rate(g.covered, g.books);
    g.trustedCoverageRate = rate(g.trusted, g.books);
  }
  return groups;
}

/** 每源聚合：尝试数、ok 数、覆盖书数、平均耗时、失败分类。 */
export function sourceStats(results) {
  const map = new Map();
  for (const b of results) {
    const coveredHosts = new Set(okHosts(b));
    for (const s of b.perSource || []) {
      const rec = map.get(s.host) || { host: s.host, name: s.name || '', attempts: 0, ok: 0, coverage: 0, totalMs: 0, statuses: {} };
      rec.attempts += 1;
      rec.statuses[s.status] = (rec.statuses[s.status] || 0) + 1;
      if (typeof s.ms === 'number') rec.totalMs += s.ms;
      if (s.status === 'ok' && s.readable === true) rec.ok += 1;
      map.set(s.host, rec);
    }
    for (const h of coveredHosts) {
      const rec = map.get(h);
      if (rec) rec.coverage += 1;
    }
  }
  return [...map.values()]
    .map((r) => ({ ...r, avgMs: r.attempts ? Math.round(r.totalMs / r.attempts) : 0 }))
    .sort((a, b) => b.ok - a.ok || b.coverage - a.coverage || a.host.localeCompare(b.host));
}

/**
 * 单点依赖度：贡献 ok 最多的单个站点占全部 (源,书) ok 对的比例（okPairs 口径），
 * 以及「唯一可读源就是该站点」的书占已覆盖书的比例（书级口径，更贴近换源失效风险）。
 */
export function singlePointDependency(results, srcStats) {
  const okPairs = srcStats.reduce((n, s) => n + s.ok, 0);
  const top = srcStats.find((s) => s.ok > 0);
  const topHost = top ? top.host : null;
  const topHostOk = top ? top.ok : 0;
  let soleProviderBooks = 0;
  let coveredBooks = 0;
  for (const b of results) {
    const hosts = okHosts(b);
    if (hosts.length === 0) continue;
    coveredBooks += 1;
    if (hosts.length === 1 && topHost && hosts[0] === topHost) soleProviderBooks += 1;
  }
  return {
    topHost,
    topHostOk,
    okPairs,
    ratio: okPairs > 0 ? Number((topHostOk / okPairs).toFixed(4)) : 0,
    soleProviderBooks,
    soleProviderRate: coveredBooks > 0 ? Number((soleProviderBooks / coveredBooks).toFixed(4)) : 0,
  };
}

/** 主汇总：覆盖率 + 分层 + 分题材 + 每源 + 单点依赖度 + 未覆盖清单 + 状态计数。 */
export function summarize(results, meta = {}) {
  const books = results.length;
  const covered = results.filter(isCovered).length;
  const srcStats = sourceStats(results);
  const statusTotals = {};
  for (const b of results) {
    for (const s of b.perSource || []) statusTotals[s.status] = (statusTotals[s.status] || 0) + 1;
  }
  const tiers = { exact: 0, identity: 0, fuzzy: 0 };
  for (const b of results) {
    for (const s of b.perSource || []) {
      if (s.status === 'ok' && s.readable === true) tiers[matchTier(s)] += 1;
    }
  }
  const trusted = results.filter(isTrusted).length;
  return {
    generatedAt: meta.generatedAt || new Date().toISOString(),
    codeVersion: meta.codeVersion || null,
    poolSize: meta.poolSize ?? null,
    label: meta.label || null,
    totals: {
      books,
      covered,
      coverageRate: rate(covered, books),
      okPairs: srcStats.reduce((n, s) => n + s.ok, 0),
      // idExactPairs 保留：旧 summary 与既有断言依赖该字段，与 tiers.exact 同值。
      idExactPairs: tiers.exact,
      tiers,
      trusted,
      trustedCoverageRate: rate(trusted, books),
    },
    byTier: groupBy(results, 'tier'),
    byGenre: groupBy(results, 'genre'),
    bySource: srcStats,
    singlePoint: singlePointDependency(results, srcStats),
    uncovered: results.filter((b) => !isCovered(b)).map((b) => ({ title: b.title, author: b.author, tier: b.tier })),
    statusTotals,
  };
}

const bookKey = (b) => JSON.stringify([b.title, b.author]);

/** 两次汇总对比：总/分层覆盖率差、每源 ok 差、新覆盖/新丢失的书、单点依赖度差。 */
export function compare(prev, curr) {
  const tierKeys = [...new Set([...Object.keys(prev.byTier || {}), ...Object.keys(curr.byTier || {})])];
  const byTierDelta = {};
  for (const t of tierKeys) {
    const p = prev.byTier?.[t]?.coverageRate ?? 0;
    const c = curr.byTier?.[t]?.coverageRate ?? 0;
    byTierDelta[t] = { prev: p, curr: c, delta: Number((c - p).toFixed(4)) };
  }
  // uncovered 差集近似 newlyCovered/newlyLost（书目键一致时精确；键 = JSON.stringify([title, author])，无分隔符碰撞）。
  const prevUncov = new Set((prev.uncovered || []).map(bookKey));
  const currUncov = new Set((curr.uncovered || []).map(bookKey));
  const newlyCovered = [...prevUncov].filter((k) => !currUncov.has(k)).map((k) => JSON.parse(k));
  const newlyLost = [...currUncov].filter((k) => !prevUncov.has(k)).map((k) => JSON.parse(k));
  const okByHost = (s) => new Map((s.bySource || []).map((r) => [r.host, r.ok]));
  const pOk = okByHost(prev);
  const cOk = okByHost(curr);
  const hosts = [...new Set([...pOk.keys(), ...cOk.keys()])];
  const bySourceDelta = hosts
    .map((h) => ({ host: h, prevOk: pOk.get(h) || 0, currOk: cOk.get(h) || 0, delta: (cOk.get(h) || 0) - (pOk.get(h) || 0) }))
    .filter((r) => r.delta !== 0)
    .sort((a, b) => b.delta - a.delta);
  return {
    coverageRate: {
      prev: prev.totals?.coverageRate ?? 0,
      curr: curr.totals?.coverageRate ?? 0,
      delta: Number(((curr.totals?.coverageRate ?? 0) - (prev.totals?.coverageRate ?? 0)).toFixed(4)),
    },
    trustedCoverageRate: {
      prev: prev.totals?.trustedCoverageRate ?? 0,
      curr: curr.totals?.trustedCoverageRate ?? 0,
      delta: Number(((curr.totals?.trustedCoverageRate ?? 0) - (prev.totals?.trustedCoverageRate ?? 0)).toFixed(4)),
    },
    /** @type {{ exact: {prev:number,curr:number,delta:number}, identity: {prev:number,curr:number,delta:number}, fuzzy: {prev:number,curr:number,delta:number} }} */
    tiers: Object.fromEntries(['exact', 'identity', 'fuzzy'].map((k) => {
      const p = prev.totals?.tiers?.[k] ?? 0;
      const c = curr.totals?.tiers?.[k] ?? 0;
      return [k, { prev: p, curr: c, delta: c - p }];
    })),
    byTierDelta,
    newlyCovered,
    newlyLost,
    bySourceDelta,
    singlePoint: {
      prevRatio: prev.singlePoint?.ratio ?? 0,
      currRatio: curr.singlePoint?.ratio ?? 0,
      delta: Number(((curr.singlePoint?.ratio ?? 0) - (prev.singlePoint?.ratio ?? 0)).toFixed(4)),
    },
  };
}

const pct = (r) => `${(r * 100).toFixed(1)}%`;

/** 一页中文 markdown 报告。opts.compare 传 compare() 结果时附对比小节。 */
export function renderMarkdown(summary, opts = {}) {
  const L = [];
  L.push(`# 换源覆盖率基准结果${opts.title ? ` — ${opts.title}` : ''}`);
  L.push('');
  const meta = [];
  if (summary.label) meta.push(`标签 ${summary.label}`);
  if (summary.codeVersion) meta.push(`代码 ${summary.codeVersion}`);
  if (summary.poolSize != null) meta.push(`源池 ${summary.poolSize} 条`);
  meta.push(`生成 ${summary.generatedAt}`);
  L.push(meta.join(' / '));
  L.push('');
  const t = summary.totals;
  L.push(`## 总览`);
  L.push('');
  L.push(`- **基准覆盖率 ${pct(t.coverageRate)}**（${t.covered}/${t.books} 本至少一个可切换源）`);
  L.push(`- **可信覆盖率 ${pct(t.trustedCoverageRate)}**（${t.trusted}/${t.books} 本至少一个 exact 或 identity 命中；模糊降级不算可信）`);
  L.push(`- 可读 ok 的 (源,书) 对：${t.okPairs}，分三档 exact=${t.tiers.exact} / identity=${t.tiers.identity} / fuzzy=${t.tiers.fuzzy}`);
  const sp = summary.singlePoint;
  L.push(`- **单点依赖度 ${pct(sp.ratio)}**：贡献 ok 最多的站点 ${sp.topHost || '无'}（${sp.topHostOk}/${sp.okPairs} 个 ok 对）`);
  L.push(`- 单源命脉书：${sp.soleProviderBooks} 本已覆盖书的唯一可读源就是该站点（占已覆盖 ${pct(sp.soleProviderRate)}）`);
  L.push('');
  L.push(`## 分层覆盖率`);
  L.push('');
  L.push('| 分层 | 覆盖 | 总数 | 覆盖率 | exact | identity | fuzzy | 可信覆盖率 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const [tier, s] of Object.entries(summary.byTier)) L.push(`| ${tier} | ${s.covered} | ${s.books} | ${pct(s.coverageRate)} | ${s.exact} | ${s.identity} | ${s.fuzzy} | ${pct(s.trustedCoverageRate)} |`);
  L.push('');
  L.push(`## 分题材覆盖率`);
  L.push('');
  L.push('| 题材 | 覆盖 | 总数 | 覆盖率 |');
  L.push('|---|---|---|---|');
  for (const [g, s] of Object.entries(summary.byGenre).sort((a, b) => b[1].books - a[1].books)) L.push(`| ${g} | ${s.covered} | ${s.books} | ${pct(s.coverageRate)} |`);
  L.push('');
  L.push(`## 每源（按 ok 数排序，取前 25）`);
  L.push('');
  L.push('| 站点 | ok | 覆盖书 | 尝试 | 平均ms | 主要失败 |');
  L.push('|---|---|---|---|---|---|');
  for (const s of summary.bySource.slice(0, 25)) {
    const fails = Object.entries(s.statuses).filter(([k]) => k !== 'ok').sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
    L.push(`| ${s.host} | ${s.ok} | ${s.coverage} | ${s.attempts} | ${s.avgMs} | ${fails || '-'} |`);
  }
  L.push('');
  L.push(`## 状态计数（全部 源×书 尝试）`);
  L.push('');
  L.push(Object.entries(summary.statusTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '（无）');
  L.push('');
  if (summary.uncovered.length) {
    L.push(`## 零覆盖书（${summary.uncovered.length}）`);
    L.push('');
    L.push(summary.uncovered.map((b) => `${b.title}/${b.author}(${b.tier})`).join('、'));
    L.push('');
  }
  if (opts.compare) {
    const c = opts.compare;
    L.push(`## 与上一次对比`);
    L.push('');
    L.push(`- 总覆盖率 ${pct(c.coverageRate.prev)} → ${pct(c.coverageRate.curr)}（${c.coverageRate.delta >= 0 ? '+' : ''}${pct(c.coverageRate.delta)}）`);
    L.push(`- 可信覆盖率 ${pct(c.trustedCoverageRate.prev)} → ${pct(c.trustedCoverageRate.curr)}（${c.trustedCoverageRate.delta >= 0 ? '+' : ''}${pct(c.trustedCoverageRate.delta)}）`);
    L.push(`- 三档 (源,书) 对前后差：${['exact', 'identity', 'fuzzy'].map((k) => `${k} ${c.tiers[k].prev}→${c.tiers[k].curr}（${c.tiers[k].delta >= 0 ? '+' : ''}${c.tiers[k].delta}）`).join('、')}`);
    L.push(`- 单点依赖度 ${pct(c.singlePoint.prevRatio)} → ${pct(c.singlePoint.currRatio)}（${c.singlePoint.delta >= 0 ? '+' : ''}${pct(c.singlePoint.delta)}）`);
    if (c.newlyCovered.length) L.push(`- 新覆盖 ${c.newlyCovered.length} 本：${c.newlyCovered.map((x) => x.join('/')).join('、')}`);
    if (c.newlyLost.length) L.push(`- 新丢失 ${c.newlyLost.length} 本：${c.newlyLost.map((x) => x.join('/')).join('、')}`);
    if (c.bySourceDelta.length) L.push(`- 每源 ok 变化：${c.bySourceDelta.map((r) => `${r.host}(${r.delta >= 0 ? '+' : ''}${r.delta})`).join('、')}`);
    L.push('');
  }
  return L.join('\n');
}

