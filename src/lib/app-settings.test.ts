import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSql } from './fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('./db', () => ({ getSql: mocks.getSql }));

import {
  DEFAULT_LLM_MODEL,
  clearLabelModelSetting,
  clearModelSetting,
  environmentModel,
  isValidModelName,
  modelSettingsPayload,
  readLabelModelSetting,
  readModelSetting,
  writeLabelModelSetting,
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
    db.resolve.mockResolvedValue([
      { llm_model: 'vendor/model', llm_reasoning: 'yes', updated_at: '2026-09-16T10:00:00.000Z' },
    ]);
    await expect(readModelSetting()).resolves.toEqual({
      model: 'vendor/model',
      updatedAt: '2026-09-16T10:00:00.000Z',
      reasoning: 'yes',
    });
    expect(db.queries[0].text).toContain('FROM app_settings');
    expect(db.queries[0].text).toContain('WHERE id = 1');
    expect(db.queries[0].text).toContain('llm_reasoning');
  });

  it('把 Date 形式的 updated_at 归一为 ISO 字符串', async () => {
    const at = new Date('2026-09-16T10:00:00.000Z');
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', llm_reasoning: null, updated_at: at }]);
    await expect(readModelSetting()).resolves.toEqual({
      model: 'vendor/model', updatedAt: at.toISOString(), reasoning: null,
    });
  });

  it.each([
    ['没有行', []],
    ['值为 NULL', [{ llm_model: null, llm_reasoning: 'yes', updated_at: null }]],
    ['值为空串', [{ llm_model: '', llm_reasoning: 'yes', updated_at: 'x' }]],
    ['值是不合法模型名', [{ llm_model: 'bad model!', llm_reasoning: 'yes', updated_at: 'x' }]],
  ])('%s 时视为没有覆盖值，连同那条判定一起作废', async (_name, rows) => {
    db.resolve.mockResolvedValue(rows);
    await expect(readModelSetting()).resolves.toEqual({ model: null, updatedAt: null, reasoning: null });
  });

  // 判定值直接来自库里那一列，前端按 ReasoningVerdict 渲染；脏值不能直达前端。
  it.each([
    ['yes', 'yes'], ['unknown', 'unknown'], ['no', 'no'],
    ['不是判定的字符串', null], [true, null], ['', null],
  ])('库里的判定值 %j 读出来是 %j', async (stored, expected) => {
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', llm_reasoning: stored, updated_at: 'x' }]);
    await expect(readModelSetting()).resolves.toMatchObject({ reasoning: expected });
  });

  // 回归护栏（warning 落库）：写入不带上判定值 / UPSERT 不更新那一列 → 本用例必须失败。
  it('写入走参数化 UPSERT，并带上判定值', async () => {
    db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
    await expect(writeModelSetting('vendor/model', 'yes')).resolves.toBe('2026-09-16T10:00:00.000Z');
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).toContain('INSERT INTO app_settings');
    expect(db.queries[0].text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(db.queries[0].text).toContain('llm_reasoning = EXCLUDED.llm_reasoning');
    expect(db.queries[0].values).toEqual(['vendor/model', 'yes']);
  });

  it('判定值可以是 unknown / null，照样落库', async () => {
    db.resolve.mockResolvedValue([{ updated_at: 'x' }]);
    await writeModelSetting('vendor/model', 'unknown');
    expect(db.queries[0].values).toEqual(['vendor/model', 'unknown']);
    await writeModelSetting('vendor/model', null);
    expect(db.queries[1].values).toEqual(['vendor/model', null]);
  });

  it('拒绝写入非法模型名且不发任何查询', async () => {
    await expect(writeModelSetting('bad model', null)).rejects.toThrow('invalid model name');
    await expect(writeModelSetting('', 'yes')).rejects.toThrow('invalid model name');
    expect(db.queries).toHaveLength(0);
  });

  it('恢复默认清空覆盖值，也清掉那条判定（它描述的是被清掉的模型）', async () => {
    await clearModelSetting();
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].text).toContain('UPDATE app_settings SET llm_model = NULL');
    expect(db.queries[0].text).toContain('llm_reasoning = NULL');
    expect(db.queries[0].values).toEqual([]);
  });
});

