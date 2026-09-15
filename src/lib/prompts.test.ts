import { describe, expect, it } from 'vitest';
import { recallUser, rerankUser } from './prompts';

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
});
