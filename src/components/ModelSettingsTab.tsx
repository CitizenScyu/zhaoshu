'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import { REASONING_CONFIRMATION_CODE } from '@/lib/app-settings';
import type { LlmModelSettings, LlmModelSource, ReasoningVerdict } from '@/lib/app-settings';

const SOURCE_LABELS: Record<LlmModelSource, string> = {
  database: '数据库设置',
  environment: '环境变量 LLM_MODEL',
  default: '硬编码缺省',
};

// 默认值那一栏的来源措辞要跟「当前模型」区分开：两个都用 'database'，
// 但对默认值来说它指的是「库内默认值」这一列，不是当前模型的覆盖值。
export const DEFAULT_SOURCE_LABELS: Record<LlmModelSource, string> = {
  database: '库内默认值',
  environment: '环境变量 LLM_MODEL',
  default: '硬编码缺省',
};

// 三态判定在页面上的说法。'unknown' 不能说成「否」：探测没观察到思维链不等于该模型
// 不是推理模型（短请求本来就可能不触发思考），2026-09-17 之前这里就是这么说的。
const REASONING_LABELS: Record<ReasoningVerdict, string> = {
  yes: '是（先出思维链，找书更慢）',
  no: '否',
  unknown: '未观察到',
};

export function reasoningLabel(reasoning: ReasoningVerdict | null): string {
  if (reasoning === null) return '未知（保存时会实测一次）';
  return REASONING_LABELS[reasoning];
}

/**
 * 「恢复默认」这个按钮该不该可用：它清的是 llm_model 覆盖值，所以只在**确实存在覆盖值**时才有意义。
 * 不能直接看 source === 'database'——库内默认值生效时 source 也是 'database'，那会让按钮可点却什么都不做。
 * 判据是 updatedAt：只有 llm_model 那一列有覆盖值时才写它（见 app-settings 的 readModelSetting）。
 */
export function hasModelOverride(settings: LlmModelSettings): boolean {
  return settings.source === 'database' && settings.updatedAt !== null;
}

// 保存成功后的提示：判定为推理模型时必须主动说出来，'unknown' 只补充一句限制说明。
function reasoningNotes(next: { reasoning: ReasoningVerdict | null; warning?: string }): string {
  const notes: string[] = [];
  if (next.warning) notes.push(next.warning);
  else if (next.reasoning === 'yes') notes.push('探测观察到该模型会输出思维链（推理模型），找书会更慢。');
  else if (next.reasoning === 'unknown') {
    notes.push('本次探测没有观察到思维链，但不代表它不是推理模型——探测只能证明「是」。');
  }
  return notes.map((note) => `注意：${note}`).join('');
}

export function savedNotice(model: string, next: { reasoning: ReasoningVerdict | null; warning?: string }): string {
  return `已切换到 ${model}，立即生效。${reasoningNotes(next)}`;
}

// 默认值保存后**暂未生效**时的推理说明。不能复用 reasoningNotes 的「找书会更慢」——
// 那句话描述的是现在，而此刻跑的还是另一个模型；这里说的是"等它生效之后"。
function pendingReasoningNote(next: { reasoning: ReasoningVerdict | null; warning?: string }): string {
  const notes: string[] = [];
  if (next.warning) notes.push(next.warning);
  else if (next.reasoning === 'yes') notes.push('该默认值是推理模型，等它生效后找书会更慢。');
  else if (next.reasoning === 'unknown') {
    notes.push('本次探测没有观察到思维链，但不代表它不是推理模型——探测只能证明「是」。');
  }
  return notes.map((note) => `注意：${note}`).join('');
}

/**
 * 保存默认值后的提示。
 *
 * 🔴 必须按「这个默认值现在到底跑不跑」分开说：当前模型另有 llm_model 覆盖值时，新默认值
 * 一个字节都还没生效。此时统一说「立即生效」是假陈述——若它还是推理模型，接着来一句
 * 「找书会更慢」更是把未来的事说成了现在的事（2026-09-17 审查指出）。
 * 判据就是 model === defaultModel：没有覆盖值时两者是同一个值，有覆盖值时前者是覆盖值。
 */
export function defaultSavedNotice(next: {
  model: string;
  defaultModel: string;
  reasoning: ReasoningVerdict | null;
  warning?: string;
}): string {
  if (next.model === next.defaultModel) {
    return `默认值已改为 ${next.defaultModel}，当前模型就是它，立即生效。${reasoningNotes(next)}`;
  }
  return `默认值已改为 ${next.defaultModel}，暂未生效：当前仍有数据库覆盖值 ${next.model} 在跑，`
    + `要等「恢复默认」之后才会用到它。${pendingReasoningNote(next)}`;
}

