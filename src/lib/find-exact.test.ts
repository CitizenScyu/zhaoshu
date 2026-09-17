import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXACT_STATE,
  EXACT_DOUBAN_MISS_NOTE,
  EXACT_UNAVAILABLE_NOTE,
  canSubmitExact,
  exactEmptyMessage,
  exactFallbackQuery,
  exactReducer,
  exactResultNote,
  initialShelfPhase,
  parseExactResponse,
  shelfButtonLabel,
  shelfOutcome,
  showExactEmpty,
  tasteFallbackQuery,
  toggleMode,
  type ExactState,
} from './find-exact';

const libraryResult = { source: 'library' as const, items: [{ title: '诡秘之主', author: '爱潜水的乌贼', source: 'library' as const }] };

describe('模式切换', () => {
  it('toggles between taste and exact', () => {
    expect(toggleMode('taste')).toBe('exact');
    expect(toggleMode('exact')).toBe('taste');
  });
});

describe('精确找书状态机', () => {
  it('starts idle with nothing to show', () => {
    expect(EMPTY_EXACT_STATE).toEqual({ phase: 'idle', title: '', result: null, error: '' });
    expect(showExactEmpty(EMPTY_EXACT_STATE)).toBe(false);
  });

  // 判别力：submit 若保留上一次的 result，加载中会继续显示旧书，用户以为新搜索秒回且结果没变。
  it('drops the previous result when a new search starts', () => {
    const settled = exactReducer(EMPTY_EXACT_STATE, { type: 'settle', result: libraryResult });
    expect(settled.phase).toBe('done');
    expect(exactReducer(settled, { type: 'submit', title: '同名书' }))
      .toEqual({ phase: 'searching', title: '同名书', result: null, error: '' });
  });

  it('clears a previous error when a new search starts', () => {
    const failed = exactReducer(EMPTY_EXACT_STATE, { type: 'fail', message: '网络错误' });
    expect(failed.phase).toBe('error');
    expect(exactReducer(failed, { type: 'submit', title: '书' }).error).toBe('');
  });

  // 结果帧不带书名：提交时的书名必须一路带到终态，否则「换口味推荐」的出路句会拿不到它。
  it('keeps the submitted title through settle and failure', () => {
    const searched = exactReducer(EMPTY_EXACT_STATE, { type: 'submit', title: '某本网文' });
    expect(exactReducer(searched, { type: 'settle', result: { source: 'none', items: [] } }).title).toBe('某本网文');
    expect(exactReducer(searched, { type: 'fail', message: 'x' }).title).toBe('某本网文');
  });

  it('settles empty results as done, not as an error', () => {
    const done = exactReducer(EMPTY_EXACT_STATE, { type: 'settle', result: { source: 'none', items: [] } });
    expect(done.phase).toBe('done');
    expect(showExactEmpty(done)).toBe(true);
  });

  it('only offers the empty hint once a search actually finished', () => {
    const searching: ExactState = { phase: 'searching', title: '书', result: null, error: '' };
    expect(showExactEmpty(searching)).toBe(false);
    expect(showExactEmpty({ phase: 'done', title: '书', result: { source: 'none', items: [] }, error: '' })).toBe(true);
    expect(showExactEmpty({ phase: 'error', title: '书', result: null, error: 'x' })).toBe(false);
  });
});

describe('搜索按钮可用性', () => {
  it('blocks empty titles and re-entry while searching', () => {
    expect(canSubmitExact('idle', '诡秘之主')).toBe(true);
    expect(canSubmitExact('idle', '   ')).toBe(false);
    expect(canSubmitExact('idle', '')).toBe(false);
    expect(canSubmitExact('searching', '诡秘之主')).toBe(false);
    expect(canSubmitExact('done', '诡秘之主')).toBe(true);
    expect(canSubmitExact('error', '诡秘之主')).toBe(true);
  });
});

