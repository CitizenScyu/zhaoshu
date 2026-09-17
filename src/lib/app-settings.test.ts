import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSql } from './fixtures/mock-sql';

const mocks = vi.hoisted(() => ({ getSql: vi.fn() }));
vi.mock('./db', () => ({ getSql: mocks.getSql }));

import {
  DEFAULT_LLM_MODEL,
  clearDefaultModelSetting,
  clearLabelModelSetting,
  clearModelSetting,
  emptyModelSetting,
  environmentModel,
  isValidModelName,
  modelSettingsPayload,
  readLabelModelSetting,
  readModelSetting,
  resolveDefaultModel,
  writeDefaultModelSetting,
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
  // 构造一份"另一列没有覆盖值"的读库结果，让每个用例只声明它真正关心的那一列。
  const row = (over: Record<string, unknown>) => ({
    llm_model: null, llm_reasoning: null, updated_at: null,
    default_model: null, default_model_reasoning: null, default_model_updated_at: null,
    ...over,
  });

  it('读取数据库覆盖值', async () => {
    db.resolve.mockResolvedValue([row({
      llm_model: 'vendor/model', llm_reasoning: 'yes', updated_at: '2026-09-16T10:00:00.000Z',
    })]);
    await expect(readModelSetting()).resolves.toEqual({
      model: 'vendor/model',
      updatedAt: '2026-09-16T10:00:00.000Z',
      reasoning: 'yes',
      defaultModel: null,
      defaultModelUpdatedAt: null,
      defaultReasoning: null,
    });
    expect(db.queries[0].text).toContain('FROM app_settings');
    expect(db.queries[0].text).toContain('WHERE id = 1');
    expect(db.queries[0].text).toContain('llm_reasoning');
    // 默认值那三列必须真的被读出来：漏读会让「库内默认值」在运行时与页面上同时消失。
    expect(db.queries[0].text).toContain('default_model');
  });

  it('把 Date 形式的 updated_at 归一为 ISO 字符串', async () => {
    const at = new Date('2026-09-16T10:00:00.000Z');
    db.resolve.mockResolvedValue([row({ llm_model: 'vendor/model', updated_at: at })]);
    await expect(readModelSetting()).resolves.toMatchObject({
      model: 'vendor/model', updatedAt: at.toISOString(), reasoning: null,
    });
  });

  it('默认值那三列独立读出来，不借用 llm 那一列的时间戳', async () => {
    const at = new Date('2026-06-01T00:00:00.000Z');
    db.resolve.mockResolvedValue([row({
      default_model: 'vendor/default-1', default_model_reasoning: 'yes', default_model_updated_at: at,
    })]);
    await expect(readModelSetting()).resolves.toEqual({
      model: null, updatedAt: null, reasoning: null,
      defaultModel: 'vendor/default-1', defaultModelUpdatedAt: at.toISOString(), defaultReasoning: 'yes',
    });
  });

  it.each([
    ['没有行', []],
    ['值为 NULL', [row({ llm_model: null, llm_reasoning: 'yes' })]],
    ['值为空串', [row({ llm_model: '', llm_reasoning: 'yes', updated_at: 'x' })]],
    ['值是不合法模型名', [row({ llm_model: 'bad model!', llm_reasoning: 'yes', updated_at: 'x' })]],
  ])('%s 时视为没有覆盖值，连同那条判定一起作废', async (_name, rows) => {
    db.resolve.mockResolvedValue(rows);
    await expect(readModelSetting()).resolves.toEqual(emptyModelSetting());
  });

  // 两组覆盖值互不牵连：脏的 llm_model 不能把合法的 default_model 一起拖下水（反之亦然）。
  it('llm_model 是脏值时，合法的 default_model 仍然读得出来', async () => {
    db.resolve.mockResolvedValue([row({
      llm_model: 'bad model!', llm_reasoning: 'yes', default_model: 'vendor/default-1',
    })]);
    await expect(readModelSetting()).resolves.toMatchObject({
      model: null, updatedAt: null, reasoning: null, defaultModel: 'vendor/default-1',
    });
  });

  it('default_model 是脏值时，合法的 llm_model 仍然读得出来', async () => {
    db.resolve.mockResolvedValue([row({
      llm_model: 'vendor/model', llm_reasoning: 'yes', default_model: 'bad model!',
      default_model_updated_at: 'x',
    })]);
    await expect(readModelSetting()).resolves.toMatchObject({
      model: 'vendor/model', reasoning: 'yes',
      defaultModel: null, defaultModelUpdatedAt: null, defaultReasoning: null,
    });
  });

  // 判定值直接来自库里那一列，前端按 ReasoningVerdict 渲染；脏值不能直达前端。
  it.each([
    ['yes', 'yes'], ['unknown', 'unknown'], ['no', 'no'],
    ['不是判定的字符串', null], [true, null], ['', null],
  ])('库里的判定值 %j 读出来是 %j', async (stored, expected) => {
    db.resolve.mockResolvedValue([row({ llm_model: 'vendor/model', llm_reasoning: stored })]);
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

  // 回归护栏（别把两件事写进同一条 SQL）：恢复默认只该清 llm_model 那三列。
  // 顺手清掉 default_model 会让「恢复默认」把 owner 设的默认值一起抹了。
  it('恢复默认不碰默认值那三列', async () => {
    await clearModelSetting();
    expect(db.queries[0].text).not.toContain('default_model');
  });
});

// 默认值（llm_model 没有覆盖值时用的那个）——task-69 新增的一层。
describe('默认值设置读写', () => {
  it('写入走参数化 UPSERT，只动默认值那三列', async () => {
    db.resolve.mockResolvedValue([{ default_model_updated_at: '2026-06-01T00:00:00.000Z' }]);
    await expect(writeDefaultModelSetting('vendor/default-1', 'unknown')).resolves.toBe('2026-06-01T00:00:00.000Z');
    const query = db.queries[0];
    expect(query.text).toContain('INSERT INTO app_settings');
    expect(query.text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(query.text).toContain('default_model = EXCLUDED.default_model');
    expect(query.text).toContain('default_model_reasoning = EXCLUDED.default_model_reasoning');
    expect(query.text).toContain('default_model_updated_at = now()');
    expect(query.values).toEqual(['vendor/default-1', 'unknown']);
    // 别把当前模型那三列一起改了：改默认值与改当前模型是两件事。
    expect(query.text).not.toContain('llm_model');
    expect(query.text).not.toContain('llm_reasoning');
  });

  it('写入前校验模型名，非法值不写库', async () => {
    await expect(writeDefaultModelSetting('bad name', null)).rejects.toThrow('invalid model name');
    await expect(writeDefaultModelSetting('', 'yes')).rejects.toThrow('invalid model name');
    expect(db.queries).toHaveLength(0);
  });

  it('清除默认值只清那三列，时间戳一并置 NULL', async () => {
    await clearDefaultModelSetting();
    const query = db.queries[0];
    expect(query.text).toContain('default_model = NULL');
    expect(query.text).toContain('default_model_reasoning = NULL');
    expect(query.text).toContain('default_model_updated_at = NULL');
    expect(query.text).not.toContain('llm_model');
  });
});

// 解析链本身。改坏优先级（例如让环境变量盖过库内默认值）→ 本组必须失败。
describe('默认值解析链：库内默认值 → 环境变量 → 硬编码缺省', () => {
  const stored = (over: Partial<Parameters<typeof resolveDefaultModel>[0]> = {}) =>
    ({ ...emptyModelSetting(), ...over });

  it('库内有默认值时优先于环境变量，来源是 database', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(resolveDefaultModel(stored({
      defaultModel: 'db-default', defaultModelUpdatedAt: '2026-09-17T00:00:00.000Z',
    }))).toEqual({ model: 'db-default', source: 'database', updatedAt: '2026-09-17T00:00:00.000Z' });
  });

  it('库内没有默认值时用环境变量', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(resolveDefaultModel(stored())).toEqual({ model: 'env-model', source: 'environment', updatedAt: null });
  });

  it('两者都没有时用硬编码缺省', () => {
    withoutModelEnv(() => {
      expect(resolveDefaultModel(stored()))
        .toEqual({ model: DEFAULT_LLM_MODEL, source: 'default', updatedAt: null });
    });
  });
});

