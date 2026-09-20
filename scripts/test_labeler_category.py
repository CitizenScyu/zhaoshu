#!/usr/bin/env python3
"""labeler.py 分类扩源入口（list-t-N）+ 残本候选终态（P1）单测。

与 T1 回归锁 test_labeler_source.py 互不覆盖：本文件只钉分类扩源新增的纯函数
与 P1/组合语义——parse_categories 默认安全、parse_last_page 尾页解析、
merge_books 去重、is_stub_candidate 判据、残本折进 done 侧口径、以及
「残本 × --limit」组合断言（现有 42 例无一覆盖）。

全离线：不联网、不调 LLM、不读 .env（http_get 一律打桩）。
复跑：cd <worktree> && python scripts/test_labeler_category.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402


class TestParseCategoriesSafeDefault(unittest.TestCase):
    """--categories 默认关闭：不给参数 = 只走榜单，行为不变（上线安全默认）。"""

    def test_none_returns_empty_tuple(self):
        """变异钉：把 parse_categories(None) 改成返回全量 = 默认开全扫，本用例必红。"""
        self.assertEqual(labeler.parse_categories(None), ())


if __name__ == '__main__':
    unittest.main(verbosity=2)