/**
 * 「来源」那一栏的文案。库内默认值生效时（source 是 database、但没有 llm_model 覆盖值）
 * 不能笼统写「数据库设置」——紧挨着的「更新时间」同时显示「无覆盖值」，两句放一起自相矛盾。
 * 直接用默认值那一栏的措辞，让读者一眼看出这个值是「默认值」而不是「当前覆盖」。
 */
export function currentSourceLabel(settings: LlmModelSettings): string {
  if (settings.source === 'database' && settings.updatedAt === null) return DEFAULT_SOURCE_LABELS.database;
  return SOURCE_LABELS[settings.source];
}

// 接口的「需要确认」响应 → 确认块要显示的内容；不是这个码就返回 null（当普通错误处理）。
// 单独抽出来是因为它必须与接口的错误码逐字一致：写错一个字母，确认块会静默退化成
// 一句干巴巴的报错，owner 只会以为保存坏了。
export function confirmationFor(
  status: number,
  data: { code?: unknown; error?: unknown },
  model: string | null,
): { model: string; message: string } | null {
  if (status < 400 || data.code !== REASONING_CONFIRMATION_CODE || typeof model !== 'string') return null;
  return {
    model,
    message: typeof data.error === 'string' && data.error ? data.error : '该模型是推理模型，需要确认后才保存。',
  };
}

// owner 专用的最小模型切换入口：展示当前值 + 一个输入框 + 保存 / 恢复默认。
// 保存会先用新模型发一次极小请求验证，验证失败不写库，原因就地显示。
// 「默认值」那一栏同样可改（task-69）：改的是 llm_model 没有覆盖值时用的那个模型，
// 走的是同一套「探测 → 可能确认 → 写库」流程。
type SaveTarget = 'model' | 'defaultModel';

