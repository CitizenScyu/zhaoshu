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


class TestRvjunkCounterexamples(unittest.TestCase):
    """rvjunk41 异厂审查的每一个误删反例都转成回归（必修 1/2 + 建议 3/4）。"""

    # 必修 1：固定字面无锚子串误删的叙述（现改为强字面无锚 / 弱字面须 ≥2 或搭实体）
    LITERAL_PROSE_KEEP = (
        '后面更精彩的情节他已经猜到了七七八八。',
        '他知道后面更精彩，所以舍不得睡。',
        '後面更精彩的部分他已經猜到了。',
        '多多分享你的想法，大家一起讨论。',
        '老师说要多多分享，他便站了起来。',
        '手打更新的速度让他很满意。',
        '这章没有结束的意思，他继续往下翻。',
        '收藏网址下次再用，他这样提醒自己。',
        '第一时间看正版的人并不多，他是其中一个。',
        '看正版内容才对得起作者，他一直这么觉得。',
        '请点击下一页继续阅读的提示跳了出来，他没理。',
        '手机阅读是他每天睡前的习惯。',
    )

    def test_literal_substrings_in_prose_are_kept(self):
        for line in self.LITERAL_PROSE_KEEP:
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    def test_bare_source_declaration_not_dropped(self):
        # _PROMO_SOURCE_URL_RE 的 |$ 笔误已修：裸「本书来自」不再整行删
        for line in ('本书来自', '本书来自）', '本书来自)', '本书来自民间的一个传说。'):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    # 必修 2：站名水印裸子串抠正文（现须带括号/域名/推广信号才剥）
    SITE_NAME_PROSE_KEEP = (
        '他走过开心文学社的门口，里面传来朗朗书声。',
        '开心文学是他最喜欢的一门课。',
        '精华书阁是城里最老的书店，他常去坐一下午。',
        '她在精华书阁里找了整整一个下午。',
        '他在搜趣屋坐了一下午，喝了三壶茶。',
        '搜趣屋里人声鼎沸，他挤了进去。',
        '无弹出广告的浏览器让他终于能安心看文章了。',
        '他特意找了个无弹出广告的浏览器。',
        '吾爱文学网课是学校新开的选修。',
        '雅文言情是这本诗集的风格，他很喜欢。',
        '燃文书库里的藏书他翻了个遍。',
        '他走進開心文學社，裡頭坐滿了人。',
        '無彈出廣告的日子讓他很不習慣。',
    )

    def test_site_names_as_prose_are_not_carved(self):
        for line in self.SITE_NAME_PROSE_KEEP:
            with self.subTest(line=line):
                self.assertEqual(labeler._strip_inline_noise(line), line)

    def test_bounded_site_watermark_still_stripped(self):
        # 带括号 / 域名 / @ 的站名水印仍要剥（E2 举证形态）
        self.assertEqual(labeler._strip_inline_noise('[吾爱文学网]'), '')
        self.assertEqual(labeler._strip_inline_noise('雅文言情.org'), '')
        self.assertEqual(labeler._strip_inline_noise('@精华书阁'), '')
        self.assertEqual(labeler._strip_inline_noise('无弹出广告文本小说站。'), '')

    # 建议 3：系统流【…现金红包…领取…】不被两信号删（含「红包/下载/推荐」字样的系统提示）
    SYSTEM_STREAM_KEEP = (
        '【红包雨来袭！点击领取现金红包】',
        '【系统：恭喜获得现金红包×1，请及时领取】',
        '【叮！现金红包已到账，请领取】',
        '【系统提示：新技能已下载到脑海，可随时使用】',
        '【推荐副本：深渊之门已开启，速去挑战】',
        '宿主打开背包，发现一个现金红包静静躺在里面。',
    )

    def test_system_stream_redpacket_kept(self):
        for line in self.SYSTEM_STREAM_KEEP:
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    # 增量复审：行首【放行过宽——带账号标记/强字面/弱字面≥2 的真广告即使包在【】里也须删
    BRACKET_AD_DROP = (
        '【公众号：天涯悦读】',
        '【关注公众号领取现金红包】',
        '【微信公众号：书友大本营】看书领现金红包',
        '【txt下载地址：www.x.com】',
        '【本站已开通小说订阅功能】',
        '【广个告】看书app，书源多，更新快！',
        '【推荐】本书首发来自，第一时间看正版内容！',
        '【公告】请点击下一页继续阅读，后面更精彩！',
        '【 公众号：天涯悦读】',
        '【限时活动：关注公众号领取新手礼包】',   # 含「公众号…领取」→ 按账号/CTA 删（复审认可）
    )

    def test_bracket_wrapped_ads_still_dropped(self):
        for line in self.BRACKET_AD_DROP:
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')

    # 建议 4：无引号叙述「他关注了那个公众号…」不被公众号+关注删
    def test_weak_entity_prose_kept(self):
        for line in ('他关注了那个公众号，只为了看每日推送。',
                     '他建了个QQ群，把同学都拉了进去。',
                     '客户端崩溃了三次，他终于忍不住重启了电脑。',
                     '他把客户端卸载了，改用网页版。'):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    # 硬正例仍须删（收窄不能放漏）
    def test_real_promo_still_dropped(self):
        for line in ('免费看书，关注微信公众号：天涯悦读',
                     '本书由公众号整理制作。关注VX【书友大本营】，看书领现金红包！',
                     '(更多的更新，已經在微信公眾號傳了，大家可以去關注閱讀，微信號:fenghuo1985)',
                     '小主，这个章节后面还有哦，请点击下一页继续阅读，后面更精彩！',
                     '广个告，我最近在用的看书app，书源多，书籍全，更新快！',
                     '本站已开通小说订阅功能，您可以订阅自己喜欢的小说…'):
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')


if __name__ == '__main__':
    unittest.main(verbosity=2)
