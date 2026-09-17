import { describe, expect, it } from 'vitest';
import { recallSystem, recallUser, rerankSystem, rerankUser } from './prompts';

describe('find prompt boundaries', () => {
  it('uses only the current input when the profile and one-off conditions are empty', () => {
    const prompt = recallUser('', '只想看航海冒险');
    expect(prompt).toContain('只想看航海冒险');
    expect(prompt).toContain('画像为空，不添加任何长期偏好假定');
    expect(prompt).not.toContain('资深老书虫');
    expect(prompt).not.toContain('重剧情逻辑和文笔');
  });

  it('keeps one-off conditions separate from the long-term profile', () => {
    const prompt = recallUser('长期偏好：严肃慢热', '找一本新书', [], '这次轻松、节奏快');
    expect(prompt).toContain('# 用户口味画像\n\n长期偏好：严肃慢热');
    expect(prompt).toContain('# 仅本次生效的条件\n\n这次轻松、节奏快');
    expect(prompt).toContain('本次条件只是召回与排序意图');
  });

  it('does not leave a previous condition when callers clear it', () => {
    const prompt = rerankUser('画像', '找书', '[]', '');
    expect(prompt).toContain('# 仅本次生效的条件\n\n（无）');
    expect(prompt).not.toContain('这次轻松');
  });

  it('labels unverified one-off constraints as inference instead of hard filtering', () => {
    const prompt = rerankUser('', '找书', '[]', '必须完结且无雷');
    expect(prompt).toContain('只能作为模型推断或待核验风险');
    expect(prompt).toContain('不能陈述为已满足的事实');
  });

  // 调用方会把软约束清单截断（书架无限增长，见 find/route.ts 的 EXCLUDED_BOOKS_PROMPT_LIMIT）。
  // 截断了却不说，模型会把「没列出来」读成「没排除」，转身把用户书架上的书再推一遍。
  it('截断已排除书单时必须说明这只列出了一部分', () => {
    const prompt = recallUser('画像', '找书', [{ title: '架上书', author: '作者甲' }], '', 12);
    expect(prompt).toContain('- 《架上书》 作者甲');
    expect(prompt).toContain('另有 12 本已排除的书未列出');
    expect(prompt).toContain('**部分**清单');
  });

  it('没截断时不出现「另有」提示', () => {
    const prompt = recallUser('画像', '找书', [{ title: '架上书', author: '作者甲' }]);
    expect(prompt).not.toContain('另有');
  });
});

describe('evidence and inference boundaries', () => {
  it('defines match score as model ranking rather than a preference probability', () => {
    const prompt = rerankSystem();
    expect(prompt).toContain('个人匹配排序分');
    expect(prompt).toContain('不是用户喜欢这本书的概率');
  });

  it('keeps unverifiable attributes and reference books constrained', () => {
    const prompt = rerankSystem();
    expect(prompt).toContain('只能表述为待核验的模型推断');
    expect(prompt).toContain('不得发明作品');
    expect(recallSystem()).toContain('wordCount 是召回模型提供的待核验描述');
  });
});
