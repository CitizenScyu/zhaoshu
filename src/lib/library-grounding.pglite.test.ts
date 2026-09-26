import { beforeAll, describe, expect, it } from 'vitest';
import { createProductionSchema } from '@/lib/fixtures/production-schema';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { libraryLabelsForCandidatesQuery, planLibraryGrounding, type LibraryLabelRow } from '@/lib/library-grounding';

// 41-rerankgnd：书库标签批量查询的真实 SQL 语义（PGlite = 真 PostgreSQL）。
// 钉住三件事：① 走生成列 title_key/author_key（剥《》、NFKC、大小写与 0002 迁移同源）；
// ② 整批一条语句；③ 只回所需列（不带整个 labels jsonb）。
// 建表走 createProductionSchema（原样执行生产 0002 迁移，不手抄生成列表达式）。

type Statement = { text: string; params: unknown[] };

function tag(parts: TemplateStringsArray, ...values: unknown[]): Statement {
  let text = '';
  const params: unknown[] = [];
  parts.forEach((part, index) => {
    text += part;
    if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
  });
  return { text, params };
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('41-rerankgnd：书库标签批量查询', () => {
  let pg: PGliteLike;
  const run = async (candidates: { title: string; author: string }[]) => {
    const statement = libraryLabelsForCandidatesQuery(tag as never, candidates) as unknown as Statement;
    return { statement, rows: (await pg.query(statement.text, statement.params)).rows as unknown as LibraryLabelRow[] };
  };

  beforeAll(async () => {
    pg = new PGliteCtor!();
    const adapted = Object.assign(tag, {
      transaction: async (builder: (t: typeof tag) => Statement[]) => {
        const results = [];
        for (const s of builder(tag)) results.push((await pg.query(s.text, s.params)).rows);
        return results;
      },
    });
    await createProductionSchema(adapted as never, (statement) => pg.exec(statement));
    const insert = `INSERT INTO labeled_books (title, author, labels, sub_tags, quality) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`;
    await pg.query(insert, ['《仙武同修》', '作者甲', JSON.stringify({
      weaknesses: ['后宫过多'], strengths: ['战斗热血'], tone: '热血', pace: '快',
      protagonist: '不该被取回的长字段', worldbuilding: '同上',
    }), JSON.stringify(['东方玄幻']), 6.5]);
    await pg.query(insert, ['恶灵附身', 'ABC', JSON.stringify({ weaknesses: '时间线复杂', tone: '冷峻' }), '[]', null]);
    await pg.query(insert, ['同名书', '真作者', JSON.stringify({ weaknesses: ['后宫'] }), '[]', 7]);
  }, 60_000);

  it('matches a whole batch in one statement via the generated identity keys', async () => {
    const { statement, rows } = await run([
      { title: '仙武同修', author: '作者甲' }, // 库里带《》
      { title: '恶灵附身', author: 'abc' }, // 作者大小写不同
      { title: '同名书', author: '冒名作者' }, // 同名不同作者：不得命中
      { title: '不存在', author: '谁' },
      { title: '仙武同修', author: '作者甲' }, // 重复候选：参数去重
    ]);
    expect(statement.text).toContain('unnest(');
    expect(statement.params[0]).toEqual(['仙武同修', '恶灵附身', '同名书', '不存在']);
    expect(rows.map((row) => row.title_key).sort()).toEqual(['仙武同修', '恶灵附身']);
    const xianwu = rows.find((row) => row.title_key === '仙武同修')!;
    expect(Object.keys(xianwu).sort()).toEqual(
      ['author_key', 'pace', 'quality', 'strengths', 'sub_tags', 'title_key', 'tone', 'weaknesses']);
    expect(xianwu).toMatchObject({
      weaknesses: ['后宫过多'], strengths: ['战斗热血'], tone: '热血', pace: '快', sub_tags: ['东方玄幻'], quality: 6.5,
    });
    expect(JSON.stringify(rows)).not.toContain('不该被取回');
  });

  it('feeds planLibraryGrounding end to end (legacy string weaknesses, null quality)', async () => {
    const candidates = [{ title: '《仙武同修》', author: '作者甲' }, { title: '恶灵附身', author: 'ABC' }];
    const { rows } = await run(candidates);
    const plan = planLibraryGrounding(candidates, rows, '## 雷点\n- 后宫');
    expect(plan.vetoed.map((v) => v.title)).toEqual(['《仙武同修》']);
    expect([...plan.evidence.values()]).toEqual([{ weaknesses: ['时间线复杂'], tone: '冷峻' }]);
  });

  it('returns no rows for an empty batch', async () => {
    expect((await run([])).rows).toEqual([]);
  });
});