describe('GET 响应体', () => {
  const stored = (over: Partial<Parameters<typeof modelSettingsPayload>[0]> = {}) =>
    ({ ...emptyModelSetting(), ...over });

  it('数据库有覆盖值时来源是 database，默认值仍来自环境变量', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(modelSettingsPayload(stored({
      model: 'db-model', updatedAt: '2026-09-16T10:00:00.000Z',
    })))
      .toEqual({
        model: 'db-model',
        defaultModel: 'env-model',
        source: 'database',
        defaultSource: 'environment',
        updatedAt: '2026-09-16T10:00:00.000Z',
        defaultUpdatedAt: null,
        reasoning: null,
      });
  });

  it('没有覆盖值时报告 environment / default 来源且不谎报更新时间', () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    expect(modelSettingsPayload(stored()))
      .toEqual({
        model: 'env-model', defaultModel: 'env-model', source: 'environment', defaultSource: 'environment',
        updatedAt: null, defaultUpdatedAt: null, reasoning: null,
      });
    withoutModelEnv(() => {
      // 库里即便残留一条判定，它也不属于环境变量里的这个模型，不能拿来给它下结论。
      expect(modelSettingsPayload(stored({ reasoning: 'yes' })))
        .toEqual({
          model: DEFAULT_LLM_MODEL, defaultModel: DEFAULT_LLM_MODEL, source: 'default', defaultSource: 'default',
          updatedAt: null, defaultUpdatedAt: null, reasoning: null,
        });
    });
  });

  it('保存后把探测到的推理模型结论透出（三态原样透传）', () => {
    const withModel = (reasoning: 'yes' | 'no' | 'unknown' | null) =>
      modelSettingsPayload(stored({ model: 'db-model', reasoning }));
    expect(withModel('yes').reasoning).toBe('yes');
    expect(withModel('unknown').reasoning).toBe('unknown');
    expect(withModel(null).reasoning).toBe(null);
  });

  // 核心优先级：当前覆盖 → 库内默认值 → 环境变量 → 硬编码缺省。
  // 把任一层的顺序写反，本组用例必须失败。
  describe('回落链优先级', () => {
    it('库内默认值生效：当前模型就是默认值，来源 database，且不谎报 updatedAt', () => {
      vi.stubEnv('LLM_MODEL', 'env-model');
      expect(modelSettingsPayload(stored({
        defaultModel: 'db-default', defaultModelUpdatedAt: '2026-09-17T00:00:00.000Z',
      }))).toEqual({
        model: 'db-default',
        defaultModel: 'db-default',
        source: 'database',
        defaultSource: 'database',
        // updatedAt 描述的是 llm_model 覆盖值；这里没有覆盖值，不能借用默认值的时间戳。
        updatedAt: null,
        defaultUpdatedAt: '2026-09-17T00:00:00.000Z',
        reasoning: null,
      });
    });

    it('当前覆盖值优先于库内默认值', () => {
      expect(modelSettingsPayload(stored({
        model: 'db-model', defaultModel: 'db-default',
      }))).toMatchObject({ model: 'db-model', defaultModel: 'db-default', source: 'database' });
    });

    it('库内默认值优先于环境变量', () => {
      vi.stubEnv('LLM_MODEL', 'env-model');
      expect(modelSettingsPayload(stored({ defaultModel: 'db-default' })).model).toBe('db-default');
    });

    it('库内默认值优先于硬编码缺省', () => {
      withoutModelEnv(() => {
        expect(modelSettingsPayload(stored({ defaultModel: 'db-default' })))
          .toMatchObject({ model: 'db-default', defaultModel: 'db-default', defaultSource: 'database' });
      });
    });

    // 判定必须跟着当前生效的那个模型走，绝不能张冠李戴。
    it('默认值生效时，告警用的是默认值那条判定', () => {
      withoutModelEnv(() => {
        expect(modelSettingsPayload(stored({ defaultModel: 'db-default', defaultReasoning: 'yes' })).reasoning)
          .toBe('yes');
      });
    });

    it('当前覆盖值生效时，告警用的是覆盖值那条判定，不是默认值的', () => {
      expect(modelSettingsPayload(stored({
        model: 'db-model', reasoning: 'unknown', defaultModel: 'db-default', defaultReasoning: 'yes',
      })).reasoning).toBe('unknown');
    });

    it('默认值来自环境变量时没有判定可用（环境变量里的模型从没探测过）', () => {
      vi.stubEnv('LLM_MODEL', 'env-model');
      // 即便库里躺着一条 default_model 的判定（正常已被 clear 清掉），它对环境变量里的模型也不成立。
      expect(modelSettingsPayload(stored({ defaultReasoning: 'yes' })).reasoning).toBe(null);
    });
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
