import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

export function requireTestDatabaseUrl() {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) throw Object.assign(new Error('TEST_DATABASE_URL is required; no environment files or DATABASE_URL fallback.'), { exitCode: 2 });
  return value;
}

// Neon HTTP 不依赖连接串中的 search_path：每次请求都在同一事务内显式设置。
// 保留驱动的惰性 QueryPromise，组合查询和 transaction 都不会提前发送业务 SQL。
export function scopedSql(raw, schema) {
  if (!/^a04_[a-z0-9_]+$/.test(schema)) throw new Error('Invalid test schema');
  const prefix = (tx) => tx`SELECT set_config('search_path', ${schema}, true)`;
  const lazy = (query, options) => {
    query.then = (fulfilled, rejected) => raw.transaction([prefix(raw), query], options)
      .then((rows) => rows[1]).then(fulfilled, rejected);
    return query;
  };
  const sql = (parts, ...values) => lazy(raw(parts, ...values));
  sql.query = (text, values, options) => lazy(raw.query(text, values), options);
  sql.unsafe = raw.unsafe;
  sql.transaction = (queries, options) => raw.transaction((tx) => [
    prefix(tx), ...(typeof queries === 'function' ? queries(tx) : queries),
  ], options).then((rows) => rows.slice(1));
  return sql;
}

export async function withTestSchema(run) {
  const raw = neon(requireTestDatabaseUrl());
  const schema = `a04_${randomUUID().replaceAll('-', '')}`;
  await raw.query(`CREATE SCHEMA "${schema}"`);
  try {
    const sql = scopedSql(raw, schema);
    const rows = await sql`SELECT current_schema() AS schema`;
    if (rows[0]?.schema !== schema) throw new Error('Test schema isolation failed');
    return await run(sql, raw, schema);
  } finally {
    // 名称仅由本函数生成且 CREATE 已成功；不删除 public 或任何已有 schema。
    await raw.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

export function reportDatabaseFailure(error) {
  // 驱动原始错误可能含连接信息；只输出固定说明和 SQLSTATE。
  console.error(error?.exitCode === 2 ? 'TEST_DATABASE_URL 未提供；拒绝访问任何数据库。'
    : `隔离库验收失败（${typeof error?.code === 'string' ? error.code : 'CHECK_FAILED'}）。`);
  process.exitCode = error?.exitCode === 2 ? 2 : 1;
}
