// 源注册表生命周期的合成反例（桩测试，无 DB）：两个本批必须统一的契约——
// (a) 活跃 = lifecycle='active' 且 enabled!==false 同时满足（enabled 仍是可用开关，不是「登记在册」）；
// (b) 别名判定按**同一源**的 apex/www 配对，不跨源——另一 active 源的 host 不得被当成 retired 源的别名。
// 判定逻辑经可注入核心（sourceForHostIn / isHostActiveInSources）以合成注册表驱动，与真实
// BUILTIN_SOURCES 走同一份代码。

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SOURCES, activeBuiltinSource, activeBuiltinSources, builtinSourceForHost,
  isHostActiveInSources, isRetiredBuiltinHost, sourceForHostIn, type SupportedSource,
} from './supported-sources';

const base = {
  searchUrl: 'https://example.invalid/s?q={{key}}', rules: {}, tier: 'builtin' as const,
};

function entry(url: string, over: Partial<SupportedSource> = {}): SupportedSource {
  return {
    url, name: url, searchUrl: `${url}s?q={{key}}`, rules: {}, tier: 'builtin',
    enabled: true, lifecycle: 'active', retiredReason: null, ...over,
  };
}

describe('源注册表生命周期：合成反例', () => {
  it('真实注册表：book15 已退休——host 可识别但不许可请求', () => {
    expect(builtinSourceForHost('book15.net')).toMatchObject({ lifecycle: 'retired' });
    expect(isHostActiveInSources('book15.net', BUILTIN_SOURCES)).toBe(false);
    expect(isHostActiveInSources('www.book15.net', BUILTIN_SOURCES)).toBe(false);
    expect(activeBuiltinSources()).toEqual([]);
    expect(activeBuiltinSource()).toBeNull();
    // 第三态：识别集合内但无活跃内建源（取文链路据此按永久不可达收口，零请求）。
    expect(isRetiredBuiltinHost('book15.net')).toBe(true);
    expect(isRetiredBuiltinHost('www.book15.net')).toBe(true);
    expect(isRetiredBuiltinHost('BOOK15.NET.')).toBe(true); // 尾点根形态同判
    // 识别集合外不是退休（是普通未知 host，走各链路自己的反查/失败路径）。
    expect(isRetiredBuiltinHost('good.example')).toBe(false);
  });

  it('反例 (a)：enabled=false 但 lifecycle=active 的源不是活跃源（active ∩ enabled 缺一不可）', () => {
    const registry = [
      entry('https://switched-off.example/'),
      entry('https://switched-off2.example/', { lifecycle: 'active' }),
      entry('https://live.example/', { enabled: true }),
    ];
    const off = entry('https://a.example/', { enabled: false, lifecycle: 'active' });
    // 直接判据：enabled=false ⇒ 即便 lifecycle=active 也拒绝发请求。
    expect(isHostActiveInSources('a.example', [off, ...registry])).toBe(false);
    // 池合成入口（activeBuiltinSources 的同款谓词）：关掉的条目不进活跃集。
    const synthetic = [off, ...registry];
    expect(synthetic.filter((source) => source.lifecycle === 'active' && source.enabled !== false).map((s) => s.url))
      .toEqual(['https://switched-off.example/', 'https://switched-off2.example/', 'https://live.example/']);
    // 反例判别力：enabled=true 且 active 的照常活跃（不是恒 false 的装饰断言）。
    expect(isHostActiveInSources('live.example', [off, ...registry])).toBe(true);
  });

  it('反例 (b)：另一 active 内建源的 host 不是 retired 源的别名（同源 apex/www 才配对）', async () => {
    const retiredBook15 = entry('https://book15.net/', { lifecycle: 'retired', retiredReason: 'test' });
    // 另一 active 内建源，primary=www.book15.net——改前的「任意非 primary 识别 host 都当别名」
    // 会让 book15.net（retired 的 primary）按别名命中 anotherActive，令退休 host 复活。
    // 同源配对修复后：book15.net 映射到 retiredBook15（primary 直配优先、注册表序）；
    // www.book15.net 虽是 anotherActive 的 primary，但 retiredBook15 的同源别名集合先命中——
    // 同站双 host 跟随主条目（retired）状态，两者都不因对方的存在改变许可结论：retired 不复活。
    const anotherActive = entry('https://www.book15.net/');
    const registry = [retiredBook15, anotherActive];
    expect(sourceForHostIn('book15.net', registry)).toBe(retiredBook15);
    expect(sourceForHostIn('www.book15.net', registry)).toBe(retiredBook15);
    expect(isHostActiveInSources('book15.net', registry)).toBe(false);
    expect(isHostActiveInSources('www.book15.net', registry)).toBe(false);
    // 反例判别力：把 retired 条目拿掉后 www.book15.net 照常活跃（不是恒 false 的装饰断言）。
    expect(isHostActiveInSources('www.book15.net', [anotherActive])).toBe(true);
  });

  it('同源 apex/www 配对：active 条目对两个 host 形态都许可，对尾点根形态同样归一', () => {
    const active = entry('https://dup.example/');
    expect(isHostActiveInSources('dup.example', [active])).toBe(true);
    expect(isHostActiveInSources('www.dup.example', [active])).toBe(true);
    expect(isHostActiveInSources('dup.example.', [active])).toBe(true);
    expect(isHostActiveInSources('www.dup.example.', [active])).toBe(true);
    // 无关 host 不因前缀相似放行。
    expect(isHostActiveInSources('notdup.example', [active])).toBe(false);
    expect(isHostActiveInSources('dup.example.evil.test', [active])).toBe(false);
  });

  it('retired 条目的同站双 host 跟随主条目退休', () => {
    const retired = entry('https://dup.example/', { lifecycle: 'retired', retiredReason: 'dead' });
    expect(isHostActiveInSources('dup.example', [retired])).toBe(false);
    expect(isHostActiveInSources('www.dup.example', [retired])).toBe(false);
    expect(builtinSourceForHost('dup.example')).toBeNull(); // 真实注册表无此条目
  });
});
