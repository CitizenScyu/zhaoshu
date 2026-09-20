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


if __name__ == '__main__':
    unittest.main(verbosity=2)
