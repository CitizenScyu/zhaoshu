// jsutil1028：ENGINE_SYNTAX_JS_UTIL —— JS 里放行 legado `java.createSymmetricCrypto(...)` 与 aes/des/tripleDES 旧包装、
// `java.toNumChapter`；语义版本位、按源判定、沙箱口径（宿主失败致命）与 source-usability 缓存口径。
// 密钥/明文均为合成值；期望密文用 node:crypto 直接算（不经 js-util），DES 的 K‖K‖K 等价用公开测试向量核对。
import { createCipheriv } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSource, engineSourceRevision, sourceUsesJsUtilSyntax } from './compile';
import { createScope, evaluateField, normalizeBody } from './evaluate';
import { preloadJsSandbox, runJs, type JsBindings } from './js-sandbox';
import { stringToInt, symmetricCrypt, toNumChapter } from './js-util';
import { parseFieldRule, type ParseOptions } from './parse';
import { ENGINE_SEMANTICS_JS_UTIL_BIT, engineSemanticsVersion, engineSyntaxJsUtilEnabled } from './syntax-flags';
import { RuleEngineError, type FieldIr } from './types';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RuleEngineError ? err.diagnostic?.code ?? err.code : `non-engine:${String(err)}`;
  }
};
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const SITE = 'https://book15.net';
const PAGE_URL = `${SITE}/p/1.html`;
const ON = { jsEnabled: true, jsUtilEnabled: true } as const;
const OFF = { jsEnabled: true, jsUtilEnabled: false } as const;
const on = (rule: string, field: string, extra: ParseOptions = {}) => parseFieldRule(rule, { ...ON, ...extra, field });
const off = (rule: string, field: string) => parseFieldRule(rule, { ...OFF, field });
const value = (field: FieldIr, text: string) => evaluateField(field, createScope(normalizeBody(text), PAGE_URL));
const raw = (rules: Record<string, unknown>) => ({ url: SITE, searchUrl: `${SITE}/s?q={{key}}`, rules });
const NAME = 'ruleBookInfo.name';
const CONTENT = 'ruleContent.content';

const KEY16 = '0123456789abcdef';
const IV16 = 'fedcba9876543210';
const KEY24 = 'abcdefghijklmnopqrstuvwx';
const IV8 = '12345678';
const PLAIN = '第一章 正文 synthetic';

/** 期望密文：node:crypto 直接算。 */
const enc = (cipher: string, key: string | Buffer, iv: string | null, plain: Buffer, autoPadding = true): Buffer => {
  const c = createCipheriv(cipher, typeof key === 'string' ? Buffer.from(key) : key, iv === null ? null : Buffer.from(iv));
  c.setAutoPadding(autoPadding);
  return Buffer.concat([c.update(plain), c.final()]);
};

const bindings = (result: string, util = true): JsBindings => ({ result, src: result, baseUrl: PAGE_URL, utilHelpers: util || undefined });
const js = (code: string, result = '', util = true) => runJs(code, bindings(result, util));

