import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVITE_TTL_DAYS,
  INVITE_CODE_PREFIX,
  MAX_INVITE_BATCH,
  createInviteCodes,
  generateInviteCode,
  hashInviteCode,
  isRegistrationMode,
  listInviteCodes,
  readRegistrationSettings,
  revokeInviteCode,
  toInviteSummary,
  writeRegistrationSettings,
} from './invite-codes';
import { mockSql } from './fixtures/mock-sql';

describe('邀请码生成与摘要', () => {
  it('随机码带固定前缀、长度足够，摘要与原文一致', () => {
    const { code, codeHash, codeHint } = generateInviteCode();
    expect(code.startsWith(INVITE_CODE_PREFIX)).toBe(true);
    // 24 字节 base64url = 32 字符，加上前缀共 35。
    expect(code.length).toBe(INVITE_CODE_PREFIX.length + 32);
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash).toBe(hashInviteCode(code));
    expect(codeHint).toBe(code.slice(-4));
  });

  it('每次生成都不同，且同一批里没有重复摘要', () => {
    const codes = Array.from({ length: 200 }, () => generateInviteCode());
    expect(new Set(codes.map((item) => item.code)).size).toBe(200);
    expect(new Set(codes.map((item) => item.codeHash)).size).toBe(200);
  });

  it('摘要只做 trim，绝不折大小写（base64url 区分大小写）', () => {
    const { code, codeHash } = generateInviteCode();
    expect(hashInviteCode(`  ${code}\n`)).toBe(codeHash);
    const flipped = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    expect(hashInviteCode(flipped)).not.toBe(codeHash);
  });
});

describe('注册模式值', () => {
  it('只认三态字面量', () => {
    expect(['closed', 'open', 'invite'].every(isRegistrationMode)).toBe(true);
    for (const bad of ['CLOSED', '', null, undefined, 1, 'registration']) {
      expect(isRegistrationMode(bad)).toBe(false);
    }
  });
});

describe('邀请码状态判定', () => {
  const base = {
    id: 1, code_hint: 'AB12', created_at: '2026-01-01T00:00:00.000Z',
    expires_at: null, used_at: null, revoked_at: null, used_by_username: null,
  };
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  it('未使用、未作废、未过期 → active', () => {
    expect(toInviteSummary(base, now).status).toBe('active');
    expect(toInviteSummary({ ...base, expires_at: '2026-07-01T00:00:00.000Z' }, now).status).toBe('active');
  });

  it('过期按数据库时间字符串判定，边界用 <=', () => {
    expect(toInviteSummary({ ...base, expires_at: '2026-06-01T00:00:00.000Z' }, now).status).toBe('expired');
    expect(toInviteSummary({ ...base, expires_at: '2026-05-31T23:59:59.000Z' }, now).status).toBe('expired');
  });

  it('已使用压过作废与过期；已作废压过过期', () => {
    expect(toInviteSummary({ ...base, used_at: '2026-02-01T00:00:00.000Z', revoked_at: '2026-03-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z' }, now).status).toBe('used');
    expect(toInviteSummary({ ...base, revoked_at: '2026-03-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z' }, now).status).toBe('revoked');
  });
});

