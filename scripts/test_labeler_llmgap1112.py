#!/usr/bin/env python3
"""LLM_INTERVAL_SEC 按「距上次模型调用结束」计（llmgap1112）单测。

旧写法每本书末尾固定睡 30s，与下一本取文串行叠加；现在只在调模型前补足差额。
覆盖：取文比间隔长 ⇒ 不再等；取文比间隔短 ⇒ 两次模型调用之间仍 ≥ LLM_INTERVAL_SEC；
没调模型的书（源失效）不等；模型链耗尽同样计入间隔。
全离线：不联网、不调模型、不起进程。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_llmgap1112.py
"""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402
from test_labeler_adgate import MainHarness, _good_fetch, _labels  # noqa: E402

LLM_DOWN = RuntimeError('打标失败: 模型链 [\'m-1\'] 全部耗尽, 最后错误: HTTP 524')


class LlmGapTest(MainHarness):
    def _run(self, plan, fetch_secs, llm_secs=20.0):
        """plan: 每本 'ok' / 'src' / 'llm'。返回 (退出码, 模型调用 [(开始, 结束)], 长睡眠列表)。"""
        books = [dict(self.BOOK, url=f'https://www.kxdu.net/book/{n}', title=f'书{n}')
                 for n in range(len(plan))]
        by_url = {b['url']: kind for b, kind in zip(books, plan)}
        clock = [1000.0]
        seen, calls, sleeps = [], [], []

        def fake_build(*a, **k):
            return [dict(b) for b in books]

        def fetch(cli, url, stats=None, **k):
            seen.append(url)
            clock[0] += fetch_secs
            if by_url.get(url) == 'src':
                raise labeler.EngineSourceGaveUp('so.ihuaben.com', 'no_source', '目录不可用')
            return _good_fetch(cli, url, stats, **k)

        def fake_label(text, *a, **k):
            start = clock[0]
            clock[0] += llm_secs
            calls.append((start, clock[0]))
            if by_url.get(seen[-1]) == 'llm':
                raise LLM_DOWN
            return dict(_labels('正常', evidence=())), 1

        def fake_sleep(s):
            if s >= 1:
                sleeps.append(round(s, 3))
            clock[0] += s

        env = {'LABELER_DATA_DIR': str(self.dir), labeler.DETAIL_EXIT_ENV: '1'}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue', side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine', side_effect=fetch), \
                mock.patch.object(labeler, 'label_book', side_effect=fake_label), \
                mock.patch.object(labeler.time, 'sleep', side_effect=fake_sleep), \
                mock.patch.object(labeler.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = labeler.main()
        return code, calls, sleeps

    def test_long_fetch_needs_no_extra_wait(self):
        code, calls, sleeps = self._run(['ok', 'ok', 'ok'], fetch_secs=100)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, [])     # 旧写法这里是 [30, 30, 30]

    def test_short_fetch_keeps_minimum_interval(self):
        code, calls, sleeps = self._run(['ok', 'ok', 'ok'], fetch_secs=5)
        self.assertEqual(code, 0)
        self.assertEqual(sleeps, [labeler.LLM_INTERVAL_SEC - 5] * 2)
        for (_, prev_end), (start, _) in zip(calls, calls[1:]):
            self.assertGreaterEqual(start - prev_end, labeler.LLM_INTERVAL_SEC)

    def test_source_failures_do_not_wait(self):
        code, calls, sleeps = self._run(['src', 'ok'], fetch_secs=5)
        self.assertEqual(code, labeler.EXIT_PARTIAL)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sleeps, [])     # 旧写法每本源失效书也睡 30s

    def test_llm_exhaustion_counts_toward_interval(self):
        code, calls, sleeps = self._run(['llm', 'ok'], fetch_secs=5)
        self.assertEqual(code, labeler.EXIT_PARTIAL)
        self.assertEqual(len(calls), 2)
        self.assertGreaterEqual(calls[1][0] - calls[0][1], labeler.LLM_INTERVAL_SEC)


if __name__ == '__main__':
    unittest.main()
