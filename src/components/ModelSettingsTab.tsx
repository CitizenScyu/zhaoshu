'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import type { LlmModelSettings, ReasoningVerdict } from '@/lib/app-settings';

const SOURCE_LABELS: Record<LlmModelSettings['source'], string> = {
  database: '数据库设置',
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

// 保存成功后的提示：判定为推理模型时必须主动说出来，'unknown' 只补充一句限制说明。
export function savedNotice(model: string, next: { reasoning: ReasoningVerdict | null; warning?: string }): string {
  const notes: string[] = [];
  if (next.warning) notes.push(next.warning);
  else if (next.reasoning === 'yes') notes.push('探测观察到该模型会输出思维链（推理模型），找书会更慢。');
  else if (next.reasoning === 'unknown') {
    notes.push('本次探测没有观察到思维链，但不代表它不是推理模型——探测只能证明「是」。');
  }
  return `已切换到 ${model}，立即生效。${notes.map((note) => `注意：${note}`).join('')}`;
}

// owner 专用的最小模型切换入口：展示当前值 + 一个输入框 + 保存 / 恢复默认。
// 保存会先用新模型发一次极小请求验证，验证失败不写库，原因就地显示。
export default function ModelSettingsTab() {
  const { apiFetch } = useOwner();
  const [settings, setSettings] = useState<LlmModelSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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

  async function submit(model: string | null) {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await apiFetch('/api/admin/llm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '模型设置保存失败');
      const next = data as LlmModelSettings & { warning?: string };
      setSettings(next);
      setDraft('');
      setNotice(
        model === null ? '已恢复默认，立即生效' : savedNotice(next.model, next),
      );
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

      {loading && !settings && (
        <p role="status" className="mt-6 text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>
      )}

      {settings && (
        <div className="mt-6 space-y-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm" aria-label="当前模型设置">
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>当前模型 </dt><dd className="inline font-bold">{settings.model}</dd></div>
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>来源 </dt><dd className="inline">{SOURCE_LABELS[settings.source]}</dd></div>
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>默认值 </dt><dd className="inline">{settings.defaultModel}</dd></div>
            <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>推理模型 </dt><dd className="inline">{reasoningLabel(settings.reasoning)}</dd></div>
            <div>
              <dt className="inline" style={{ color: 'var(--ink-faint)' }}>更新时间 </dt>
              <dd className="inline">
                {settings.updatedAt ? new Date(settings.updatedAt).toLocaleString('zh-CN') : '无数据库覆盖'}
              </dd>
            </div>
          </dl>

          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => { event.preventDefault(); void submit(draft.trim()); }}
          >
            <label htmlFor="llm-model" className="text-sm shrink-0" style={{ color: 'var(--ink-soft)' }}>新模型名</label>
            <input
              id="llm-model"
              className="paper-input text-sm min-h-11 flex-1 min-w-48"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(''); setNotice(''); }}
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
              onClick={() => void submit(null)}
              disabled={saving || settings.source !== 'database'}
            >
              {saving ? '处理中…' : '恢复默认'}
            </button>
          </form>
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            保存按钮会先用新模型发一次极小的验证请求（最长 30 秒），验证通过才写库。
            「恢复默认」清空数据库覆盖值，回退到默认值那一栏的模型。
          </p>
        </div>
      )}
    </div>
  );
}