describe('开关与语义版本', () => {
  it('engineSyntaxJsUtilEnabled 严格口径', () => {
    expect(engineSyntaxJsUtilEnabled({})).toBe(false);
    expect(engineSyntaxJsUtilEnabled({ ENGINE_SYNTAX_JS_UTIL: '0' })).toBe(false);
    expect(engineSyntaxJsUtilEnabled({ ENGINE_SYNTAX_JS_UTIL: 'yes' })).toBe(false);
    expect(engineSyntaxJsUtilEnabled({ ENGINE_SYNTAX_JS_UTIL: ' On ' })).toBe(true);
    expect(engineSyntaxJsUtilEnabled({ ENGINE_SYNTAX_JS_UTIL: 'TRUE' })).toBe(true);
    expect(engineSyntaxJsUtilEnabled({ ENGINE_SYNTAX_JS_UTIL: '1' })).toBe(true);
  });

  it('帮手位 +8192，1–8192 逐字不变', () => {
    expect(ENGINE_SEMANTICS_JS_UTIL_BIT).toBe(8192);
    const all = [true, true, true, true, true, true, true, true, true, true, true, true, true] as const;
    const base = engineSemanticsVersion(...all);
    expect(engineSemanticsVersion(...all, false)).toBe(base);
    expect(engineSemanticsVersion(...all, true)).toBe(base + 8192);
    expect(engineSemanticsVersion(false, false, false, false, false, false, false, false, false, false, false, false, false, true))
      .toBe(engineSemanticsVersion(false) + 8192);
  });

  it('按源判定：只有 off 拒、on 过的字段所在源换版本', () => {
    const opts = (jsUtilEnabled: boolean, jsEnabled = true) => ({
      orEnabled: false, xpathEnabled: false, varsEnabled: false, jsEnabled, xpathEvalEnabled: false, regexEnabled: false,
      andEnabled: false, aioEnabled: false, searchJsEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false,
      jsGetEnabled: false, jsUtilEnabled,
    });
    const crypto = raw({ ruleContent: { content: `#c@text@js:java.createSymmetricCrypto("AES/CBC/PKCS5Padding", "${KEY16}", "${IV16}").decryptStr(result)` } });
    const legacy = raw({ ruleContent: { content: `#c@text@js:java.aesBase64DecodeToString(result, "${KEY16}", "AES/ECB/PKCS5Padding", "")` } });
    const chapter = raw({ ruleToc: { chapterName: 'a@text@js:java.toNumChapter(result)' } });
    const plainJs = raw({ ruleContent: { content: '#c@html@js:result.trim()' } });
    const inString = raw({ ruleBookInfo: { name: '#t@text@js:result + "java.toNumChapter(x)"' } });
    const inComment = raw({ ruleBookInfo: { name: '#t@text@js:result // java.toNumChapter(result)' } });
    const bothReject = raw({ ruleBookInfo: { name: '@js:java.toNumChapter("x") + java.ajax("x")' } });
    const withLib = raw({ ...chapter.rules, jsLib: 'function f(){}' });
    for (const s of [plainJs, inString, inComment, bothReject, withLib]) {
      expect(engineSourceRevision(s, opts(true))).toBe(engineSourceRevision(s, opts(false)));
    }
    for (const s of [crypto, legacy, chapter]) {
      expect(engineSourceRevision(s, opts(true))).not.toBe(engineSourceRevision(s, opts(false)));
      expect(engineSourceRevision(s, opts(true, false))).toBe(engineSourceRevision(s, opts(false, false)));
    }
    const flags = {
      orEnabled: false, varsEnabled: false, xpathEnabled: false, xpathEvalEnabled: false, regexEnabled: false, andEnabled: false,
      aioEnabled: false, listJsEnabled: false, jsExtEnabled: false, jsBindEnabled: false, jsGetEnabled: false,
    };
    for (const s of [crypto, legacy, chapter]) expect(sourceUsesJsUtilSyntax(s.rules, flags)).toBe(true);
    for (const s of [plainJs, inString, inComment, bothReject, withLib]) expect(sourceUsesJsUtilSyntax(s.rules, flags)).toBe(false);
  });

  it('compileSource：off 态照旧 skipped，on 态编译；两态缓存互不污染', () => {
    const rules = { ruleContent: { content: '#c@text@js:java.toNumChapter(result)' } };
    const compiled = (jsUtilEnabled: boolean) => compileSource(raw(rules), { jsEnabled: true, jsUtilEnabled }).get(CONTENT);
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
    expect(compiled(true)).not.toHaveProperty('skipped');
    expect(compiled(false)).toEqual({ skipped: 'unsupported' });
  });
});

