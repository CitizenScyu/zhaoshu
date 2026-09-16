import { describe, expect, it, vi } from 'vitest';
import { authorizedTransaction, AuthorizationRevokedError, type WriteAuthorization } from './personal-write';

function fixture() {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = Object.assign(vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: parts.join('?'), values }; queries.push(query); return query;
  }), { transaction: vi.fn(async (build: (tx: unknown) => unknown[]) => { build(sql); return [[], [], [{ id: 7 }], []]; }) });
  const actor: WriteAuthorization = { userId: 2, role: 'member', method: 'session', tokenHash: 'a'.repeat(64), ownerTag: null, expiresAt: new Date(Date.now() + 10_000).toISOString() };
  return { sql, queries, actor };
}

describe('最终写事务的授权边界', () => {
  it('在同一事务中设置 statement_timeout，前后检查原会话并锁住权限行', async () => {
    const { sql, queries, actor } = fixture();
    const signal = new AbortController().signal;
    const rows = await authorizedTransaction(sql as never, actor, (tx) => [tx`UPDATE profile SET content = ${'本人的稿'} WHERE id = ${2}`], signal);
    expect(rows).toEqual([[{ id: 7 }]]);
    expect(sql.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted', fetchOptions: { signal } });
    expect(queries).toHaveLength(4);
    expect(queries[0].text).toContain("set_config('statement_timeout'");
    expect(JSON.parse(String(queries[0].values[1]))).toEqual(actor);
    for (const query of [queries[1], queries[3]]) {
      expect(query.text).toContain('FOR SHARE');
      expect(query.text).toContain('disabled_at IS NULL AND can_find');
      expect(query.text).toContain('members_enabled');
      expect(query.text).toContain("token_hash = g->>'tokenHash'");
      expect(query.text).toContain("user_id = (g->>'userId')::int");
      expect(query.text).toContain('expires_at > clock_timestamp()');
      expect(query.text).toContain("ERRCODE = '42501'");
      expect(query.text).toContain("ERRCODE = '57014'");
    }
    expect(queries[2].values).toEqual(['本人的稿', 2]);
  });
  it('取消或预算已耗尽时不向数据库提交事务', async () => {
    const { sql, actor } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(authorizedTransaction(sql as never, actor, () => [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(authorizedTransaction(sql as never, { ...actor, expiresAt: new Date(0).toISOString() }, () => [], new AbortController().signal)).rejects.toMatchObject({ code: '57014' });
    expect(sql.transaction).not.toHaveBeenCalled();
  });
  it('数据库内授权失败整体失败关闭，不暴露数据库错误详情', async () => {
    const { sql, actor } = fixture();
    sql.transaction.mockRejectedValueOnce({ code: '42501', detail: 'private database information' });
    await expect(authorizedTransaction(sql as never, actor, () => [], new AbortController().signal)).rejects.toBeInstanceOf(AuthorizationRevokedError);
  });
  it('只给当前事务传入 signal，提交后收到取消也不返回迟到成功', async () => {
    const { sql, actor } = fixture();
    const controller = new AbortController();
    sql.transaction.mockImplementationOnce(async () => {
      controller.abort(); return [[], [], [{ id: 7 }], []];
    });
    await expect(authorizedTransaction(sql as never, actor, () => [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(sql.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted', fetchOptions: { signal: controller.signal } });
  });
});
