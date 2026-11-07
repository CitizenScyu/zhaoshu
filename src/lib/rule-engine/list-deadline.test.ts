// listdeadline1107（ENGINE_JS_LIST_DEADLINE_MS）：列表 JS 按开关放宽中断时限，其余 JS 照旧 250ms；死循环照旧被中断。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { preloadJsSandbox, runJs, runJsItems, runJsoupItems } from './js-sandbox';
import { engineJsListDeadlineMs } from './syntax-flags';
import { RuleEngineError } from './types';

const BASE = { result: '', baseUrl: 'https://example.com/book/1/' };
// 沙箱里按墙钟忙等，越不越过时限与机器负载无关；tag 让每段代码各记各的预算。
const busy = (ms: number, tag: string) => `var t = Date.now(); while (Date.now() - t < ${ms}) {} ['a'] // ${tag}`;

function failure(fn: () => unknown): RuleEngineError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RuleEngineError) return error;
    throw error;
  }
  throw new Error('预期求值失败，实际成功');
}

beforeAll(async () => { await preloadJsSandbox(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('engineJsListDeadlineMs', () => {
  it('缺省/空/非数字/负数为 0，取整，上限 5000', () => {
    expect(engineJsListDeadlineMs({})).toBe(0);
    for (const raw of ['', 'on', '-5']) expect(engineJsListDeadlineMs({ ENGINE_JS_LIST_DEADLINE_MS: raw })).toBe(0);
    expect(engineJsListDeadlineMs({ ENGINE_JS_LIST_DEADLINE_MS: ' 3000 ' })).toBe(3000);
    expect(engineJsListDeadlineMs({ ENGINE_JS_LIST_DEADLINE_MS: '1500.7' })).toBe(1500);
    expect(engineJsListDeadlineMs({ ENGINE_JS_LIST_DEADLINE_MS: '99999' })).toBe(5000);
  });
});

describe('列表 JS 时限', () => {
  it('关：列表 JS 照旧 250ms 中断', () => {
    expect(failure(() => runJsItems(busy(400, 'off'), BASE)).message).toContain('interrupted');
  });

  it.each(['0', '1'])('开（ENGINE_JS_PRELUDE_GRACE=%s）：列表 JS 与 jsoup 列表 JS 放宽，其余 JS 照旧 250ms', (grace) => {
    vi.stubEnv('ENGINE_JS_PRELUDE_GRACE', grace);
    vi.stubEnv('ENGINE_JS_LIST_DEADLINE_MS', '3000');
    expect(runJsItems(busy(400, `items-${grace}`), BASE)).toEqual(['a']);
    expect(runJsoupItems(busy(400, `jsoup-${grace}`), BASE)).toEqual(['a']);
    expect(failure(() => runJs(busy(400, `scalar-${grace}`), BASE)).message).toContain('interrupted');
  });

  it('开：死循环照旧在开关时限内被中断', () => {
    vi.stubEnv('ENGINE_JS_LIST_DEADLINE_MS', '600');
    const started = Date.now();
    expect(failure(() => runJsItems('while (true) {} // list-loop', BASE)).message).toContain('interrupted');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(3000);
  });
});