describe('parse', () => {
  it('off 或 JS 关照旧拒；on 标 jsUtil，不用帮手的字段不标', () => {
    expect(codeOf(() => off('@js:java.toNumChapter(result)', NAME))).toBe('unsupported_js');
    expect(codeOf(() => parseFieldRule('@js:java.toNumChapter(result)', { jsEnabled: false, jsUtilEnabled: true, field: NAME })))
      .toBeDefined();
    expect(on('@js:java.toNumChapter(result)', NAME).jsUtil).toBe(true);
    expect(on('#t@text@js:result.trim()', NAME).jsUtil).toBeUndefined();
    expect(on('#t@text@js:java.base64Decode(result)', NAME).jsUtil).toBeUndefined();
  });

  it('名单外与计算成员照旧拒；列表 JS 自 listutil1029 起同收（见 listutil.test.ts）', () => {
    expect(codeOf(() => on('@js:java.createAsymmetricCrypto("RSA")', NAME))).toBe('unsupported_js');
    expect(codeOf(() => on('@js:java["toNumChapter"](result)', NAME))).toBe('unsupported_js');
    expect(on('@js:java.toNumChapter(result)', 'ruleSearch.bookList', { listJsEnabled: true }).jsUtil).toBe(true);
    expect(codeOf(() => on('@js:java.toNumChapter(result)', 'ruleSearch.bookList', { listJsEnabled: true, jsUtilEnabled: false })))
      .toBe('unsupported_js');
  });
});

