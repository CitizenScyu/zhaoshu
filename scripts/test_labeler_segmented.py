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


def _content_calls(cli, host=None):
    return [c for c in cli.calls if c[0] == 'content'
            and (host is None or labeler._url_host(c[1]) == host)]


def _fetch(cli, book, **kw):
    tracker = kw.pop('tracker', None) or labeler.SourceGiveupTracker(labeler.DEAD_HOST_GIVEUPS)
    stats = {}
    with contextlib.redirect_stdout(io.StringIO()):
        text, chars, used, sampling = labeler.fetch_book_text_segmented(
            cli, book, tracker, stats=stats, **kw)
    return text, chars, used, sampling, stats


class TestFetchSegmented(_NoSleep):
    def test_primary_serves_all_four_segments(self):
        cli = make_cli({'a.example.com': {'n': 100}})
        text, chars, used, sampling, stats = _fetch(cli, _book())
        segs = sampling['segments']
        self.assertEqual([s['no'] for s in segs], [1, 2, 3, 4])
        self.assertEqual([s['chapters'] for s in segs], ['1-7', '41-45', '71-74', '91-95'])
        self.assertFalse(any(s['switched'] or s['partial'] for s in segs))
        self.assertEqual(chars, 21 * 3000)
        self.assertEqual(len(_content_calls(cli)), 21)
        self.assertEqual(sum(1 for c in cli.calls if c[0] == 'toc'), 1)
        self.assertEqual(used['url'], 'https://a.example.com/book')
        self.assertEqual((stats['toc_title'], stats['toc_author']), (TITLE, AUTHOR))
        for marker in ('【第 1 段：开头，第 1–7 章】', '【第 2 段：约 40% 处，第 41–45 章】',
                       '【第 3 段：约 70% 处，第 71–74 章】', '【第 4 段：约 90% 处，第 91–95 章】'):
            self.assertIn(marker, text)
        self.assertLess(text.index('第 1 段'), text.index('第 2 段'))
        self.assertLess(text.index('第 3 段'), text.index('第 4 段'))

    def test_markers_survive_prepare_and_chapters_still_split(self):
        """段标注行过 prepare_book_text 不被清洗掉；章节标题仍能切章（标注与章之间空一行）。"""
        cli = make_cli({'a.example.com': {'n': 100}})
        text, *_ = _fetch(cli, _book())
        out, n, reason, pre = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertEqual(sorted(labeler.segment_bodies(out)), [1, 2, 3, 4])
        self.assertEqual(pre['chapters_after'], 21 + 1)   # 21 章 + 开头标注行所在的前导块

    def test_late_4xx_switches_source_for_that_segment(self):
        """主源第 60 章起 4xx（付费墙）：第 3 段请求 3 章即判不可用，换备选补段；第 4 段直接用备选。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else
                              _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual(segs[1]['source'], 'a.example.com')
        self.assertEqual(segs[2]['source'], 'a.example.com')
        self.assertEqual((segs[3]['source'], segs[3]['switched']), ('b.example.com', True))
        self.assertEqual((segs[4]['source'], segs[4]['switched']), ('b.example.com', True))
        self.assertEqual(segs[3]['tried'], ['a.example.com:preview', 'b.example.com:ok'])
        self.assertEqual(segs[4]['tried'], ['b.example.com:ok'])        # 上一段成功的源排最前
        a_late = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) >= 60]
        self.assertEqual(len(a_late), labeler.SEG_PROBE_CHAPTERS)
        self.assertEqual(sum(1 for c in cli.calls if c[0] == 'toc'), 2)  # 每源目录只取一次
        self.assertEqual(used['url'], 'https://a.example.com/book')    # 主源供给最多（1、2 段）

    def test_preview_pages_abort_fast(self):
        """阳神型：中后段章章返回 ~120 字预览 → 每段只花 3 个请求就换源（不再空转）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: (f'预览{i}' + '字' * 110 + '……')
                              if i >= 40 else _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual([segs[n]['source'] for n in (2, 3, 4)], ['b.example.com'] * 3)
        a_mid = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) >= 40]
        self.assertEqual(len(a_mid), labeler.SEG_PROBE_CHAPTERS)        # 只在第 2 段试过一次

    def test_used_source_is_the_one_serving_most_text(self):
        """主源只供开头一小段、其余全由备选供给 → 记录的实际来源是备选（圣墟实测形态）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 10 else
                              _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100, 'author': '唐家三少著'},
        })
        text, chars, used, sampling, stats = _fetch(cli, _book(alternates=['b.example.com']))
        self.assertEqual(used['url'], 'https://b.example.com/book')
        self.assertEqual([s['switched'] for s in sampling['segments']], [False, True, True, True])
        self.assertEqual(stats['toc_author'], '唐家三少著')     # 回写用实际所用源的目录作者

    def test_mid_segment_4xx_stops_after_streak(self):
        """段中途起 4xx（cuoceng 实测形态）：连续 3 章落空即停，不按累计均值拖到几十个请求；
        已取到的 3 章 9000 字 ≥ 目标 40% → 该段仍可用，不换源。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 43 else
                              _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        a_seg2 = [c for c in _content_calls(cli, 'a.example.com') if 40 <= _idx(c[1]) < 70]
        self.assertEqual(len(a_seg2), 6)
        seg2 = sampling['segments'][1]
        self.assertEqual((seg2['source'], seg2['chapters'], seg2['switched']),
                         ('a.example.com', '41-43', False))

    def test_app_free_titles_skipped_without_requests(self):
        """目录标题带 APP免费 的试读章不发请求；整段都是 → 该段 no_request → 换源。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'titles': lambda i: f'第{i + 1}章 标题' + (
                'APP免费' if i >= 40 else '')},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, stats = _fetch(cli, _book(alternates=['b.example.com']))
        self.assertFalse([c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) >= 40])
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual(segs[2]['tried'], ['a.example.com:no_request', 'b.example.com:ok'])

    def test_all_sources_fail_marks_segment_missing(self):
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else
                              _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else
                              _chapter_body('b.example.com', i)},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertTrue(segs[3]['missing'] and segs[4]['missing'])
        self.assertIn('【第 3 段：未取到】', text)
        self.assertIn('【第 4 段：未取到】', text)
        self.assertEqual(labeler.normalize_arc({'decline': 'none'}, text)['decline'], 'unknown')

    def test_short_real_text_used_as_partial(self):
        """窗口里只有 1 章真正文（其余是试读章）、又没有备选源 → 用这 1 章（partial），不标未取到。"""
        cli = make_cli({'a.example.com': {'n': 100, 'titles': lambda i: f'第{i + 1}章 标题' + (
            'APP免费' if i >= 91 else '')}})
        text, chars, used, sampling, stats = _fetch(cli, _book())
        seg4 = sampling['segments'][3]
        self.assertEqual((seg4['chapters'], seg4['partial']), ('91-91', True))
        self.assertIn('【第 4 段：约 90% 处，第 91–91 章】', text)
        self.assertEqual(stats['preview_chapters'], 9)

    def test_primary_identity_mismatch_raises_without_content(self):
        cli = make_cli({'a.example.com': {'n': 100, 'title': '完全不同的书'},
                        'b.example.com': {'n': 100}})
        with self.assertRaises(labeler.EngineIdentityMismatch):
            _fetch(cli, _book(alternates=['b.example.com']))
        self.assertEqual(_content_calls(cli), [])

    def test_alternate_identity_mismatch_is_skipped(self):
        """备选源身份不符只跳过，不拿它补段（新源必须过同样的身份校验）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else
                              _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100, 'author': '别的作者'},
            'c.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(
            cli, _book(alternates=['b.example.com', 'c.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[3]['source'], segs[4]['source']), ('c.example.com', 'c.example.com'))
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_primary_toc_fail_plans_on_alternate(self):
        cli = make_cli({'a.example.com': {'n': 100, 'toc_fail': True}, 'b.example.com': {'n': 50}})
        tracker = labeler.SourceGiveupTracker(1)
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']),
                                                tracker=tracker)
        self.assertEqual(used['url'], 'https://b.example.com/book')
        self.assertTrue(all(s['switched'] for s in sampling['segments']))   # 相对名单主源
        self.assertIn('a.example.com', tracker.dead)                   # 确定性目录失败记放弃

    def test_all_tocs_fail_raises_gaveup(self):
        cli = make_cli({'a.example.com': {'n': 100, 'toc_fail': True}})
        with self.assertRaises(labeler.EngineSourceGaveUp):
            _fetch(cli, _book())

    def test_time_budget_stops_fetching(self):
        """每个 CLI 请求耗 10s、时限 60s：到时即停，已取到的段照用，其余段标未取到；
        最后一个请求在时限前发出（总耗时 ≤ 时限 + 单请求）。"""
        now = [0.0]
        inner = make_cli({'a.example.com': {'n': 100}})

        class SlowCli:
            calls = inner.calls

            def run(self, sub, *args):
                now[0] += 10
                return inner.run(sub, *args)

        text, chars, used, sampling, _ = _fetch(SlowCli(), _book(), time_budget_s=60,
                                                clock=lambda: now[0])
        self.assertLessEqual(now[0], 60 + 10)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertFalse(segs[1].get('missing'))
        self.assertTrue(segs[4].get('missing'))
        self.assertIn('【第 4 段：未取到】', text)


class TestNormalizeArc(unittest.TestCase):
    Q1 = '萧炎舔了舔嘴唇迟疑了一下方才缓缓的道'
    Q3 = '你们一次又一次的震，震了天上，震地下'
    Q4 = '那就更好办了，省的我一一去寻找，走'

    def text(self, missing=()):
        bodies = {1: f'【第1章 开始】\n前文。{self.Q1}。后文。', 2: '【第401章 中】\n中段正文若干。',
                  3: f'【第701章 转】\n前面。{self.Q3}！后面。', 4: f'【第901章 末】\n{self.Q4}。尾声。'}
        return '\n\n'.join(f'【第 {n} 段：未取到】' if n in missing
                           else f'【第 {n} 段：位置，第 1–2 章】\n\n{bodies[n]}' for n in (1, 2, 3, 4))

    def test_valid_decline_kept(self):
        arc = labeler.normalize_arc({'decline': 'severe', 'note': '后期注水',
                                     'evidence': [{'segment': 1, 'quote': self.Q1},
                                                  {'segment': 3, 'quote': self.Q3}]}, self.text())
        self.assertEqual(arc['decline'], 'severe')
        self.assertEqual(len(arc['evidence']), 2)
        self.assertEqual(arc['checked'], {'dropped': 0, 'forced': ''})
        self.assertEqual(arc['note'], '后期注水')

    def test_whitespace_normalized_match(self):
        arc = labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': 1, 'quote': '萧炎舔了舔 嘴唇\n迟疑了一下'},
            {'segment': '4', 'quote': self.Q4}]}, self.text())
        self.assertEqual(arc['decline'], 'mild')
        self.assertEqual([e['segment'] for e in arc['evidence']], [1, 4])

    def test_forged_quote_dropped_then_unknown(self):
        """伪造（原文里没有）的 quote 被丢弃，剩 1 条 → 降为 unknown（防对照组误报）。"""
        arc = labeler.normalize_arc({'decline': 'severe', 'evidence': [
            {'segment': 1, 'quote': self.Q1},
            {'segment': 3, 'quote': '中后段套路重复明显且注水严重'}]}, self.text())
        self.assertEqual(arc['decline'], 'unknown')
        self.assertEqual(arc['checked'], {'dropped': 1, 'forced': 'weak_evidence'})
        self.assertEqual(len(arc['evidence']), 1)

    def test_quote_attributed_to_wrong_segment_dropped(self):
        arc = labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': 1, 'quote': self.Q1}, {'segment': 2, 'quote': self.Q3}]}, self.text())
        self.assertEqual((arc['decline'], arc['checked']['dropped']), ('unknown', 1))

    def test_two_quotes_same_segment_not_enough(self):
        arc = labeler.normalize_arc({'decline': 'severe', 'evidence': [
            {'segment': 3, 'quote': self.Q3}, {'segment': 3, 'quote': '前面。' + self.Q3[:8]}]},
            self.text())
        self.assertEqual(len(arc['evidence']), 2)
        self.assertEqual((arc['decline'], arc['checked']['forced']), ('unknown', 'weak_evidence'))

    def test_quote_from_marker_or_too_short_not_evidence(self):
        arc = labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': 1, 'quote': '前文'}, {'segment': 3, 'quote': '第 3 段：位置'},
            {'segment': True, 'quote': self.Q1}, 'bad', {'segment': 4}]}, self.text())
        self.assertEqual(arc['evidence'], [])
        self.assertEqual(arc['checked']['dropped'], 5)
        self.assertEqual(arc['decline'], 'unknown')

    def test_missing_late_segments_forces_unknown(self):
        for decline in ('none', 'mild'):
            arc = labeler.normalize_arc({'decline': decline, 'evidence': [
                {'segment': 1, 'quote': self.Q1}, {'segment': 2, 'quote': '中段正文若干'}]},
                self.text(missing=(3, 4)))
            self.assertEqual((arc['decline'], arc['checked']['forced']),
                             ('unknown', 'missing_segments'), decline)
        # 只缺第 3 段、第 4 段在 → 仍可判
        arc = labeler.normalize_arc({'decline': 'none'}, self.text(missing=(3,)))
        self.assertEqual(arc['decline'], 'none')

    def test_missing_head_forces_unknown(self):
        arc = labeler.normalize_arc({'decline': 'none'}, self.text(missing=(1,)))
        self.assertEqual(arc['decline'], 'unknown')

    def test_garbage_values(self):
        for value in (None, 'severe', [], {'decline': 'BAD'}, {'decline': 3}):
            arc = labeler.normalize_arc(value, self.text())
            self.assertEqual(arc['decline'], 'unknown', value)
            self.assertEqual(arc['evidence'], [])
        self.assertEqual(labeler.normalize_arc({'decline': ' None '}, self.text())['decline'], 'none')

    def test_quote_truncated_to_50(self):
        long = self.Q3 + '后面。'
        body = f'【第 1 段：x】\n\n{self.Q1}\n\n【第 3 段：x】\n\n' + long * 3
        arc = labeler.normalize_arc({'decline': 'none', 'evidence': [
            {'segment': 3, 'quote': long * 3}]}, body)
        self.assertEqual(len(arc['evidence'][0]['quote']), labeler.ARC_QUOTE_MAX)


