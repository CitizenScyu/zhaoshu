// JS 沙箱单测（jsbox1027）：返回值口径、java.* 帮手、资源上限（超时/超内存/栈/预算）、未就绪失败。
// 只看沙箱自身行为；编译期白名单（parse.ts）与链式求值（evaluate.ts）各有自己的测试。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jsSandboxReady, preloadJsSandbox, runJs, MAX_JS_INPUT_CHARS } from './js-sandbox';
import { RuleEngineError } from './types';

const BASE = { baseUrl: 'https://example.com/a/b.html' };

function failure(code: string, bindings: Parameters<typeof runJs>[1] = { result: '', ...BASE }): RuleEngineError {
  try {
    runJs(code, bindings);
  } catch (error) {
    if (error instanceof RuleEngineError) return error;
    throw error;
  }
  throw new Error('预期求值失败，实际成功');
}

describe('js-sandbox: 未就绪', () => {
  it('模块未加载时求值直接 RULE_EVAL_FAILED，不会隐式加载', () => {
    expect(jsSandboxReady()).toBe(false);
    expect(failure('1+1').code).toBe('RULE_EVAL_FAILED');
    expect(jsSandboxReady()).toBe(false);
  });
});

describe('js-sandbox: 求值口径', () => {
  beforeAll(async () => {
    await preloadJsSandbox();
    expect(jsSandboxReady()).toBe(true);
  });

  it('字符串结果原样返回数字/布尔按 String', () => {
    expect(runJs('"abc"', { result: '', ...BASE })).toBe('abc');
    expect(runJs('1+1', { result: '', ...BASE })).toBe('2');
    expect(runJs('true', { result: '', ...BASE })).toBe('true');
  });

  it('undefined/null → null（legado 链中止口径）', () => {
    expect(runJs('undefined', { result: '', ...BASE })).toBeNull();
    expect(runJs('void 0', { result: '', ...BASE })).toBeNull();
    expect(runJs('null', { result: '', ...BASE })).toBeNull();
    expect(runJs('result.match(/zzz/)', { result: 'abc', ...BASE })).toBeNull();
  });

  it('数组结果逐项转字符串（null/undefined 项为空串）', () => {
    expect(runJs('["a", 1, null]', { result: '', ...BASE })).toEqual(['a', '1', '']);
    expect(runJs('result.split("\\n")', { result: 'a\nb', ...BASE })).toEqual(['a', 'b']);
  });

  it('result/src/baseUrl 注入：src 是页面原文，baseUrl 是当前页地址', () => {
    expect(runJs('result + "|" + src.length', { result: 'x', src: '<p>123</p>', ...BASE })).toBe('x|10');
    expect(runJs('baseUrl', { result: '', ...BASE })).toBe('https://example.com/a/b.html');
    expect(runJs('typeof src', { result: '', ...BASE })).toBe('undefined');
  });

  it('列表 result 带 legado NativeJavaList 的 size()/get()', () => {
    expect(runJs('[result.size(), result.get(1)]', { result: ['a', 'b'], ...BASE })).toEqual(['2', 'b']);
  });
});

