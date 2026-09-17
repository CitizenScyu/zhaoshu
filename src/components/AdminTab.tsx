'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';
import ModelSettingsTab from '@/components/ModelSettingsTab';
import type { InviteCodeSummary, RegistrationMode } from '@/lib/invite-codes';

type AdminUser = {
  id: number;
  username: string;
  role: string;
  canFind: boolean;
  canRead: boolean;
  canDownload: boolean;
  disabled: boolean;
  createdAt: string;
  inviteHint: string | null;
};

type RegistrationSettings = { membersEnabled: boolean; registrationMode: RegistrationMode; updatedAt: string | null };
type LabelModelSetting = { model: string | null; updatedAt: string | null };
type CreatedInvite = { code: string; codeHint: string; expiresAt: string | null };

const MODE_LABELS: Record<RegistrationMode, string> = {
  closed: '关闭注册',
  invite: '邀请码注册',
  open: '开放注册',
};
const MODE_HINTS: Record<RegistrationMode, string> = {
  closed: '任何注册请求都被拒绝，有效邀请码也不能绕过。',
  invite: '必须携带未用过、未过期、未作废的邀请码。',
  open: '不需要邀请码，页面也不显示邀请码输入框。',
};
const INVITE_STATUS_LABELS: Record<InviteCodeSummary['status'], string> = {
  active: '可用', used: '已使用', revoked: '已作废', expired: '已过期',
};

function errorText(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    const text = (data as { error: string }).error;
    if (text) return text;
  }
  return fallback;
}

