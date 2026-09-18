#!/usr/bin/env python3
"""labeler.py 抓取层清洗的离线单测（task-79）。

全离线：不联网、不调 LLM、不读 .env。
复跑：python scripts/test_labeler_clean.py
      python -m unittest discover -s scripts -p 'test_labeler_clean.py'

样本来源：D:/ClaudeCode/projects/zhaoshu/.t76-analysis/ 的排查结论
（该目录只有 labels.jsonl / labels-rejected.jsonl / gate.log 等派生统计，
原始章节 html 没有落盘，故正文用合成样例，UI/推广行按 t76 转写的实测样本构造）。
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402


# 站点章节页结构（按旧代码 mark 点 + t76 结论合成）：容器内混 UI/导航/推广行，
# 容器之后的页脚同样有 <p>，旧实现会把它一起收进去。
CHAPTER_HTML = """<!doctype html><html><body>
<div class="header"><p>首页</p><p>书架</p><p>手机</p></div>
<div id="chapter-content-panel" class="content read-content">
  <p>第一章 初入宗门</p>
  <p>清晨的雾气还没散，林越已经站在山门前，仰头看着那块斑驳的匾额出神。</p>
  <p>上一章()/()下一章</p>
  <p>他想起昨夜师父说的话，心里忽然涌起一股说不清的滋味，脚下的青石板冰凉。</p>
  <p>章节目录 阅读设置 加入书签 字体大小</p>
  <p>本站提供无弹窗全文字在线阅读，更新速度快，请记住本站网址。</p>
  <p>多多分享本站，向您qq群和微博里的朋友推荐。</p>
  <div class="ads"><p>高速首发，最新章节</p></div>
  <p>山风穿过松林，带着松脂的气味，他深吸一口气，抬脚迈过了山门。</p>
