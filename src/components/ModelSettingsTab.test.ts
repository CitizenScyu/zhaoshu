import { describe, expect, it } from 'vitest';
import { confirmationFor, reasoningLabel, savedNotice } from './ModelSettingsTab';
import { REASONING_CONFIRMATION_CODE } from '@/lib/app-settings';

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