describe('js-util：对称加解密', () => {
  const plain = Buffer.from(PLAIN);

  it('AES-CBC/ECB PKCS5：与 node:crypto 一致，hex/base64 两种密文都解', () => {
    const cbc = enc('aes-128-cbc', KEY16, IV16, plain);
    expect(symmetricCrypt('encryptBase64', 'AES/CBC/PKCS5Padding', KEY16, IV16, PLAIN)).toBe(cbc.toString('base64'));
    expect(symmetricCrypt('encryptHex', 'AES/CBC/PKCS7Padding', KEY16, IV16, PLAIN)).toBe(cbc.toString('hex'));
    expect(symmetricCrypt('decryptStr', 'AES/CBC/PKCS5Padding', KEY16, IV16, cbc.toString('base64'))).toBe(PLAIN);
    expect(symmetricCrypt('decryptStr', 'AES/CBC/PKCS5Padding', KEY16, IV16, cbc.toString('hex').toUpperCase())).toBe(PLAIN);
    const ecb = enc('aes-256-ecb', KEY16 + KEY16, null, plain);
    expect(symmetricCrypt('encryptBase64', 'AES', KEY16 + KEY16, '', PLAIN)).toBe(ecb.toString('base64'));
    expect(symmetricCrypt('decryptStr', 'AES/ECB/PKCS5Padding', KEY16 + KEY16, '', ecb.toString('base64'))).toBe(PLAIN);
    // 模式大小写不敏感（JCE），算法名大小写原样
    expect(symmetricCrypt('encryptHex', 'AES/cbc/pkcs5padding', KEY16, IV16, PLAIN)).toBe(cbc.toString('hex'));
    expect(throws(() => symmetricCrypt('check', 'aes/CBC/PKCS5Padding', KEY16, IV16, ''))).toBe(true);
  });

  it('base64 口径：URL 安全字母表与省略填充可解，非规范形态失败', () => {
    const ecb = enc('aes-128-ecb', KEY16, null, Buffer.from('x'.repeat(40)));
    const b64 = ecb.toString('base64');
    const url = ecb.toString('base64url');
    expect(symmetricCrypt('decryptStr', 'AES', KEY16, '', url)).toBe('x'.repeat(40));
    expect(symmetricCrypt('decryptStr', 'AES', KEY16, '', b64.replace(/=+$/, ''))).toBe('x'.repeat(40));
    for (const bad of [`${b64}=`, `${b64.slice(0, -3)}`, ` ${b64}`, `${b64.slice(0, 8)}\n${b64.slice(8)}`, '=', 'abc$']) {
      expect(throws(() => symmetricCrypt('decryptStr', 'AES', KEY16, '', bad))).toBe(true);
    }
    // 全 hex 字符按 hex：空串、奇数长失败
    expect(throws(() => symmetricCrypt('decryptStr', 'AES', KEY16, '', ''))).toBe(true);
    expect(throws(() => symmetricCrypt('decryptStr', 'AES', KEY16, '', ecb.toString('hex').slice(1)))).toBe(true);
  });

  it('ZeroPadding / NoPadding', () => {
    const zeroPadded = Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16))]);
    const zero = enc('aes-128-cbc', KEY16, IV16, zeroPadded, false);
    expect(symmetricCrypt('encryptBase64', 'AES/CBC/ZeroPadding', KEY16, IV16, PLAIN)).toBe(zero.toString('base64'));
    expect(symmetricCrypt('decryptStr', 'AES/CBC/ZeroPadding', KEY16, IV16, zero.toString('base64'))).toBe(PLAIN);
    // hutool 的 ZeroPadding 替换大小写敏感：别的写法当成 JCE 不认的填充
    expect(throws(() => symmetricCrypt('check', 'AES/CBC/zeropadding', KEY16, IV16, ''))).toBe(true);
    const block = 'b'.repeat(32);
    const none = enc('aes-128-ecb', KEY16, null, Buffer.from(block), false);
    expect(symmetricCrypt('encryptHex', 'AES/ECB/NoPadding', KEY16, '', block)).toBe(none.toString('hex'));
    expect(symmetricCrypt('decryptStr', 'AES/ECB/NoPadding', KEY16, '', none.toString('hex'))).toBe(block);
    expect(throws(() => symmetricCrypt('encryptHex', 'AES/ECB/NoPadding', KEY16, '', 'short'))).toBe(true);
  });

  it('DES 用 K‖K‖K 的 3DES 等价：公开向量核对，取密钥前 8 字节', () => {
    // 经典 DES 向量：K=133457799BBCDFF1, P=0123456789ABCDEF → C=85E813540F0AB405
    const k = Buffer.from('133457799BBCDFF1', 'hex');
    expect(enc('des-ede3', Buffer.concat([k, k, k]), null, Buffer.from('0123456789ABCDEF', 'hex'), false).toString('hex'))
      .toBe('85e813540f0ab405');
    const des = enc('des-ede3-cbc', Buffer.from(KEY24.slice(0, 8).repeat(3)), IV8, plain);
    expect(symmetricCrypt('encryptBase64', 'DES/CBC/PKCS5Padding', KEY24, IV8, PLAIN)).toBe(des.toString('base64'));
    expect(symmetricCrypt('decryptStr', 'DES/CBC/PKCS5Padding', KEY24.slice(0, 8), IV8, des.toString('base64'))).toBe(PLAIN);
    const ede = enc('des-ede3', KEY24, null, plain);
    expect(symmetricCrypt('encryptHex', 'DESede/ECB/PKCS5Padding', `${KEY24}tail`, '', PLAIN)).toBe(ede.toString('hex'));
    expect(symmetricCrypt('decryptStr', 'DESede', KEY24, '', ede.toString('hex'))).toBe(PLAIN);
  });

  it('规格失败：CBC 缺 IV、ECB 带 IV、IV/密钥长度不对、算法与模式不认', () => {
    const check = (t: string, key: string, iv: string) => throws(() => symmetricCrypt('check', t, key, iv, ''));
    expect(check('AES/CBC/PKCS5Padding', KEY16, '')).toBe(true);
    expect(check('AES/ECB/PKCS5Padding', KEY16, IV16)).toBe(true);
    expect(check('AES/CBC/PKCS5Padding', KEY16, IV8)).toBe(true);
    expect(check('AES', 'short', '')).toBe(true);
    expect(check('DES', '1234567', '')).toBe(true);
    expect(check('DESede', KEY16, '')).toBe(true);
    expect(check('AES/GCM/NoPadding', KEY16, IV16)).toBe(true);
    expect(check('AES/CBC', KEY16, IV16)).toBe(true);
    expect(check('Blowfish', KEY16, '')).toBe(true);
    expect(check('AES/CBC/PKCS5Padding', KEY16, IV16)).toBe(false);
  });

  it('明文口径：非 UTF-8 解密结果失败，孤立代理项失败', () => {
    const bin = enc('aes-128-ecb', KEY16, null, Buffer.from([0xff, 0xfe, 0x41]));
    expect(throws(() => symmetricCrypt('decryptStr', 'AES', KEY16, '', bin.toString('base64')))).toBe(true);
    const lone = `a${String.fromCharCode(0xd800)}b`;
    expect(throws(() => symmetricCrypt('encryptHex', 'AES', KEY16, '', lone))).toBe(true);
    expect(throws(() => symmetricCrypt('check', 'AES', `${KEY16.slice(0, 15)}${String.fromCharCode(0xdc00)}`, '', ''))).toBe(true);
  });
});

