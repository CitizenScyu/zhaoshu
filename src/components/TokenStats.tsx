import type { LlmUsagePhase, TokenStats } from '@/lib/llm-usage';

const PHASE_NAMES: Record<LlmUsagePhase, string> = {
  find_recall: '找书 · 召回',
  find_rerank: '找书 · 重排',
  profile: '生成画像',
  feedback: '反馈更新',
};

const count = (value: number) => value.toLocaleString('zh-CN');

export function TokenStatTile({ tokens, available }: { tokens: TokenStats | null | undefined; available?: boolean }) {
  return (
    <div className="book-card px-4 py-4 sm:px-5">
      <dt className="text-xs tracking-[0.2em]" style={{ color: 'var(--ink-faint)' }}>LLM tokens</dt>
      <dd className="mt-2 leading-none">
        <span
          className="text-2xl sm:text-3xl font-bold tabular-nums break-all"
          style={{ color: tokens ? 'var(--ink)' : 'var(--ink-faint)' }}
        >
          {tokens ? count(tokens.total.total) : available === false ? '不可用' : '暂未统计'}
        </span>
      </dd>
      <p className="text-xs mt-2 leading-5" style={{ color: 'var(--ink-faint)' }}>
        {tokens
          ? `近 24 小时 ${count(tokens.last24h.total)} · 已记录 ${count(tokens.total.calls)} 次调用`
          : available === false ? '用量统计暂不可用，请刷新重试' : '用量数据接入后在此展示'}
      </p>
    </div>
  );
}

export function TokenUsageDetails({ tokens }: { tokens: TokenStats | null | undefined }) {
  if (!tokens) return null;
  return (
    <section aria-labelledby="stats-tokens">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="stats-tokens" className="text-sm font-bold">模型用量</h3>
        <p className="text-xs leading-6" style={{ color: 'var(--ink-faint)' }}>自用量统计接入起累计</p>
      </div>
      <dl className="mt-3 grid sm:grid-cols-2 gap-4 text-sm">
        {([['累计', tokens.total], ['近 24 小时', tokens.last24h]] as const).map(([label, totals]) => (
            <div key={label} className="border-l-2 pl-3 py-1" style={{ borderColor: 'var(--line)' }}>
              <dt className="text-xs" style={{ color: 'var(--ink-soft)' }}>{label}</dt>
              <dd className="mt-1 leading-7 tabular-nums">
                输入 {count(totals.prompt)} · 输出 {count(totals.completion)}
                <span className="block text-xs" style={{ color: 'var(--ink-faint)' }}>
                  缓存命中 {count(totals.cache)} · 未完整上报 {count(totals.missingUsageCalls)} 次
                </span>
              </dd>
            </div>
        ))}
      </dl>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs sm:text-sm text-right tabular-nums whitespace-nowrap">
          <caption className="sr-only">各场景累计 token 用量</caption>
          <thead style={{ color: 'var(--ink-faint)' }}>
            <tr className="border-b" style={{ borderColor: 'var(--line)' }}>
              {['调用场景', '输入', '输出', '合计', '调用次数'].map((label, index) => (
                <th key={label} scope="col" className={`py-2 font-normal ${index === 0 ? 'text-left pr-4' : 'pl-4'}`}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tokens.byPhase.map((row) => (
              <tr key={row.phase} className="border-b" style={{ borderColor: 'var(--line)' }}>
                <th scope="row" className="text-left py-2.5 pr-4 font-normal">{PHASE_NAMES[row.phase]}</th>
                <td className="pl-4">{count(row.prompt)}</td>
                <td className="pl-4">{count(row.completion)}</td>
                <td className="pl-4 font-bold">{count(row.total)}</td>
                <td className="pl-4">{count(row.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-6" style={{ color: 'var(--ink-faint)' }}>
        缓存命中包含在输入中。未上报的用量按 0 记录，实际用量可能更高。
      </p>
    </section>
  );
}
