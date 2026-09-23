// 灾备重建链路的端到端真库验收（41-COLD-SCHEMA）。
//
// 背景：review-42 的灾备修复（MS-24a 闸门 `!==`→`<`、MS-25 冷建库记账补到 v7）此前只有
// 桩证据——`auth-migration-safety.test.ts` 用 `vi.fn().mockResolvedValue([{version}])` 绕过了
// SQL，只测闸门比较逻辑。本文件用 PGlite 在内存里**真执行** `migrations/0001_baseline.sql`，
// 给「冷建库后库版本=7、assertAuthSchema 放行」这件事提供真 SQL 证据，不是桩。
//
// 三不变量：
// 1. 执行 0001 后 SELECT max(version) FROM auth_schema_migrations = 7（MS-25 记账行）。
// 2. 冷建库后 assertAuthSchema（真 sql，非 mock）resolve 不抛（MS-24a+MS-25 联立的「不 503」）。
// 3. 版本 8 仍放行；版本降到 6 抛 AuthSchemaRequiredError（闸门的前向/后向保护，真 SQL）。

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertAuthSchema, AuthSchemaRequiredError } from '@/lib/auth-store';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';

type SqlTag = (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

// assertAuthSchema 只把 sql`...` 的 thenable 结果当 { version }[] 用；这里给 PGlite 做一个
// 与生产 neon 标签同构的适配器（参数化 query，返回 rows），不 mock 任何 SQL。
function adapter(pg: PGliteLike): SqlTag {
  return async (parts, ...values) => {
    let text = '';
    const params: unknown[] = [];
    parts.forEach((part, index) => {
      text += part;
      if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
    });
    return (await pg.query(text, params)).rows;
  };
}

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

// 0001 由迁移 runner 作为**一条**语句在事务里执行（文件头注释明示不要加 BEGIN/COMMIT），
// 因此这里也整份一次性 exec，保持与生产一致的语句边界——不做按语句切分去迁就测试。
const BASELINE_SQL = readFileSync(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8');

maybe('冷建库灾备链路（0001 真执行 + assertAuthSchema 真闸门）', () => {
  let pg: PGliteLike;
  let sql: SqlTag;

  beforeAll(async () => {
    pg = new PGliteCtor!();
    sql = adapter(pg);
    await pg.exec(BASELINE_SQL);
  });

  // 不变式 1：MS-25 记账行把冷建库记账到 v7。
  it('执行 0001 后 max(version) = 7（MS-25 冷建库记账行）', async () => {
    const rows = await pg.query('SELECT max(version)::int AS version FROM auth_schema_migrations');
    expect(rows.rows).toEqual([{ version: 7 }]);
  });

  // 不变式 2：MS-24a+MS-25——冷建库（库版本=7 = 代码常量 7）不再 503。
  it('冷建库后 assertAuthSchema 放行（库 7 ≥ 代码 7，冷启动不 503）', async () => {
    await expect(assertAuthSchema(sql as never)).resolves.toBeUndefined();
  });

  // 不变式 3a：库新于代码（灰度/回滚窗口）放行——闸门是 `<` 不是 `!==`（MS-24a）。
  it('把库版本推到 8 后 assertAuthSchema 仍放行（库新代码旧不 503）', async () => {
    await pg.query('INSERT INTO auth_schema_migrations(version) VALUES (8)');
    await expect(assertAuthSchema(sql as never)).resolves.toBeUndefined();
  });

  // 不变式 3b：库落后于代码抛 AuthSchemaRequiredError（真 SQL，非 vi.fn 桩）。
  it('把库版本降到 6 后 assertAuthSchema 抛 AuthSchemaRequiredError', async () => {
    await pg.query('DELETE FROM auth_schema_migrations WHERE version > 6');
    await expect(assertAuthSchema(sql as never)).rejects.toBeInstanceOf(AuthSchemaRequiredError);
  });
});
