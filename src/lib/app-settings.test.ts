import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSql } from './fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('./db', () => ({ getSql: mocks.getSql }));

import {
  DEFAULT_LLM_MODEL,
  clearModelSetting,
  environmentModel,
  isValidModelName,
  modelSettingsPayload,
  readModelSetting,
  writeModelSetting,
} from './app-settings';

let db: ReturnType<typeof mockSql>;

beforeEach(() => {
  db = mockSql();
  mocks.getSql.mockReturnValue(db.sql);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// 不依赖进程环境是否恰好有 LLM_MODEL：显式删掉再还原。
function withoutModelEnv<T>(run: () => T): T {
  const saved = process.env.LLM_MODEL;
  delete process.env.LLM_MODEL;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = saved;
  }
}

describe('模型名校验', () => {
  it.each(['claude-opus-5-88', 'vendor/model', 'gpt-4o-mini', 'a', 'a'.repeat(200)])(
    '接受合法模型名 %j',
    (value) => expect(isValidModelName(value)).toBe(true),
  );

  it.each([
    '', ' ', 'has space', 'tab\there', 'new\nline', 'carriage\rreturn', 'nul' + String.fromCharCode(0),
    'semi;colon', 'quote"x', 'back\\slash', 'emoji😀', 'a'.repeat(201),
  ])('拒绝含空白/控制字符/越界长度的模型名 %j', (value) => {
    expect(isValidModelName(value)).toBe(false);
  });

  it.each([null, undefined, 42, {}, ['m'], true])('拒绝非字符串 %j', (value) => {
    expect(isValidModelName(value)).toBe(false);
  });
});

describe('环境变量回退（保持既有 LLM_MODEL 语义）', () => {
  it('没有 LLM_MODEL 时用硬编码缺省', () => {
    withoutModelEnv(() => {
      expect(environmentModel()).toEqual({ model: DEFAULT_LLM_MODEL, source: 'default' });
      expect(DEFAULT_LLM_MODEL).toBe('claude-opus-5-88');
    });
  });

  it('LLM_MODEL 非空即用，不做额外判定', () => {
    vi.stubEnv('LLM_MODEL', 'vendor/model-x');
    expect(environmentModel()).toEqual({ model: 'vendor/model-x', source: 'environment' });
  });

  it('LLM_MODEL 为空串时等同未配置', () => {
    vi.stubEnv('LLM_MODEL', '');
    expect(environmentModel()).toEqual({ model: DEFAULT_LLM_MODEL, source: 'default' });
  });
});

describe('app_settings 读写', () => {
  it('读取数据库覆盖值', async () => {
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', updated_at: '2026-09-16T10:00:00.000Z' }]);
    await expect(readModelSetting()).resolves.toEqual({
      model: 'vendor/model',
      updatedAt: '2026-09-16T10:00:00.000Z',
    });
    expect(db.queries[0].text).toContain('FROM app_settings');
    expect(db.queries[0].text).toContain('WHERE id = 1');
  });

  it('把 Date 形式的 updated_at 归一为 ISO 字符串', async () => {
    const at = new Date('2026-09-16T10:00:00.000Z');
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', updated_at: at }]);
    await expect(readModelSetting()).resolves.toEqual({ model: 'vendor/model', updatedAt: at.toISOString() });
  });

  it.each([
    ['没有行', []],
    ['值为 NULL', [{ llm_model: null, updated_at: null }]],
    ['值为空串', [{ llm_model: '', updated_at: 'x' }]],
    ['值是不合法模型名', [{ llm_model: 'bad model!', updated_at: 'x' }]],
  ])('%s 时视为没有覆盖值', async (_name, rows) => {
    db.resolve.mockResolvedValue(rows);
    await expect(readModelSetting()).resolves.toEqual({ model: null, updatedAt: null });
  });

  it('写入走参数化 UPSERT', async () => {
    db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
    await expect(writeModelSetting('vendor/model')).resolves.toBe('2026-09-16T10:00:00.000Z');
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).toContain('INSERT INTO app_settings');
    expect(db.queries[0].text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(db.queries[0].values).toEqual(['vendor/model']);
  });

  it('拒绝写入非法模型名且不发任何查询', async () => {
    await expect(writeModelSetting('bad model')).rejects.toThrow('invalid model name');
    await expect(writeModelSetting('')).rejects.toThrow('invalid model name');
    expect(db.queries).toHaveLength(0);
  });

  it('恢复默认只清空覆盖值', async () => {
    await clearModelSetting();
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).toContain('UPDATE app_settings SET llm_model = NULL');
    expect(db.queries[0].values).toEqual([]);
  });
});

describe('GET 响应体', () => {
  it('数据库有覆盖值时来源是 database，默认值仍来自环境变量', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(modelSettingsPayload({ model: 'db-model', updatedAt: '2026-09-16T10:00:00.000Z' }))
      .toEqual({
        model: 'db-model',
        defaultModel: 'env-model',
        source: 'database',
        updatedAt: '2026-09-16T10:00:00.000Z',
        reasoning: null,
      });
  });

  it('没有覆盖值时报告 environment / default 来源且不谎报更新时间', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(modelSettingsPayload({ model: null, updatedAt: null }))
      .toEqual({ model: 'env-model', defaultModel: 'env-model', source: 'environment', updatedAt: null, reasoning: null });
    withoutModelEnv(() => {
      expect(modelSettingsPayload({ model: null, updatedAt: null }))
        .toEqual({ model: DEFAULT_LLM_MODEL, defaultModel: DEFAULT_LLM_MODEL, source: 'default', updatedAt: null, reasoning: null });
    });
  });

  it('保存后把探测到的推理模型结论透出', () => {
    expect(modelSettingsPayload({ model: 'db-model', updatedAt: null }, true).reasoning).toBe(true);
  });
});