describe('邀请码读库', () => {
  it('列表不超过 200，且不查询原文列', async () => {
    const db = mockSql();
    db.resolve.mockResolvedValue([]);
    await listInviteCodes(db.sql as never, 9999);
    const query = db.queries[0].text;
    expect(query).toContain('registration_invites');
    expect(query).not.toContain('code_hash');
    expect(db.queries[0].values).toContain(200);
  });

  it('作废只作用于未使用未作废的行，并区分四种结果', async () => {
    const db = mockSql();
    db.resolve.mockResolvedValueOnce([{ id: 4 }]);
    expect(await revokeInviteCode(db.sql as never, 4)).toBe('revoked');
    expect(db.queries[0].text).toContain('revoked_at = now()');
    expect(db.queries[0].text).toContain('used_at IS NULL');

    db.resolve.mockReset();
    db.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([{ used_at: '2026-01-01T00:00:00Z', revoked_at: null }]);
    expect(await revokeInviteCode(db.sql as never, 5)).toBe('used');

    db.resolve.mockReset();
    db.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([{ used_at: null, revoked_at: '2026-01-01T00:00:00Z' }]);
    expect(await revokeInviteCode(db.sql as never, 6)).toBe('already_revoked');

    db.resolve.mockReset();
    db.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await revokeInviteCode(db.sql as never, 7)).toBe('not_found');
  });

  // 审计（audit-admin Finding 2）确认并发 revoke 语义安全：UPDATE 0 行之后、SELECT 复核之前，
  // 行被并发改动为已用/已废之外的情况，最终一律按幂等的 already_revoked 收口。这里钉住这个
  // 竞态兜底分支，防止后续重构把它改成 500 或误报 not_found。
  it('UPDATE 与 SELECT 之间的并发改动按已作废收口（幂等兜底）', async () => {
    const db = mockSql();
    db.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([{ used_at: null, revoked_at: null }]);
    expect(await revokeInviteCode(db.sql as never, 8)).toBe('already_revoked');
  });

  it('批量上限与有效期在库里也拒绝，不靠上层校验', async () => {
    const db = mockSql();
    await expect(createInviteCodes(db.sql as never, MAX_INVITE_BATCH + 1, DEFAULT_INVITE_TTL_DAYS, 1)).rejects.toThrow('invite batch');
    await expect(createInviteCodes(db.sql as never, 1, 0, 1)).rejects.toThrow('invite ttl');
    await expect(createInviteCodes(db.sql as never, 1, 999, 1)).rejects.toThrow('invite ttl');
    expect(db.queries).toHaveLength(0);
  });

  it('批量插入一条语句完成，原文与摘要一一对应', async () => {
    const db = mockSql();
    const hashes = new Map<string, string | null>();
    db.resolve.mockImplementation((query) => {
      const hashList = query.values.find((value): value is string[] => Array.isArray(value)) ?? [];
      const rows = hashList.map((hash) => ({ code_hash: hash, expires_at: '2026-07-01T00:00:00.000Z' }));
      for (const row of rows) hashes.set(row.code_hash, row.expires_at);
      return rows;
    });
    const created = await createInviteCodes(db.sql as never, 3, 7, 1);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).toContain('unnest');
    expect(created).toHaveLength(3);
    for (const invite of created) {
      expect(hashes.get(hashInviteCode(invite.code))).toBe('2026-07-01T00:00:00.000Z');
      expect(invite.expiresAt).toBe('2026-07-01T00:00:00.000Z');
    }
  });
});

describe('注册设置读写', () => {
  it('成员闸门或模式为脏值时按最保守的关闭处理', async () => {
    const db = mockSql();
    db.resolve.mockResolvedValue([{ members_enabled: 'yes', registration_mode: 'public', updated_at: null }]);
    expect(await readRegistrationSettings(db.sql as never)).toEqual({ membersEnabled: false, registrationMode: 'closed', updatedAt: null });
  });

  it('读不到行时也返回关闭', async () => {
    const db = mockSql();
    db.resolve.mockResolvedValue([]);
    expect(await readRegistrationSettings(db.sql as never)).toMatchObject({ membersEnabled: false, registrationMode: 'closed' });
  });

  it('写入前拒绝非法模式值', async () => {
    const db = mockSql();
    await expect(writeRegistrationSettings(db.sql as never, { membersEnabled: true, registrationMode: 'public' as never }))
      .rejects.toThrow('invalid registration mode');
    expect(db.queries).toHaveLength(0);
  });

  it('合法写入 UPSERT 单行并返回更新时间', async () => {
    const db = mockSql();
    db.resolve.mockResolvedValue([{ updated_at: '2026-06-01T00:00:00.000Z' }]);
    const updatedAt = await writeRegistrationSettings(db.sql as never, { membersEnabled: true, registrationMode: 'invite' });
    expect(updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(db.queries[0].text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(db.queries[0].values).toEqual([true, 'invite']);
  });
});