describe('GET 响应体', () => {
  it('数据库有覆盖值时来源是 database，默认值仍来自环境变量', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(modelSettingsPayload({
      model: 'db-model', updatedAt: '2026-09-16T10:00:00.000Z', reasoning: null,
    }))
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
    expect(modelSettingsPayload({ model: null, updatedAt: null, reasoning: null }))
      .toEqual({ model: 'env-model', defaultModel: 'env-model', source: 'environment', updatedAt: null, reasoning: null });
    withoutModelEnv(() => {
      // 库里即便残留一条判定，它也不属于环境变量里的这个模型，不能拿来给它下结论。
      expect(modelSettingsPayload({ model: null, updatedAt: null, reasoning: 'yes' }))
        .toEqual({ model: DEFAULT_LLM_MODEL, defaultModel: DEFAULT_LLM_MODEL, source: 'default', updatedAt: null, reasoning: null });
    });
  });

  it('保存后把探测到的推理模型结论透出（三态原样透传）', () => {
    expect(modelSettingsPayload({ model: 'db-model', updatedAt: null, reasoning: 'yes' }).reasoning).toBe('yes');
    expect(modelSettingsPayload({ model: 'db-model', updatedAt: null, reasoning: 'unknown' }).reasoning).toBe('unknown');
    expect(modelSettingsPayload({ model: 'db-model', updatedAt: null, reasoning: null }).reasoning).toBe(null);
  });
});

describe('打标模型设置', () => {
  it('读不到行或值是脏值时报告未设置（由打标机的 .env 决定）', async () => {
    db.resolve.mockResolvedValue([]);
    expect(await readLabelModelSetting()).toEqual({ model: null, updatedAt: null });
    db.resolve.mockResolvedValue([{ label_model: '坏 名字', label_model_updated_at: '2026-06-01T00:00:00.000Z' }]);
    expect(await readLabelModelSetting()).toEqual({ model: null, updatedAt: null });
  });

  it('合法覆盖值带上独立的更新时间，不读 llm 那一列', async () => {
    db.resolve.mockResolvedValue([{ label_model: 'vendor/label-1', label_model_updated_at: '2026-06-01T00:00:00.000Z' }]);
    expect(await readLabelModelSetting()).toEqual({ model: 'vendor/label-1', updatedAt: '2026-06-01T00:00:00.000Z' });
    expect(db.queries[0].text).toContain('label_model_updated_at');
    expect(db.queries[0].text).not.toContain('llm_model');
  });

  it('写入前校验模型名，非法值不写库', async () => {
    await expect(writeLabelModelSetting('bad name')).rejects.toThrow('invalid model name');
    await expect(writeLabelModelSetting('')).rejects.toThrow('invalid model name');
    expect(db.queries).toHaveLength(0);
  });

  it('写入只动 label_model 两列，不碰 llm_model / llm_reasoning', async () => {
    db.resolve.mockResolvedValue([{ label_model_updated_at: '2026-06-01T00:00:00.000Z' }]);
    expect(await writeLabelModelSetting('vendor/label-1')).toBe('2026-06-01T00:00:00.000Z');
    const query = db.queries[0];
    expect(query.text).toContain('label_model = EXCLUDED.label_model');
    expect(query.text).not.toContain('llm_model');
    expect(query.text).not.toContain('llm_reasoning');
  });

  it('清除覆盖值只清 label_model 两列', async () => {
    await clearLabelModelSetting();
    const query = db.queries[0];
    expect(query.text).toContain('label_model = NULL');
    expect(query.text).toContain('label_model_updated_at = NULL');
    expect(query.text).not.toContain('llm_model');
  });
});