</div>
<div class="footer"><p>上一章</p><p>目录</p><p>下一章</p><p>加入书架</p></div>
</body></html>"""

PROSE = [
    '第一章 初入宗门',
    '清晨的雾气还没散，林越已经站在山门前，仰头看着那块斑驳的匾额出神。',
    '他想起昨夜师父说的话，心里忽然涌起一股说不清的滋味，脚下的青石板冰凉。',
    '山风穿过松林，带着松脂的气味，他深吸一口气，抬脚迈过了山门。',
]
NOISE_LINES = [
    '上一章()/()下一章',
    '章节目录 阅读设置 加入书签 字体大小',
    '本站提供无弹窗全文字在线阅读，更新速度快，请记住本站网址。',
    '多多分享本站，向您qq群和微博里的朋友推荐。',
    '高速首发，最新章节',
]


def html_with(inner: str) -> str:
    return f'<html><body><div id="chapter-content-panel">{inner}</div></body></html>'


def paras(lines) -> str:
    return ''.join(f'<p>{line}</p>' for line in lines)


# 噪声占比低的章节：清洗后丢弃远不到 CLEAN_MAX_DROP_RATIO，fetch_chapter_text 不告警，
# 用于验证「正常章节静默通过」这条路径（CHAPTER_HTML 是刻意做浓的告警样本）。
QUIET_HTML = html_with(paras(PROSE[:2] + ['章节目录'] + PROSE[2:]))


class TestContainer(unittest.TestCase):
    """规则 1a：正文容器由配对闭合标签定界，而不是盲截 25k。"""

    def test_footer_after_container_is_excluded(self):
        lines, how = labeler.extract_chapter_lines(CHAPTER_HTML)
        self.assertEqual(how, 'closed')
        # 页脚在容器之外：旧实现会捞到「上一章/目录/下一章/加入书架」四个 <p>
        for footer in ('目录', '加入书架'):
            self.assertNotIn(footer, lines)

    def test_nested_div_inside_container_is_kept_within_bounds(self):
        # 容器内的 .ads 子 div 不应让容器提前闭合——它的 <p> 会进到行列表，
        # 由推广行规则（而非容器边界）负责剥掉。
        lines, _ = labeler.extract_chapter_lines(CHAPTER_HTML)
        self.assertIn('高速首发，最新章节', lines)

    def test_br_splits_lines(self):
        lines, _ = labeler.extract_chapter_lines(
            html_with('<p>正文第一句。<br>目录</p>'))
        self.assertEqual(lines, ['正文第一句。', '目录'])

    def test_missing_marker_yields_no_lines(self):
        lines, how = labeler.extract_chapter_lines('<html><body><p>正文</p></body></html>')
        self.assertEqual((lines, how), ([], 'missing'))

    def test_unbalanced_div_falls_back_to_window(self):
        # 闭合标签缺失：不能把整页吞进来，退回旧的 25k 窗口
        html = '<div id="chapter-content-panel"><p>' + '正' * 200 + '</p>'
        lines, how = labeler.extract_chapter_lines(html)
        self.assertEqual(how, 'fallback')
        self.assertEqual(lines, ['正' * 200])

    def test_tiny_container_falls_back(self):
        # 容器判定出不到 100 字符 → 视为定位失败，用窗口兜底而不是丢掉正文
        html = ('<div id="chapter-content-panel"></div>'
                '<p>' + '文' * 300 + '</p>')
        lines, how = labeler.extract_chapter_lines(html)
        self.assertEqual(how, 'fallback')
        self.assertEqual(len(lines), 1)

    def test_earlier_closed_div_is_not_mistaken_for_container(self):
        # marker 之前有个已闭合的大 div：不能把它的闭合点当作正文容器边界，
        # 否则取回的是页头、正文整段丢失。
        html = ('<div class="nav">' + '<p>页头</p>' * 40 + '</div>'
                '<div id="chapter-content-panel"><p>' + '正文' * 80 + '</p></div>')
        lines, how = labeler.extract_chapter_lines(html)
        self.assertEqual(how, 'closed')
        self.assertEqual(lines, ['正文' * 80])

    def test_non_div_container_does_not_return_the_header(self):
        """变异钉：`m.start() > i` 是承重护栏，去掉后本用例会取回页头、正文全丢。

        正文容器不是 <div>（如 <section>）时，rfind('<div') 只能配到 marker **之前**
        那个已闭合的页头 div；没有护栏就会把页头当成正文返回。"""
        html = ('<div class="nav">' + '<p>页头导航</p>' * 30 + '</div>'
                '<section id="chapter-content-panel"><p>' + '正文' * 80 + '</p></section>')
        lines, how = labeler.extract_chapter_lines(html)
        self.assertEqual(how, 'fallback')
        self.assertEqual(lines, ['正文' * 80])


class TestNoiseRules(unittest.TestCase):
    """规则 1b/1c/1d：UI 按钮行、导航行、推广行。"""

    def test_ui_token_words_are_dropped(self):
        for token in labeler.UI_TOKENS_CORE:
            with self.subTest(token=token):
                self.assertEqual(labeler._drop_rule(token), 'ui')

    def test_ext_tokens_are_present_and_dropped(self):
        # 变异钉：删掉 UI_TOKENS_EXT 整个词表也要能被抓到（所以先 assertIn 再逐词验）
        for token in ('加入书架', '字体', '背景', '亮度', '返回目录', '章节报错',
                      '打赏', '推荐本书', '投推荐票', '夜间模式', '上一节'):
            with self.subTest(token=token):
                self.assertIn(token, labeler.UI_TOKENS_EXT)
                self.assertEqual(labeler._drop_rule(token), 'ui')

    def test_ui_lines_with_separators_are_dropped(self):
        for line in ('章节目录', '阅读设置', '目录 | 设置', '上一章', '下一章',
                     '加入书签 字体大小', '【目录】', '手机阅读设置'):
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'ui')

    def test_nav_line_variants_are_dropped(self):
        for line in ('上一章()/()下一章', '上一章 / 下一章',
                     '上一章（第12章 初入宗门）/（第14章 比斗）下一章',
                     '《上一章》|《下一章》'):
            with self.subTest(line=line):
                self.assertIsNotNone(labeler._drop_rule(line))

    def test_injection_samples_are_dropped(self):
        # t76 实测命中样本（含完整句形式）
        for line in ('提供无弹窗全文字在线阅读',
                     '多多分享本站',
                     '高速首发，最新章节',
                     '向您qq群和微博里的朋友推荐',
                     '本站提供无弹窗全文字在线阅读，更新速度快。',
                     '多多分享本站，向您QQ群和微博里的朋友推荐。'):
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')


class TestProsePreserved(unittest.TestCase):
    """误伤护栏：正常正文一字不少。"""

    def test_prose_survives_whole_chapter(self):
        text, stats = labeler.clean_chapter_text(CHAPTER_HTML)
        self.assertEqual(text.split('\n'), PROSE)
        self.assertEqual(stats['container'], 'closed')
        self.assertEqual(stats['lines_dropped'], len(NOISE_LINES))

    def test_prose_containing_ui_words_is_kept(self):
        for line in ('他掏出手机，翻开书架上的目录，随手点开章节目录，这一串动作他做过无数遍。',
                     '他看了看目录。',
                     '“设置”两个字写在门楣上，字体大小不一。',
                     '上一章里他没写清楚，下一章才交代了来龙去脉，读者为此争论了很久。'):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    def test_punctuation_only_line_is_kept(self):
        # 必须有「整行只由 UI 词构成」才剥，否则「……」这类正文行会被误删
        self.assertIsNone(labeler._drop_rule('……'))
        self.assertIsNone(labeler._drop_rule('——'))

    def test_short_prose_with_ui_token_residue_is_kept(self):
        self.assertIsNone(labeler._drop_rule('他看了看目录。'))

    def test_short_lines_and_dialogue_are_kept(self):
        """交叉审查实测到的误删形态，全部必须保留（本轮修复的直接回归用例）。"""
        for line in ('手机。', '打赏。', '背景。', '字体。', '书架。', '目录。',
                     '「手机。」',
                     '“你翻上一章看看，下一章就明白了”',   # nav 误删形态
                     '“你给我记住本站的规矩。”',           # inject 误删形态
                     '“手机用户请注意，前面是雷区。”'):     # inject 误删形态
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    def test_injection_generalizations_are_gone(self):
        # 变异钉：不许把「本站/手机用户」这类站点自指**泛化**重新加回黑名单——
        # 带 `?`/分组的写法会把「（我）记住本站…」这类对白一起圈进来。
        # 用整条 pattern 相等判定；固定字面（INJECT_LITERALS）不算泛化，不在此列。
        patterns = {p.pattern for p in labeler.INJECT_PATTERNS}
        for removed in (r'请?记住本站(网址)?', '手机用户请'):
            with self.subTest(pattern=removed):
                self.assertNotIn(removed, patterns)

    def test_promotional_full_sentence_is_still_dropped(self):
        # 收紧到固定口号后，实测的整句推广仍然要被剥掉
        self.assertEqual(
            labeler._drop_rule('本站提供无弹窗全文字在线阅读，更新速度快，请记住本站网址。'),
            'inject')

    def test_clean_text_is_stripped_and_deduplicated_newlines(self):
        text, _ = labeler.clean_chapter_text(html_with('<p>甲</p><p></p><p>乙</p>'))
        self.assertEqual(text, '甲\n乙')


class TestRound2PromoLiterals(unittest.TestCase):
    """t79 第二轮补丁：独立成行的口号碎片按**固定字面**补回（task-79-review2 §六.2）。

    上一轮整族删掉 `分享本站` / `请?记住本站(网址)?` 是对的（泛化会圈进对白），
    代价是 `分享本站` / `请记住本站网址` 这类碎片一起漏剥；本轮只补固定字面。
    `分享本站。` 由上一轮的「应留」改判为「应删」（复核 §二 第 11 条）。
    """

    NEW_LITERALS = ('分享本站', '请记住本站网址', '记住本站不迷路')

    def test_new_literals_are_declared_and_dropped(self):
        """变异钉：清空 INJECT_LITERALS 后本用例必须变红（先 assertIn 再验行为）。"""
        for literal in self.NEW_LITERALS:
            with self.subTest(literal=literal):
                self.assertIn(literal, labeler.INJECT_LITERALS)
                self.assertEqual(labeler._drop_rule(literal), 'inject')

    def test_new_literal_noise_forms_are_dropped(self):
        for line in ('分享本站', '分享本站。',
                     '请记住本站网址', '请记住本站网址。',
                     '记住本站不迷路', '记住本站不迷路！'):
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')

    def test_literal_tail_punctuation_variants_are_dropped(self):
        """行尾标点集（`_LITERAL_TAIL`）各变体都该剥——末轮补 `？?；;：:~～—` 的钉子。

        变异钉：把 `_LITERAL_TAIL` 缩回旧集（去掉 `？?；;：:~～—`）本用例须变红。"""
        for tail in ('', '。', '！', '!', '，', ',', '、', '…', '？', '?', '；', ';', '：', ':',
                     '~', '～', '—', '。。。', '？？', '……', '。！？'):
            with self.subTest(tail=tail):
                self.assertEqual(labeler._drop_rule('记住本站不迷路' + tail), 'inject')
                self.assertEqual(labeler._drop_rule('分享本站' + tail), 'inject')
        for line in ('分享本站？', '分享本站：', '请记住本站网址~', '记住本站不迷路~',
                     '记住本站不迷路——', '　分享本站。　'):  # 首尾全角空格
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')

    def test_punctuation_tail_does_not_widen_to_sentences(self):
        """反向钉子：tail 只在**行尾**起作用，句中含字面串的正文句一律保留。

        `$` 要求字面串之后整段都在标点集内，所以 `分享本站？他不敢相信。` 不命中。
        特别钉住 `他喊：“分享本站！”`——整行**蕴含**口号但前面有说话人，必须保留。"""
        for line in ('他喊：“分享本站！”', '她问：“分享本站？”',
                     '“我分享本站？不可能。”', '“他分享本站：一个奇怪的说法。”',
                     '“记住本站～然后呢？”',
                     '分享本站？他不敢相信。', '分享本站——这只是个玩笑。',
                     '分享本站：这句话他记得很清楚。',
                     '记住本站不迷路，然后继续走。', '记住本站不迷路？他反问。',
                     '记住本站不迷路：这才是重点。',
                     '请记住本站网址；不然会走丢。', '请记住本站网址？他没听清。',
                     '他念着“分享本站”这四个字。', '分享本站的口号他记了很多年。',
                     '请你不要分享本站的链接，好吗？',
                     '把记住本站不迷路写进了歌词里。'):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    def test_new_literals_stay_fixed_not_generalized(self):
        """约束钉子：补回的是固定字面，不是 `请?`/`(网址)?` 这类泛化。

        re.escape 是恒等 → 串里不含任何正则元字符，匹配面严格等于该串本身。
        把 `请记住本站网址` 改成 `请?记住本站(网址)?` 会被本用例抓到。"""
        for literal in labeler.INJECT_LITERALS:
            with self.subTest(literal=literal):
                self.assertEqual(re.escape(literal), literal)
        patterns = {p.pattern for p in labeler.INJECT_PATTERNS}
        for generalized in (r'请?记住本站(网址)?', '手机用户请'):
            with self.subTest(pattern=generalized):
                self.assertNotIn(generalized, patterns)

    def test_literal_patterns_are_whole_line_anchored(self):
        """结构钉子：短固定串**必须整行锚定**，不能裸 search。

        裸 search 只要求子串相邻，`他分享本站的帖子。` 会被误删——这正是本轮阻断的根因。
        去掉 `^…$` 锚会被 `test_round2_counterexamples_are_kept` 与下面的短串用例一起抓到。"""
        self.assertEqual(len(labeler.INJECT_LITERAL_PATTERNS), len(labeler.INJECT_LITERALS))
        for literal, pat in zip(labeler.INJECT_LITERALS, labeler.INJECT_LITERAL_PATTERNS):
            with self.subTest(literal=literal):
                self.assertTrue(pat.pattern.startswith('^'), pat.pattern)
                self.assertTrue(pat.pattern.endswith('$'), pat.pattern)
                self.assertIn(re.escape(literal), pat.pattern)

    def test_core_patterns_stay_unanchored(self):
        """反向钉子：CORE 整句标语**不能**加锚，否则真实噪声长句会漏剥。"""
        pat = labeler.INJECT_PATTERNS[0]
        self.assertFalse(pat.pattern.startswith('^'))
        long_noise = '本站提供无弹窗全文字在线阅读，更新速度快，请记住本站网址。'
        self.assertIsNotNone(pat.search(long_noise))
        self.assertEqual(labeler._drop_rule(long_noise), 'inject')

    def test_round2_counterexamples_are_kept(self):
        """独立构造的对白/独词/短行反例（未照抄复核语料）：误删必须为 0。

        重点是含「本站」「记住本站」「多多」「推荐」「全文字」的**非口号**句——
        固定字面的匹配面必须严格小于这些句子。

        其中 `“请记住本站的规矩。”` 是收窄的判据：它只比复核 A 组「应留」样例
        `“你给我记住本站的规矩。”` 少一个「给我」，若字面表里放的是裸形 `请记住本站`
        就会被误删。因此 `INJECT_LITERALS` 只收带「网址」的完整口号。
        代价是独立成行的裸形 `请记住本站` 会漏剥——有意付的，不在本用例钉。

        前 5 条（含 `他分享本站的帖子。` / `“我分享本站的东西，你有意见？”`）是
        确认方判阻断时实测的 da61153=keep → 97537eb=drop 误删；去掉整行锚就会全部变红。"""
        for line in (
            '他分享本站的帖子。',                 # 阻断实测误删（短串裸 search 会命中）
            '“我分享本站的东西，你有意见？”',     # 阻断实测误删
            '“你分享本站的文章，别人也受益。”',   # 阻断实测误删
            '“大家都记住本站不迷路就好。”',       # 阻断实测误删
            '“分享本站是我的习惯。”',             # 阻断实测误删
            '“请记住本站的规矩。”',              # 收窄判据：裸形 `请记住本站` 会误删它
            '“请记住本站的规矩，别乱跑。”',
            '“你把本站的规矩记牢了。”',          # 含「本站」但不含任何字面串
            '“你也记住本站的规矩。”',            # 含「记住本站」但没有「请」→ 不命中
            '“记住本站的路，别走岔了。”',         # 同上，句首无「请」
            '“本站的规矩，你也记住了。”',
            '“请记住，本站不欢迎外人。”',         # 「请记住」与「本站」被逗号隔开
            '“分享的书单在本站置顶。”',          # 「分享」「本站」不相邻
            '“上一章写完了，下一章还没动笔。”',   # 对白含 nav 词 + 中文逗号
            '“目录在中间，设置在最下面。”',
            '“字体再大一点。”',
            '章节目录在哪一页？',
            '他点开目录，又退了出来。',
            '手机屏幕黑了下去。',
            '书架的最上层落了灰。',
            '打赏的银子她一分没要。',
            '背景是灰蒙蒙的天。',
            '亮度低得看不清字。',
            '“夜。”',
            '“风……”',
            '门被推开，冷风灌了进来。',
            '“多多保重。”',                     # 含「多多」但非「多多分享本站」
            '“向我推荐几本书吧。”',              # 含「推荐」但非「推荐本书」整行
            '“微博上有人转了。”',                # 含「微博」但非「qq群和微博」
            '“高速路上的首发车队。”',            # 含「高速…首发」但非「高速首发…最新章节」
            '“全文字数一共三十万。”',            # 含「全文字」但非「全文字在线阅读」
        ):
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))


class TestGuards(unittest.TestCase):
    """护栏：清洗过度 / 定位失效要能被发现。"""

    def test_drop_ratio_is_reported(self):
        # 一半行是噪声 → 统计里能看出丢弃比例
        inner = '<p>' + '正文甲' * 20 + '</p><p>目录</p>'
        _, stats = labeler.clean_chapter_text(html_with(inner))
        self.assertGreater(stats['drop_ratio'], 0)
        self.assertLessEqual(stats['drop_ratio'], labeler.CLEAN_MAX_DROP_RATIO)

    def test_heavy_drop_trips_threshold(self):
        # 容器内几乎全是噪声 → 超阈值，fetch_chapter_text 会告警
        inner = ''.join(f'<p>{i}章节目录</p>' for i in range(1)) + '<p>目录</p>' * 10 + '<p>正</p>'
        _, stats = labeler.clean_chapter_text(html_with(inner))
        self.assertGreater(stats['drop_ratio'], labeler.CLEAN_MAX_DROP_RATIO)

    def test_clean_text_unchanged_when_no_noise(self):
        # 无噪声章节：清洗前后逐字相同（回归护栏）
        plain = '\n'.join(PROSE)
        text, stats = labeler.clean_chapter_text(html_with(paras(PROSE)))
        self.assertEqual(text, plain)
        self.assertEqual(stats['lines_dropped'], 0)
        self.assertEqual(stats['chars_after'], stats['chars_before'])

    def test_ui_line_cap_is_a_real_valve(self):
        """变异钉：把 UI_LINE_MAX_LEN 从 20 改大（如 60）必须被抓到。

        本行整行只由 UI 词+空格构成、但长于 20 字——长度上限就是为这种行留的安全阀，
        超过上限一律不剥（宁漏勿误删）。"""
        long_ui_row = '章节目录 阅读设置 加入书签 字体大小 返回目录 章节报错 打赏'
        self.assertGreater(len(long_ui_row), labeler.UI_LINE_MAX_LEN)
        self.assertLessEqual(len(long_ui_row), 60)
        self.assertIsNone(labeler._drop_rule(long_ui_row))


class TestFetchIntegration(unittest.TestCase):
    """fetch_chapter_text 接线：只做清洗，不改判定门。"""

    def test_no_network_and_no_prompt_change(self):
        calls = []
        original = labeler.http_get
        labeler.http_get = lambda url, timeout=30: calls.append(url) or QUIET_HTML
        try:
            text = labeler.fetch_chapter_text('/chapter/index1-2.html')
        finally:
            labeler.http_get = original
        self.assertEqual(calls, [labeler.BASE + '/chapter/index1-2.html'])
        self.assertEqual(text.split('\n'), PROSE)

    def test_warns_when_drop_exceeds_threshold(self):
        import contextlib
        import io
        original = labeler.http_get
        labeler.http_get = lambda url, timeout=30: CHAPTER_HTML
        buf = io.StringIO()
        try:
            with contextlib.redirect_stderr(buf):
                labeler.fetch_chapter_text('/chapter/index1-9.html')
        finally:
            labeler.http_get = original
        self.assertIn('清洗丢弃', buf.getvalue())

    def test_warns_when_container_missing(self):
        original = labeler.http_get
        labeler.http_get = lambda url, timeout=30: '<html><body>无正文</body></html>'
        try:
            text = labeler.fetch_chapter_text('/chapter/index1-3.html')
        finally:
            labeler.http_get = original
        self.assertEqual(text, '')

    def test_warns_when_falling_back_to_window(self):
        # 退回旧 25k 窗口意味着页脚噪声回归，必须显式告警而不是静默
        import contextlib
        import io
        original = labeler.http_get
        labeler.http_get = lambda url, timeout=30: (
            '<div id="chapter-content-panel"><p>' + '正' * 300 + '</p>')
        buf = io.StringIO()
        try:
            with contextlib.redirect_stderr(buf):
                labeler.fetch_chapter_text('/chapter/index1-4.html')
        finally:
            labeler.http_get = original
        self.assertIn('退回', buf.getvalue())

    def test_thresholds_are_declared(self):
        # 判定门与提示词不在本次改动范围：这里只是钉住常量仍在
        self.assertEqual(labeler.CLEAN_MAX_DROP_RATIO, 0.30)
        self.assertIn('含广告注入', labeler.SYSTEM_PROMPT)


class TestSplitNavAndSourceWatermark(unittest.TestCase):
    """t79 真数据实测的两类残留噪声（labeler-p0-report §2.2e）。

    旧 `nav` 规则要求**同一行内同时**含「上一章」「下一章」，而 book15.net 把两者
    渲染成两行（抽样 90 章里 86 章残留 `(英雄救美)下一章` 这类半截行）⇒ 几乎永不触发；
    上游书源（三七中文）的水印行每章 1 行，`INJECT_PATTERNS` 五条全不匹配。
    本组用例直接钉住这两处补强，**误删防线优先于覆盖率**。
    """

    SPLIT_NAV_DROPS = (
        '(英雄救美)下一章',              # t79 现场样本
        '(你也配)下一章',
        '(危机)下一章',
        '上一章(第11章 初入宗门)',
        '(第12章 比斗)下一章',
        '上一章(章节名)',
        '上一章 【第7章 出山】',
    )

    def test_split_nav_lines_are_dropped(self):
        """变异钉：把 `_nav_shape_ok` 退回旧的「两词同行」判据，本用例全组变红。"""
        for line in self.SPLIT_NAV_DROPS:
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'nav')

    SPLIT_NAV_KEEPS = (
        '他想起了上一章的内容',            # 🔴 本轮派单点名的反例：无标点也必须留
        '（他想起了上一章的事）',          # 整句被括号裹住，导航词在括号内
        '上一章的内容和下一章的内容',
        '他翻到上一章，又看了看下一章。',
        '“上一章写完了，下一章还没动笔。”',
    )

    def test_prose_mentioning_nav_words_is_kept(self):
        """变异钉：去掉整行结构判据、只留「行内出现导航词」，本组立刻变红。"""
        for line in self.SPLIT_NAV_KEEPS:
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    WATERMARK_DROPS = (
        '〖三七中文www.37zw.com〗百度搜索“37zw”访问',   # t79 现场样本 1（弯引号）
        '[三七中文www.37zw.com]百度搜索“37zw.com”',     # t79 现场样本 2（弯引号）
        '〖三七中文www.37zw.com〗百度搜索"37zw"访问',      # 直引号变体
        '[三七中文www.37zw.com]百度搜索"37zw.com"',        # 直引号变体
    )

    def test_source_watermark_lines_are_dropped(self):
        """变异钉：清空 `_WATERMARK_BRACKET_RE` / `_WATERMARK_RESIDUE_WORDS_RE` 任一条即变红。"""
        for line in self.WATERMARK_DROPS:
            with self.subTest(line=line):
                self.assertEqual(labeler._drop_rule(line), 'inject')

    WATERMARK_KEEPS = (
        '他打开浏览器，输入 www.37zw.com，页面却是一片空白。',
        '“这书是从37zw.com搬来的。”',
        '小说里提到的 www.37zw.com 只是一个虚构站点。',
        '他念道：“[www.37zw.com]”',       # 括号裹域名但句中还有说话人，整行非水印
    )

    def test_prose_mentioning_domain_is_kept(self):
        """反向钉子：只按「含域名」删会把这些正文行一起剥掉——锚点必须落在**括号包裹**上。"""
        for line in self.WATERMARK_KEEPS:
            with self.subTest(line=line):
                self.assertIsNone(labeler._drop_rule(line))

    def test_watermark_anchor_requires_bracketed_domain(self):
        # 结构钉子：裸域名（无括号包裹）不构成水印，任何情况下都不能只凭域名删行
        self.assertIsNone(labeler._WATERMARK_BRACKET_RE.search('www.37zw.com 全文字无水印'))
        self.assertIsNotNone(labeler._WATERMARK_BRACKET_RE.search('[三七中文www.37zw.com]'))

    def test_split_nav_and_watermark_survive_whole_chapter_pipeline(self):
        """接线：两类新噪声在 clean_chapter_text 里真的被剥掉，且正文一字不少。"""
        html = html_with(paras(
            PROSE[:2] + list(self.SPLIT_NAV_DROPS[:2]) + PROSE[2:]
            + list(self.WATERMARK_DROPS[:2])))
        text, stats = labeler.clean_chapter_text(html)
        self.assertEqual(stats['container'], 'closed')
        self.assertEqual(stats['lines_dropped'], 4)
        self.assertEqual(text.split('\n'), PROSE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