// owner 管理台：注册开关、邀请码、用户与打标模型。全部走 /api/admin/*（仅 owner，
// 写请求自动带 CSRF 头）。主模型沿用既有组件，功能不回退。
export default function AdminTab() {
  const { apiFetch } = useOwner();

  const [registration, setRegistration] = useState<RegistrationSettings | null>(null);
  const [registrationDraft, setRegistrationDraft] = useState<RegistrationSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<InviteCodeSummary[]>([]);
  const [created, setCreated] = useState<CreatedInvite[]>([]);
  const [batchCount, setBatchCount] = useState(1);
  const [ttlDays, setTtlDays] = useState<number | null>(7);
  const [labelModel, setLabelModel] = useState<LabelModelSetting | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [regRes, usersRes, invitesRes, labelRes] = await Promise.all([
        apiFetch('/api/admin/registration', { signal }),
        apiFetch('/api/admin/users', { signal }),
        apiFetch('/api/admin/invites', { signal }),
        apiFetch('/api/admin/label-model', { signal }),
      ]);
      const reg = await regRes.json();
      if (!regRes.ok) throw new Error(errorText(reg, '注册设置加载失败'));
      const userData = await usersRes.json();
      if (!usersRes.ok) throw new Error(errorText(userData, '用户列表加载失败'));
      const inviteData = await invitesRes.json();
      if (!invitesRes.ok) throw new Error(errorText(inviteData, '邀请码加载失败'));
      const label = await labelRes.json();
      if (!labelRes.ok) throw new Error(errorText(label, '打标模型加载失败'));
      setRegistration(reg as RegistrationSettings);
      setRegistrationDraft(reg as RegistrationSettings);
      setUsers((userData as { users: AdminUser[] }).users ?? []);
      setInvites((inviteData as { invites: InviteCodeSummary[] }).invites ?? []);
      setLabelModel(label as LabelModelSetting);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : '管理数据加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(controller.signal); });
    return () => controller.abort();
  }, [refresh]);

  async function saveRegistration() {
    if (!registrationDraft || busy) return;
    setBusy('registration');
    setError(''); setNotice('');
    try {
      const res = await apiFetch('/api/admin/registration', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          membersEnabled: registrationDraft.membersEnabled,
          registrationMode: registrationDraft.registrationMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, '注册设置保存失败'));
      setRegistration(data as RegistrationSettings);
      setRegistrationDraft(data as RegistrationSettings);
      setNotice(`已保存：${data.registrationMode === 'closed' ? '注册关闭' : MODE_LABELS[data.registrationMode as RegistrationMode]}，成员功能${data.membersEnabled ? '已启用' : '已停用'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '注册设置保存失败');
    } finally {
      setBusy('');
    }
  }

  async function setUser(id: number, patch: Partial<Pick<AdminUser, 'canFind' | 'canRead' | 'canDownload' | 'disabled'>>) {
    if (busy) return;
    setBusy(`user-${id}`);
    setError(''); setNotice('');
    try {
      const res = await apiFetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, '用户设置保存失败'));
      const next = (data as { user: AdminUser }).user;
      setUsers((current) => current.map((user) => (user.id === id ? { ...user, ...next } : user)));
      setNotice(`已更新 ${next.username}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '用户设置保存失败');
    } finally {
      setBusy('');
    }
  }

  async function createInvites() {
    if (busy) return;
    setBusy('invites-create');
    setError(''); setNotice(''); setCreated([]);
    try {
      const res = await apiFetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: batchCount, ttlDays }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, '邀请码生成失败'));
      setCreated((data as { invites: CreatedInvite[] }).invites ?? []);
      setNotice('已生成邀请码：原文只显示这一次，请立即复制。');
      const listRes = await apiFetch('/api/admin/invites');
      if (listRes.ok) setInvites(((await listRes.json()) as { invites: InviteCodeSummary[] }).invites ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '邀请码生成失败');
    } finally {
      setBusy('');
    }
  }

  async function revokeInvite(id: number) {
    if (busy) return;
    setBusy(`invite-${id}`);
    setError(''); setNotice('');
    try {
      const res = await apiFetch(`/api/admin/invites/${id}/revoke`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, '作废失败'));
      setInvites((current) => current.map((invite) => (invite.id === id ? { ...invite, status: 'revoked', revokedAt: new Date().toISOString() } : invite)));
      setNotice('邀请码已作废');
    } catch (e) {
      setError(e instanceof Error ? e.message : '作废失败');
    } finally {
      setBusy('');
    }
  }

  async function saveLabelModel(model: string | null) {
    if (busy) return;
    setBusy('label-model');
    setError(''); setNotice('');
    try {
      const res = await apiFetch('/api/admin/label-model', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, '打标模型保存失败'));
      setLabelModel(data as LabelModelSetting);
      setLabelDraft('');
      setNotice(model === null ? '已清除，打标机回退到它自己的 .env' : `打标模型已设为 ${model}（下次运行 labeler.py 时生效）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '打标模型保存失败');
    } finally {
      setBusy('');
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('已复制到剪贴板');
    } catch {
      setError('复制失败，请手动选中复制');
    }
  }

  const dirty = Boolean(registration && registrationDraft
    && (registration.membersEnabled !== registrationDraft.membersEnabled
      || registration.registrationMode !== registrationDraft.registrationMode));

  return (
    <div className="space-y-10">
      <h2 className="text-lg font-bold">管理</h2>

      {error && <p role="alert" className="text-sm" style={{ color: 'var(--cinnabar)' }}>✗ {error}</p>}
      {notice && <p role="status" className="text-sm" style={{ color: 'var(--moss)' }}>✓ {notice}</p>}
      {loading && <p role="status" className="text-sm" style={{ color: 'var(--ink-faint)' }}>读取中…</p>}

      <section aria-label="注册开关" className="space-y-3">
        <h3 className="text-base font-bold">注册与成员开关</h3>
        {registrationDraft && (
          <>
            <label className="flex items-center gap-3 text-sm" style={{ color: 'var(--ink-soft)' }}>
              <input
                type="checkbox"
                checked={registrationDraft.membersEnabled}
                onChange={(event) => setRegistrationDraft({ ...registrationDraft, membersEnabled: event.target.checked })}
              />
              成员总闸（关闭后成员无法登录，注册也一并关闭）
            </label>
            <div className="flex flex-wrap gap-4">
              {(['closed', 'invite', 'open'] as RegistrationMode[]).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm" style={{ color: 'var(--ink-soft)' }}>
                  <input
                    type="radio"
                    name="registration-mode"
                    checked={registrationDraft.registrationMode === mode}
                    onChange={() => setRegistrationDraft({ ...registrationDraft, registrationMode: mode })}
                  />
                  {MODE_LABELS[mode]}
                </label>
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              {MODE_HINTS[registrationDraft.registrationMode]}
            </p>
            <button type="button" className="seal-button text-sm" disabled={!dirty || busy === 'registration'} onClick={() => void saveRegistration()}>
              {busy === 'registration' ? '保存中…' : '保存注册设置'}
            </button>
          </>
        )}
      </section>

      <section aria-label="邀请码" className="space-y-3">
        <h3 className="text-base font-bold">邀请码</h3>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1" style={{ color: 'var(--ink-soft)' }}>
            数量（最多 10）
            <input
              className="paper-input text-sm min-h-11 w-24"
              type="number"
              min={1}
              max={10}
              value={batchCount}
              onChange={(event) => setBatchCount(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
            />
          </label>
          <label className="flex flex-col gap-1" style={{ color: 'var(--ink-soft)' }}>
            有效期
            <select
              className="paper-input text-sm min-h-11"
              value={ttlDays === null ? 'never' : String(ttlDays)}
              onChange={(event) => setTtlDays(event.target.value === 'never' ? null : Number(event.target.value))}
            >
              <option value="1">1 天</option>
              <option value="7">7 天</option>
              <option value="30">30 天</option>
              <option value="never">不过期</option>
            </select>
          </label>
          <button type="button" className="ink-button text-xs !px-4 min-h-11" disabled={busy === 'invites-create'} onClick={() => void createInvites()}>
            {busy === 'invites-create' ? '生成中…' : '生成邀请码'}
          </button>
        </div>

        {created.length > 0 && (
          <div role="status" className="p-3 text-sm space-y-2" style={{ border: '1px solid var(--line)' }}>
            <p style={{ color: 'var(--cinnabar)' }}>邀请码原文只显示这一次，请立即复制：</p>
            <ul className="space-y-1">
              {created.map((invite) => (
                <li key={invite.code} className="flex items-center gap-3">
                  <code className="text-xs break-all">{invite.code}</code>
                  <button type="button" className="ink-button text-xs !px-3" onClick={() => void copy(invite.code)}>复制</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <table className="w-full text-xs" aria-label="邀请码列表">
          <thead>
            <tr style={{ color: 'var(--ink-faint)' }}>
              <th className="text-left font-normal py-1">提示</th>
              <th className="text-left font-normal py-1">状态</th>
              <th className="text-left font-normal py-1">有效期至</th>
              <th className="text-left font-normal py-1">使用者</th>
              <th className="text-left font-normal py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 && (
              <tr><td colSpan={5} className="py-2" style={{ color: 'var(--ink-faint)' }}>还没有邀请码。</td></tr>
            )}
            {invites.map((invite) => (
              <tr key={invite.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="py-2">…{invite.codeHint}</td>
                <td className="py-2">{INVITE_STATUS_LABELS[invite.status]}</td>
                <td className="py-2">{invite.expiresAt ? new Date(invite.expiresAt).toLocaleString('zh-CN') : '不过期'}</td>
                <td className="py-2">{invite.usedByUsername ?? '—'}</td>
                <td className="py-2">
                  <button
                    type="button"
                    className="ink-button text-xs !px-3"
                    disabled={invite.status !== 'active' || busy === `invite-${invite.id}`}
                    onClick={() => void revokeInvite(invite.id)}
                  >
                    作废
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="用户管理" className="space-y-3">
        <h3 className="text-base font-bold">用户</h3>
        <table className="w-full text-xs" aria-label="用户列表">
          <thead>
            <tr style={{ color: 'var(--ink-faint)' }}>
              <th className="text-left font-normal py-1">用户名</th>
              <th className="text-left font-normal py-1">找书</th>
              <th className="text-left font-normal py-1">阅读</th>
              <th className="text-left font-normal py-1">下载</th>
              <th className="text-left font-normal py-1">状态</th>
              <th className="text-left font-normal py-1">创建时间</th>
              <th className="text-left font-normal py-1">邀请来源</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="py-2">{user.username}{user.role === 'owner' && '（管理员）'}</td>
                {(['canFind', 'canRead', 'canDownload'] as const).map((field) => (
                  <td className="py-2" key={field}>
                    <input
                      type="checkbox"
                      aria-label={`${user.username} ${field}`}
                      checked={user[field]}
                      // owner 行由表 CHECK 钉死，界面不提供入口。
                      disabled={user.role === 'owner' || busy === `user-${user.id}`}
                      onChange={(event) => void setUser(user.id, { [field]: event.target.checked })}
                    />
                  </td>
                ))}
                <td className="py-2">
                  <button
                    type="button"
                    className="ink-button text-xs !px-3"
                    disabled={user.role === 'owner' || busy === `user-${user.id}`}
                    onClick={() => void setUser(user.id, { disabled: !user.disabled })}
                  >
                    {user.disabled ? '已禁用 · 点击启用' : '启用中 · 点击禁用'}
                  </button>
                </td>
                <td className="py-2">{new Date(user.createdAt).toLocaleDateString('zh-CN')}</td>
                <td className="py-2">{user.inviteHint ? `…${user.inviteHint}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          阅读依赖找书、下载依赖阅读；勾选不满足该关系时会被拒绝。禁用会同时撤销该用户的所有会话。
        </p>
      </section>

      <section aria-label="打标模型" className="space-y-3">
        <h3 className="text-base font-bold">打标模型</h3>
        <p className="text-sm leading-7" style={{ color: 'var(--ink-soft)' }}>
          批量打标（labeler.py）跑在服务器上，用的是它自己的上游地址与密钥，这里只存模型名。
          留空表示由打标机的 .env 决定；改完在下次运行 labeler.py 时生效。
        </p>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div><dt className="inline" style={{ color: 'var(--ink-faint)' }}>当前值 </dt><dd className="inline font-bold">{labelModel?.model ?? '未设置（用打标机的 .env）'}</dd></div>
          <div>
            <dt className="inline" style={{ color: 'var(--ink-faint)' }}>更新时间 </dt>
            <dd className="inline">{labelModel?.updatedAt ? new Date(labelModel.updatedAt).toLocaleString('zh-CN') : '无'}</dd>
          </div>
        </dl>
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={(event) => { event.preventDefault(); void saveLabelModel(labelDraft.trim()); }}
        >
          <label htmlFor="label-model" className="text-sm shrink-0" style={{ color: 'var(--ink-soft)' }}>新模型名</label>
          <input
            id="label-model"
            className="paper-input text-sm min-h-11 flex-1 min-w-48"
            value={labelDraft}
            onChange={(event) => { setLabelDraft(event.target.value); setError(''); setNotice(''); }}
            placeholder={labelModel?.model ?? '例如 claude-opus-5-88'}
            autoComplete="off"
            spellCheck={false}
            disabled={busy === 'label-model'}
          />
          <button type="submit" className="ink-button text-xs !px-4" disabled={busy === 'label-model' || !labelDraft.trim()}>保存</button>
          <button
            type="button"
            className="seal-button text-sm"
            disabled={busy === 'label-model' || !labelModel?.model}
            onClick={() => void saveLabelModel(null)}
          >
            清除（回退 .env）
          </button>
        </form>
      </section>

      <section aria-label="主模型" className="space-y-3">
        <ModelSettingsTab />
      </section>
    </div>
  );
}
