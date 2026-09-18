#!/usr/bin/env python3
"""labeler.py「钉子户终态」的离线单测（诊断 P1-1）。

背景：被拒的书不进 labels.jsonl，断点续传（done_urls）认不出来，于是每轮都被
重新抓取 + 重新打标 + 重新拒收（5 本钉子户历史被拒 34~51 次，每轮白烧 ~25 分钟）。

全离线：不联网、不调 LLM。复跑：
    python scripts/test_labeler_pinned.py
    python -m unittest discover -s scripts -p 'test_labeler_pinned.py'
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import douban_list  # noqa: E402
import labeler  # noqa: E402


def write_jsonl(path: Path, rows) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        for row in rows:
            f.write((row if isinstance(row, str)
                     else json.dumps(row, ensure_ascii=False)) + '\n')


class TestCountRejections(unittest.TestCase):
    """拒收计数：逐行累加，坏行不拖垮整轮。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'labels-rejected.jsonl'

    def test_counts_are_per_url(self):
        write_jsonl(self.path, [
            {'url': 'https://book15.net/books/details1.html'},
            {'url': 'https://book15.net/books/details1.html'},
            {'url': 'https://book15.net/books/details2.html'},
        ])
        self.assertEqual(labeler.count_rejections(self.path), {
            'https://book15.net/books/details1.html': 2,
            'https://book15.net/books/details2.html': 1,
        })

    def test_missing_file_is_empty_not_an_error(self):
        self.assertEqual(labeler.count_rejections(
            Path(self.tmp.name) / 'nope.jsonl'), {})

    def test_empty_file_is_empty(self):
        self.path.write_text('', encoding='utf-8')
        self.assertEqual(labeler.count_rejections(self.path), {})

    def test_broken_and_blank_lines_are_skipped(self):
        write_jsonl(self.path, [
            '',
            '   ',
            '{ 截断的 json',
            '[1, 2, 3]',                      # 合法 json 但不是对象
            '"字符串"',                       # 同上
            '{"reason": "没有 url 字段"}',      # 字段缺失
            '{"url": ""}',                    # 空 url
            '{"url": 123}',                   # 非字符串 url
            {'url': 'https://book15.net/books/details9.html'},
        ])
        self.assertEqual(labeler.count_rejections(self.path),
                         {'https://book15.net/books/details9.html': 1})


class TestTerminalThreshold(unittest.TestCase):
    """终态判定：≥ 阈值才跳，边界是闭区间。"""

    URL_5 = 'https://book15.net/books/details5950.html'   # 恰好 5 次
    URL_4 = 'https://book15.net/books/details4173.html'   # 4 次，不到线
    URL_9 = 'https://book15.net/books/details6520.html'   # 9 次

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'labels-rejected.jsonl'

    def test_exactly_threshold_rejections_is_terminal(self):
        """① 恰好 5 次拒收 → 跳过（阈值是闭区间，不是 >）。"""
        write_jsonl(self.path, [{'url': self.URL_5}] * 5)
        counts = labeler.count_rejections(self.path)
        self.assertEqual(counts[self.URL_5], 5)
        self.assertIn(self.URL_5, labeler.terminal_urls(counts))
        self.assertEqual(labeler.REJECT_TERMINAL_THRESHOLD, 5)

    def test_one_below_threshold_is_not_terminal(self):
        """② 4 次不跳。变异钉：阈值 5→3 时本用例必须变红。"""
        write_jsonl(self.path, [{'url': self.URL_4}] * 4)
        counts = labeler.count_rejections(self.path)
        self.assertEqual(counts[self.URL_4], 4)
        self.assertNotIn(self.URL_4, labeler.terminal_urls(counts))

    def test_urls_do_not_cross_contaminate(self):
        """③ 不同 url 的次数互不串：4 次的邻居不能把 5 次的顶进/顶出名单。"""
        write_jsonl(self.path, [{'url': self.URL_4}] * 4 + [{'url': self.URL_9}] * 9)
        counts = labeler.count_rejections(self.path)
        terminal = labeler.terminal_urls(counts)
        self.assertEqual(terminal, {self.URL_9})
        self.assertNotIn(self.URL_4, terminal)

    def test_empty_jsonl_yields_no_terminal(self):
        """④ 空 jsonl 正常：无计数、无终态、不报错。"""
        self.path.write_text('', encoding='utf-8')
        counts = labeler.count_rejections(self.path)
        self.assertEqual(counts, {})
        self.assertEqual(labeler.terminal_urls(counts), set())

    def test_missing_jsonl_yields_no_terminal(self):
        self.assertEqual(
            labeler.terminal_urls(labeler.count_rejections(
                Path(self.tmp.name) / 'absent.jsonl')), set())

    def test_threshold_is_configurable(self):
        write_jsonl(self.path, [{'url': self.URL_4}] * 4)
        counts = labeler.count_rejections(self.path)
        self.assertEqual(labeler.terminal_urls(counts, threshold=4), {self.URL_4})
        self.assertEqual(labeler.terminal_urls(counts, threshold=5), set())

    def test_non_positive_threshold_disables_the_mechanism(self):
        write_jsonl(self.path, [{'url': self.URL_9}] * 9)
        counts = labeler.count_rejections(self.path)
        self.assertEqual(labeler.terminal_urls(counts, threshold=0), set())
        self.assertEqual(labeler.terminal_urls(counts, threshold=-1), set())


