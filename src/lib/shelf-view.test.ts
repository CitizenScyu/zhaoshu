import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLEAR_NEW_TARGET, SHELF_ROW_LIMIT, filterShelfCards, foldShelfItems, nextConfirm, removeTarget,
} from './shelf-view';

type Row = {
  id: number; query: string; status: string | null; match_score: number | null;
  created_at: string; title: string; author: string; reason?: string;
};

function row(overrides: Partial<Row> & { id: number; title: string }): Row {
  return {
    query: 'q', status: 'new', match_score: null, created_at: '2026-09-01T00:00:00Z',
    author: '作者', ...overrides,
  };
}

describe('foldShelfItems', () => {
  it('同一本书的多条推荐折叠成一张卡，主卡取最新，查询词去重后主卡在前', () => {
    const cards = foldShelfItems([
      row({ id: 1, title: '红楼梦', query: '找明清小说', created_at: '2026-09-01T00:00:00Z', reason: '旧' }),
      row({ id: 3, title: '红楼梦', query: '想读古典', created_at: '2026-09-10T00:00:00Z', reason: '新' }),
      row({ id: 2, title: '红楼梦', query: '想读古典', created_at: '2026-09-05T00:00:00Z' }),
      row({ id: 4, title: '西游记', query: '找明清小说', created_at: '2026-09-02T00:00:00Z' }),
    ]);
    expect(cards).toHaveLength(2);
    expect(cards[0].master).toMatchObject({ id: 3, reason: '新' });
    expect(cards[0].queries).toEqual(['想读古典', '找明清小说']);
    expect(cards[1].master).toMatchObject({ id: 4, title: '西游记' });
    // 卡片之间也按最新在前，不随 Map 插入序漂移。
    expect(cards.map((card) => card.master.id)).toEqual([3, 4]);
  });

  it('折叠键与 books 生成列同源：书名号、全半角、大小写与首尾空格的不同写法算同一本', () => {
    const cards = foldShelfItems([
      row({ id: 1, title: '《红楼梦》', author: '曹雪芹' }),
      row({ id: 2, title: ' 红楼梦 ', author: '曹雪芹' }),
      row({ id: 3, title: '红楼梦', author: '曹雪芹' }),
      // 作者不同就是另一本书，不能被书名折叠吞掉。
      row({ id: 4, title: '红楼梦', author: '无名氏' }),
    ]);
    expect(cards).toHaveLength(2);
    expect(cards.find((card) => card.master.author === '曹雪芹')?.queries).toHaveLength(1);
    expect(cards.map((card) => card.master.id).sort()).toEqual([3, 4]);
  });

  it('created_at 相同时用 match_score、再退到 id 定主卡，与后端 ORDER BY 同序', () => {
    const at = '2026-09-01T00:00:00Z';
    const byScore = foldShelfItems([
      row({ id: 1, title: '书', created_at: at, match_score: 3 }),
      row({ id: 2, title: '书', created_at: at, match_score: 9 }),
    ]);
    expect(byScore[0].master.id).toBe(2);
    const byId = foldShelfItems([
      row({ id: 5, title: '书', created_at: at, match_score: 9 }),
      row({ id: 6, title: '书', created_at: at, match_score: 9 }),
    ]);
    expect(byId[0].master.id).toBe(6);
  });

  it('空输入与非法时间的行都不会抛错', () => {
    expect(foldShelfItems([])).toEqual([]);
    const cards = foldShelfItems([
      row({ id: 1, title: '书', created_at: 'not-a-date' }),
      row({ id: 2, title: '书', created_at: '2026-09-01T00:00:00Z' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].master.id).toBe(2);
  });
});

describe('filterShelfCards', () => {
  const cards = foldShelfItems([
    row({ id: 1, title: '红楼梦', author: '曹雪芹' }),
    row({ id: 2, title: '西游记', author: '吴承恩' }),
    row({ id: 3, title: 'Catch-22', author: 'Joseph Heller' }),
    // 历史遗留：书名自带书名号的版本，和上面的「红楼梦」是两张卡（身份键不同）。
    row({ id: 4, title: '《镜花缘》', author: '李汝珍' }),
  ]);

  it('空关键词或纯空白返回全部', () => {
    expect(filterShelfCards(cards, '')).toHaveLength(4);
    expect(filterShelfCards(cards, '   ')).toHaveLength(4);
  });

  // 库里书名是「红楼梦」（无书名号）时，带半边书名号的搜索词必须照样命中：
  // 只归一「书名自带《》」这一种形态是不够的（审查实测 0 命中）。
  it.each([['红楼梦'], ['红楼'], ['《红楼'], ['红楼梦》'], ['《红楼梦》'], [' 红楼 '], ['红楼梦 ']])(
    '搜索「%s」都能命中红楼梦，书名号只在半边或不加都一样',
    (keyword) => {
      expect(filterShelfCards(cards, keyword).map((card) => card.master.id)).toEqual([1]);
    },
  );

  it('书名自带书名号的历史书用同样几种写法也能命中', () => {
    expect(filterShelfCards(cards, '镜花缘').map((card) => card.master.id)).toEqual([4]);
    expect(filterShelfCards(cards, '《镜花').map((card) => card.master.id)).toEqual([4]);
  });

  it('按书名命中，忽略大小写与首尾空格', () => {
    expect(filterShelfCards(cards, 'catch').map((card) => card.master.id)).toEqual([3]);
    expect(filterShelfCards(cards, '  CATCH-22 ').map((card) => card.master.id)).toEqual([3]);
  });

  it('按作者命中，无命中返回空数组', () => {
    expect(filterShelfCards(cards, '吴承恩').map((card) => card.master.id)).toEqual([2]);
    expect(filterShelfCards(cards, '不存在的书')).toEqual([]);
  });

  it('只由书名号组成的词退回字面匹配，不会退化成「返回全部」', () => {
    expect(filterShelfCards(cards, '《》')).toEqual([]);
    expect(filterShelfCards(cards, '《')).toEqual([]);
  });
});

describe('nextConfirm 两段式确认', () => {
  it('第一次点只武装，同一目标再点才放行并解除武装', () => {
    const first = nextConfirm(null, CLEAR_NEW_TARGET);
    expect(first).toEqual({ armed: CLEAR_NEW_TARGET, fire: false });
    expect(nextConfirm(first.armed, CLEAR_NEW_TARGET)).toEqual({ armed: null, fire: true });
  });

  it('换目标只重新武装新目标，绝不顺手放行旧目标', () => {
    const armed = nextConfirm(null, removeTarget(7)).armed;
    expect(nextConfirm(armed, removeTarget(8))).toEqual({ armed: removeTarget(8), fire: false });
    expect(nextConfirm(armed, CLEAR_NEW_TARGET)).toEqual({ armed: CLEAR_NEW_TARGET, fire: false });
    // 批量清理与单条移除的武装目标互不串台。
    expect(nextConfirm(CLEAR_NEW_TARGET, removeTarget(7)).fire).toBe(false);
  });
});

describe('SHELF_ROW_LIMIT', () => {
  // F06：分页后 LIMIT 变成绑定参数（limit/offset），不能再从模板里找字面量。
  // 前后端一致性改钉在「默认页大小常量」上：recommendationsForUserQuery 未显式传 limit 时
  // 用的就是它，前端 SHELF_ROW_LIMIT 又按它判断「还有更多」。解析常量值而非子串。
  const body = (() => {
    const source = readFileSync(new URL('./user-data.ts', import.meta.url), 'utf8');
    const slice = source.split('export function recommendationsForUserQuery')[1]?.split('\nexport function')[0];
    expect(slice).toBeTruthy();
    return slice!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  })();

  it('user-data.ts 的默认页大小常量与前端 SHELF_ROW_LIMIT 一致', () => {
    const source = readFileSync(new URL('./user-data.ts', import.meta.url), 'utf8');
    const declared = /const SHELF_PAGE_LIMIT = (\d+);/.exec(source);
    expect(declared?.[1]).toBe(String(SHELF_ROW_LIMIT));
    // 默认值真的用在查询里（不是只声明）：boundedLimit 缺省返回它。
    const bounded = source.slice(source.indexOf('function boundedLimit'));
    expect(bounded).toContain('SHELF_PAGE_LIMIT');
  });

  it('分页 LIMIT/OFFSET 走绑定参数，且外层的排序在分页之前', () => {
    expect(body).toMatch(/LIMIT \$\{limit\} OFFSET \$\{offset\}/);
    // DISTINCT ON 在内层，外层再按时间排序分页（否则第 301 本被 book_id 截断）。
    expect(body.indexOf('DISTINCT ON (r.book_id)')).toBeLessThan(body.indexOf('ORDER BY rep.created_at'));
  });
});
