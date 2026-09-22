import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// audit-41 S5-1：匿名只读健康端点。这里钉三件事：
//   1) payload 的键集**恰为**契约集合（用 Object.keys 精确比对，不是 toMatchObject——
//      多一个键就是缺陷，多出来的键可能泄漏源站/用户标识）；
//   2) ok 判据（池新鲜度 + 三条 cron 都在阈值内）；
//   3) 异常路径返回 200 + ok:false，绝不 500。

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  getShuyuanPoolHealth: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema: mocks.ensureSchema, getSql: mocks.getSql }));
vi.mock('@/lib/shuyuan', async (original) => ({
  ...await original<typeof import('@/lib/shuyuan')>(),
  getShuyuanPoolHealth: mocks.getShuyuanPoolHealth,
}));

import { GET } from './route';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

// 池健康度 fixture：只用到 refreshedAtAgeHours，其余字段按真实形状给全。
function pool(refreshedAtAgeHours: number | null) {
  return {
    readingPoolSize: 12, enginePoolSize: 3, poolCandidates: 5,
    admission: {
      ok: 3, deferred: 4, rejected: 2, url_defaulted: 0,
      miss_chapter_list: 0, miss_chapter_name: 0, rejection_codes: {},
    },
    refreshedAtAgeHours,
  };
}

// cron_health / source_admission 的 SQL 替身：按查询文本分派，不发真库（列表无参数）。
function sqlStub(cronRows: { name: string; last_success_at: string | null }[], admissionCheckedAt: string | null) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (/FROM cron_health/.test(text)) return cronRows;
    if (/max\(search_checked_at\)/.test(text)) return [{ max_checked_at: admissionCheckedAt }];
    return [];
  });
}

async function body(res: Response) {
  return await res.json() as Record<string, unknown>;
}

describe('GET /api/health/sources (S5-1 匿名健康端点)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // 默认：一切新鲜（池 3.2h；两条 cron 都在阈值内）。
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getShuyuanPoolHealth.mockResolvedValue(pool(3.2));
    mocks.getSql.mockReturnValue(sqlStub(
      [{ name: 'reclaim', last_success_at: hoursAgo(5) }, { name: 'drain', last_success_at: hoursAgo(6) }],
      hoursAgo(5),
    ));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 变异测试靶子：给响应临时多返回一个键（如 debug: <任何值>）→ 本用例必须变红。
  it('键集恰为契约集合（多一个键即缺陷）', async () => {
    const payload = await body(await GET());
    expect(Object.keys(payload).sort()).toEqual(
      ['admissionCheckedAtAgeHours', 'crons', 'ok', 'refreshedAtAgeHours'],
    );
    expect(Object.keys(payload.crons as object).sort()).toEqual(['drain', 'reclaim', 'shuyuan']);
    for (const cron of Object.values(payload.crons as Record<string, object>)) {
      expect(Object.keys(cron)).toEqual(['lastSuccessAt']);
    }
  });

  it('值类型：年龄是数字或 null，cron 上次成功是 ISO 文本或 null', async () => {
    const payload = await body(await GET());
    expect(payload.refreshedAtAgeHours).toBe(3.2);
    expect(payload.admissionCheckedAtAgeHours).toBe(5);
    expect(payload.ok).toBe(true);
    const crons = payload.crons as Record<string, { lastSuccessAt: string | null }>;
    expect(crons.reclaim.lastSuccessAt).toBe(hoursAgo(5));
    expect(crons.drain.lastSuccessAt).toBe(hoursAgo(6));
    // shuyuan 的 lastSuccessAt 由 refreshedAtAgeHours 反推。
    expect(Date.parse(crons.shuyuan.lastSuccessAt as string)).toBe(NOW - 3.2 * 3_600_000);
  });

  it('响应带 no-store，且不需要任何鉴权头（匿名可读）', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    // GET() 不接收请求对象：没有任何 CRON_SECRET / owner token 通道，天然匿名。
    expect(GET.length).toBe(0);
  });

  it('payload 里不出现 URL / 域名 / 源名等可复用标识', async () => {
    const raw = JSON.stringify(await body(await GET()));
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/source_url|sourceUrl|\.com|\.net|\.org/);
    // 只允许出现契约里的 4 个键名与数字/ISO 文本。
    expect(raw).toMatch(/^\{"ok":true,"refreshedAtAgeHours":3\.2,/);
  });

  it('池陈旧（> 8h）⇒ ok:false，但字段仍在（200，不 500）', async () => {
    mocks.getShuyuanPoolHealth.mockResolvedValue(pool(9.5));
    const res = await GET();
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.ok).toBe(false);
    expect(payload.refreshedAtAgeHours).toBe(9.5);
  });

  it('从未刷新（null）⇒ ok:false 且 shuyuan.lastSuccessAt 为 null', async () => {
    mocks.getShuyuanPoolHealth.mockResolvedValue(pool(null));
    const payload = await body(await GET());
    expect(payload.ok).toBe(false);
    expect((payload.crons as Record<string, { lastSuccessAt: string | null }>).shuyuan.lastSuccessAt).toBeNull();
  });

  it('reclaim 从未成功（缺行）⇒ ok:false', async () => {
    mocks.getSql.mockReturnValue(sqlStub([{ name: 'drain', last_success_at: hoursAgo(6) }], hoursAgo(5)));
    const payload = await body(await GET());
    expect(payload.ok).toBe(false);
    expect((payload.crons as Record<string, { lastSuccessAt: string | null }>).reclaim.lastSuccessAt).toBeNull();
  });

  it('drain 上次成功超过 26h ⇒ ok:false', async () => {
    mocks.getSql.mockReturnValue(sqlStub(
      [{ name: 'reclaim', last_success_at: hoursAgo(5) }, { name: 'drain', last_success_at: hoursAgo(30) }],
      hoursAgo(5),
    ));
    const payload = await body(await GET());
    expect(payload.ok).toBe(false);
  });

  it('池健康度查询异常 ⇒ 200 + ok:false，全部字段为 null（探针可区分「端点挂了」与「池子陈旧」）', async () => {
    mocks.getShuyuanPoolHealth.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      ok: false,
      refreshedAtAgeHours: null,
      admissionCheckedAtAgeHours: null,
      crons: {
        shuyuan: { lastSuccessAt: null },
        reclaim: { lastSuccessAt: null },
        drain: { lastSuccessAt: null },
      },
    });
  });
});
