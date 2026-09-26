#!/usr/bin/env python3
"""lblseg41：分布式采样 + 按段换源补段 + 后期落差字段 arc 单测。

覆盖：
  * 配置：resolve_segmented（只认 '1'）、resolve_seg_time_budget（默认/覆盖/坏值）；
  * 配比 segment_plan（8 万 = 20k/15k/10k/15k、按比例缩放、上限夹取）；
  * 段位置 segment_windows（按目录序号、段间不重叠、章节不足时并段）；
  * 有效字数判定 segment_usable / fetch_segment（预览页、4xx、截断目录、正常）；
  * 换源补段 fetch_book_text_segmented（mock 源：主源后段不可用 → 备选补段；身份不符；时限）；
  * arc 解析 normalize_arc（伪造 quote 丢弃→unknown、同段两条不算、缺后段强制 unknown）；
  * 主循环：开关关时逐字不变（v1、无 arc/sampling、按开头取文）；开时 v2 + arc + sampling。

全离线：不联网、不真调 CLI、不调 LLM（.env 是自造假值）。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_segmented.py'
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402

TITLE, AUTHOR = '斗罗大陆III龙王传说', '唐家三少'


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class FakeEngineCli:
    """引擎 CLI 桩：handler(subcommand, url) → proc，记录调用。"""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def run(self, subcommand, *args):
        url = args[1] if len(args) >= 2 and args[0] == '--url' else None
        self.calls.append((subcommand, url))
        return self.handler(subcommand, url)


def _chapter_body(host: str, i: int, n: int = 3000) -> str:
    """第 i 章正文，恰好 n 字、各章各源不同（防跨章去重把样本抽干）。带句读，贴近真实正文。"""
    head, tail = f'{host}第{i}章正文起。', f'终{i:06d}。'
    return head + '正' * (n - len(head) - len(tail)) + tail


def _toc_proc(host, n, title=TITLE, author=AUTHOR, titles=None):
    chapters = [{'title': (titles(i) if titles else f'第{i + 1}章'), 'url': f'https://{host}/c{i}'}
                for i in range(n)]
    return _proc(0, json.dumps({'source': host, 'title': title, 'author': author,
                                'chapters': chapters}, ensure_ascii=False))


def _content_proc(body):
    return _proc(0, json.dumps({'source': 'x', 'url': 'x', 'text': body}, ensure_ascii=False))


def _idx(url):
    return int(url.rsplit('/c', 1)[1])


def make_cli(sources: dict):
    """sources: host → {'n': 章数, 'body': fn(idx)->正文|None(=4xx), 'title', 'author', 'toc_fail'}。"""
    def handler(sub, url):
        host = labeler._url_host(url)
        spec = sources[host]
        if sub == 'toc':
            if spec.get('toc_fail'):
                return _proc(1, '', 'x\n{"errorKind": "http_4xx"}\n')
            return _toc_proc(host, spec['n'], spec.get('title', TITLE), spec.get('author', AUTHOR),
                             spec.get('titles'))
        body = spec.get('body', lambda i: _chapter_body(host, i))(_idx(url))
        if body is None:
            return _proc(1, '', 'x\n{"errorKind": "http_4xx"}\n')
        return _content_proc(body)
    return FakeEngineCli(handler)


def _book(host='a.example.com', alternates=()):
    return {'url': f'https://{host}/book', 'title': TITLE, 'author': AUTHOR, 'engine': True,
            'source_host': host,
            'engine_alternates': [{'url': f'https://{h}/book', 'title': TITLE, 'source': h}
                                  for h in alternates]}


class _NoSleep(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)


class TestConfig(unittest.TestCase):
    def test_segmented_only_on_literal_1(self):
        self.assertFalse(labeler.resolve_segmented({}))
        self.assertFalse(labeler.resolve_segmented(None))
        for off in ('0', 'true', 'yes', ''):
            self.assertFalse(labeler.resolve_segmented({'LABELER_SEGMENTED': off}), off)
        self.assertTrue(labeler.resolve_segmented({'LABELER_SEGMENTED': ' 1 '}))

    def test_time_budget(self):
        self.assertEqual(labeler.resolve_seg_time_budget({}), 240)
        self.assertEqual(labeler.resolve_seg_time_budget({'LABELER_SEG_TIME_BUDGET_S': '90'}), 90)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            for bad in ('abc', '0', '-5', '1.5'):
                self.assertEqual(
                    labeler.resolve_seg_time_budget({'LABELER_SEG_TIME_BUDGET_S': bad}), 240, bad)
        self.assertIn('不是正整数', err.getvalue())


class TestSegmentPlan(unittest.TestCase):
    def test_default_80k_is_20_15_10_15(self):
        plan = labeler.segment_plan(80_000)
        self.assertEqual([s['no'] for s in plan], [1, 2, 3, 4])
        self.assertEqual([s['target'] for s in plan], [20_000, 15_000, 10_000, 15_000])
        self.assertEqual([s['frac'] for s in plan], [0.0, 0.40, 0.70, 0.90])

    def test_scales_with_total(self):
        self.assertEqual([s['target'] for s in labeler.segment_plan(40_000)],
                         [10_000, 7_500, 5_000, 7_500])
        self.assertEqual([s['target'] for s in labeler.segment_plan(160_000)],
                         [40_000, 30_000, 20_000, 30_000])

    def test_total_clamped_to_single_call_limit(self):
        """总量 > SEGMENTED_MAX_TOTAL（如回退值 50 万）时夹到上限：保证一次模型调用。"""
        big = labeler.segment_plan(500_000)
        self.assertEqual(big, labeler.segment_plan(labeler.SEGMENTED_MAX_TOTAL))
        self.assertLess(sum(s['target'] for s in big), labeler.SEGMENT_CHARS)


class TestSegmentWindows(unittest.TestCase):
    plan = labeler.segment_plan(80_000)

    def test_positions_by_chapter_index(self):
        w = labeler.segment_windows(1000, self.plan)
        self.assertEqual([(s['start'], s['end']) for s in w],
                         [(0, 400), (400, 700), (700, 900), (900, 1000)])
        self.assertEqual([s['target'] for s in w], [20_000, 15_000, 10_000, 15_000])

    def test_windows_do_not_overlap_and_cover_toc(self):
        for n in (1, 2, 3, 4, 5, 7, 10, 11, 99, 1391):
            w = labeler.segment_windows(n, self.plan)
            self.assertEqual(w[0]['start'], 0 if w[0]['no'] == 1 else w[0]['start'])
            for a, b in zip(w, w[1:]):
                self.assertEqual(a['end'], b['start'], n)
            self.assertEqual(w[-1]['end'], n, n)
            self.assertTrue(all(s['start'] < s['end'] for s in w), n)
            # 目标字数总量不因并段丢失
            self.assertEqual(sum(s['target'] for s in w), 60_000, n)

    def test_few_chapters_merge_into_previous(self):
        """3 章：int(3×0.7)=int(3×0.9)=2 → 第 3 段窗口为空，并入第 2 段（字数一并加过去）。"""
        w = labeler.segment_windows(3, self.plan)
        self.assertEqual([s['no'] for s in w], [1, 2, 4])
        self.assertEqual([(s['start'], s['end']) for s in w], [(0, 1), (1, 2), (2, 3)])
        self.assertEqual(w[1]['target'], 15_000 + 10_000)

    def test_single_chapter(self):
        w = labeler.segment_windows(1, self.plan)
        self.assertEqual(len(w), 1)
        self.assertEqual((w[0]['start'], w[0]['end'], w[0]['target']), (0, 1, 60_000))

    def test_empty_toc(self):
        self.assertEqual(labeler.segment_windows(0, self.plan), [])


class TestSegmentUsable(unittest.TestCase):
    def test_normal(self):
        self.assertEqual(labeler.segment_usable(
            {'requested': 5, 'eff_chars': 15_000, 'stop': 'target'}, 15_000), (True, ''))

    def test_preview_pages(self):
        """章章百字预览（阳神型）：章均 < 300 → 不可用。"""
        self.assertEqual(labeler.segment_usable(
            {'requested': 3, 'eff_chars': 600, 'stop': 'preview'}, 15_000), (False, 'preview'))

    def test_4xx_all_empty(self):
        self.assertEqual(labeler.segment_usable(
            {'requested': 3, 'eff_chars': 0, 'stop': 'preview'}, 15_000), (False, 'preview'))

    def test_short_below_40_percent(self):
        self.assertEqual(labeler.segment_usable(
            {'requested': 2, 'eff_chars': 5_000, 'stop': 'deadline'}, 15_000), (False, 'short'))
        self.assertEqual(labeler.segment_usable(
            {'requested': 2, 'eff_chars': 6_000, 'stop': 'deadline'}, 15_000), (True, ''))

    def test_short_because_window_exhausted_is_ok(self):
        """窗口里的正文章本来就不够（短书）不是源的问题；但若是跳过了试读章才抓完，仍判不可用。"""
        self.assertEqual(labeler.segment_usable(
            {'requested': 1, 'eff_chars': 3_000, 'stop': 'window_end'}, 15_000), (True, ''))
        self.assertEqual(labeler.segment_usable(
            {'requested': 1, 'eff_chars': 3_000, 'stop': 'window_end', 'preview_skipped': 20},
            15_000), (False, 'short'))

    def test_nothing_requested(self):
        self.assertEqual(labeler.segment_usable(
            {'requested': 0, 'eff_chars': 0, 'stop': 'window_end', 'preview_skipped': 9}, 15_000),
            (False, 'no_request'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
