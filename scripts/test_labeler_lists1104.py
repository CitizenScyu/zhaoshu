#!/usr/bin/env python3
"""新增名单源（lists1104）单测：七猫榜单 + 17K 排行榜首页。

背景（2026-11-04）：原名单源抽干，打标每轮候选 0–1 本。local-server 实测七猫 /paihang 与
17K /top/ 均为 SSR、UTF-8 可直抓。下列 HTML 是按实测结构缩写的合成片段。
全离线：http_get 由测试替身提供。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_lists1104.py
"""
import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import douban_list as dl  # noqa: E402

QIMAO_HTML = """<div class="txt"><div class="txt-row">
<a href="https://www.qimao.com/shuku/1/" target="_blank" class="s-book-title" data-v-1>合成甲书</a></div>
<span class="s-book-info"><a href="https://www.qimao.com/zuozhe/a_1/" target="_blank" data-v-1>甲作者</a>
<a href="https://www.qimao.com/shuku/a-203-a-a-a-a-a-click-1/" data-v-1>都市</a></span></div>
<div class="txt"><a href="https://www.qimao.com/shuku/2/" class="s-book-title">合成乙书：副标&amp;题</a>
<span class="s-book-info"><em>连载中</em></span></div>
<div class="txt"><a href="https://www.qimao.com/shuku/3/" class="s-book-title">合成丙书</a>
<a href="https://www.qimao.com/zuozhe/c_3/">丙作者</a></div>
<div class="txt"><a href="https://www.qimao.com/shuku/4/" class="s-book-title">合成甲书</a>
<a href="https://www.qimao.com/zuozhe/a_1/">甲作者</a></div>"""

Y17K_TOP_HTML = """<li><span class="num">1</span><a href="//www.17k.com/book/11.html" target="_blank">合成丁书</a></li>
<li><span class="num">2</span><a href="//www.17k.com/book/12.html" target="_blank">姐夫，我姐叫你当...</a></li>"""


class QimaoParseTest(unittest.TestCase):
    def test_title_author_pairs_do_not_bleed_across_entries(self):
        books = dl.parse_qimao_rank(QIMAO_HTML)
        self.assertEqual([(b['title'], b['author']) for b in books],
                         [('合成甲书', '甲作者'), ('合成乙书：副标&题', ''), ('合成丙书', '丙作者')])
        self.assertEqual({b['origin'] for b in books}, {'七猫榜单'})

    def test_empty_page_yields_nothing(self):
        self.assertEqual(dl.parse_qimao_rank('<html></html>'), [])


class BuildQueueTest(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.out = io.StringIO()

    def http_get(self, url):
        self.seen.append(url)
        if url.startswith(dl.QIMAO_BASE + '/paihang/'):
            if url.endswith('/boy/new/date/'):
                raise ConnectionError('synthetic down')
            return QIMAO_HTML
        if url == dl.Y17K_BASE + '/top/':
            return Y17K_TOP_HTML
        return '<html></html>'

    def build(self):
        captured = []

        def fake_resolve(candidates, *_args, **_kwargs):
            captured.extend(candidates)
            return []

        with contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.out):
            orig = dl._resolve_candidates
            dl._resolve_candidates = fake_resolve
            try:
                dl.build_webnovel_queue(self.http_get, include_douban=False)
            finally:
                dl._resolve_candidates = orig
        return captured

    def test_new_sources_feed_candidates_and_one_bad_rank_does_not_sink_the_rest(self):
        candidates = self.build()
        for rank in dl.QIMAO_RANKS:
            self.assertIn(f'{dl.QIMAO_BASE}/paihang/{rank}/', self.seen)
        self.assertIn(dl.Y17K_BASE + '/top/', self.seen)
        by_title = {c['title']: c['origin'] for c in candidates}
        self.assertEqual(by_title['合成甲书'], '七猫榜单')
        self.assertEqual(by_title['合成丁书'], '17K榜单')
        self.assertNotIn('姐夫，我姐叫你当...', by_title)      # 截断标题丢弃
        self.assertEqual(sum(1 for c in candidates if c['title'] == '合成甲书'), 1)  # 跨榜去重
        self.assertIn('七猫[boy/new/date] 拉取失败', self.out.getvalue())


if __name__ == '__main__':
    unittest.main()
