import { vi } from 'vitest';
import type { PersonalSql } from '../personal-write';

export type RecordedQuery = { text: string; values: unknown[] };
export function mockSql() {
  const queries: RecordedQuery[] = [];
  const resolve = vi.fn<(query: RecordedQuery) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>>(() => []);
  const execute = async (query: RecordedQuery) => {
    queries.push(query);
    // 授权 SQL 的真实原子性另由专用 Neon 验收验证；这里保留请求及 SQL 参数边界。
    if (query.text.includes('nf.write_authorization')) return [];
    return resolve(query);
  };
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query: RecordedQuery = { text: '', values: [] };
    parts.forEach((part, index) => {
      query.text += part;
      if (index >= values.length) return;
      const value = values[index];
      if (value && typeof value === 'object' && 'text' in value && 'values' in value) {
        const fragment = value as RecordedQuery; query.text += fragment.text; query.values.push(...fragment.values);
      } else { query.text += '?'; query.values.push(value); }
    });
    return { ...query, then: (fulfilled: (rows: Record<string, unknown>[]) => unknown, rejected: (error: unknown) => unknown) => execute(query).then(fulfilled, rejected) };
  };
  const transaction = vi.fn(async (batch: ((sql: unknown) => RecordedQuery[]) | RecordedQuery[]) => {
    const rows = [];
    for (const query of typeof batch === 'function' ? batch(tag) : batch) rows.push(await execute(query));
    return rows;
  });
  return { sql: Object.assign(tag, { transaction }) as unknown as PersonalSql, queries, resolve, transaction };
}
