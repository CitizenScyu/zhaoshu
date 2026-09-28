// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FindTab from './FindTab';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/components/OwnerProvider', () => ({
  useOwner: () => ({ apiFetch: mocks.apiFetch, user: { id: 7 }, ready: true, can: () => true }),
}));

function result(fields: Record<string, unknown>) {
  return new Response(`data: ${JSON.stringify({ type: 'result', ...fields })}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/find/exact') {
      return new Response(JSON.stringify({ source: 'none', items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body));
    if (body.step === 'recall') return result({ candidates: [] });
    if (body.step === 'verify') return result({ verified: [], ticket: 'synthetic-test-ticket' });
    return result({ items: [], persisted: true });
  });
});
afterEach(cleanup);

function exactFields() {
  fireEvent.click(screen.getByRole('tab', { name: '精确找书' }));
  return {
    title: screen.getByRole('textbox', { name: '书名' }),
    author: screen.getByRole('textbox', { name: '作者（选填）' }),
  };
}

describe('找书快捷键与中文输入法', () => {
  it.each([
    ['title', '组合输入', { isComposing: true, keyCode: 13 }],
    ['author', '组合输入', { isComposing: true, keyCode: 13 }],
    ['title', '229 确认回车', { isComposing: false, keyCode: 229 }],
    ['author', '229 确认回车', { isComposing: false, keyCode: 229 }],
  ] as const)('精确找书 %s 的%s不发请求，结束后回车只提交最终文字', async (field, _label, event) => {
    render(<FindTab />);
    const inputs = exactFields();
    fireEvent.change(inputs.title, { target: { value: '诡秘之主' } });
    fireEvent.change(inputs.author, { target: { value: '测试作者' } });
    fireEvent.compositionStart(inputs[field]);
    fireEvent.change(inputs[field], { target: { value: field === 'title' ? 'gui' : 'zuo' } });
    // 229 路径模拟 compositionend 先于确认回车的浏览器事件顺序。
    if (!event.isComposing) fireEvent.compositionEnd(inputs[field]);
    fireEvent.keyDown(inputs[field], { key: 'Enter', code: 'Enter', ...event });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByText('正在查本地书库与豆瓣…')).toBeNull();

    if (event.isComposing) fireEvent.compositionEnd(inputs[field]);
    fireEvent.change(inputs.title, { target: { value: '诡秘之主' } });
    fireEvent.change(inputs.author, { target: { value: '测试作者' } });
    fireEvent.keyDown(inputs[field], { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false });
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    expect(mocks.apiFetch.mock.calls[0][0]).toBe('/api/find/exact');
    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body)).toEqual({ title: '诡秘之主', author: '测试作者' });
    await waitFor(() => expect(screen.queryByText('正在查本地书库与豆瓣…')).toBeNull());
  });

  it.each(['ctrlKey', 'metaKey'] as const)('口味推荐 %s+Enter 在组合输入时不提交，完成后保持快捷键', async (modifier) => {
    render(<FindTab />);
    const input = screen.getByRole('textbox', { name: '找书需求' });
    // 隔离测试不写搜索历史，同时保持真实的组件/SSE请求编排。
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'ke huan' } });
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true, isComposing: true, keyCode: 13 });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true, isComposing: false, keyCode: 229 });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '硬核科幻，主角冷静' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 13 });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true, isComposing: false, keyCode: 13 });
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(3));
    const bodies = mocks.apiFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((body) => body.step)).toEqual(['recall', 'verify', 'rerank']);
    expect(bodies.every((body) => body.query === '硬核科幻，主角冷静')).toBe(true);
    await waitFor(() => expect(screen.queryByText('寻径中…')).toBeNull());
  });

  it('精确查找按钮仍提交当前书名和作者', async () => {
    render(<FindTab />);
    const inputs = exactFields();
    fireEvent.change(inputs.title, { target: { value: '测试书名' } });
    fireEvent.change(inputs.author, { target: { value: '测试作者' } });
    fireEvent.click(screen.getByRole('button', { name: '精确查找' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body)).toEqual({ title: '测试书名', author: '测试作者' });
    await waitFor(() => expect(screen.queryByText('正在查本地书库与豆瓣…')).toBeNull());
  });

  it('口味推荐按钮仍按三步提交当前需求', async () => {
    render(<FindTab />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('textbox', { name: '找书需求' }), { target: { value: '轻松科幻' } });
    fireEvent.click(screen.getByRole('button', { name: '找 书' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(mocks.apiFetch.mock.calls[0][1].body).query).toBe('轻松科幻');
    await waitFor(() => expect(screen.queryByText('寻径中…')).toBeNull());
  });
});