class TestDataDir(unittest.TestCase):
    """数据目录：默认就是脚本同目录（服务器行为不变），只有显式设 LABELER_DATA_DIR 才改。"""

    def test_default_is_script_dir(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('LABELER_DATA_DIR', None)
            self.assertEqual(labeler.data_dir(),
                             Path(labeler.__file__).resolve().parent)

    def test_env_override_wins(self):
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': 'D:/tmp/x'}):
            self.assertEqual(labeler.data_path('labels.jsonl'),
                             Path('D:/tmp/x') / 'labels.jsonl')

    def test_empty_env_value_falls_back_to_script_dir(self):
        # 设成空串不等于「指向当前目录」——仍回落到脚本目录，避免误读到 cwd
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': ''}):
            self.assertEqual(labeler.data_dir(),
                             Path(labeler.__file__).resolve().parent)


class TestSplitQueue(unittest.TestCase):
    """名单与 done_urls 同等地位；两者对同一本书互斥（已完成优先）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.done_path = Path(self.tmp.name) / 'labels.jsonl'

    def test_done_and_pinned_are_both_skipped_and_mutually_exclusive(self):
        """既是钉子户又已成功的书，只算「已完成」——不该继续占终态名额。"""
        done = {'https://book15.net/books/detailsA.html',
                'https://book15.net/books/detailsB.html'}
        pinned = {'https://book15.net/books/detailsB.html',
                  'https://book15.net/books/detailsC.html'}
        books = [{'url': '/books/detailsA.html', 'title': '甲'},
                 {'url': '/books/detailsB.html', 'title': '乙'},
                 {'url': '/books/detailsC.html', 'title': '丙'},
                 {'url': '/books/detailsD.html', 'title': '丁'}]
        todo, skipped_done, skipped_pinned = labeler.split_queue(books, done, pinned)
        self.assertEqual([b['title'] for b in todo], ['丁'])
        self.assertEqual([b['title'] for b in skipped_done], ['甲', '乙'])
        self.assertEqual([b['title'] for b in skipped_pinned], ['丙'])

    def test_load_done_urls_reads_labels_jsonl(self):
        write_jsonl(self.done_path, [
            {'url': 'https://book15.net/books/detailsA.html'},
            '坏行',
            {'url': ''},
            {'url': 'https://book15.net/books/detailsB.html'},
        ])
        self.assertEqual(labeler.load_done_urls(self.done_path), {
            'https://book15.net/books/detailsA.html',
            'https://book15.net/books/detailsB.html'})


class TestRealRejectedSample(unittest.TestCase):
    """真实拒收副本回归（有则跑，无则跳）——副本在仓库外，服务器上不会命中。"""

    SAMPLE = Path(__file__).resolve().parents[2] / 'rejected-from-phoenix-20260918.jsonl'

    def setUp(self):
        if not self.SAMPLE.exists():
            self.skipTest(f'缺真实副本 {self.SAMPLE}')
        self.counts = labeler.count_rejections(self.SAMPLE)

    def test_known_pinned_books_are_terminal(self):
        for url in ('https://book15.net/books/details5950.html',
                    'https://book15.net/books/details4173.html',
                    'https://book15.net/books/details5660.html',
                    'https://book15.net/books/details6520.html',
                    'https://book15.net/books/details7164.html'):
            with self.subTest(url=url):
                self.assertGreaterEqual(self.counts.get(url, 0),
                                        labeler.REJECT_TERMINAL_THRESHOLD)
                self.assertIn(url, labeler.terminal_urls(self.counts))

    def test_clean_book_is_not_terminal(self):
        # 只被拒 1~2 次的书不能被终态吞掉
        terminal = labeler.terminal_urls(self.counts)
        for url, n in self.counts.items():
            if n < labeler.REJECT_TERMINAL_THRESHOLD:
                with self.subTest(url=url):
                    self.assertNotIn(url, terminal)


class TestMainDryRun(unittest.TestCase):
    """main() 接线：模板串与逐本播报必须真的打出来（离线，榜单被 mock）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        write_jsonl(d / 'labels.jsonl', [
            {'url': labeler.BASE + '/books/detailsA.html'}])
        write_jsonl(d / 'labels-rejected.jsonl',
                    [{'url': labeler.BASE + '/books/detailsC.html',
                      'site_title': '钉子户丙'}] * 5
                    + [{'url': labeler.BASE + '/books/detailsD.html',
                        'site_title': '四次丁'}] * 4)
        self.data_dir = d
        self.books = [
            {'url': '/books/detailsA.html', 'title': '已完成甲'},
            {'url': '/books/detailsC.html', 'title': '钉子户丙'},
            {'url': '/books/detailsD.html', 'title': '四次丁'},
            {'url': '/books/detailsE.html', 'title': '待处理戊'},
        ]

    def test_dry_run_prints_pinned_skip_line(self):
        import contextlib
        import io
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.data_dir)}), \
                mock.patch.object(labeler, 'fetch_rank_books', return_value=list(self.books)), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--dry-run', '--no-db-model']), \
                contextlib.redirect_stdout(buf):
            rc = labeler.main()
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        # 已完成甲 + 钉子户丙 = 跳过 2 本，其中钉子户 1 本；四次丁不到线、戊无记录 → 待处理 2 本
        self.assertIn('本轮处理 2 本（跳过已完成 2 本（含钉子户 1 本））', out)
        self.assertIn('钉子户终态：跳过（历史被拒 5 次）', out)
        self.assertIn('钉子户丙', out)
        pinned_lines = [ln for ln in out.splitlines() if '钉子户终态' in ln]
        self.assertEqual(len(pinned_lines), 1)
        self.assertNotIn('四次丁', pinned_lines[0])   # 4 次的书不上终态名单
        self.assertIn(' - 四次丁', out)               # 4 次的书仍进候选
        self.assertIn(' - 待处理戊', out)

    def test_threshold_zero_in_main_disables_the_mechanism(self):
        """关闸语义：把常量改成 0 即不再有钉子户跳过。

        变异钉：若 main() 改成依赖 `terminal_urls` 的**默认参数**（def 时求值），
        运行时改常量不生效，本用例会红。"""
        import contextlib
        import io
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.data_dir)}), \
                mock.patch.object(labeler, 'fetch_rank_books', return_value=list(self.books)), \
                mock.patch.object(labeler, 'REJECT_TERMINAL_THRESHOLD', 0), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--dry-run', '--no-db-model']), \
                contextlib.redirect_stdout(buf):
            rc = labeler.main()
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn('本轮处理 3 本（跳过已完成 1 本（含钉子户 0 本））', out)
        self.assertNotIn('钉子户终态', out)


