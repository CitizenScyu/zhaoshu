import { describe, expect, it } from 'vitest';
import { buildSourceSearchRequest } from './source-parser';

const BASE = 'https://book15.net';
const build = (template: string, title = '剑来') => buildSourceSearchRequest(template, title, BASE);

describe('buildSourceSearchRequest', () => {
  it('无选项 = 纯 GET，{{key}} 按 utf-8 编码', () => {
    const req = build('https://book15.net/search?q={{key}}&p={{page}}');
    expect(req.method).toBe('GET');
    expect(req.charset).toBe('utf-8');
    expect(req.body).toBeUndefined();
    expect(req.url).toBe(`https://book15.net/search?q=${encodeURIComponent('剑来')}&p=1`);
  });

  it('POST + body + gb2312：body 的 {{key}} 按 GBK 百分号编码', () => {
    const req = build('https://book15.net/search,{"method":"POST","body":"searchkey={{key}}","charset":"gb2312"}');
    expect(req.method).toBe('POST');
    expect(req.charset).toBe('gbk');
    expect(req.url).toBe('https://book15.net/search');
    expect(req.body).toBe('searchkey=%BD%A3%C0%B4');
  });

  it('JSON body（gbk）里 {{key}} 原样替换（不百分号编码，靠发送层字节化）', () => {
    const req = build('https://book15.net/api,{"method":"POST","charset":"gbk","body":"{\\"key\\":\\"{{key}}\\"}"}');
    expect(req.body).toBe('{"key":"剑来"}');
  });

  it('受限容错：单引号选项可解析', () => {
    const req = build("https://book15.net/s?q={{key}},{'method':'POST','body':'k={{key}}'}");
    expect(req.method).toBe('POST');
    expect(req.body).toBe(`k=${encodeURIComponent('剑来')}`);
  });

  it('设备指纹字段（imei/udid）当字面量原样发送', () => {
    const req = build('https://book15.net/s,{"method":"POST","body":"imei=000000&udid=abcdef&k={{key}}"}');
    expect(req.body).toBe(`imei=000000&udid=abcdef&k=${encodeURIComponent('剑来')}`);
  });

  it('headers 白名单：保留 Content-Type，丢弃 Cookie/Authorization', () => {
    const req = build('https://book15.net/s,{"method":"POST","body":"k={{key}}","headers":{"Content-Type":"application/x-www-form-urlencoded","Cookie":"sid=secret","Authorization":"Bearer x"}}');
    expect(req.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
  });

  it.each([
    ['非法 JSON（裸词）', 'https://book15.net/s?q={{key}},{method:POST}'],
    ['未知选项键', 'https://book15.net/s?q={{key}},{"method":"POST","foo":1}'],
    ['webView（未知键）', 'https://book15.net/s?q={{key}},{"webView":true}'],
    ['未知字符集', 'https://book15.net/s?q={{key}},{"charset":"big5"}'],
    ['未知方法', 'https://book15.net/s?q={{key}},{"method":"PUT"}'],
    ['body 含 @js:', 'https://book15.net/s,{"body":"@js:evil","method":"POST"}'],
    ['url 含 java.', 'https://book15.net/s?q={{key}}{{java.time()}},{"method":"POST"}'],
    ['跨站 host（不在白名单）', 'https://evil.invalid/s?q={{key}},{"method":"POST"}'],
  ])('拒绝：%s', (_label, template) => {
    expect(() => build(template)).toThrow();
  });

  it('缺 {{key}} 直接拒', () => {
    expect(() => build('https://book15.net/s,{"method":"POST"}')).toThrow();
  });
});
