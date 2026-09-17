import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 触控目标是纯 CSS 行为，没有布局可断言（本项目测试跑在 jsdom），所以对样式表钉契约。
// 实测数据（Playwright + chromium-1208，注入真实 globals.css）见 task-70 回报：
//   button.chip text-xs  → 46×44      （合规，来自下面第 23 行的全局规则）
//   button.chip text-sm  → 44×44      （合规）
//   span.chip text-xs    → 70×22      （静态标签，非交互，无触控目标要求）
//   a.chip 无 min-h-11   → 142.9×22   （本次补上的那类）
// 注意：必须先剥掉 CSS 注释再查找。注释里会原样引用规则文本（比如解释「为什么要 44px」时
// 抄了选择器），不剥注释的 indexOf 会命中注释、再往后抓到下一条规则的声明块。
// 变异自测实证：删掉全局 button 44px 规则时，未剥注释的版本仍然绿。
const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarationValue(selectorFragment: string, prop: string): string | null {
  const index = css.indexOf(selectorFragment);
  if (index < 0) return null;
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  const match = css.slice(open + 1, close).match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
  return match ? match[1].trim() : null;
}

describe('globals.css: chip 触控目标', () => {
  it('可点 chip 靠全局 button 规则达到 44×44，不靠 .chip 自身的 padding', () => {
    // 这条规则是全部 <button>（含全部可点 chip）达标的原因；删掉它 chip 会掉回 22px 高，
    // 连带 .ink-button/.seal-button 等一起破功。
    expect(declarationValue('button, select', 'min-height')).toBe('44px');
    expect(declarationValue('button, select', 'min-width')).toBe('44px');
    // .chip 自身只有 2px 纵向 padding，绝不能误以为它自带 44px。
    expect(declarationValue('.chip {', 'min-height')).toBeNull();
  });

  it('<a>.chip 与 button 同标准（交互元素里唯一没有 44px 保证的一类）', () => {
    expect(declarationValue('a.chip {', 'min-height')).toBe('44px');
    expect(declarationValue('a.chip {', 'min-width')).toBe('44px');
  });

  it('不给 .chip 加伪元素扩热区（实测会在换行时盖住上一行 chip）', () => {
    // 曾经的方案：.chip::after 居中 44px 撑大命中区。实测 chip 本就是 44px 高，
    // 撑出来的热区在 flex-wrap 行距只有 8px 时会侵入上一行 chip 的可见盒底部，
    // 点得到看得见的 chip 却触发下一行。故禁止回退到这个做法。
    expect(css).not.toContain('.chip::after');
  });
});
