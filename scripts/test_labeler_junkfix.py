#!/usr/bin/env python3
"""labeler.py 广告/乱码清洗补强的离线单测（junkfix41，依据 junkaudit-41-report §5）。

全离线：不联网、不调 LLM、不读 .env。
复跑：python scripts/test_labeler_junkfix.py
      python -m unittest discover -s scripts -p 'test_labeler_junkfix.py'

样本来源：junkaudit-41-report §2/§3 的现场实测形态 + 派单硬正/反例。
覆盖：§2 整行推广黑名单（两信号同现 + 固定字面）、§3 段内插入子串剥除、
      §3 乱码（?? 占位 / HTML 残渣 / 章级 UTF-8→GBK 错位兜底）。
误删护栏：硬反例（对白/正文/系统流）一律保留。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402


def strip_then_drop(line: str):
    """复刻 prepare_book_text 的单行处理：先剥段内噪声，再过整行规则。

    返回 'strip-empty'（剥空）/ 'drop:<rule>'（整行命中）/ ('keep', 剥后文本)。"""
    st = labeler._strip_inline_noise(line)
    if not st:
        return 'strip-empty'
    rule = labeler._drop_rule(st)
    if rule:
        return f'drop:{rule}'
    return ('keep', st)


class TestPromoLineTwoSignal(unittest.TestCase):
    """§2 整行推广：推广实体词 + 呼告/来源词两信号同现（无引号、行长 ≤120）。"""

    HARD_DROPS = (
        '广个告，我最近在用的看书app，书源多，书籍全，更新快！',
        '免费看书，关注微信公众号：天涯悦读',
        '本书由公众号整理制作。关注VX【书友大本营】，看书领现金红包！',
        '(更多的更新，已經在微信公眾號傳了，大家可以去關注閱讀，微信號:fenghuo1985)',
        '本站已开通小说订阅功能，您可以订阅自己喜欢的小说…',
        '小主，这个章节后面还有哦，请点击下一页继续阅读，后面更精彩！',
    )

    def test_hard_promo_lines_are_dropped(self):
        for line in self.HARD_DROPS:
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')

    def test_source_url_declaration_is_dropped(self):
        # `本书来自 <网址>` 型来源声明：后接网址/空白/行尾才算
        for line in ('本書來自    https://', '本书来自 www.example.com',
                     '本书来自m.33xs.com', '本书首发来自，第一时间看正版内容！'):
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')

    def test_two_signal_requires_both(self):
        # 只有实体词、没有呼告词 → 不是推广（避免正文误删）
        self.assertIsNone(labeler._drop_rule('他掏出手机打开了一个看书app。'))
        # 只有呼告词、没有实体词 → 不删
        self.assertIsNone(labeler._drop_rule('大家快去关注一下比赛的结果。'))

    def test_dialogue_with_promo_words_is_kept(self):
        """引号闸：含推广词的对白必须保留（`“你关注我公众号了没？”他问。`）。

        变异钉：去掉 `_PROMO_QUOTE_RE` 引号闸，本用例全组变红。"""
        for line in ('“你关注我公众号了没？”他问。',
                     '“记得关注我的公众号，有红包。”她笑着说。',
                     '「本书来自哪里？」他随口问了一句。'):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    def test_prose_source_declaration_is_kept(self):
        # `这本书来自民间传说` 后面不是网址 → 正文，保留
        for line in ('这本书来自民间流传的一个故事。', '本书来自作者多年的构思。'):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))


class TestInlineStrip(unittest.TestCase):
    """§3 段内插入子串剥除：只剥噪声子串，两侧正文相连。"""

    CASES = (
        ('烈●31小说app下载地址●帝便特意', '烈帝便特意'),
        ('原本数字是7，这个时候却变成了八。浏*览*器*搜*索：@精华书阁……最快更新……',
         '原本数字是7，这个时候却变成了八。'),
        ('“虚伪。”百度搜索神秘复苏爱好中文网ah123z.com全网首发', '“虚伪。”'),
        ('林北也意识(本章未完！)', '林北也意识'),
        ('她惭愧地低下头。（）', '她惭愧地低下头。'),
    )

    def test_inline_strip_keeps_prose(self):
        for raw, want in self.CASES:
            with self.subTest(raw=raw):
                self.assertEqual(labeler._strip_inline_noise(raw), want)

    def test_bare_paren_not_stripped_when_has_content(self):
        # `Costco（美國連鎖超市名稱）` 括号里有内容，不是空括号残渣
        self.assertEqual(labeler._strip_inline_noise('Costco（美國連鎖超市名稱）'),
                         'Costco（美國連鎖超市名稱）')


class TestGarbleQmarkAndHtml(unittest.TestCase):
    """§3 乱码：句读后半角 ?? 占位 / HTML 标签残渣。"""

    def test_halfwidth_qmark_after_punct_removed(self):
        self.assertEqual(labeler._strip_inline_noise('。??在以前'), '。在以前')
        self.assertEqual(labeler._strip_inline_noise('他愣了一下，??随后笑了。'),
                         '他愣了一下，随后笑了。')

    def test_fullwidth_qmark_is_kept(self):
        # 全角 ？？ 是正常强调，不动
        self.assertEqual(labeler._strip_inline_noise('什么？？'), '什么？？')

    def test_qmark_not_after_punct_is_kept(self):
        # `一??怪异` 的 ?? 不在句读之后 → 只按 audit §5.3 处理句读后形态，保留
        self.assertEqual(labeler._strip_inline_noise('一??怪异的人偶'), '一??怪异的人偶')

    def test_html_tag_residue_line_dropped(self):
        # 谷&lt;/span&gt; → unescape → 谷</span> → 去标签后仅 1 字 → 整行删
        for line in ('谷&lt;/span&gt;', '谷乚&lt;/span&gt;', '谷&lt;/span&gt'):
            with self.subTest(line=line):
                self.assertEqual(labeler._strip_inline_noise(line), '')

    def test_prose_with_entity_is_not_over_stripped(self):
        # 含 &amp; 的正文 unescape 后保留，不当标签残渣删
        self.assertEqual(labeler._strip_inline_noise('AT&amp;T 是一家公司。'),
                         'AT&T 是一家公司。')


class TestMojibakeChapter(unittest.TestCase):
    """§4 章级 UTF-8→GBK 错位兜底：先还原，还原不了整章丢弃。"""

    CLEAN = ('杨间悄无声息的再次回到大昌市，他没有时间去尚通大厦，'
             '而是直接去了观江小区，和半年前比起来，现在的观江小区异常的热闹。')
    MOJI = CLEAN.encode('utf-8').decode('gbk', 'ignore')

    def test_mojibake_line_detected(self):
        self.assertTrue(labeler._mojibake_ratio(self.MOJI) > labeler.MOJIBAKE_LINE_RATIO)
        self.assertTrue(labeler.is_mojibake_chapter([self.MOJI]))

    def test_normal_prose_not_flagged(self):
        self.assertFalse(labeler.is_mojibake_chapter([self.CLEAN]))
        self.assertLess(labeler._mojibake_ratio(self.CLEAN), 0.05)

    def test_demojibake_restores(self):
        restored = labeler.demojibake(self.MOJI)
        self.assertIsNotNone(restored)
        self.assertIn('杨间', restored)
        self.assertLess(labeler._mojibake_ratio(restored), 0.05)

    def test_demojibake_gives_up_on_normal_text(self):
        # 正常文本不是错码：还原会产生垃圾 → 返回 None（不乱动正常章）
        self.assertIsNone(labeler.demojibake(self.CLEAN))

    def test_mojibake_chapter_restored_in_prepare(self):
        # 整章多行错码：prepare_book_text 里被还原进正文，不计为丢弃
        clean = '\n'.join(
            f'这是第{i}段测试正文，杨间悄无声息地回到了大昌市观江小区，四周异常热闹非凡。'
            for i in range(400))
        moji = clean.encode('utf-8').decode('gbk', 'ignore')
        out, chars, reason, stats = labeler.prepare_book_text(
            f'【第1章 测试】\n{moji}', clean=True)
        self.assertIn('杨间', out)          # 错码章已还原进正文
        self.assertIsNone(reason)
        self.assertEqual(stats['mojibake_chapters'], 0)

    def test_unrestorable_mojibake_chapter_discarded(self):
        # 还原失败（demojibake 返回 None）时整章丢弃、不计字数、不进正文。
        # 用桩把某章的还原强制判失败，直接验证 prepare_book_text 的丢弃接线。
        bad = self.MOJI
        text = (f'【第1章 坏章】\n{bad}\n\n【第2章 好章】\n'
                + '正常的正文内容，情节推进得很快。' * 900)
        original = labeler.demojibake
        labeler.demojibake = lambda t: None if bad in t else original(t)
        try:
            out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        finally:
            labeler.demojibake = original
        self.assertNotIn(bad, out)                     # 坏章正文未进输出
        self.assertNotIn('坏章', out)                  # 坏章整章（含标题）被丢
        self.assertIn('好章', out)                     # 好章保留
        self.assertEqual(stats['mojibake_chapters'], 1)


class TestPreservedHardNegatives(unittest.TestCase):
    """派单硬反例：全部必须保留（误删护栏）。"""

    KEEP = (
        '“你关注我公众号了没？”他问。',
        '原本站在那里', '防盗窗', '亲手打造', '手机响了',
        '什么？？',
        '【叮！恭喜宿主获得新手大礼包】',
        'Costco（美國連鎖超市名稱）',
        '空****的山洞',
    )

    def test_hard_negatives_survive(self):
        for line in self.KEEP:
            with self.subTest(line=line):
                st = labeler._strip_inline_noise(line)
                self.assertEqual(st, line)              # 不被段内剥改
                self.assertIsNone(labeler._drop_rule(st))  # 不被整行删

    def test_star_separator_status_quo(self):
        # `*****` 维持现状：仍按纯分隔线（marker）删，本次不改其处置
        self.assertEqual(labeler._drop_rule('*****'), 'marker')

    def test_system_stream_brackets_survive_pipeline(self):
        # 系统流大量【叮！…】：整本走 prepare_book_text 不被误删
        text = '【第1章 开局】\n' + '【叮！恭喜宿主获得新手大礼包】\n主角很高兴。\n' * 800
        out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIn('【叮！恭喜宿主获得新手大礼包】', out)


if __name__ == '__main__':
    unittest.main(verbosity=2)