describe('js-util：toNumChapter', () => {
  it('中文数字、阿拉伯数字、全角与空白', () => {
    expect(toNumChapter('第一千零二十五章 大结局')).toBe('第1025章');
    expect(toNumChapter('第十章')).toBe('第10章');
    expect(toNumChapter('第二百五章')).toBe('第250章');
    expect(toNumChapter('第三万五千章')).toBe('第35000章');
    expect(toNumChapter('第两百章')).toBe('第200章');
    expect(toNumChapter('第 12 章')).toBe('第12章');
    expect(toNumChapter('第１２章')).toBe('第12章');
    expect(toNumChapter('前言 第+5章 后记')).toBe('第5章');
  });

  it('未知字符 -1、超 Int 范围按中文数字（-1）、亿位 Int 回绕', () => {
    expect(toNumChapter('第abc章')).toBe('第-1章');
    expect(toNumChapter('第2147483648章')).toBe('第-1章');
    expect(toNumChapter('第2147483647章')).toBe('第2147483647章');
    expect(toNumChapter('第十亿亿章')).toBe('第1569325056章');
  });

  it('无匹配原样；`.` 不跨 Java 行终止符', () => {
    expect(toNumChapter('序章')).toBe('序章');
    expect(toNumChapter('第一\n二章')).toBe('第一\n二章');
    expect(toNumChapter(`第一${String.fromCharCode(0x85)}二章`)).toBe(`第一${String.fromCharCode(0x85)}二章`);
    expect(toNumChapter('第一\n第二章')).toBe('第2章');
  });

  it('非 ASCII 数字不复现', () => {
    expect(throws(() => stringToInt(String.fromCharCode(0x661, 0x662)))).toBe(true);
    expect(throws(() => toNumChapter(`第${String.fromCharCode(0x661, 0x662)}章`))).toBe(true);
  });
});

