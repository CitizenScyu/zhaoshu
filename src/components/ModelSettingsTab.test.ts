import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_LABELS,
  confirmationFor,
  currentSourceLabel,
  defaultSavedNotice,
  hasModelOverride,
  reasoningLabel,
  savedNotice,
} from './ModelSettingsTab';
import { REASONING_CONFIRMATION_CODE } from '@/lib/app-settings';
import type { LlmModelSettings } from '@/lib/app-settings';

// 回归护栏（判据说谎）：页面文案只能转述三态判定。'unknown' 一旦被写成「否」，
// 保存推理模型时 owner 就会看到「不是推理模型」——那正是 2026-09-17 修掉的说谎。
describe('页面上的推理模型判定', () => {
  it('unknown 只说「未观察到」，绝不说成「否」', () => {
    const label = reasoningLabel('unknown');
    expect(label).toContain('未观察到');
    expect(label).not.toBe('否');
    expect(label).not.toMatch(/^否/);
  });

  it('只有 yes 才说「是」，no 才说「否」', () => {
    expect(reasoningLabel('yes')).toMatch(/^是/);
    expect(reasoningLabel('no')).toMatch(/^否/);
  });

  it('GET 没有探测过时说未知并说明保存时会实测', () => {
    expect(reasoningLabel(null)).toContain('未知');
    expect(reasoningLabel(null)).toContain('保存');
  });

  it('保存后判定为推理模型时主动提示，未知时说明探测的局限', () => {
    expect(savedNotice('m', { reasoning: 'yes' })).toContain('推理模型');
    expect(savedNotice('m', { reasoning: 'unknown' })).toContain('不代表它不是推理模型');
    expect(savedNotice('m', { reasoning: 'unknown' })).not.toContain('不是推理模型。');
  });

  it('上游给的 warning 优先原样透出，不与页面文案重复', () => {
    const notice = savedNotice('m', { reasoning: 'yes', warning: '预算被思维链用尽' });
    expect(notice).toContain('预算被思维链用尽');
    expect(notice).not.toContain('探测观察到该模型会输出思维链');
  });
});

// 回归护栏（推理模型确认）：确认块只认接口那个错误码。把码写错/删掉这段判断，
// 页面就会把「需要确认」当成普通报错，owner 只看到一句干巴巴的失败。
describe('推理模型确认块', () => {
  const data = { code: REASONING_CONFIRMATION_CODE, error: '该模型会输出思维链（推理模型）……' };

  it('接口返回确认码时摆出确认块，并原样带出接口的原因', () => {
    const confirmation = confirmationFor(409, data, 'reasoner/model');
    expect(confirmation).toEqual({ model: 'reasoner/model', message: '该模型会输出思维链（推理模型）……' });
  });

  it('确认码必须与接口一致', () => {
    expect(REASONING_CONFIRMATION_CODE).toBe('REASONING_MODEL_REQUIRES_CONFIRMATION');
  });

  it.each([
    ['别的错误码', 400, { code: 'INVALID_MODEL', error: 'x' }],
    ['没有错误码', 502, { error: 'x' }],
    ['恢复默认（没有模型名）', 409, data],
    ['HTTP 200', 200, data],
  ])('%s 时不当确认块处理，走普通错误路径', (_name, status, payload) => {
    expect(confirmationFor(status, payload as { code?: unknown; error?: unknown }, _name === '恢复默认（没有模型名）' ? null : 'm')).toBe(null);
  });

  it('接口没给原因时也要有一句能看懂的说明', () => {
    expect(confirmationFor(409, { code: REASONING_CONFIRMATION_CODE }, 'm')?.message)
      .toContain('推理模型');
  });
});

