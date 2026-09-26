// 41-srcfix 改法2 运行时侧：http:// 库键的准入 ok 源进引擎池时身份 url 升 https（所有请求由它派生），
// 库键不变；与同站 https 原生副本撞车时让位；SSRF 锁（validateSourceUrl）照旧拦截。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = { text: string; values: unknown[] };

const { getSql, sql, execute } = vi.hoisted(() => {
  const execute = vi.fn<(query: Query) => Promise<unknown[]>>();
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values };
    return {
      ...query,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected: (error: unknown) => unknown) {
        return execute(query).then(onFulfilled, onRejected);
      },
    };
  });
  return { getSql: vi.fn(), sql, execute };
});

vi.mock('@/lib/db', () => ({ ensureSchema: vi.fn(), getSql }));

import { getEngineSources, invalidateShuyuanReadCache } from './shuyuan';
import { refreshSupportedHosts } from './source-policy';
import { sourceSearchUrl } from './source-parser';

const item = (bookSourceUrl: string, searchUrl: string, name: string) => ({
  bookSourceUrl, bookSourceName: name, searchUrl,
  ruleSearch: { bookList: '.i', name: '.t@text', bookUrl: 'a@href' },
  ruleContent: { content: '.c' }, enabled: true,
});
const engineRow = (sourceUrl: string, source: Record<string, unknown>) => ({
  source_url: sourceUrl, source, name: String(source.bookSourceName), disabled_at: null, last_error: '',
  tier: 'M1', search_checked_at: null,
});

let engine: unknown[] = [];

beforeEach(() => {
  vi.stubEnv('SHUYUAN_READ_CACHE_TTL_MS', '0');
  invalidateShuyuanReadCache();
  execute.mockReset().mockImplementation(async (query) => {
    if (query.text.includes('FROM shuyuan_meta')) return [{ collections: [], refreshed_at: null }];
    if (query.text.includes('JOIN source_admission')) return engine;
    return [];
  });
  getSql.mockReturnValue(Object.assign(sql, {
    transaction: (queries: Query[]) => Promise.all(queries.map((query) => execute(query))),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateShuyuanReadCache();
  refreshSupportedHosts([]);
});

describe('引擎池：http:// 库键升 https（41-srcfix 改法2）', () => {
  it('身份 url 取 https 形态，搜索（相对模板）打 https；库键不变（rules 原样透传）', async () => {
    refreshSupportedHosts(['up.example.com']);
    const rules = item('http://up.example.com/', '/s?q={{key}}', '升级源');
    engine = [engineRow('http://up.example.com', rules)];
    const pool = await getEngineSources(new AbortController().signal);
    expect(pool.map((source) => source.url)).toEqual(['https://up.example.com/']);
    expect(pool[0].rules).toBe(rules);
    expect(sourceSearchUrl(pool[0].searchUrl, '书', pool[0].url)).toMatch(/^https:\/\/up\.example\.com\/s\?q=/);
  });

  it('同站 http/https 两份都准入 ok：留库键本就是 https 的那份，http 副本让位（url 不重复）', async () => {
    refreshSupportedHosts(['dup.example.com']);
    const native = item('https://dup.example.com/', 'https://dup.example.com/s?q={{key}}', '原生');
    engine = [
      engineRow('http://dup.example.com', item('http://dup.example.com/', '/search?k={{key}}', '副本')),
      engineRow('https://dup.example.com', native),
    ];
    const pool = await getEngineSources(new AbortController().signal);
    expect(pool.map((source) => source.url)).toEqual(['https://dup.example.com/']);
    expect(pool[0].rules).toBe(native);
  });

  it('SSRF 锁照旧：IP / 非 443 端口 / userinfo / 未进 host 门的 http 源升级后仍被滤掉', async () => {
    refreshSupportedHosts(['up.example.com']);
    engine = [
      engineRow('http://10.0.0.1', item('http://10.0.0.1/', '/s?q={{key}}', 'ip')),
      engineRow('http://up.example.com:8080', item('http://up.example.com:8080/', '/s?q={{key}}', 'port')),
      engineRow('http://u@up.example.com', item('http://u@up.example.com/', '/s?q={{key}}', 'userinfo')),
      engineRow('http://gate.example.com', item('http://gate.example.com/', '/s?q={{key}}', 'gate')),
    ];
    expect(await getEngineSources(new AbortController().signal)).toEqual([]);
  });
});
