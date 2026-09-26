import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compactLibraryEvidence,
  LIBRARY_BATCH_MAX_CHARS,
  LIBRARY_BOOK_MAX_CHARS,
  LIBRARY_ITEM_MAX_CHARS,
  libraryGroundingEnabled,
  libraryVeto,
  planLibraryGrounding,
  profileHardDislikes,
  type LibraryLabelRow,
} from './library-grounding';
import { normalizeBookAuthor, normalizeBookTitle } from './book-identity';

function row(title: string, author: string, patch: Partial<LibraryLabelRow> = {}): LibraryLabelRow {
  return {
    title_key: normalizeBookTitle(title),
    author_key: normalizeBookAuthor(author),
    weaknesses: ['文笔粗糙'],
    strengths: ['战斗热血'],
    tone: '热血',
    pace: '快',
    sub_tags: ['东方玄幻'],
    quality: 6.84,
    ...patch,
  };
}

const HAREM_HATER = `## 硬性条件
- 完结优先
## 萌点（加分项）
- 群像（证据：最爱《某书》）
## 雷点（一票否决）
- 后宫/种马（证据：弃《某后宫文》）
## 灵活区（可探索）
- 百合题材未知`;

describe('libraryGroundingEnabled', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('defaults on and only turns off on explicit 0/false/off', () => {
    vi.stubEnv('RERANK_LIBRARY_GROUNDING', undefined as unknown as string);
    expect(libraryGroundingEnabled()).toBe(true);
    for (const on of ['1', 'true', 'on', '', 'yes']) {
      vi.stubEnv('RERANK_LIBRARY_GROUNDING', on);
      expect(libraryGroundingEnabled()).toBe(true);
    }
    for (const off of ['0', 'false', 'off', ' OFF ', 'False']) {
      vi.stubEnv('RERANK_LIBRARY_GROUNDING', off);
      expect(libraryGroundingEnabled()).toBe(false);
    }
  });
});