// task-69：默认值那一栏可改，两个按钮的可用性判断必须诚实。
describe('默认值那一栏', () => {
  const settings = (over: Partial<LlmModelSettings> = {}): LlmModelSettings => ({
    model: 'm',
    defaultModel: 'm',
    source: 'environment',
    defaultSource: 'environment',
    updatedAt: null,
    defaultUpdatedAt: null,
    reasoning: null,
    ...over,
  });

  // 回归护栏：判据写成 source === 'database' 时，库内默认值生效的场景会让「恢复默认」
  // 可点却什么都不做（没有 llm_model 覆盖值可清）。本用例必须因此失败。
  it('「恢复默认」只在真的有当前覆盖值时可用', () => {
    expect(hasModelOverride(settings({ source: 'database', updatedAt: '2026-09-17T00:00:00.000Z' }))).toBe(true);
    // 库内默认值生效：source 也是 database，但没有覆盖值可清。
    expect(hasModelOverride(settings({ source: 'database', defaultSource: 'database' }))).toBe(false);
    expect(hasModelOverride(settings({ source: 'environment' }))).toBe(false);
    expect(hasModelOverride(settings({ source: 'default' }))).toBe(false);
  });

  it('默认值的来源措辞与当前模型区分开', () => {
    expect(DEFAULT_SOURCE_LABELS.database).toBe('库内默认值');
    expect(DEFAULT_SOURCE_LABELS.environment).toContain('LLM_MODEL');
    expect(DEFAULT_SOURCE_LABELS.default).toContain('硬编码');
  });

  it('保存默认值后的提示说的是默认值，不冒充「已切换当前模型」', () => {
    const notice = defaultSavedNotice({ model: 'db/default', defaultModel: 'db/default', reasoning: 'unknown' });
    expect(notice).toContain('默认值已改为 db/default');
    expect(notice).not.toContain('已切换到');
    // 生效时沿用与「切换当前模型」完全一致的三态文案。
    expect(notice).toContain('不代表它不是推理模型');
    expect(defaultSavedNotice({ model: 'm', defaultModel: 'm', reasoning: 'yes' })).toContain('推理模型');
    expect(defaultSavedNotice({
      model: 'm', defaultModel: 'm', reasoning: 'yes', warning: '预算被思维链用尽',
    })).toContain('预算被思维链用尽');
  });

  // 回归护栏（假陈述）：把两句合成一句「立即生效」→ 本用例必须失败。
  // 有 llm_model 覆盖值时新默认值一个字节都没跑，说它「生效」是假话；
  // 它又是推理模型时，接着说「找书会更慢」更是把未来的事说成了现在的事。
  describe('默认值保存后是否真的生效，必须分开说', () => {
    it('当前另有覆盖值时不说「立即生效」，并点明是谁在跑', () => {
      const notice = defaultSavedNotice({
        model: 'vendor/current', defaultModel: 'vendor/default-1', reasoning: 'yes',
      });
      expect(notice).toContain('默认值已改为 vendor/default-1');
      expect(notice).not.toContain('立即生效');
      expect(notice).toContain('暂未生效');
      expect(notice).toContain('vendor/current');
      expect(notice).toContain('恢复默认');
    });

    it('生效与未生效两种情形下，「找书会更慢」的时态不同', () => {
      const live = defaultSavedNotice({ model: 'm', defaultModel: 'm', reasoning: 'yes' });
      const pending = defaultSavedNotice({ model: 'other', defaultModel: 'm', reasoning: 'yes' });
      expect(live).toContain('找书会更慢');
      // 未生效时只能说「等它生效后」，不能说成现在就在变慢。
      expect(pending).toContain('等它生效后找书会更慢');
      expect(pending).not.toContain('立即生效');
    });

    it('未生效时上游 warning 仍原样透出', () => {
      expect(defaultSavedNotice({
        model: 'other', defaultModel: 'm', reasoning: 'yes', warning: '预算被思维链用尽',
      })).toContain('预算被思维链用尽');
    });

    it('未生效时也不谎报「不是推理模型」', () => {
      const notice = defaultSavedNotice({ model: 'other', defaultModel: 'm', reasoning: 'unknown' });
      expect(notice).toContain('不代表它不是推理模型');
    });
  });

  // 回归护栏：来源那一栏在「库内默认值生效」时写回「数据库设置」，
  // 会同屏出现「来源：数据库设置」+「覆盖更新时间：无覆盖值」这对自相矛盾的话。
  it('来源文案在库内默认值生效时不再笼统写「数据库设置」', () => {
    expect(currentSourceLabel(settings({ source: 'database', defaultSource: 'database' }))).toBe('库内默认值');
    // 真的有 llm_model 覆盖值时，来源仍然是「数据库设置」。
    expect(currentSourceLabel(settings({ source: 'database', updatedAt: '2026-09-17T00:00:00.000Z' })))
      .toBe('数据库设置');
    expect(currentSourceLabel(settings({ source: 'environment' }))).toContain('LLM_MODEL');
    expect(currentSourceLabel(settings({ source: 'default' }))).toContain('硬编码');
  });
});
