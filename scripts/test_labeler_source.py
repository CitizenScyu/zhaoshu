#!/usr/bin/env python3
"""labeler.py 书源适配层（BookSource / BOOK15）单测（T1）。

目的：钉住 T1 解耦「book15 行为逐字不变」——
  * URL 归一：站内相对路径经 BOOK15.absolute 得到的绝对 URL = 解耦前的 BASE + path；
  * 章节列表解析：BOOK15.chapters_from_html = 解耦前 re.findall 的逐字输出（金样）；
  * 章节正文解析：BOOK15.parse_chapter_html = 解耦前 clean_chapter_text 的逐字输出（金样）；
  * 取正文链路的调用点确实经适配器取基址（fetch_chapters / fetch_chapter_text /
    fetch_book_text / split_queue），且能接入第二个源（T5 接入点）。

金样（GOLDEN_*）是用**解耦前**的 labeler.py 实跑采集的，与实现无关，故能作回归锁。
全离线：不联网、不调 LLM、不读 .env。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_source.py'
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402


# ---- 金样（解耦前实跑采集）----
DETAIL_HTML = """<html><body><div class="list">
<dd><a href="/chapter/index1-1.html">第一章 初入宗门</a></dd>
<dd class="x"><a href="/chapter/index1-2.html">第二章 山雨欲来</a></dd>
<dd><a href="/chapter/index12-345.html">第三百四十五章（完）</a></dd>
<dd><a href="/chapter/other.html">不是章节</a></dd>
</div></body></html>"""

GOLDEN_CHAPTERS = [
    ('/chapter/index1-1.html', '第一章 初入宗门'),
    ('/chapter/index1-2.html', '第二章 山雨欲来'),
    ('/chapter/index12-345.html', '第三百四十五章（完）'),
]

CHAP_HTML = """<html><body>
<div id="chapter-content-panel" class="content">
  <p>第二章 山雨欲来</p>
  <p>他推开窗，雨点打在青瓦上，噼啪作响。</p>
  <p>上一章(初入宗门)下一章</p>
  <p>章节目录 阅读设置 加入书签 字体大小</p>
  <p>本站提供无弹窗全文字在线阅读，更新速度快，请记住本站网址。</p>
  <p>雨停时，天边泛起一线鱼肚白，他握紧了手里的剑。</p>
</div>
<div class="footer"><p>目录</p><p>下一章</p></div>
</body></html>"""

GOLDEN_TEXT = ('第二章 山雨欲来\n他推开窗，雨点打在青瓦上，噼啪作响。\n'
               '雨停时，天边泛起一线鱼肚白，他握紧了手里的剑。')
GOLDEN_STATS = {
    'container': 'closed', 'lines_before': 6, 'lines_dropped': 3,
    'chars_before': 114, 'chars_after': 51, 'drop_ratio': 0.5526315789473684,
}


class TestBook15AdapterIdentity(unittest.TestCase):
    """适配器是解耦前逻辑的同一份：金样逐字相同。"""

    def test_base_matches_legacy_constant(self):
        """变异钉：把 BOOK15.base 改坏（如 https://book15.example）本用例必红。"""
        self.assertEqual(labeler.BOOK15.base, labeler.BASE)
        self.assertEqual(labeler.BOOK15.base, 'https://book15.net')
        self.assertIs(labeler.SOURCES['book15.net'], labeler.BOOK15)

    def test_relative_path_normalized_like_legacy_base_concat(self):
        """变异钉：改坏 BOOK15.base → 这里的 BASE + path 比对必红。"""
        for path in ('/books/details3168.html', '/chapter/index1-2.html', '/books/rank1.html'):
            with self.subTest(path=path):
                self.assertEqual(labeler.BOOK15.absolute(path), labeler.BASE + path)
                self.assertTrue(labeler.BOOK15.absolute(path).startswith('https://book15.net/'))

    def test_absolute_url_is_passed_through(self):
        for url in ('https://book15.net/books/details1.html', 'http://other.example/x'):
            with self.subTest(url=url):
                self.assertEqual(labeler.BOOK15.absolute(url), url)

    def test_chapter_list_parse_matches_legacy_regex_output(self):
        legacy = re.findall(
            r'<dd[^>]*>\s*<a[^>]*href="(/chapter/index\d+-\d+\.html)"[^>]*>([^<]{1,60})</a>',
            DETAIL_HTML)
        self.assertEqual(legacy, GOLDEN_CHAPTERS)
        self.assertEqual(labeler.BOOK15.chapters_from_html(DETAIL_HTML), GOLDEN_CHAPTERS)

    def test_chapter_body_parse_matches_legacy_output(self):
        text, stats = labeler.BOOK15.parse_chapter_html(CHAP_HTML)
        self.assertEqual(text, GOLDEN_TEXT)
        self.assertEqual(stats, GOLDEN_STATS)