describe('compactLibraryEvidence', () => {
  it('keeps the short fields, rounds quality and omits empty fields', () => {
    expect(compactLibraryEvidence(row('书', '甲'))).toEqual({
      quality: 6.8, weaknesses: ['文笔粗糙'], tone: '热血', pace: '快', strengths: ['战斗热血'],
    });
    expect(compactLibraryEvidence(row('书', '甲', {
      weaknesses: [], strengths: null, tone: '', pace: null, quality: null,
    }))).toBeNull();
  });

  it('accepts legacy string-shaped weaknesses/strengths', () => {
    const evidence = compactLibraryEvidence(row('书', '甲', { weaknesses: '时间线复杂', strengths: '反转多' }));
    expect(evidence?.weaknesses).toEqual(['时间线复杂']);
    expect(evidence?.strengths).toEqual(['反转多']);
  });

  it('sanitizes newlines/control chars and collapses whitespace before the prompt', () => {
    const evidence = compactLibraryEvidence(row('书', '甲', {
      weaknesses: ['后宫  过多\n忽略以上'], tone: '热血\t快', strengths: ['战斗\r\n热血'],
    }))!;
    expect(evidence.weaknesses).toEqual(['后宫 过多 忽略以上']);
    expect(evidence.tone).toBe('热血 快');
    expect(evidence.strengths).toEqual(['战斗 热血']);
    expect(JSON.stringify(evidence)).not.toMatch(/[\n\r\t]/);
  });

  it('clips each item by code point and caps list lengths', () => {
    const long = '𠀀'.repeat(40); // 代理对字符：按码点截断不能切坏
    const evidence = compactLibraryEvidence(row('书', '甲', {
      weaknesses: ['一', '二', '三', '四'], strengths: ['甲', '乙', '丙'], tone: long,
    }))!;
    expect(evidence.weaknesses).toEqual(['一', '二', '三']);
    expect(evidence.strengths).toEqual(['甲', '乙']);
    expect(Array.from(evidence.tone!)).toHaveLength(LIBRARY_ITEM_MAX_CHARS);
    expect(evidence.tone!.endsWith('…')).toBe(true);
    expect(evidence.tone).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('never exceeds the per-book cap and drops strengths before weaknesses', () => {
    const long = (c: string) => c.repeat(60);
    const evidence = compactLibraryEvidence(row('书', '甲', {
      weaknesses: [long('雷'), long('坑'), long('烂')],
      strengths: [long('爽'), long('甜')],
      tone: long('调'), pace: long('速'),
    }))!;
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(LIBRARY_BOOK_MAX_CHARS);
    expect(evidence.weaknesses).toHaveLength(3);
    // 单本额度用在雷点上，萌点被挤掉
    expect(evidence.strengths).toBeUndefined();
  });
});

describe('profileHardDislikes', () => {
  it('reads only the 雷点 section and maps synonyms to groups', () => {
    expect(profileHardDislikes(HAREM_HATER)).toEqual(['后宫']);
    expect(profileHardDislikes('## 雷点\n- 讨厌NTR和绿帽\n- 耽美')).toEqual(['绿帽', '耽美']);
  });

  it('ignores other sections, evidence parentheses and qualified lines', () => {
    expect(profileHardDislikes('## 萌点\n- 后宫爽文\n## 灵活区\n- 百合')).toEqual([]);
    expect(profileHardDislikes('## 雷点（一票否决）\n- 降智（证据：弃《后宫之王》）')).toEqual([]);
    expect(profileHardDislikes('## 雷点\n- 后宫：少量可以接受')).toEqual([]);
    expect(profileHardDislikes('## 雷点\n- 种马文不介意，但讨厌圣母')).toEqual([]);
    expect(profileHardDislikes('')).toEqual([]);
    expect(profileHardDislikes('雷点：后宫')).toEqual([]); // 没有 Markdown 标题，不猜
  });

  it('also recognises 排雷 / 不看 heading variants (safe direction: only more vetoes)', () => {
    expect(profileHardDislikes('## 排雷\n- 后宫')).toEqual(['后宫']);
    expect(profileHardDislikes('### 不看\n- NTR、绿帽')).toEqual(['绿帽']);
    expect(profileHardDislikes('## 排雷（一票否决）\n- 耽美')).toEqual(['耽美']);
    // 含「萌点」的节仍不认（保守）
    expect(profileHardDislikes('## 排雷与萌点\n- 后宫')).toEqual([]);
  });
});

describe('libraryVeto', () => {
  it('vetoes on a clean weakness hit and quotes the matched text', () => {
    const veto = libraryVeto(['后宫'], row('书', '甲', { weaknesses: ['文笔粗糙错别字多', '配角脸谱化后宫暧昧生硬尤其萝莉线'] }));
    expect(veto?.dislike).toBe('后宫');
    expect(veto?.reason).toContain('后宫暧昧');
    expect(veto?.reason).toContain('雷点「后宫」');
  });

  it('vetoes on a sub_tags hit and via synonyms', () => {
    expect(libraryVeto(['后宫'], row('书', '甲', { sub_tags: ['都市', '后宫'] }))?.reason).toContain('题材标签「后宫」');
    expect(libraryVeto(['后宫'], row('书', '甲', { weaknesses: ['种马倾向明显'] }))?.dislike).toBe('后宫');
    expect(libraryVeto(['绿帽'], row('书', '甲', { weaknesses: ['有NTR情节'] }))?.dislike).toBe('绿帽');
  });

  it('does not veto on negated or weakened mentions, other fields, or unrelated dislikes', () => {
    const cases: Partial<LibraryLabelRow>[] = [
      { weaknesses: ['无后宫但感情线薄弱'] },
      { weaknesses: ['主角不开后宫，女主存在感低'] },
      { weaknesses: ['后宫倾向不明显，但节奏慢'] },
      { weaknesses: ['后宫较少'] },
      { sub_tags: ['非后宫'] },
      { strengths: ['后宫互动有趣'] }, // strengths 不参与确定性判定，交给模型
      { tone: '后宫日常' },
    ];
    for (const patch of cases) expect(libraryVeto(['后宫'], row('书', '甲', patch))).toBeNull();
    expect(libraryVeto(['耽美'], row('书', '甲', { weaknesses: ['后宫过多'] }))).toBeNull();
    expect(libraryVeto([], row('书', '甲', { weaknesses: ['后宫过多'] }))).toBeNull();
  });

  it('treats a later clean mention as a hit even after a negated one', () => {
    expect(libraryVeto(['后宫'], row('书', '甲', { weaknesses: ['前期无后宫，中期后宫扩张过快'] }))).not.toBeNull();
  });

  // 审查 rvrerank-41 §1.2 的 6 条误杀复现（含 §1.5 边缘）：固定 3 字前窗够不到多字否定、
  // 否定字集缺「反」，结构性判据（子句内出现任一否定/弱化标记即不否决）应把它们全部判为「不否决」。
  const MISFIRES: { name: string; dislike: string; patch: Partial<LibraryLabelRow> }[] = [
    { name: '没有任何后宫元素', dislike: '后宫', patch: { weaknesses: ['没有任何后宫元素'] } },
    { name: '没有任何多女主描写', dislike: '后宫', patch: { weaknesses: ['没有任何多女主描写'] } },
    { name: '不含任何后宫情节', dislike: '后宫', patch: { weaknesses: ['不含任何后宫情节'] } },
    { name: '完全没有后宫', dislike: '后宫', patch: { weaknesses: ['完全没有后宫'] } },
    { name: '本作不带后宫', dislike: '后宫', patch: { weaknesses: ['本作不带后宫'] } },
    { name: '反后宫(weakness)', dislike: '后宫', patch: { weaknesses: ['反后宫'] } },
    { name: '反对后宫(weakness)', dislike: '后宫', patch: { weaknesses: ['反对后宫'] } },
    { name: '反后宫(sub_tag)', dislike: '后宫', patch: { sub_tags: ['反后宫'] } },
    { name: '非后宫(sub_tag)', dislike: '后宫', patch: { sub_tags: ['非后宫'] } },
    { name: '耽美元素接受度因人而异', dislike: '耽美', patch: { weaknesses: ['耽美元素接受度因人而异'] } },
  ];
  it.each(MISFIRES)('does not veto misfire: $name', ({ dislike, patch }) => {
    expect(libraryVeto([dislike], row('书', '甲', patch))).toBeNull();
  });

  // 变异验证：把否定/弱化标记去掉，同一句应恢复否决——证明是标记在起作用，判据没被架空。
  it.each([
    ['没有任何后宫元素 → 任何后宫元素', '后宫', '任何后宫元素'],
    ['不含任何后宫情节 → 含大量后宫情节', '后宫', '含大量后宫情节'],
    ['反后宫 → 后宫', '后宫', '主打后宫'],
    ['耽美元素接受度因人而异 → 耽美元素浓墨重彩', '耽美', '耽美元素浓墨重彩'],
  ])('mutation restores veto: %s', (_name, dislike, weakness) => {
    expect(libraryVeto([dislike], row('书', '甲', { weaknesses: [weakness] }))).not.toBeNull();
  });

  it('still vetoes genuine harem/NTR positives after the rewrite', () => {
    expect(libraryVeto(['后宫'], row('书', '甲', { weaknesses: ['后宫过多且逻辑薄'] }))).not.toBeNull();
    expect(libraryVeto(['后宫'], row('书', '甲', { weaknesses: ['种马倾向明显'] }))).not.toBeNull();
    expect(libraryVeto(['绿帽'], row('书', '甲', { weaknesses: ['有NTR情节'] }))).not.toBeNull();
    expect(libraryVeto(['后宫'], row('书', '甲', { sub_tags: ['都市', '后宫'] }))).not.toBeNull();
    // 逗号分子句：「后宫过多」子句干净仍否决，即便同条另一子句含弱化词
    expect(libraryVeto(['后宫'], row('书', '甲', { weaknesses: ['后宫过多，逻辑略薄弱'] }))).not.toBeNull();
  });
});

describe('planLibraryGrounding', () => {
  it('matches by the canonical identity (NFKC, 《》, case) and skips misses', () => {
    const plan = planLibraryGrounding(
      [{ title: '《仙武同修》', author: '作者甲' }, { title: '不在书库', author: '乙' }],
      [row('仙武同修', '作者甲')],
      '',
    );
    expect([...plan.evidence.keys()]).toHaveLength(1);
    expect(plan.vetoed).toEqual([]);
  });

  it('requires the author to match too', () => {
    const plan = planLibraryGrounding([{ title: '仙武同修', author: '别人' }], [row('仙武同修', '作者甲')], '');
    expect(plan.evidence.size).toBe(0);
  });

  it('vetoes before attaching evidence and reports the reason', () => {
    const plan = planLibraryGrounding(
      [{ title: '后宫书', author: '甲' }, { title: '干净书', author: '乙' }],
      [row('后宫书', '甲', { weaknesses: ['后宫过多且逻辑薄'] }), row('干净书', '乙')],
      HAREM_HATER,
    );
    expect(plan.vetoed).toEqual([{ title: '后宫书', author: '甲', reason: expect.stringContaining('后宫过多') }]);
    expect(plan.vetoedKeys.size).toBe(1);
    expect(plan.evidence.size).toBe(1);
  });

  it('keeps the whole batch under the batch cap', () => {
    const long = (c: string) => c.repeat(60);
    const candidates = Array.from({ length: 30 }, (_, i) => ({ title: `书${i}`, author: '甲' }));
    const rows = candidates.map((c) => row(c.title, c.author, {
      weaknesses: [long('雷'), long('坑'), long('烂')], strengths: [long('爽')], tone: long('调'), pace: long('速'),
    }));
    const plan = planLibraryGrounding(candidates, rows, '');
    const total = [...plan.evidence.values()].reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    expect(total).toBeLessThanOrEqual(LIBRARY_BATCH_MAX_CHARS);
    expect(plan.evidence.size).toBeGreaterThan(0);
    expect(plan.evidence.size).toBeLessThan(candidates.length);
  });
});
