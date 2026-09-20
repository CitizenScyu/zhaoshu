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
