// cleanSearchTitle / cleanSearchAuthor 单元测试（dlsearch-1026）：生产实例（精灵宝钻）与
// 边界（空串、无括号、只有括号、多段注记、名字内点不拆）钉死。
import { describe, expect, it } from 'vitest';
import { cleanSearchAuthor, cleanSearchTitle, searchKeysOf } from './search-key';

describe('cleanSearchTitle', () => {
  it('生产实例：去掉末尾版本注记', () => {
    expect(cleanSearchTitle('精灵宝钻（精装插图本）')).toBe('精灵宝钻');
    expect(cleanSearchTitle('三国演义（典藏版）')).toBe('三国演义');
    expect(cleanSearchTitle('红楼梦(修订版)')).toBe('红楼梦');
    expect(cleanSearchTitle('百年孤独【全译本】')).toBe('百年孤独');
    expect(cleanSearchTitle('平凡的世界（纪念版）')).toBe('平凡的世界');
  });

  it('多段注记可重复剥，只剥末尾', () => {
    expect(cleanSearchTitle('平凡的世界（上）（精装版）')).toBe('平凡的世界（上）');
    expect(cleanSearchTitle('书名（精装版）（2023修订）')).toBe('书名');
  });

  it('书名中间的括号内容不动', () => {
    expect(cleanSearchTitle('三国演义（上）')).toBe('三国演义（上）');
    expect(cleanSearchTitle('多收了三五斗（农民小说选）')).toBe('多收了三五斗（农民小说选）');
  });

  it('无括号原样返回（含首尾空白 trim）', () => {
    expect(cleanSearchTitle('活着')).toBe('活着');
    expect(cleanSearchTitle('  活着  ')).toBe('活着');
  });

  it('只有括号注记时返回原值（不剥空）', () => {
    expect(cleanSearchTitle('（精装插图本）')).toBe('（精装插图本）');
    expect(cleanSearchTitle('【全译本】')).toBe('【全译本】');
    expect(cleanSearchTitle('  (修订版)  ')).toBe('(修订版)');
  });

  it('空串与纯空白返回空串', () => {
    expect(cleanSearchTitle('')).toBe('');
    expect(cleanSearchTitle('   ')).toBe('');
  });

  it('混合括号风格也剥', () => {
    expect(cleanSearchTitle('书名（修订版)')).toBe('书名');
    expect(cleanSearchTitle('书名[典藏版]')).toBe('书名');
  });
});

describe('cleanSearchAuthor', () => {
  it('生产实例：多作者取第一个、去国籍前缀、去角色词', () => {
    expect(cleanSearchAuthor('[英] J.R.R.托尔金 著，[英] 泰德·纳史密斯 图')).toBe('J.R.R.托尔金');
    expect(cleanSearchAuthor('（明）罗贯中')).toBe('罗贯中');
    expect(cleanSearchAuthor('〔美〕海明威（Hemingway） 著')).toBe('海明威（Hemingway）');
  });

  it('名字内的点不拆（J.R.R. 是名字本体）', () => {
    expect(cleanSearchAuthor('[英] J.R.R.托尔金 著，[英] 克里斯托弗·托尔金 编')).toBe('J.R.R.托尔金');
  });

  it('各分隔符取第一段', () => {
    expect(cleanSearchAuthor('鲁迅，许广平 编')).toBe('鲁迅');
    expect(cleanSearchAuthor('鲁迅,许广平')).toBe('鲁迅');
    expect(cleanSearchAuthor('金麻雀、刘白羽')).toBe('金麻雀');
    expect(cleanSearchAuthor('甲/乙/丙')).toBe('甲');
    expect(cleanSearchAuthor('甲;乙')).toBe('甲');
  });

  it('角色词只剥末尾一次', () => {
    expect(cleanSearchAuthor('木苏里 著')).toBe('木苏里');
    expect(cleanSearchAuthor('南派三叔编著')).toBe('南派三叔');
    expect(cleanSearchAuthor('张三主编')).toBe('张三');
    expect(cleanSearchAuthor('李四 译')).toBe('李四');
    expect(cleanSearchAuthor('王五 绘')).toBe('王五');
    expect(cleanSearchAuthor('马未都 校注')).toBe('马未都');
  });

  it('剥空时回退原值（角色词本体是名字）', () => {
    // 名字本体恰与角色词同形：剥完为空必须回退，不能把作者变成空串（会误判「无作者」）。
    expect(cleanSearchAuthor('著')).toBe('著');
    expect(cleanSearchAuthor('编译')).toBe('编译');
  });

  it('无修饰的单名原样返回', () => {
    expect(cleanSearchAuthor('木苏里')).toBe('木苏里');
    expect(cleanSearchAuthor('  天下归元  ')).toBe('天下归元');
  });

  it('单个笔名以单字角色字结尾不削（非出版形态）；出版形态照剥', () => {
    expect(cleanSearchAuthor('鸿蒙宏图')).toBe('鸿蒙宏图');
    expect(cleanSearchAuthor('宏图')).toBe('宏图');
    expect(cleanSearchAuthor('辰东著')).toBe('辰东');
    expect(cleanSearchAuthor('张著')).toBe('张著');
    expect(cleanSearchAuthor('[美]甲乙著')).toBe('甲乙');
    expect(cleanSearchAuthor('甲乙著，丙丁译')).toBe('甲乙');
  });

  it('空串返回空串', () => {
    expect(cleanSearchAuthor('')).toBe('');
    expect(cleanSearchAuthor('   ')).toBe('');
  });

  it('佚名/未知按原样返回（不在这层判，判交给身份门）', () => {
    expect(cleanSearchAuthor('佚名')).toBe('佚名');
  });
});

describe('searchKeysOf', () => {
  it('组合清洗：生产实例', () => {
    expect(searchKeysOf({ title: '精灵宝钻（精装插图本）', author: '[英] J.R.R.托尔金 著，[英] 泰德·纳史密斯 图' }))
      .toEqual({ title: '精灵宝钻', author: 'J.R.R.托尔金' });
  });
});