class TestWebnovelLimitCut(unittest.TestCase):
    """--limit 必须切在「剔除已完成/钉子户之后」（审查 F.1 / 必修 3）。

    扩容后命中数会 > limit：切在前缀会让队尾（豆瓣/17K 尾部）永远进不了视野——
    每轮只处理前缀 limit 条，做完进 done_urls，之后每轮 queue=[] 却仍全量搜索。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        # 命中 150：前 100 已打标，后 50 未完成
        self.books = [{'url': f'/books/details{i}.html', 'title': f'书{i}'}
                      for i in range(1, 151)]
        write_jsonl(d / 'labels.jsonl', [
            {'url': labeler.BASE + f'/books/details{i}.html',
             'title': f'书{i}', 'site_title': f'书{i}'} for i in range(1, 101)])
        self.data_dir = d

    def _run(self, limit):
        import contextlib
        import io
        buf = io.StringIO()

        def fake_build(http_get, skip_titles=None, include_douban=True):
            return list(self.books)

        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.data_dir)}), \
                mock.patch.object(douban_list, 'build_webnovel_queue', side_effect=fake_build), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--source', 'webnovel',
                                                '--limit', str(limit), '--dry-run',
                                                '--no-db-model']), \
                contextlib.redirect_stdout(buf):
            rc = labeler.main()
        return rc, buf.getvalue()

    def test_limit_applies_after_done_filtering(self):
        rc, out = self._run(100)
        self.assertEqual(rc, 0)
        self.assertIn('本轮处理 50 本', out)          # 切在 split_queue 之后
        self.assertIn('跳过已完成 100 本', out)
        self.assertIn(' - 书101', out)                # 队尾的未完成书真的进队列
        self.assertIn(' - 书150', out)
        self.assertNotIn(' - 书1 ', out)              # 已完成的 1..100 不进本轮
        self.assertNotIn(' - 书99', out)

    def test_limit_still_caps_the_unfinished_queue(self):
        # limit 的作用仍在：未完成 50 本、limit 10 → 只取前 10 本未完成的
        rc, out = self._run(10)
        self.assertEqual(rc, 0)
        self.assertIn('本轮处理 10 本', out)
        self.assertIn(' - 书101', out)
        self.assertIn(' - 书110', out)
        self.assertNotIn(' - 书111', out)


if __name__ == '__main__':
    unittest.main(verbosity=2)