class TestMainLoop(unittest.TestCase):
    """主循环接线：开关关 → 与改前逐字一致；开 → 分段取文 + v2 + arc + sampling。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def run_main(self, env_lines, cli, label_fn):
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n' + env_lines,
                                       encoding='utf-8')
        book = _book(alternates=['b.example.com'])

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [json.loads(json.dumps(book))]
        label_mock = mock.Mock(side_effect=label_fn)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, '_build_engine_cli', return_value=cli), \
                mock.patch.object(labeler, 'label_book', label_mock), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        lines = (self.dir / 'labels.jsonl').read_text(encoding='utf-8').splitlines() \
            if (self.dir / 'labels.jsonl').exists() else []
        return code, [json.loads(x) for x in lines], label_mock, out.getvalue()

    @staticmethod
    def base_labels():
        return {'title_guess': TITLE, 'site_title_match': True, 'text_quality': '正常',
                'confidence': 0.9, 'genre': '玄幻'}

    def test_switch_off_is_unchanged(self):
        cli = make_cli({'a.example.com': {'n': 100}, 'b.example.com': {'n': 100}})
        code, recs, label_mock, out = self.run_main('', cli, lambda *a, **k: (self.base_labels(), 1))
        self.assertEqual(code, 0)
        rec = recs[0]
        self.assertEqual(rec['prompt_version'], 'v1')
        self.assertNotIn('sampling', rec)
        self.assertNotIn('arc', rec['labels'])
        # 仍是「从开头顺序读到 8 万」：只取主源第 0..26 章
        self.assertEqual(sorted(_idx(c[1]) for c in _content_calls(cli)), list(range(27)))
        self.assertEqual(rec['chars'], 27 * 3000)
        # label_book 调用形态与改前一致：不传 system_prompt
        self.assertEqual(set(label_mock.call_args.kwargs),
                         {'site_title', 'site_author', 'max_tokens', 'meta'})
        self.assertNotIn('分布式采样', out)

    def test_switch_on_segments_and_arc(self):
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else
                              _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100},
        })
        seen = {}

        def label_fn(text, *a, **k):
            seen['text'], seen['kwargs'] = text, k
            labels = self.base_labels()
            q1 = _chapter_body('a.example.com', 0)[:30]
            q4 = _chapter_body('b.example.com', 90)[:30]
            labels['arc'] = {'decline': 'mild', 'note': '后段注水',
                             'evidence': [{'segment': 1, 'quote': q1}, {'segment': 4, 'quote': q4},
                                          {'segment': 3, 'quote': '模型编造的一句话不在原文里'}]}
            return labels, 1

        code, recs, label_mock, out = self.run_main('LABELER_SEGMENTED=1\n', cli, label_fn)
        self.assertEqual(code, 0)
        rec = recs[0]
        self.assertEqual(rec['prompt_version'], 'v2')
        self.assertTrue(seen['kwargs']['system_prompt'].startswith(labeler.SYSTEM_PROMPT))
        self.assertIn('arc', seen['kwargs']['system_prompt'])
        self.assertIn('【第 4 段：约 90% 处，第 91–95 章】', seen['text'])
        arc = rec['labels']['arc']
        self.assertEqual(arc['decline'], 'mild')
        self.assertEqual([e['segment'] for e in arc['evidence']], [1, 4])
        self.assertEqual(arc['checked']['dropped'], 1)
        segs = rec['sampling']['segments']
        self.assertEqual([s['source'] for s in segs],
                         ['a.example.com', 'a.example.com', 'b.example.com', 'b.example.com'])
        self.assertEqual(rec['url'], 'https://a.example.com/book')
        self.assertEqual(rec['label_source'], 'text_engine')
        self.assertIn('分布式采样', out)
        self.assertIn('第3段 b.example.com', out)

    def test_switch_on_forged_evidence_becomes_unknown(self):
        cli = make_cli({'a.example.com': {'n': 100}, 'b.example.com': {'n': 100}})

        def label_fn(text, *a, **k):
            labels = self.base_labels()
            labels['arc'] = {'decline': 'severe', 'evidence': [
                {'segment': 1, 'quote': '开头紧凑悬念十足引人入胜'},
                {'segment': 4, 'quote': '后期套路重复注水严重拖沓'}]}
            return labels, 1

        code, recs, *_ = self.run_main('LABELER_SEGMENTED=1\n', cli, label_fn)
        arc = recs[0]['labels']['arc']
        self.assertEqual((arc['decline'], arc['evidence'], arc['checked']['dropped']),
                         ('unknown', [], 2))

    def test_imports_ignore_new_fields(self):
        """import_one 的记录校验：labels.arc 与顶层 sampling 不导致 failed（未知字段忽略）。"""
        import import_one
        rec = {'title': TITLE, 'site_title': TITLE, 'author': AUTHOR, 'category': '玄幻',
               'status': '完本', 'source': 'a.example.com', 'url': 'https://a.example.com/book',
               'prompt_version': 'v2', 'label_model': 'm', 'label_source': 'text_engine',
               'sampling': {'mode': 'segmented', 'segments': []},
               'labels': {**self.base_labels(),
                          'quality': {'prose': 7, 'worldbuilding': 7, 'pacing': 7,
                                      'enjoyment': 7, 'overall': 7},
                          'arc': {'decline': 'unknown', 'evidence': [], 'note': '',
                                  'checked': {'dropped': 0, 'forced': ''}}}}
        verdict = import_one.validate_record(rec)
        self.assertEqual(verdict['status'], 'ready', verdict)
        self.assertEqual(verdict['record']['labels']['arc']['decline'], 'unknown')


if __name__ == '__main__':
    unittest.main(verbosity=2)
