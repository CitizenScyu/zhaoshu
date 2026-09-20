#!/usr/bin/env python3
"""labeler.py 分类扩源入口（list-t-N）+ 残本候选终态（P1）单测。

与 T1 回归锁 test_labeler_source.py 互不覆盖：本文件只钉分类扩源新增的纯函数
与 P1/组合语义——parse_categories 默认安全、parse_last_page 尾页解析、
merge_books 去重、is_stub_candidate 判据、残本折进 done 侧口径、以及
「残本 × --limit」组合断言（现有 42 例无一覆盖）。

全离线：不联网、不调 LLM、不读 .env（http_get 一律打桩）。
复跑：cd <worktree> && python scripts/test_labeler_category.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402


def write_jsonl(path: Path, rows) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        for row in rows:
            f.write((row if isinstance(row, str)
                     else json.dumps(row, ensure_ascii=False)) + '\n')


# ---- 真实 HTML 片段（branch2 用 curl 抓回，2026-09-18 实测，未改一字）----
# list-t-23.html?page=1：尾页 = 2（共16条记录）
TAIL_PAGE_HTML_T23 = (
    '<div class="public-page"><ul class="pagination">'
    '<li><a href="/books/list-t-23.html?page=1">首页</a></li> '
    '<li class="disabled"><span>上一页</span></li> '
    '<li class="active"><span>1</span></li>'
    '<li><a href="/books/list-t-23.html?page=2">2</a></li> '
    '<li><a href="/books/list-t-23.html?page=2">下一页</a></li> '
    '<li><a href="/books/list-t-23.html?page=2">尾页</a></li> '
    '<li class="more">共16条记录</li></ul></div>'
)
# list-t-3.html?page=70：中段页带省略号，尾页 = 133（不能被「下一页 71」带偏）
TAIL_PAGE_HTML_T3_P70 = (
    '<ul class="pagination">'
    '<li><a href="/books/list-t-3.html?page=69">上一页</a></li> '
    '<li class="active"><span>70</span></li>'
    '<li><a href="/books/list-t-3.html?page=71">71</a></li>'
    '<li><a href="/books/list-t-3.html?page=133">尾页</a></li>'
    '<li class="more">共1995条记录</li></ul>'
)
# 详情页 og:novel 元数据 + 12 章 dd 列表（形态与实测一致）
DETAIL_HTML = (
    '<html><head>'
    '<meta property="og:novel:author" content="忘语"/>'
    '<meta property="og:novel:category" content="玄幻奇幻"/>'
    '<meta property="og:novel:status" content="连载中"/>'
    '</head><body><div id="list">'
    + ''.join(f'<dd><a href="/chapter/index{100 + i}-{i}.html">第{i}章 测试章节</a></dd>'
              for i in range(1, 13))
    + '</div></body></html>'
)


def _anchor(details_id: int, title: str) -> str:
    return f'<a href="/books/details{details_id}.html">{title}</a>'


def _list_page(grid_ids, sidebar_ids=(9001, 9002), tail: str = '') -> str:
    """合成分类列表页：真网格 + 每页固定侧栏（侧栏在真实页面里每页相同）。"""
    body = ''.join(_anchor(i, f'网格{i}') for i in grid_ids)
    side = ''.join(_anchor(i, f'侧栏{i}') for i in sidebar_ids)
    return f'<html><body>{body}{side}{tail}</body></html>'


def _tail_link(cat: int, page: int) -> str:
    return (f'<ul class="pagination"><li><a href="/books/list-t-{cat}.html?page=1">首页</a></li>'
            f'<li><a href="/books/list-t-{cat}.html?page={page}">尾页</a></li></ul>')


class TestParseCategoriesSafeDefault(unittest.TestCase):
    """--categories 默认关闭：不给参数 = 只走榜单，行为不变（上线安全默认）。"""

    def test_none_returns_empty_tuple(self):
        """变异钉：把 parse_categories(None) 改成返回全量 = 默认开全扫，本用例必红。"""
        self.assertEqual(labeler.parse_categories(None), ())

    def test_empty_and_none_string_disable(self):
        """空串 / 'none'（含大小写与空白）同样关闭分类入口。"""
        for spec in ('', '   ', 'none', 'None', ' NONE '):
            with self.subTest(spec=spec):
                self.assertEqual(labeler.parse_categories(spec), ())

    def test_all_returns_full_category_pages(self):
        """'all' = 全量 CATEGORY_PAGES（显式全量）。"""
        self.assertEqual(labeler.parse_categories('all'), tuple(labeler.CATEGORY_PAGES))
        self.assertEqual(labeler.parse_categories(' ALL '), tuple(labeler.CATEGORY_PAGES))

    def test_comma_list_parsed_and_deduped_in_order(self):
        """逗号列表按出现顺序取整数，重复项去重、空段忽略。"""
        self.assertEqual(labeler.parse_categories('3,21,23'), (3, 21, 23))
        self.assertEqual(labeler.parse_categories('3, 3 ,21,3'), (3, 21))
        self.assertEqual(labeler.parse_categories('3,,,21'), (3, 21))

    def test_invalid_spec_exits(self):
        """非整数 / 非正整数一律 sys.exit，不静默忽略（省得以为限了范围其实没限）。"""
        for spec in ('3,abc', '3,0', '3,-1', 'foo'):
            with self.subTest(spec=spec):
                with self.assertRaises(SystemExit):
                    labeler.parse_categories(spec)


class TestParseLastPage(unittest.TestCase):
    """分类列表页尾页页码从 HTML 解析，不写死（各类不同且随书目增长）。"""

    def test_parses_last_page_number(self):
        html = '<li><a href="/books/list-t-3.html?page=133">尾页</a></li>'
        self.assertEqual(labeler.parse_last_page(html), 133)

    def test_handles_ampersand_and_other_params(self):
        html = '<a href="/books/list-t-21.html?foo=1&page=93">尾页</a>'
        self.assertEqual(labeler.parse_last_page(html), 93)

    def test_missing_tail_link_returns_none(self):
        """无「尾页」链接（单页 / 结构变化）→ None，调用方回落 1 页。"""
        self.assertIsNone(labeler.parse_last_page('<a href="/x?page=2">下一页</a>'))
        self.assertIsNone(labeler.parse_last_page('<html>no pager</html>'))

    def test_real_two_page_category_fragment(self):
        """真实片段（list-t-23 p1，共16条）：尾页=2。"""
        self.assertEqual(labeler.parse_last_page(TAIL_PAGE_HTML_T23), 2)

    def test_real_middle_page_fragment_reports_tail_not_next(self):
        """真实中段片段（list-t-3 p70）：取到 133，不被「下一页 71」带偏。"""
        self.assertEqual(labeler.parse_last_page(TAIL_PAGE_HTML_T3_P70), 133)

    def test_next_page_link_alone_is_not_a_tail(self):
        """变异钉：把锚定放宽成「任何 page= 链接」时本用例必红。"""
        html = ('<ul><li><a href="/books/list-t-3.html?page=1">首页</a></li>'
                '<li><a href="/books/list-t-3.html?page=2">下一页</a></li></ul>')
        self.assertIsNone(labeler.parse_last_page(html))

    def test_zero_page_and_missing_param_and_non_numeric(self):
        self.assertIsNone(labeler.parse_last_page('<a href="/books/list-t-3.html?page=0">尾页</a>'))
        self.assertIsNone(labeler.parse_last_page('<a href="/books/list-t-3.html">尾页</a>'))
        self.assertIsNone(labeler.parse_last_page('<a href="/books/x.html?page=abc">尾页</a>'))


class TestMergeBooks(unittest.TestCase):
    """多路书目按 url 去重合并：先出现者优先（榜单路在前、分类路在后）。"""

    def test_dedup_keeps_first_occurrence_title(self):
        rank = [{'url': '/books/details1.html', 'title': '榜单甲'},
                {'url': '/books/details2.html', 'title': '榜单乙'}]
        cat = [{'url': '/books/details2.html', 'title': '分类乙改名'},   # 同 url 被前者占
               {'url': '/books/details3.html', 'title': '分类丙'}]
        merged = labeler.merge_books(rank, cat)
        self.assertEqual([b['url'] for b in merged],
                         ['/books/details1.html', '/books/details2.html',
                          '/books/details3.html'])
        # 先出现者（榜单）的 title 保留，后路同 url 的改名被丢弃
        self.assertEqual(merged[1]['title'], '榜单乙')

    def test_missing_url_entries_dropped(self):
        self.assertEqual(labeler.merge_books([{'title': '无 url'}], []), [])

    def test_empty_groups_yield_empty(self):
        self.assertEqual(labeler.merge_books([], []), [])


class TestIsStubCandidate(unittest.TestCase):
    """残本判据：章节数 < 阈值 或 正文字数 < 阈值 ⇒ 残本（返回原因），否则 None。"""

    def test_below_min_chapters_flagged(self):
        reason = labeler.is_stub_candidate(labeler.STUB_MIN_CHAPTERS - 1,
                                           labeler.STUB_MIN_CHARS)
        self.assertIsNotNone(reason)
        self.assertIn('章节数', reason)

    def test_below_min_chars_flagged(self):
        reason = labeler.is_stub_candidate(labeler.STUB_MIN_CHAPTERS,
                                           labeler.STUB_MIN_CHARS - 1)
        self.assertIsNotNone(reason)
        self.assertIn('正文字数', reason)

    def test_at_thresholds_is_not_stub(self):
        """边界闭区间：恰好达阈值不算残本（变异钉：把 < 改成 <= 本用例必红）。"""
        self.assertIsNone(labeler.is_stub_candidate(labeler.STUB_MIN_CHAPTERS,
                                                    labeler.STUB_MIN_CHARS))

    def test_chapter_count_checked_before_chars(self):
        """章节数不足优先短路（不必抓全本正文即可判残本）。"""
        reason = labeler.is_stub_candidate(0, 0)
        self.assertIn('章节数', reason)


class TestLoadStubUrls(unittest.TestCase):
    """labels-stub.jsonl → 残本候选 url 集合（与 done_urls 同口径参与跳过）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'labels-stub.jsonl'

    def test_reads_urls_and_skips_bad_lines(self):
        write_jsonl(self.path, [
            {'url': labeler.BASE + '/books/details1.html', 'reason': '章节数 3 < 10'},
            '坏行',
            {'reason': '缺 url'},
            {'url': labeler.BASE + '/books/details2.html'},
        ])
        self.assertEqual(labeler.load_stub_urls(self.path), {
            labeler.BASE + '/books/details1.html',
            labeler.BASE + '/books/details2.html'})

    def test_missing_file_is_empty(self):
        self.assertEqual(labeler.load_stub_urls(
            Path(self.tmp.name) / 'nope.jsonl'), set())


