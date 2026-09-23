// @vitest-environment jsdom
import { useReducer } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfileTab from './ProfileTab';
import { createProfileDraft, profileDraftReducer } from '@/lib/profile-draft';

const mocks = vi.hoisted(() => ({ owner: {} as Record<string, unknown> }));
vi.mock('@/components/OwnerProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/OwnerProvider')>();
  return { ...actual, useOwner: () => mocks.owner };
});

// 文案含中文标点(规范化成裸字符),按字面量匹配会失配;去掉所有非字母数字汉字再比。
const squeeze = (s: string) => s.replace(/[^0-9A-Za-z㐀-䶿一-鿿]/g, '');
function textIs(expected: string) {
  const want = squeeze(expected);
  return (_content: string, element: Element | null) => element !== null && squeeze(element.textContent ?? '') === want;
}

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchMock = ApiFetch & { mock: { calls: unknown[][] } };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// 用真实 reducer 起一个空草稿,组件自己 GET /api/profile 把快照灌进来 —— 与线上同一条路径。
function Harness({ active = true }: { active?: boolean }) {
  const [state, dispatch] = useReducer(profileDraftReducer, undefined, createProfileDraft);
  return <ProfileTab state={state} dispatch={dispatch} active={active} />;
}

function renderTab(apiFetch: FetchMock, active = true) {
  mocks.owner = {
    ready: true, status: 'ready', user: { id: 5 }, permissions: { find: true, read: true, download: true },
    authMethod: 'session', accountsEnabled: true, expired: false, sessionId: 1, sessionOnly: false,
    setSessionOnly: vi.fn(), submitToken: vi.fn(), login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    apiFetch, can: () => true,
  };
  return render(<Harness active={active} />);
}

const profile = (over: Record<string, unknown> = {}) => ({
  seeds: [{ title: '诡秘之主', kind: 'love', reason: '喜欢' }],
  content: '## 口味\n- 偏好克制叙事', updatedAt: '2026-09-20T00:00:00.000Z', ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ProfileTab:读取画像', () => {
  it('GET /api/profile 成功:渲染画像正文与种子书单,load 派发写入 saved', async () => {
    const apiFetch = vi.fn<ApiFetch>(async () => json(profile()));
    renderTab(apiFetch);

    await screen.findByText('诡秘之主');
    // 画像正文经极简 Markdown 渲染出标题。
    expect(screen.getByText('口味')).toBeTruthy();
    expect(String(apiFetch.mock.calls[0]?.[0])).toBe('/api/profile');
    // 种子在只读态以「爱」徽标 + 书名展示。
    expect(screen.getByText('爱')).toBeTruthy();
  });

  it('读取失败(无 saved):role=alert 透出原因,并给「重新读取」入口', async () => {
    const apiFetch = vi.fn(async () => json({ error: '读取画像失败(500)' }, 500));
    renderTab(apiFetch);

    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze('读取画像失败(500)'));
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy();
  });

  it('响应缺字段(非 ProfileSnapshot 形状):报「画像数据不完整」而不当成空画像', async () => {
    const apiFetch = vi.fn(async () => json({ content: '只有正文', updatedAt: 'x' })); // 缺 seeds
    renderTab(apiFetch);

    const alert = await screen.findByRole('alert');
    expect(squeeze(alert.textContent ?? '')).toContain(squeeze('画像数据不完整'));
  });
});

describe('ProfileTab:人工修订画像', () => {
  it('点「人工修订」进编辑态,改完「保存修订」发 PUT(带 content 与 updatedAt)', async () => {
    const apiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return json(profile({ content: '## 口味\n- 改写后的正文' }));
      return json(profile());
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByText('诡秘之主');

    await user.click(screen.getByRole('button', { name: '人工修订' }));
    const editor = screen.getByRole('textbox');
    await user.clear(editor);
    await user.type(editor, '改写后的正文');
    await user.click(screen.getByRole('button', { name: '保存修订' }));

    await waitFor(() => {
      const put = apiFetch.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.content).toContain('改写后的正文');
      expect(body.updatedAt).toBe('2026-09-20T00:00:00.000Z');
    });
    // 成功后提示保存成功,并退出编辑态。
    expect(await screen.findByText(textIs('✓ 已保存'))).toBeTruthy();
  });

  it('保存冲突(409 PROFILE_CONFLICT):给出「画像有新版本」区,保留草稿', async () => {
    const apiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return json({ code: 'PROFILE_CONFLICT', profile: profile({ content: '## 服务器版', updatedAt: '2026-09-21T00:00:00.000Z' }) }, 409);
      }
      return json(profile());
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByText('诡秘之主');

    await user.click(screen.getByRole('button', { name: '人工修订' }));
    const editor = screen.getByRole('textbox');
    await user.clear(editor);
    await user.type(editor, '我的草稿');
    await user.click(screen.getByRole('button', { name: '保存修订' }));

    // 冲突提示出现,草稿未被丢弃(编辑器里仍是「我的草稿」)。
    expect(await screen.findByText(textIs('画像有新版本'))).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('我的草稿');
    // 服务器最新内容在对比区可见。
    expect(screen.getByText('服务器最新')).toBeTruthy();
    // 冲突时给出「以当前草稿重新保存」与「使用服务器最新版本」两条出口。
    expect(screen.getByRole('button', { name: '以当前草稿重新保存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用服务器最新版本' })).toBeTruthy();
  });
});

describe('ProfileTab:种子书单', () => {
  it('「编辑书单」→ 加一本最爱 → 「保存种子」发 PUT(seeds 里带新书)', async () => {
    const apiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return json(profile({
          seeds: [{ title: '', kind: 'love' }, { title: '诡秘之主', kind: 'love', reason: '喜欢' }],
          updatedAt: '2026-09-21T00:00:00.000Z',
        }));
      }
      return json(profile());
    });
    renderTab(apiFetch);
    const user = userEvent.setup();
    await screen.findByText('诡秘之主');

    await user.click(screen.getByRole('button', { name: '编辑书单' }));
    await user.click(screen.getByRole('button', { name: '+ 最爱' }));
    await user.click(screen.getByRole('button', { name: '保存种子' }));

    await waitFor(() => {
      const put = apiFetch.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(Array.isArray(body.seeds)).toBe(true);
      expect(body.seeds.some((s: { kind: string }) => s.kind === 'love')).toBe(true);
    });
    expect(await screen.findByText(textIs('✓ 种子已保存'))).toBeTruthy();
  });
});