describe('沙箱', () => {
  const crypt = (args: string) => `java.createSymmetricCrypto(${args})`;
  const cbcB64 = enc('aes-128-cbc', KEY16, IV16, Buffer.from(PLAIN)).toString('base64');

  it('createSymmetricCrypto：三种方法、iv 可省或 null', async () => {
    await preloadJsSandbox();
    expect(js(`${crypt(`"AES/CBC/PKCS5Padding", "${KEY16}", "${IV16}"`)}.decryptStr(result)`, cbcB64)).toBe(PLAIN);
    const ecbHex = enc('aes-128-ecb', KEY16, null, Buffer.from(PLAIN)).toString('hex');
    expect(js(`${crypt(`"AES", "${KEY16}"`)}.encryptHex(result)`, PLAIN)).toBe(ecbHex);
    expect(js(`${crypt(`"AES", "${KEY16}", null`)}.decryptStr(result)`, ecbHex)).toBe(PLAIN);
    expect(js(`var c = ${crypt(`"AES", "${KEY16}", ""`)}; c.decryptStr(c.encryptBase64(result))`, PLAIN)).toBe(PLAIN);
  });

  it('旧包装：aes/des 四参、tripleDES 五参', async () => {
    await preloadJsSandbox();
    expect(js(`java.aesBase64DecodeToString(result, "${KEY16}", "AES/CBC/PKCS5Padding", "${IV16}")`, cbcB64)).toBe(PLAIN);
    expect(js(`java.aesDecodeToString(result, "${KEY16}", "AES/CBC/PKCS5Padding", "${IV16}")`, cbcB64)).toBe(PLAIN);
    expect(js(`java.aesEncodeToBase64String(result, "${KEY16}", "AES/CBC/PKCS5Padding", "${IV16}")`, PLAIN)).toBe(cbcB64);
    const des = enc('des-ede3-cbc', Buffer.from(KEY24.slice(0, 8).repeat(3)), IV8, Buffer.from(PLAIN)).toString('base64');
    expect(js(`java.desEncodeToBase64String(result, "${KEY24}", "DES/CBC/PKCS5Padding", "${IV8}")`, PLAIN)).toBe(des);
    expect(js(`java.desDecodeToString(result, "${KEY24}", "DES/CBC/PKCS5Padding", "${IV8}")`, des)).toBe(PLAIN);
    expect(js(`java.desBase64DecodeToString(result, "${KEY24}", "DES/CBC/PKCS5Padding", "${IV8}")`, des)).toBe(PLAIN);
    const ede = enc('des-ede3-cbc', KEY24, IV8, Buffer.from(PLAIN)).toString('base64');
    expect(js(`java.tripleDESEncodeBase64Str(result, "${KEY24}", "CBC", "PKCS5Padding", "${IV8}")`, PLAIN)).toBe(ede);
    expect(js(`java.tripleDESDecodeStr(result, "${KEY24}", "CBC", "PKCS5Padding", "${IV8}")`, ede)).toBe(PLAIN);
  });

  it('toNumChapter：null 原样，其余同宿主', async () => {
    await preloadJsSandbox();
    expect(js('java.toNumChapter(result)', '第一千零二十五章')).toBe('第1025章');
    expect(js('String(java.toNumChapter(null))')).toBe('null');
  });

  it('失败一律致命，try/catch 吞不掉', async () => {
    await preloadJsSandbox();
    const fatal = (code: string, result = '') => codeOf(() => js(code, result));
    const lone = 'String.fromCharCode(0xD800)';
    const cases = [
      `${crypt(`"AES/CBC/PKCS5Padding", "${KEY16}"`)}`, // CBC 缺 IV
      `${crypt(`"AES/ECB/PKCS5Padding", "${KEY16}", "${IV16}"`)}`, // ECB 带 IV
      `${crypt(`"AES", "short"`)}`,
      `${crypt(`"AES", "${KEY16}", undefined`)}`,
      `${crypt(`"AES"`)}`,
      `${crypt(`"AES", "${KEY16}", "", 1`)}`,
      `${crypt(`"AES", 123`)}`,
      `${crypt(`"AES", "${KEY16}"`)}.decrypt(result)`,
      `${crypt(`"AES", "${KEY16}"`)}.decryptStr(result, 1)`,
      `${crypt(`"AES", "${KEY16}"`)}.encryptHex(1)`,
      `${crypt(`"AES", "${KEY16}"`)}.encryptHex("a" + ${lone})`,
      `String(${crypt(`"AES", "${KEY16}"`)})`,
      `${crypt(`"AES", "${KEY16}"`)}.x = 1`,
      `String = function(){ throw 1; }; ${crypt(`"AES", "${KEY16}"`)}.decrypt`,
      `${crypt(`"AES", "${KEY16}"`)}.decryptStr("abc")`, // 奇数长 hex
      `${crypt(`"AES", "${KEY16}"`)}.decryptStr("not base64!")`,
      `java.aesDecodeToString(result, "${KEY16}", "AES")`,
      `java.tripleDESDecodeStr(result, "${KEY24}", "CBC", "PKCS5Padding", null)`,
      'java.toNumChapter()',
      'java.toNumChapter(12)',
      `java.toNumChapter("第" + String.fromCharCode(0x661) + "章")`,
    ];
    for (const code of cases) {
      expect(fatal(code, 'ab'), code).toBe('RULE_EVAL_FAILED');
      expect(fatal(`try { ${code} } catch (e) { "caught" }`, 'ab'), code).toBe('RULE_EVAL_FAILED');
    }
  });

  it('宿主入口不外露；off 态沙箱没有帮手', async () => {
    await preloadJsSandbox();
    expect(js('typeof __jsutil + "|" + typeof globalThis.__jsutil')).toBe('undefined|undefined');
    expect(js('typeof java.createSymmetricCrypto + "|" + typeof java.toNumChapter')).toBe('function|function');
    expect(js('typeof java.createSymmetricCrypto + "|" + typeof java.toNumChapter + "|" + typeof __jsutil', '', false))
      .toBe('undefined|undefined|undefined');
    // java 照旧冻结：改不掉帮手
    expect(js('java.toNumChapter = function(){ return "x"; }; java.toNumChapter("第一章")')).toBe('第1章');
  });

  it('字段求值：编译期标 jsUtil 的字段才装帮手', async () => {
    await preloadJsSandbox();
    const field = on(`#c@text@js:${crypt(`"AES/CBC/PKCS5Padding", "${KEY16}", "${IV16}"`)}.decryptStr(result)`, CONTENT);
    expect(field.jsUtil).toBe(true);
    expect(value(field, `<div id="c">${cbcB64}</div>`)).toBe(PLAIN);
    expect(value(on('a@text@js:java.toNumChapter(result)', 'ruleToc.chapterName'), '<a>第十二章 标题</a>')).toBe('第12章');
    const forged: FieldIr = { ...on('a@text@js:java.toNumChapter(result)', 'ruleToc.chapterName') };
    delete forged.jsUtil;
    expect(codeOf(() => value(forged, '<a>第十二章</a>'))).toBe('RULE_EVAL_FAILED');
  });
});