describe('js-sandbox: java.* 帮手', () => {
  beforeAll(async () => { await preloadJsSandbox(); });

  it('base64 编解码往返；md5Encode16 取 hex 的 8–24 位', () => {
    expect(runJs('java.base64Encode("中文")', { result: '', ...BASE })).toBe(Buffer.from('中文', 'utf8').toString('base64'));
    expect(runJs('java.base64Decode(java.base64Encode("中文"))', { result: '', ...BASE })).toBe('中文');
    expect(runJs('java.md5Encode("abc")', { result: '', ...BASE })).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(runJs('java.md5Encode16("abc")', { result: '', ...BASE })).toBe('3cd24fb0d6963f7d');
  });

  it('encodeURI 是 URLEncoder 语义：空格 → +，保留 -_.*', () => {
    expect(runJs('java.encodeURI("a b-_.*中")', { result: '', ...BASE })).toBe('a+b-_.*%E4%B8%AD');
  });

  it('gbkjs1029：cjkEncodeUri 才按 GBK 系编码；表外字符致命（try/catch 吞不掉）；缺省逐字不变', () => {
    expect(runJs('java.encodeURI("书 a","GBK")', { result: '', ...BASE, cjkEncodeUri: true })).toBe('%CA%E9+a');
    expect(runJs('java.encodeURI("书")', { result: '', ...BASE, cjkEncodeUri: true })).toBe('%E4%B9%A6');
    expect(runJs('java.encodeURI("书","utf-8")', { result: '', ...BASE, cjkEncodeUri: true })).toBe('%E4%B9%A6');
    expect(failure('java.encodeURI("书","gbk")').message).toContain('只支持 UTF-8');
    expect(failure('java.encodeURI("书","big5")', { result: '', ...BASE, cjkEncodeUri: true }).message).toContain('只支持 UTF-8');
    expect(failure('try { java.encodeURI("·","gbk") } catch (e) { "x" }', { result: '', ...BASE, cjkEncodeUri: true }).message)
      .toContain('JS 宿主回调失败');
  });

  it('hexDecodeToString 按字节解', () => {
    expect(runJs('java.hexDecodeToString("e4b8ad")', { result: '', ...BASE })).toBe('中');
  });

  it('非 UTF-8 charset 拒绝', () => {
    expect(failure('java.base64Decode("YQ==", "GBK")').code).toBe('RULE_EVAL_FAILED');
  });

  it('java 对象冻结：改不掉帮手', () => {
    // 沙箱代码按非严格模式执行，赋值静默失败；验证的是「原帮手仍在且行为不变」。
    expect(runJs('java.base64Encode = null; java.base64Encode("a")', { result: '', ...BASE })).toBe('YQ==');
    expect(runJs('delete java.base64Encode; java.base64Encode("a")', { result: '', ...BASE })).toBe('YQ==');
  });
});

describe('js-sandbox: 资源上限', () => {
  beforeAll(async () => { await preloadJsSandbox(); });

  it('死循环按 250ms 中断', () => {
    const started = Date.now();
    const error = failure('while (true) {}');
    const elapsed = Date.now() - started;
    expect(error.code).toBe('RULE_EVAL_FAILED');
    expect(elapsed).toBeLessThan(3000);
  });

  it('正则灾难回溯同样被中断（QuickJS 在正则执行中也会调 interrupt handler）', () => {
    const started = Date.now();
    expect(failure('"a".repeat(30).match(/(a+)+b/)').code).toBe('RULE_EVAL_FAILED');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('超内存（16MB）报 out of memory，之后模块仍可用', () => {
    const error = failure('var a = []; for (;;) a.push("x".repeat(10000))');
    expect(error.code).toBe('RULE_EVAL_FAILED');
    expect(runJs('"still ok"', { result: '', ...BASE })).toBe('still ok');
  });

  it('深递归报 stack overflow', () => {
    expect(failure('function f(n){ return f(n+1) } f(0)').code).toBe('RULE_EVAL_FAILED');
  });

  it('输入超过上限直接失败，不进沙箱', () => {
    expect(failure('result', { result: 'x'.repeat(MAX_JS_INPUT_CHARS + 1), ...BASE }).code).toBe('RULE_EVAL_FAILED');
  });

  it('首段 result 与 src 同一串只计一次：上限内的整页可以进沙箱', () => {
    const page = 'x'.repeat(MAX_JS_INPUT_CHARS);
    expect(runJs('src.length', { result: page, src: page, ...BASE })).toBe(String(MAX_JS_INPUT_CHARS));
  });

  it('快调用只占免计账额度：8000 次（全额计账会超 3s 代码预算）全部成功', () => {
    for (let i = 0; i < 8000; i += 1) {
      expect(runJs('result.trim() // fast-budget', { result: ` 第${i}章 `, ...BASE })).toBe(`第${i}章`);
    }
  }, 60_000);

  it('死循环耗尽该段代码的预算后直接失败，不再进沙箱等 250ms', () => {
    const code = 'while (true) {} // budget-loop';
    for (let i = 0; i < 14; i += 1) failure(code);
    const started = Date.now();
    expect(failure(code).message).toContain('预算耗尽');
    expect(Date.now() - started).toBeLessThan(50);
  }, 30_000);
});

describe('js-sandbox: 无宿主能力', () => {
  beforeAll(async () => { await preloadJsSandbox(); });

  it.each([
    'typeof fetch',
    'typeof require',
    'typeof XMLHttpRequest',
    'typeof setTimeout',
    'typeof WebAssembly',
  ])('%s 不存在', (code) => {
    expect(runJs(code, { result: '', ...BASE })).toBe('undefined');
  });
});

afterAll(() => {
  // 清理：沙箱模块是模块级单例，同文件内共享；无需额外释放（每个 runtime 在 runJs 内已 dispose）。
});
