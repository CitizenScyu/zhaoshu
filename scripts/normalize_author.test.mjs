import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuthor } from './normalize_author.mjs';

const html = Object.freeze({ sourceSite: 'book15.net' });
const normalize = (value, options = html) => normalizeAuthor(value, options);

describe('作者 HTML 实体规范化', () => {
  for (const [input, expected] of [
    ['埃里克&middot;霍弗', '埃里克·霍弗'],
    ['埃里克&#183;霍弗', '埃里克·霍弗'],
    ['埃里克&#xB7;霍弗', '埃里克·霍弗'],
    ['&#X0000b7;', '·'],
    ['&#000183;', '·'],
    ['Ren&eacute; &amp; Fran&ccedil;ois', 'René & François'],
    ['&quot;作者&apos;&lt;笔名&gt;', '"作者\'<笔名>'],
    ['&Afr; &NotEqualTilde;', '𝔄 ≂̸'],
    ['作者&#128512;&#x1F9D1;', '作者😀🧑'],
    ['&nbsp; 埃里克&middot;霍弗 &nbsp;', '埃里克·霍弗'],
    ['A&amp;B', 'A&B'],
    ['&&middot;', '&·'],
  ]) {
    it('一次解码 ' + input, () => {
      assert.deepEqual(normalize(input), { status: 'ready', value: expected, changed: true });
      assert.deepEqual(normalize(expected), { status: 'ready', value: expected, changed: false });
    });
  }

  for (const input of ['埃里克·霍弗', '作者😀', '作者👩‍💻', 'A & B', 'AT&T', 'A&B', '&', '作者&', 'e\u0301', 'ＡＢＣ', '']) {
    it('普通文本保持原值 ' + JSON.stringify(input), () => {
      assert.deepEqual(normalize(input), { status: 'ready', value: input, changed: false });
      assert.equal(normalize(input, {}).status, 'ready');
    });
  }

  it('只 trim 外围空格，不改作者内部空格或 Unicode 形式', () => {
    assert.equal(normalize('  作  者　').value, '作  者');
    assert.equal(normalize('  ').value, '');
  });

  for (const [input, reasonCode] of [
    ['作者&unknown;', 'unknown-entity'],
    ['作者&not_known;', 'unknown-entity'],
    ['&Middot;', 'unknown-entity'],
    ['&middot', 'missing-semicolon'],
    ['作者&middot霍弗', 'missing-semicolon'],
    ['&middotHoffer', 'missing-semicolon'],
    ['&NotEqualTilde', 'missing-semicolon'],
    ['&#183', 'missing-semicolon'],
    ['&#xB7', 'missing-semicolon'],
    ['&amp;middot;', 'multiple-encoding'],
    ['&amp;middot', 'multiple-encoding'],
    ['&amp;middotHoffer', 'multiple-encoding'],
    ['&amp;unknown;', 'multiple-encoding'],
    ['&#38;#183;', 'multiple-encoding'],
    ['&#x26;middot;', 'multiple-encoding'],
    ['&amp;amp;middot;', 'multiple-encoding'],
    ['埃里克&middot;霍弗&unknown;', 'unknown-entity'],
  ]) {
    it('保留原值并核验 ' + input, () => {
      const result = normalize(input);
      assert.equal(result.status, 'review');
      assert.equal(result.value, input);
      assert.equal(result.reasonCode, reasonCode);
    });
  }

  for (const input of [
    '&#0;', '&#x00;', '&#xD800;', '&#xDFFF;', '&#55296;', '&#x110000;',
    '&#999999999999999999999999999;', '&#x80;', '&#128;', '&#x7F;',
    '&#9;', '&#10;', '&#13;', '&#xFDD0;', '&#xFFFF;', '&#x10FFFF;', '&#xFFFD;',
    '&#-1;', '&#x-1;', '&#;', '&#x;', '&#xGG;', '&#12x;', '&# 183;',
  ]) {
    it('非法数值实体不静默替换 ' + input, () => {
      const result = normalize(input);
      assert.equal(result.status, 'review');
      assert.equal(result.value, input);
      assert.match(result.reasonCode, /invalid-numeric-entity|missing-semicolon/);
    });
  }

  for (const input of [
    '\0作者', '作者\u0001', '\t作者', '作者\n', '作者\r', '作者\u007f', '作者\u0085',
    '作者\ud800', '作者\udc00', '作者\ud800😀', '作者\uFDD0',
    '&Tab;作者', '作者&NewLine;',
  ]) {
    it('trim 前拦截非法字符 ' + JSON.stringify(input), () => {
      const result = normalize(input);
      assert.equal(result.status, 'review');
      assert.equal(result.value, input);
      assert.equal(result.reasonCode, 'invalid-characters');
    });
  }
});

describe('来源、编码标记和长度边界', () => {
  it('来源未确认时不解释 HTML，保留原作者', () => {
    for (const sourceSite of [undefined, null, '', 'fixture.invalid', 'book15.net.invalid', 'www.book15.net']) {
      const result = normalize('&middot;', { sourceSite });
      assert.equal(result.status, 'review');
      assert.equal(result.reasonCode, 'unconfirmed-source');
      assert.equal(result.value, '&middot;');
    }
    assert.equal(normalize('&middot;', { sourceSite: ' BOOK15.NET ' }).value, '·');
  });

  it('text-v1 明确跳过 HTML 解码，包括看似实体的领域文本', () => {
    for (const input of ['&middot;', '&amp;middot;', '&unknown;', '&#0;', 'A & B']) {
      const options = { ...html, encoding: 'text-v1' };
      assert.deepEqual(normalize(input, options), { status: 'ready', value: input, changed: false });
      assert.equal(normalize(normalize(input, options).value, options).value, input);
    }
    assert.equal(normalize('\0', { encoding: 'text-v1' }).status, 'review');
  });

  it('html-v1 仍只允许已核实来源，未知编码标记待核验', () => {
    assert.equal(normalize('&middot;', { ...html, encoding: 'html-v1' }).value, '·');
    assert.equal(normalize('&middot;', { encoding: 'html-v1' }).reasonCode, 'unconfirmed-source');
    assert.equal(normalize('作者', { ...html, encoding: 'html-v2' }).reasonCode, 'unknown-encoding');
  });

  it('解码和 trim 后检查 200 码点边界，合法 emoji 计为一个码点', () => {
    for (const input of ['字'.repeat(200), '😀'.repeat(200), '&middot;'.repeat(200), '  ' + '字'.repeat(200) + '  ']) {
      assert.equal(normalize(input).status, 'ready');
      assert.equal([...normalize(input).value].length, 200);
    }
    for (const input of ['字'.repeat(201), '😀'.repeat(201), '&middot;'.repeat(201)]) {
      assert.equal(normalize(input).status, 'failed');
      assert.equal(normalize(input).reasonCode, 'too-long');
      assert.equal(normalize(input).value, input);
    }
  });

  it('类型错误不强制转成作者身份', () => {
    for (const value of [null, undefined, 1, false, [], {}]) {
      assert.equal(normalize(value).status, 'failed');
      assert.equal(normalize(value).value, value);
    }
  });
});