describe('source-usability 缓存口径', () => {
  const saved = process.env.ENGINE_SYNTAX_JS_UTIL;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGINE_SYNTAX_JS_UTIL;
    else process.env.ENGINE_SYNTAX_JS_UTIL = saved;
  });

  it('翻 ENGINE_SYNTAX_JS_UTIL 后 engineSourceUsable 重新判定', async () => {
    const { engineSourceUsable } = await import('../source-usability');
    const env = process.env;
    const prev = { js: env.ENGINE_SYNTAX_JS };
    env.ENGINE_SYNTAX_JS = '1';
    try {
      const source = {
        url: 'https://book15.net/', name: 'x', searchUrl: 'https://book15.net/s?q={{key}}', // 默认 host 门白名单
        rules: {
          ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
          ruleToc: { chapterList: '.c', chapterName: 'a@text@js:java.toNumChapter(result)', chapterUrl: 'a@href' },
          ruleContent: { content: '#c@text' },
        },
      };
      env.ENGINE_SYNTAX_JS_UTIL = '0';
      const offState = engineSourceUsable(source as never);
      env.ENGINE_SYNTAX_JS_UTIL = '1';
      const onState = engineSourceUsable(source as never);
      expect(offState).toBe(false);
      expect(onState).toBe(true);
    } finally {
      if (prev.js === undefined) delete env.ENGINE_SYNTAX_JS;
      else env.ENGINE_SYNTAX_JS = prev.js;
    }
  });
});
