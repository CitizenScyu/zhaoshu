import { describe, expect, it } from 'vitest';
import { initializeBusinessSchema } from './business-schema';

// 用记录器跑真实的 DDL 序列：断言的是「真的发出去了什么语句」，而不是源码里有没有那段字。
function recorder() {
  const statements: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve([]);
  };
  return { statements, sql };
}

describe('业务 schema 的运行时 DDL', () => {
  // 回归护栏（warning 落库）：删掉这条 ALTER → 本用例必须失败；老库永远不会有这一列，
  // GET 就再也读不回「上次保存时判定它是推理模型」。
  it('幂等地补出 app_settings.llm_reasoning，且排在建表之后', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const alterIndex = statements.findIndex((text) => /ALTER TABLE app_settings/.test(text));
    expect(alterIndex).toBeGreaterThan(-1);
    expect(statements[alterIndex]).toMatch(/ADD COLUMN IF NOT EXISTS\s+llm_reasoning/);
    const createIndex = statements.findIndex((text) => /CREATE TABLE IF NOT EXISTS app_settings/.test(text));
    expect(createIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(alterIndex);
  });

  it('不动 app_settings 已有行（单行记录不能被这条补列破坏）', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const touchAppSettings = statements.filter((text) => /app_settings/.test(text));
    for (const text of touchAppSettings) {
      // 只允许建表、幂等补列、以及 ON CONFLICT DO NOTHING 的兜底插入；
      // 任何 DELETE / TRUNCATE / 无条件的 UPDATE 都会毁掉 owner 已保存的模型设置。
      expect(text).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/);
      expect(text).not.toMatch(/UPDATE\s+app_settings/i);
      expect(text).toMatch(/CREATE TABLE IF NOT EXISTS|ADD COLUMN IF NOT EXISTS|ON CONFLICT \(id\) DO NOTHING/);
    }
  });

  // 加列走业务 schema 的运行时 DDL，绝不碰认证 schema 的版本闸门
  // （闸门不匹配会全站 503；认证库那边还有独立的迁移脚本）。
  it('补列不触碰认证 schema 与版本闸门', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const all = statements.join('\n');
    expect(all).not.toMatch(/auth_settings|AUTH_SCHEMA_VERSION|auth_schema_migrations/);
  });
});