class TestCallSitesGoThroughAdapter(unittest.TestCase):
    """调用点经适配器取基址/解析：http_get 收到的 URL 与解耦前逐字相同。"""

    def _patched(self, html):
        calls = []

        def fake_get(url, timeout=30):
            calls.append(url)
            return html

        return calls, fake_get

    def test_fetch_chapters_uses_adapter_absolute(self):
        calls, fake_get = self._patched(DETAIL_HTML)
        original = labeler.http_get
        labeler.http_get = fake_get
        try:
            got = labeler.fetch_chapters('/books/details3168.html')
        finally:
            labeler.http_get = original
        self.assertEqual(calls, [labeler.BASE + '/books/details3168.html'])
        self.assertEqual(got, GOLDEN_CHAPTERS)

    def test_fetch_chapter_text_uses_adapter_absolute(self):
        calls, fake_get = self._patched(CHAP_HTML)
        original = labeler.http_get
        labeler.http_get = fake_get
        try:
            text = labeler.fetch_chapter_text('/chapter/index1-2.html')
        finally:
            labeler.http_get = original
        self.assertEqual(calls, [labeler.BASE + '/chapter/index1-2.html'])
        self.assertEqual(text, GOLDEN_TEXT)

    def test_split_queue_uses_adapter_base(self):
        books = [{'url': '/books/detailsA.html'}]
        done = {labeler.BASE + '/books/detailsA.html'}
        todo, skipped_done, skipped_pinned = labeler.split_queue(books, done, set())
        self.assertEqual(todo, [])
        self.assertEqual(skipped_done, books)
        self.assertEqual(skipped_pinned, [])


class TestSecondSourceCanPlugIn(unittest.TestCase):
    """T5 接入点：第二个源只提供 base + 两个解析钩子即可接入，调用点零改动。"""

    def _demo_source(self):
        return labeler.BookSource(
            name='demo.example',
            base='https://demo.example',
            chapter_link_re=re.compile(r'href="(/c/\d+)"[^>]*>([^<]+)<'),
            parse_chapter_html=lambda html: (html, {'container': 'closed', 'drop_ratio': 0.0}))

    def test_fetch_chapters_with_custom_source(self):
        src = self._demo_source()
        calls = []
        original = labeler.http_get
        labeler.http_get = lambda url, timeout=30: calls.append(url) or '<a href="/c/7">第七章</a>'
        try:
            chapters = labeler.fetch_chapters('/book/1.html', source=src)
        finally:
            labeler.http_get = original
        self.assertEqual(calls, ['https://demo.example/book/1.html'])
        self.assertEqual(chapters, [('/c/7', '第七章')])

    def test_fetch_chapter_text_with_custom_source(self):
        src = self._demo_source()
        original = labeler.http_get
        labeler.http_get = lambda url, timeout=30: 'DEMO BODY'
        try:
            text = labeler.fetch_chapter_text('/c/7', source=src)
        finally:
            labeler.http_get = original
        self.assertEqual(text, 'DEMO BODY')

    def test_split_queue_with_custom_source(self):
        src = self._demo_source()
        books = [{'url': '/book/1.html'}]
        todo, _, _ = labeler.split_queue(books, {'https://demo.example/book/1.html'}, set(),
                                         source=src)
        self.assertEqual(todo, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