class TestCategoryUrl(unittest.TestCase):
    def test_format(self):
        self.assertEqual(labeler.category_url(23, 2),
                         'https://book15.net/books/list-t-23.html?page=2')


class TestFetchCategoryBooks(unittest.TestCase):
    """分类翻页：先解析尾页、再逐页拉；侧栏靠 seen 去重；超上界只取前 max_pages 页。
    移植自 branch2，http_get 全打桩离线。"""

    def setUp(self):
        self.calls = []

    def _serve(self, pages: dict):
        def fake(url, timeout=30):
            self.calls.append(url)
            if url in pages:
                return pages[url]
            raise RuntimeError(f'未打桩的 URL: {url}')
        return fake

    def _run(self, pages, **kw):
        original = labeler.http_get
        labeler.http_get = self._serve(pages)
        try:
            return labeler.fetch_category_books(page_delay=0, **kw)
        finally:
            labeler.http_get = original

    def test_walks_first_to_tail_and_dedupes_sidebar(self):
        pages = {
            labeler.category_url(23, 1): _list_page([101, 102], tail=_tail_link(23, 2)),
            labeler.category_url(23, 2): _list_page([103], tail=_tail_link(23, 2)),
        }
        books = self._run(pages, categories=(23,), max_pages=200)
        urls = [b['url'] for b in books]
        self.assertEqual(urls, ['/books/details101.html', '/books/details102.html',
                                '/books/details9001.html', '/books/details9002.html',
                                '/books/details103.html'])
        self.assertEqual(self.calls,
                         [labeler.category_url(23, 1), labeler.category_url(23, 2)])
        self.assertEqual(books[0]['title'], '网格101')

    def test_max_pages_caps_a_long_category(self):
        """🔴 安全上界：尾页 133 但 --max-pages 2 ⇒ 只拉 2 页。"""
        import contextlib
        import io
        pages = {labeler.category_url(3, 1): _list_page([1], tail=_tail_link(3, 133)),
                 labeler.category_url(3, 2): _list_page([2]),
                 labeler.category_url(3, 3): _list_page([3])}
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self._run(pages, categories=(3,), max_pages=2)
        self.assertEqual(self.calls, [labeler.category_url(3, p) for p in (1, 2)])
        self.assertIn('超过上界', err.getvalue())

    def test_single_page_without_tail_link(self):
        pages = {labeler.category_url(23, 1): _list_page([7])}
        self._run(pages, categories=(23,), max_pages=200)
        self.assertEqual(self.calls, [labeler.category_url(23, 1)])

    def test_first_page_failure_skips_that_category_only(self):
        import contextlib
        import io
        pages = {labeler.category_url(3, 1): _list_page([5])}   # t-23 未打桩 → 抛错
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            books = self._run(pages, categories=(23, 3), max_pages=200)
        self.assertIn('分类 t-23 第 1 页拉取失败', err.getvalue())
        urls = [b['url'] for b in books]
        self.assertEqual(urls[0], '/books/details5.html')   # t-3 网格书仍拉到
        # t-23 整类被跳过（第 1 页失败），其网格书一本都不在
        self.assertNotIn('/books/details101.html', urls)

    def test_midpage_failure_continues_with_remaining_pages(self):
        import contextlib
        import io
        pages = {labeler.category_url(3, 1): _list_page([1], tail=_tail_link(3, 3)),
                 labeler.category_url(3, 3): _list_page([3])}   # 第 2 页缺失
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            books = self._run(pages, categories=(3,), max_pages=200)
        self.assertIn('第 2 页拉取失败', err.getvalue())
        self.assertIn('/books/details3.html', [b['url'] for b in books])

    def test_page_delay_applied_between_pages_only(self):
        from unittest import mock
        pages = {labeler.category_url(3, 1): _list_page([1], tail=_tail_link(3, 2)),
                 labeler.category_url(3, 2): _list_page([2])}
        sleeps = []
        original = labeler.http_get
        labeler.http_get = self._serve(pages)
        try:
            with mock.patch.object(labeler.time, 'sleep', lambda s: sleeps.append(s)):
                labeler.fetch_category_books(categories=(3,), max_pages=200, page_delay=1.2)
        finally:
            labeler.http_get = original
        self.assertEqual(sleeps, [1.2])       # 2 页 ⇒ 只睡 1 次页间


