#!/usr/bin/env python3
"""新增名单源（lists1104）单测：七猫榜单 + 17K 排行榜首页；名单自动加深（listdeep1105）。

背景（2026-11-04）：原名单源抽干，打标每轮候选 0–1 本。local-server 实测七猫 /paihang 与
17K /top/ 均为 SSR、UTF-8 可直抓。下列 HTML 是按实测结构缩写的合成片段。
全离线：http_get 由测试替身提供。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_lists1104.py
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from unittest import mock
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


def shuku_html(*books):
    """七猫书库列表页缩写（2026-11-05 .88 实测结构）：封面锚点 + span.s-tit 书名锚点 + s-author。"""
    return ''.join(
        f'<div class="cover-content"><a href="https://www.qimao.com/shuku/{i}/" target="_blank">'
        f'<img alt="{t}"></a></div><div class="text-top-row"><span class="s-tit" data-v-3>'
        f'<a href="https://www.qimao.com/shuku/{i}/" target="_blank" data-v-3>{t}</a></span>'
        f'<a href="https://www.qimao.com/shuku/a-56-58-a-a-a-a-click-1/" class="s-category">架空历史</a>'
        f'<span class="s-desc">简介</span></div><a href="https://www.qimao.com/zuozhe/x_14/" '
        f'target="_blank" class="s-author" data-v-3>{a}</a>'
        for i, (t, a) in enumerate(books, 100))


class QimaoParseTest(unittest.TestCase):
    def test_title_author_pairs_do_not_bleed_across_entries(self):
        books = dl.parse_qimao_rank(QIMAO_HTML)
        self.assertEqual([(b['title'], b['author']) for b in books],
                         [('合成甲书', '甲作者'), ('合成乙书：副标&题', ''), ('合成丙书', '丙作者')])
        self.assertEqual({b['origin'] for b in books}, {'七猫榜单'})

    def test_empty_page_yields_nothing(self):
        self.assertEqual(dl.parse_qimao_rank('<html></html>'), [])

    def test_shuku_page_takes_title_span_not_cover_or_category(self):
        books = dl.parse_qimao_shuku(shuku_html(('书库甲', '作者甲'), ('书库乙', '作者乙')))
        self.assertEqual([(b['title'], b['author'], b['origin']) for b in books],
                         [('书库甲', '作者甲', '七猫书库'), ('书库乙', '作者乙', '七猫书库')])
        self.assertEqual(dl.parse_qimao_shuku(QIMAO_HTML), [])      # 榜单页形态不误认


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


class ListDeepenTest(unittest.TestCase):
    """listdeep1105：固定名单打干后，队列不足下限就按游标翻七猫书库，游标跨轮只进不退。"""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.cursor_path = self.dir / dl.LIST_CURSOR_FILENAME
        self.seen = []
        self.pages = {}             # 页码 → HTML；缺省 = 空页
        self.fail_pages = set()
        self.out = io.StringIO()

    def http_get(self, url):
        self.seen.append(url)
        for page in self.fail_pages:
            if url == dl.QIMAO_SHUKU_URL.format(page=page):
                raise ConnectionError('synthetic down')
        for page, html in self.pages.items():
            if url == dl.QIMAO_SHUKU_URL.format(page=page):
                return html
        return '<html></html>'

    def shuku_urls(self):
        return [u for u in self.seen if u.startswith(dl.QIMAO_BASE + '/shuku/')]

    def build(self, cursor, deepen_min=3, hit=lambda b: True):
        def fake_resolve(candidates, *_args, **_kwargs):
            return [{'title': b['title'], 'url': f'u:{b["title"]}', 'origin': b['origin']}
                    for b in candidates if hit(b)]

        with contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.out), \
                mock.patch.object(dl, '_resolve_candidates', fake_resolve), \
                mock.patch.object(dl, 'LIST_DEEPEN_PAGE_DELAY', 0):
            return dl.build_webnovel_queue(self.http_get, include_douban=False,
                                           list_cursor=cursor, deepen_min=deepen_min)

    def test_lean_queue_pages_forward_until_enough_and_cursor_persists(self):
        self.pages = {1: shuku_html(('一甲', 'a'), ('一乙', 'b')),
                      2: shuku_html(('二甲', 'c'), ('二乙', 'd')),
                      3: shuku_html(('三甲', 'e'))}
        cursor = dl.ListCursor.load(self.cursor_path)
        queue = self.build(cursor, deepen_min=3)
        self.assertEqual([q['title'] for q in queue], ['一甲', '一乙', '二甲', '二乙'])
        self.assertEqual(self.shuku_urls(), [dl.QIMAO_SHUKU_URL.format(page=p) for p in (1, 2)])
        cursor.save()
        self.assertEqual(json.loads(self.cursor_path.read_text(encoding='utf-8'))['pages'],
                         {dl.LIST_CURSOR_QIMAO: 3})
        # 下一轮从第 3 页接着翻，不重翻 1–2 页；第 4 页空 → 游标回第 1 页
        self.seen.clear()
        cursor = dl.ListCursor.load(self.cursor_path)
        queue = self.build(cursor, deepen_min=3)
        self.assertEqual([q['title'] for q in queue], ['三甲'])
        self.assertEqual(self.shuku_urls(), [dl.QIMAO_SHUKU_URL.format(page=p) for p in (3, 4)])
        self.assertEqual(cursor.get(dl.LIST_CURSOR_QIMAO), 1)
        self.assertIn('第 4 页无书', self.out.getvalue())

    def test_pages_that_resolve_nothing_still_advance_and_are_bounded(self):
        self.pages = {p: shuku_html((f'{p}号', 'x')) for p in range(1, 20)}
        cursor = dl.ListCursor(self.cursor_path)
        queue = self.build(cursor, deepen_min=3, hit=lambda b: False)
        self.assertEqual(queue, [])
        self.assertEqual(len(self.shuku_urls()), dl.LIST_DEEPEN_MAX_PAGES)
        self.assertEqual(cursor.get(dl.LIST_CURSOR_QIMAO), dl.LIST_DEEPEN_MAX_PAGES + 1)

    def test_fetch_failure_keeps_cursor_on_that_page(self):
        self.fail_pages = {5}
        cursor = dl.ListCursor(self.cursor_path, {dl.LIST_CURSOR_QIMAO: 5})
        self.assertEqual(self.build(cursor), [])
        self.assertEqual(cursor.get(dl.LIST_CURSOR_QIMAO), 5)
        self.assertFalse(cursor.dirty)
        self.assertIn('游标留在本页', self.out.getvalue())

    def test_no_deepening_when_queue_is_enough_or_switch_off(self):
        self.pages = {1: shuku_html(('一甲', 'a'))}
        self.assertEqual(self.build(dl.ListCursor(self.cursor_path), deepen_min=0), [])
        self.assertEqual(self.build(None, deepen_min=3), [])
        self.assertEqual(self.shuku_urls(), [])
        with mock.patch.object(dl, 'fetch_qimao_rank_books',
                               return_value=[{'title': t, 'author': ''} for t in ('榜甲', '榜乙', '榜丙')]):
            queue = self.build(dl.ListCursor(self.cursor_path), deepen_min=3)
        self.assertEqual(len(queue), 3)
        self.assertEqual(self.shuku_urls(), [])

    def test_shuku_titles_already_on_fixed_lists_are_not_resolved_twice(self):
        self.pages = {1: shuku_html(('合成甲书', '甲作者'), ('书库新', 'n'))}
        resolved = []

        def fake_resolve(candidates, *_args, **_kwargs):
            resolved.append([b['title'] for b in candidates])
            return []

        orig_get = self.http_get

        def http_get(url):
            if url.startswith(dl.QIMAO_BASE + '/paihang/'):
                return QIMAO_HTML
            return orig_get(url)

        with contextlib.redirect_stdout(self.out), \
                mock.patch.object(dl, '_resolve_candidates', fake_resolve), \
                mock.patch.object(dl, 'LIST_DEEPEN_PAGE_DELAY', 0), \
                mock.patch.object(dl, 'LIST_DEEPEN_MAX_PAGES', 1):
            dl.build_webnovel_queue(http_get, include_douban=False,
                                    list_cursor=dl.ListCursor(self.cursor_path), deepen_min=3)
        self.assertEqual(resolved[-1], ['书库新'])

    def test_corrupt_cursor_file_starts_from_page_one(self):
        self.cursor_path.write_text('{oops', encoding='utf-8')
        with contextlib.redirect_stderr(self.out):
            cursor = dl.ListCursor.load(self.cursor_path)
        self.assertEqual(cursor.get(dl.LIST_CURSOR_QIMAO), 1)
        self.cursor_path.write_text(json.dumps({'pages': {dl.LIST_CURSOR_QIMAO: True, 'x': 0}}),
                                    encoding='utf-8')
        self.assertEqual(dl.ListCursor.load(self.cursor_path).pages, {})

    def test_resolve_list_deepen_min(self):
        self.assertEqual(dl.resolve_list_deepen_min({}), dl.LIST_DEEPEN_MIN)
        self.assertEqual(dl.resolve_list_deepen_min({dl.LIST_DEEPEN_ENV: '0'}), 0)
        self.assertEqual(dl.resolve_list_deepen_min({dl.LIST_DEEPEN_ENV: '25'}), 25)
        self.assertEqual(dl.resolve_list_deepen_min({dl.LIST_DEEPEN_ENV: 'x'}), dl.LIST_DEEPEN_MIN)


if __name__ == '__main__':
    unittest.main()
