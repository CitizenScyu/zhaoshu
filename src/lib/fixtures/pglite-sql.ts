// 测试夹具的 PGlite 标签适配器：把 `sql\`...\`` 转成参数化查询，返回行数组。
//
// Neon 的 neon() / NeonQueryFunctionInTransaction 与本项目各测试里的自建标签有几处不同：
//   - 每条 await 都是一次真的 HTTP 往返，且 transaction(builder) 要在**同一批**里发出；
//   - 标签本体返回 thenable，且同时透出 { text, params }，让 transaction 能取出待发语句。
// 这里是 PGlite 真库上的等价形状：标签 → 参数化 query 返回 rows；transaction 以真
// BEGIN/COMMIT 串行执行批内语句（失败 ROLLBACK），Neon 的「批内按序执行」语义等价。

import type { PGliteLike } from './pglite';

/** 标签的返回物：既是要 await 的 thenable，也自带 text/params 供 transaction 拆包。 */
export type PGliteTagResult = Promise<unknown> & { text: string; params: unknown[] };

/** 把字面量与插值合成 ($n, params)。与生产 neon 的绑定顺序一致。 */
function toStatement(parts: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  parts.forEach((part, index) => {
    text += part;
    if (index < values.length) { params.push(values[index]); text += `$${params.length}`; }
  });
  return { text, params };
}

/**
 * 返回 (tag & { transaction }) 形状的 PGlite 适配器。
 * 形状务必与 `ReturnType<typeof neon>` 的用法兼容：initialize*Schema 只要求
 * `sql\`...\`` 返回 thenable、`sql.transaction(builder)` 接受返回语句数组的 builder。
 */
export function createPGliteSql(pg: PGliteLike) {
  const tag = (parts: TemplateStringsArray, ...values: unknown[]): PGliteTagResult => {
    const { text, params } = toStatement(parts, values);
    const result = Object.assign(
      pg.query(text, params).then(query => query.rows),
      { text, params },
    );
    return result;
  };
  const transaction = async (build: (query: typeof tag) => PGliteTagResult[]) => {
    const statements = build(tag);
    await pg.exec('BEGIN');
    try {
      const rows = [];
      for (const statement of statements) {
        rows.push((await pg.query(statement.text, statement.params)).rows);
      }
      await pg.exec('COMMIT');
      return rows;
    } catch (error) {
      await pg.exec('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  // 生产 neon 的 `sql.query(text, params)`（非模板形态，见 @neondatabase/serverless 类型）在 PGlite 上的等价物：
  // 直接返回行数组（与 neon 默认 arrayMode=false 一致）。businessSchemaCurrent 的动态探测 SQL 走这条。
  const query = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows;
  return Object.assign(tag, { transaction, query });
}

/**
 * scripts/db-migration-lib.mjs 的 client 形状（`client.query(text, params?) → { rows }`）在 PGlite 上的等价物。
 * 迁移文件是整份多语句 SQL，由 runner 不带参数地一次送出（pg 驱动此时走 simple query 协议）；
 * PGlite 的 query 走扩展协议只收单语句，因此无参数时改用 exec，取最后一条语句的结果行。
 */
export function createPGliteClient(pg: PGliteLike) {
  return {
    async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
      if (params && params.length) return await pg.query(text, params);
      const results = (await pg.exec(text)) as { rows: Record<string, unknown>[] }[];
      return { rows: results.at(-1)?.rows ?? [] };
    },
  };
}