export default function ModelSettingsTab() {
  const { apiFetch } = useOwner();
  const [settings, setSettings] = useState<LlmModelSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [defaultDraft, setDefaultDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // 判为推理模型时接口会先拒绝（409），由 owner 点按钮再保存一次——绝不自动重发，
  // 否则这道确认就退化成一个多余的往返，等于没有确认。target 决定确认后重发到哪一栏。
  const [confirmReasoning, setConfirmReasoning] = useState<{ target: SaveTarget; model: string; message: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/llm', { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '模型设置加载失败');
      setSettings(data as LlmModelSettings);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : '模型设置加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  async function submit(target: SaveTarget, value: string | null, acknowledgeReasoning = false) {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    setConfirmReasoning(null);
    try {
      const res = await apiFetch('/api/admin/llm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [target]: value, ...(acknowledgeReasoning ? { acknowledgeReasoning: true } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 需要确认不是错误：单独摆成一个确认块，把接口给的原因原样带出来。
        const confirmation = confirmationFor(res.status, data, value);
        if (confirmation) {
          setConfirmReasoning({ target, ...confirmation });
          return;
        }
        throw new Error(data.error || '模型设置保存失败');
      }
      const next = data as LlmModelSettings & { warning?: string };
      setSettings(next);
      if (target === 'model') {
        setDraft('');
        setNotice(value === null ? '已恢复默认，立即生效' : savedNotice(next.model, next));
      } else {
        setDefaultDraft('');
        setNotice(value === null
          ? '已清除库内默认值，回退到环境变量/硬编码缺省。'
          : defaultSavedNotice(next));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '模型设置保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-bold">模型</h2>
      <p className="text-sm mt-2 leading-7" style={{ color: 'var(--ink-soft)' }}>
        切换后立即生效，不需要重新部署。保存前会先用候选模型发一次极小请求验证：
        验证不通过就不写库，原因显示在下面。接口密钥与地址始终留在环境变量里，这里只切换模型名。
        「默认值」那一栏也可以改：当前模型没有数据库覆盖值时就跑它，改它同样需要先验证。
      </p>
      <p className="text-xs mt-2 leading-6" style={{ color: 'var(--ink-faint)' }}>
        「推理模型」这一栏只能证明「是」：探测到思维链就报「是」；没探测到只报「未观察到」，
        那不等于该模型不是推理模型。推理模型会让找书变慢，请确认 LLM_MAX_TOKENS 足够。
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm" style={{ color: 'var(--cinnabar)' }}>
          ✗ {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm" style={{ color: 'var(--moss)' }}>
          ✓ {notice}
        </p>
      )}

      {confirmReasoning && (
        <div
          role="alertdialog"
          aria-label="确认使用推理模型"
          className="mt-4 p-3 text-sm space-y-2"
          style={{ border: '1px solid var(--cinnabar)', color: 'var(--ink-soft)' }}
        >
          <p>{confirmReasoning.message}</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="seal-button text-sm"
              disabled={saving}
              onClick={() => void submit(confirmReasoning.target, confirmReasoning.model, true)}
            >
              {saving ? '保存中…' : `确认使用 ${confirmReasoning.model}`}
            </button>
            <button
              type="button"
              className="ink-button text-xs !px-4"
              disabled={saving}
              onClick={() => setConfirmReasoning(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {loading && !settings && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>
      )}

      {settings && (
        <div className="mt-6 space-y-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm" aria-label="当前模型设置">
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>当前模型 </dt><dd className="inline font-bold">{settings.model}</dd></div>
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>来源 </dt><dd className="inline">{currentSourceLabel(settings)}</dd></div>
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>推理模型 </dt><dd className="inline">{reasoningLabel(settings.reasoning)}</dd></div>
            <div>
              <dt className="inline" style={{ color: 'var(--ink-faint)' }}>覆盖更新时间 </dt>
              <dd className="inline">
                {settings.updatedAt ? new Date(settings.updatedAt).toLocaleString('zh-CN') : '无覆盖值'}
              </dd>
            </div>
          </dl>

          {/* 落库的判定让这条告警刷新后仍在：只在保存成功那一次闪现的提示等于没有提示。 */}
          {settings.reasoning === 'yes' && (
            <p role="alert" className="text-sm leading-7" style={{ color: 'var(--cinnabar)' }}>
              ⚠ 当前模型是推理模型：思维链与正文共享 max_tokens，每次找书都会明显变慢，
              预算不足时正文还会为空。请确认 LLM_MAX_TOKENS 足够大。
            </p>
          )}

          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => { event.preventDefault(); void submit('model', draft.trim()); }}
          >
            <label htmlFor="llm-model" className="text-sm shrink-0" style={{ color: 'var(--ink-soft)' }}>新模型名</label>
            <input
              id="llm-model"
              className="paper-input text-sm min-h-11 flex-1 min-w-48"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(''); setNotice(''); setConfirmReasoning(null); }}
              placeholder={settings.model}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
            <button type="submit" className="ink-button text-xs !px-4" disabled={saving || !draft.trim()}>
              {saving ? '验证并保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="seal-button text-sm"
              onClick={() => void submit('model', null)}
              disabled={saving || !hasModelOverride(settings)}
            >
              {saving ? '处理中…' : '恢复默认'}
            </button>
          </form>
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            保存按钮会先用新模型发一次极小的验证请求（最长 30 秒），验证通过才写库。
            「恢复默认」清空数据库覆盖值，回退到下面「默认值」那一栏的模型。
          </p>

          <div className="pt-4 space-y-3" style={{ borderTop: '1px solid var(--ink-faint)' }}>
            <div className="text-sm">
              <span style={{ color: 'var(--ink-faint)' }}>默认值 </span>
              <span className="font-bold">{settings.defaultModel}</span>
              <span style={{ color: 'var(--ink-faint)' }}>（来源：{DEFAULT_SOURCE_LABELS[settings.defaultSource]}）</span>
            </div>
            <p className="text-xs leading-6" style={{ color: 'var(--ink-faint)' }}>
              当前模型没有数据库覆盖值时就跑这个模型。改它同样会先发一次验证请求；
              「清除」回到环境变量 LLM_MODEL（没有就回到硬编码缺省）。改这里不影响上面那一栏。
            </p>
            <form
              className="flex flex-wrap items-center gap-3"
              onSubmit={(event) => { event.preventDefault(); void submit('defaultModel', defaultDraft.trim()); }}
            >
              <label htmlFor="llm-default-model" className="text-sm shrink-0" style={{ color: 'var(--ink-soft)' }}>新默认值</label>
              <input
                id="llm-default-model"
                className="paper-input text-sm min-h-11 flex-1 min-w-48"
                value={defaultDraft}
                onChange={(event) => { setDefaultDraft(event.target.value); setError(''); setNotice(''); setConfirmReasoning(null); }}
                placeholder={settings.defaultModel}
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
              <button type="submit" className="ink-button text-xs !px-4" disabled={saving || !defaultDraft.trim()}>
                {saving ? '验证并保存中…' : '保存默认值'}
              </button>
              <button
                type="button"
                className="seal-button text-sm"
                onClick={() => void submit('defaultModel', null)}
                disabled={saving || settings.defaultSource !== 'database'}
              >
                {saving ? '处理中…' : '清除默认值'}
              </button>
            </form>
            <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              {settings.defaultUpdatedAt
                ? `库内默认值更新于 ${new Date(settings.defaultUpdatedAt).toLocaleString('zh-CN')}`
                : '当前默认值不在库里（来自环境变量或硬编码缺省）'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