describe('文案选择', () => {
  it('lets the server note win, falling back per source', () => {
    expect(exactResultNote({ source: 'none', items: [], note: '服务端说明' })).toBe('服务端说明');
    expect(exactResultNote({ source: 'library', items: [] })).toContain('本地书库');
    expect(exactResultNote({ source: 'douban', items: [] })).toContain('同名书');
  });

  // 🔴 核心区分：豆瓣没查成 ≠ 没有这本书。这两条文案绝不能合并成一句。
  it('never reports an unreachable douban as "the book does not exist"', () => {
    const unavailable = exactEmptyMessage({ source: 'none', items: [], unavailable: true });
    expect(unavailable).toBe(EXACT_UNAVAILABLE_NOTE);
    expect(unavailable).toContain('不代表书不存在');
    const missing = exactEmptyMessage({ source: 'none', items: [] });
    expect(missing).toBe(EXACT_DOUBAN_MISS_NOTE);
    expect(missing).toContain('未出版');
    expect(unavailable).not.toBe(missing);
  });
});

describe('响应解析', () => {
  it('treats a non-object payload as unreachable rather than as an empty library', () => {
    for (const payload of [null, undefined, 42, 'oops', []]) {
      expect(parseExactResponse(payload)).toEqual({
        source: 'none', items: [], unavailable: true, note: EXACT_UNAVAILABLE_NOTE,
      });
    }
  });

  it('drops malformed items and normalizes ratings', () => {
    const parsed = parseExactResponse({
      source: 'douban',
      items: [
        { title: '  同名书  ', author: '作者甲', source: 'douban', rating: 8.5, ratingCount: 10 },
        { title: '', author: '无题' },
        { author: '没有标题' },
        'not-an-object',
        { title: '无评分', rating: '8.5', ratingCount: 1.5 },
      ],
    });
    expect(parsed.items).toEqual([
      { title: '同名书', author: '作者甲', source: 'douban', rating: 8.5, ratingCount: 10 },
      { title: '无评分', author: '', source: 'douban', rating: null, ratingCount: null },
    ]);
  });

  it('infers the source when the server omits or misspells it', () => {
    expect(parseExactResponse({ source: 'weird', items: [{ title: '书' }] }).source).toBe('douban');
    expect(parseExactResponse({ source: 'weird', items: [] }).source).toBe('none');
    expect(parseExactResponse({ source: 'library', items: [{ title: '书', source: 'library' }] }).source).toBe('library');
  });
});

describe('口味推荐的出路', () => {
  // 裸书名喂给 recall 会被理解成「我喜欢这本」而召回相似书——那正是本模式要避开的；
  // 出路句必须显式写成「类似《X》的书」，用户才知道自己在问什么。
  it('wraps the bare title into an explicit taste query', () => {
    expect(tasteFallbackQuery('  诡秘之主 ')).toBe('类似《诡秘之主》的书');
  });

  it('offers the fallback only for a title that was actually searched', () => {
    expect(exactFallbackQuery(EMPTY_EXACT_STATE)).toBeNull();
    expect(exactFallbackQuery({ ...EMPTY_EXACT_STATE, title: '   ' })).toBeNull();
    expect(exactFallbackQuery({ ...EMPTY_EXACT_STATE, title: '某本网文' })).toBe('类似《某本网文》的书');
  });
});

describe('加入书架', () => {
  it('treats 409 ALREADY_ON_SHELF as success, not as a failure', () => {
    expect(shelfOutcome(200)).toBe('saved');
    expect(shelfOutcome(409)).toBe('saved');
    expect(shelfOutcome(401)).toBe('error');
    expect(shelfOutcome(500)).toBe('error');
  });

  it('labels the button per phase', () => {
    expect(shelfButtonLabel('idle')).toBe('加入书架');
    expect(shelfButtonLabel('saving')).toBe('加入中…');
    expect(shelfButtonLabel('saved')).toBe('✓ 已在书架');
    expect(shelfButtonLabel('error')).toBe('加入书架');
  });

  it('starts already-saved for a library hit that is on the shelf', () => {
    expect(initialShelfPhase(true)).toBe('saved');
    expect(initialShelfPhase(false)).toBe('idle');
    expect(initialShelfPhase(undefined)).toBe('idle');
  });
});