class TestStubTimesLimit(unittest.TestCase):
    """P1 核心组合断言：残本 × --limit —— 残本不得永久占住 --limit 名额把正常书饿死。

    诊断（labeler.py 文件头 P1）：残本候选一旦记入 labels-stub.jsonl，下轮必须与
    done_urls **同口径**在 split_queue 中先剔除，再切 --limit。否则残本堆在队首、
    小 limit 一切全是残本，正常书永远排不进本轮视野（exit 0 的饥饿）。
    现有 42 例（source/pinned/clean/import/engine）无一覆盖「残本 × limit」这一组合。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        self.data_dir = d
        # details1..5 = 已记录的残本；details6..10 = 正常书
        self.stub_urls = [labeler.BASE + f'/books/details{i}.html' for i in range(1, 6)]
        write_jsonl(d / 'labels-stub.jsonl',
                    [{'url': u, 'title': f'残本{i}', 'reason': '章节数 3 < 10'}
                     for i, u in enumerate(self.stub_urls, 1)])
        self.books = (
            [{'url': f'/books/details{i}.html', 'title': f'残本{i}'} for i in range(1, 6)]
            + [{'url': f'/books/details{i}.html', 'title': f'正常{i}'} for i in range(6, 11)])

    def _dry_run(self, limit):
        import contextlib
        import io
        buf = io.StringIO()
        from unittest import mock
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.data_dir)}), \
                mock.patch.object(labeler, 'fetch_rank_books', return_value=list(self.books)), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--dry-run', '--no-db-model',
                                                '--limit', str(limit)]), \
                contextlib.redirect_stdout(buf):
            rc = labeler.main()
        return rc, buf.getvalue()

    def test_recorded_stubs_folded_into_skip_before_limit(self):
        """残本折进「已完成」侧先剔除，--limit 只切在正常书上——正常书不被饿死。"""
        rc, out = self._dry_run(3)
        self.assertEqual(rc, 0)
        # 5 残本折进跳过侧（含钉子户 0），正常书 5 本切到 limit=3
        self.assertIn('本轮处理 3 本（跳过已完成 5 本（含钉子户 0 本））', out)
        # 关键：正常书确实进了本轮视野（没被残本占满 limit 饿死）
        self.assertIn(' - 正常6', out)
        self.assertIn(' - 正常8', out)
        # 残本一个都不在本轮队列（被当作已完成跳过）
        for i in range(1, 6):
            self.assertNotIn(f' - 残本{i}', out)
        # limit=3 生效：正常 9/10 被切掉
        self.assertNotIn(' - 正常9', out)
        self.assertNotIn(' - 正常10', out)

    def test_all_stubs_recorded_means_no_starvation_regression(self):
        """变异钉：若 main() 改回 `done_urls`（漏掉 `| stub_urls`），残本会重回队首，
        limit=2 时本轮全是残本、正常书 0 本 —— 下面对正常书的断言必红。"""
        rc, out = self._dry_run(2)
        self.assertEqual(rc, 0)
        self.assertIn('本轮处理 2 本', out)
        self.assertIn(' - 正常6', out)
        self.assertIn(' - 正常7', out)


class TestRuntimeStubDetection(unittest.TestCase):
    """运行时残本检测（非 dry-run）：章节数不足的书被记入 labels-stub.jsonl，
    形成 P1 闭环（下轮据此跳过）。全离线：http_get 打桩、不触达 LLM。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        self.data_dir = d
        # 详情页只有 3 章（< STUB_MIN_CHAPTERS=10）⇒ 章节数短路判残本，绝不抓全本正文
        self.detail_html = (
            '<html><body>'
            '<dd><a href="/chapter/index1-1.html">第一章</a></dd>'
            '<dd><a href="/chapter/index1-2.html">第二章</a></dd>'
            '<dd><a href="/chapter/index1-3.html">第三章</a></dd>'
            '</body></html>')
        self.books = [{'url': f'/books/details{i}.html', 'title': f'残本{i}'}
                      for i in range(1, 4)]

    def test_short_book_recorded_to_stub_and_never_reaches_llm(self):
        import contextlib
        import io
        from unittest import mock
        buf = io.StringIO()

        def boom(*a, **k):
            raise AssertionError('残本不应触达 label_book（应在章节数处短路）')

        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.data_dir)}), \
                mock.patch.object(labeler, 'fetch_rank_books', return_value=list(self.books)), \
                mock.patch.object(labeler, 'http_get', return_value=self.detail_html), \
                mock.patch.object(labeler, 'label_book', side_effect=boom), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--no-db-model', '--limit', '5']), \
                contextlib.redirect_stdout(buf):
            rc = labeler.main()
        out = buf.getvalue()
        self.assertEqual(rc, 0)                      # 无成功也无失败（残本跳过），fail==0
        self.assertIn('残本候选跳过 3', out)
        stub_written = labeler.load_stub_urls(self.data_dir / 'labels-stub.jsonl')
        # 三本残本 url 全部落盘 → 下轮 load_stub_urls 会把它们折进跳过侧（P1 闭环）
        self.assertEqual(stub_written,
                         {labeler.BASE + f'/books/details{i}.html' for i in range(1, 4)})


if __name__ == '__main__':
    unittest.main(verbosity=2)
