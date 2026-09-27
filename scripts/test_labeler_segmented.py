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
  * 审查后修复（rvlblseg-41）：补段源身份 fill_source_identity（书名严格相等 + 目录信息性章名交集，
    纯编号目录不换源）、记录 url 恒取计划源且下轮 split_queue 跳过、单请求超时/退避计入预算、
    arc 证据 ≥12 字且不认章标题行、第 1 段真短章不误弃。

全离线：不联网、不真调 CLI、不调 LLM（.env 是自造假值）。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_segmented.py'
"""
import contextlib
import io
import json
import os
import subprocess
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
        self.timeouts = []      # 每次调用传入的 timeout（None = 未传，用 CLI 默认）

    def run(self, subcommand, *args, **kw):
        url = args[1] if len(args) >= 2 and args[0] == '--url' else None
        self.calls.append((subcommand, url))
        self.timeouts.append(kw.get('timeout'))
        return self.handler(subcommand, url)


def _chapter_body(host: str, i: int, n: int = 3000) -> str:
    """第 i 章正文，恰好 n 字、各章各源不同（防跨章去重把样本抽干）。带句读，贴近真实正文。"""
    head, tail = f'{host}第{i}章正文起。', f'终{i:06d}。'
    return head + '正' * (n - len(head) - len(tail)) + tail


# rvlblseg R2-6：补段源身份改为 same_book 双信号与门（目录判同 + 正文逐章配对判同）。要让「同一本书的另一
# 个源」能补段，两源同章号的正文必须**内容一致**；要让「同名异书」被拒，正文必须**不同**。故正文夹具改成
# **源无关、逐章各异**：同书跨源同章一致（_book_body），异书用另一套情节句（_other_body）。首尾唯一 → labeler
# 拼接后整本去重不误删；同源相邻章句子完全不同 → 过 douban 跨章去模板；计划源正文信号只取第 1 段（章 0–6）。
_PLOT = (
    '少年叶凡自青丘古镇拜别双亲负剑独上问天绝峰求道。', '深谷寒潭之下他窥得残碑古卷参悟太初剑意之真髓。',
    '血月当空妖兽倾巢而出他一剑断江力挽狂澜于危局。', '登临云顶论道群雄他以一敌百声名震动四方之九州。',
    '古墓幽深机关重重他携同伴步步为营终得先贤之传承。', '大战魔渊之主他燃烧本命精血换来天地同悲之一击。',
    '功成身退归隐山林他于晨钟暮鼓之间了却红尘之旧梦。', '故人来访重提旧事他仗剑再入江湖续写不朽的篇章。',
    '荒漠孤烟他追踪古老星图寻访失落已久的仙王之遗冢。', '雪岭之巅寒风如刀他闭关百日锤炼不灭金身与神魂。',
    '都会霓虹之下他隐匿身形调查吞噬灵气的诡异之邪祟。', '终章落幕万法归一他立于苍穹俯瞰众生笑对之轮回。',
)
_OTHER = (
    '女帝苏璃执掌凤仪宫廷运筹帷幄平定四海八荒之乱。', '老渔夫独钓寒江雪夜偶得一枚会说话的青玉印章。',
    '机甲战士穿越星海残骸搜寻远古文明的能源之核心。', '书生进京赶考途中夜宿荒庙撞见一桩离奇的旧案。',
    '海盗船长追逐传说中的黄金罗盘横渡风暴的深渊。', '药师游历十洲采撷奇花异草只为炼制续命之丹方。',
    '将军班师回朝却察觉朝堂之上暗流涌动杀机四伏。', '琴师抚一曲广陵散引来漫天飞雪与山间百鸟朝凤。',
    '剑客独闯魔教总坛为报灭门血仇踏碎重重的杀阵。', '工匠倾尽毕生心血打造一座能测算天象的水运仪。',
    '少女养的锦鲤化作蛟龙在雷雨之夜跃过龙门升天。', '旅人循着旧地图深入雨林终于寻得传说中的古城。',
)


def _pool_body(pool, i: int, n: int = 3000) -> str:
    """第 i 章正文：主体是 pool[i%len] 的重复，首尾唯一 → 全局唯一、逐章各异。"""
    s = pool[i % len(pool)]
    head, tail = f'第{i}章起。', f'终{i:06d}。'
    return (head + s * ((n - len(head) - len(tail)) // len(s) + 1))[:n - len(tail)] + tail


def _book_body(i: int, n: int = 3000) -> str:
    """同书跨源共享正文（源无关）：两源同章号 → 内容一致 → 过 same_book 正文信号。"""
    return _pool_body(_PLOT, i, n)


def _other_body(i: int, n: int = 3000) -> str:
    """另一本书的正文（同章号但情节不同）→ same_book 正文信号判否。"""
    return _pool_body(_OTHER, i, n)


def _chapter_title(i: int) -> str:
    """默认章名：带编号 + 信息性章名（各源同名，按段换源的目录比对才对得上；rvlblseg 必修 1）。"""
    return f'第{i + 1}章 情节名目{i:04d}'


def _numbered_title(i: int) -> str:
    """纯编号章名（无信息性章名）。"""
    return f'第{i + 1}章'


def _toc_proc(host, n, title=TITLE, author=AUTHOR, titles=None):
    chapters = [{'title': (titles or _chapter_title)(i), 'url': f'https://{host}/c{i}'}
                for i in range(n)]
    return _proc(0, json.dumps({'source': host, 'title': title, 'author': author,
                                'chapters': chapters}, ensure_ascii=False))


def _content_proc(body):
    return _proc(0, json.dumps({'source': 'x', 'url': 'x', 'text': body}, ensure_ascii=False))


def _idx(url):
    return int(url.rsplit('/c', 1)[1])


def make_cli(sources: dict):
    """sources: host → {'n': 章数, 'body': fn(idx)->正文|None(=4xx), 'title', 'author', 'toc_fail'}。
    默认正文 = _book_body（源无关、同书跨源同章一致）：同书备选可过 same_book 双信号补段（R2-6）。"""
    def handler(sub, url):
        host = labeler._url_host(url)
        spec = sources[host]
        if sub == 'toc':
            if spec.get('toc_fail'):
                return _proc(1, '', 'x\n{"errorKind": "http_4xx"}\n')
            return _toc_proc(host, spec['n'], spec.get('title', TITLE), spec.get('author', AUTHOR),
                             spec.get('titles'))
        body = spec.get('body', lambda i: _book_body(i))(_idx(url))
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
        """主源第 60 章起 4xx（付费墙）：第 3 段请求 3 章即判不可用，换备选补段；第 4 段直接用备选。
        备选 b 与主源 a 是同一本书（同章号正文一致）→ 过 same_book 双信号，可补段（rvlblseg R2-6）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else _book_body(i)},
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
                              if i >= 40 else _book_body(i)},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual([segs[n]['source'] for n in (2, 3, 4)], ['b.example.com'] * 3)
        a_mid = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) >= 40]
        self.assertEqual(len(a_mid), labeler.SEG_PROBE_CHAPTERS)        # 只在第 2 段试过一次

    def test_record_source_stays_plan_source(self):
        """主源只供开头一小段、其余全由备选供给（圣墟实测形态）→ 返回的源仍是计划源（主源），
        记录 url 不被补段源改写（rvlblseg 必修 2）；各段真实来源只记在 sampling。
        备选 b 与 a 同书（同章号正文一致）→ 过 same_book 双信号补段。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 10 else _book_body(i)},
            'b.example.com': {'n': 100, 'author': '唐家三少著'},
        })
        text, chars, used, sampling, stats = _fetch(cli, _book(alternates=['b.example.com']))
        self.assertEqual(used['url'], 'https://a.example.com/book')
        self.assertEqual([s['switched'] for s in sampling['segments']], [False, True, True, True])
        self.assertEqual([s['url'] for s in sampling['segments']],
                         ['https://a.example.com/book'] + ['https://b.example.com/book'] * 3)
        self.assertEqual(stats['toc_author'], AUTHOR)       # 回写用计划源的目录作者

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
        """目录标题带 APP免费 的试读章不发请求；整段都是 → 该段 no_request → 换源。
        第 2 段窗口（章 41–70）整段是试读章：标题挂「番外…APP免费」（含辅助子串 → 不计入目录信号，
        计划源 a 目录仍与备选 b 大量重合 → 过 same_book 目录信号补段，rvlblseg R2-6）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'titles': lambda i: (
                f'第{i + 1}章 番外{i}APP免费' if 40 <= i < 70 else _chapter_title(i))},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, stats = _fetch(cli, _book(alternates=['b.example.com']))
        self.assertFalse([c for c in _content_calls(cli, 'a.example.com') if 40 <= _idx(c[1]) < 70])
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
        """备选源身份不符只跳过，改用下一个（新源必须过 same_book 双信号）：b 目录身份过关（同书名）但正文
        是同名下的另一本书 → 正文信号判否、只花身份核验的抓章、不补段；c 与 a 同书 → 用 c 补段（R2-6）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else _book_body(i)},
            'b.example.com': {'n': 100, 'body': _other_body},
            'c.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(
            cli, _book(alternates=['b.example.com', 'c.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[3]['source'], segs[4]['source']), ('c.example.com', 'c.example.com'))
        self.assertIn('b.example.com:identity_body', segs[3]['tried'])
        # b 只被抓了身份核验的 ≤SEG_FILL_MAX_CHAPTERS 章，从未拿它补任何段
        self.assertEqual(len(_content_calls(cli, 'b.example.com')), labeler.SEG_FILL_MAX_CHAPTERS)

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

            def run(self, sub, *args, **kw):
                now[0] += min(10, kw.get('timeout') or 10)
                return inner.run(sub, *args, **kw)

        text, chars, used, sampling, _ = _fetch(SlowCli(), _book(), time_budget_s=60,
                                                clock=lambda: now[0])
        self.assertLessEqual(now[0], 60 + 10)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertFalse(segs[1].get('missing'))
        self.assertTrue(segs[4].get('missing'))
        self.assertIn('【第 4 段：未取到】', text)


def _entry(host, title=TITLE, titles=_chapter_title, toc_author='', n=100):
    """构造 fetch_book_text_segmented 内部的源目录条目（供 fill_source_identity 单测）。"""
    ch = [{'title': titles(i), 'url': f'https://{host}/c{i}'} for i in range(n)]
    return {'title': title, 'chapters': ch, 'toc_author': toc_author,
            'names': set(labeler.douban_list._informative_toc_titles(ch))}


def _plan_entry(titles=_chapter_title, n=100, title=TITLE):
    """计划源目录条目（供 fill_source_identity 单测的 plan 参数）。"""
    ch = [{'title': titles(i), 'url': f'https://plan/c{i}'} for i in range(n)]
    return {'title': title, 'chapters': ch}


def _ref_hits(body=_book_body, k=7, nums=None):
    """计划源**可用段已取到**的章 → [{'num','text'}]（默认章号 1..k，供正文参照分组）。"""
    nums = list(nums) if nums is not None else list(range(1, k + 1))
    return [{'num': n, 'text': body(n - 1)} for n in nums]


def _generic_then(uniq):
    """前 5 条站方通用条目（关于本书/人物介绍…，rvlblseg r2_d），其余按 uniq(i) 命名。"""
    gen = ['关于本书', '人物介绍', '作者简介', '世界观设定', '阅读指南']
    return lambda i: f'第{i + 1}章 {gen[i]}' if i < 5 else f'第{i + 1}章 {uniq}{i:04d}'


class TestFillSourceIdentity(unittest.TestCase):
    """补段源身份核验（rvlblseg R3 收口）：书名折叠 + 目录信号 + 段位置标题 + 正文**双参照**（书首组 + 近窗组）
    与门。每组候选抓同章号正文走 same_book 正文信号，各须可判且判同（各 ≥2 互异章对），任一组不过即拒。"""

    WIN = {'no': 2, 'start': 40}           # 第 2 段（约 40% 处），窗口起点 = 目录第 41 章

    def _fill(self, cli, cand, plan=None, plan_ref_hits=None, win=None, caches=None):
        return labeler.fill_source_identity(
            cli, plan or _plan_entry(),
            plan_ref_hits if plan_ref_hits is not None else _ref_hits(),
            cand, win or self.WIN,
            deadline=float('inf'), caches=caches if caches is not None else {})

    def test_fold_title_traditional_and_decor(self):
        """书名比较做繁简折叠 + 去站点装饰尾缀：斗罗大陆 == 斗羅大陸 == 斗罗大陆最新章节；续作仍不等。"""
        f = labeler._fold_title
        self.assertTrue(f('斗罗大陆'))
        self.assertEqual(f('斗羅大陸'), f('斗罗大陆'))
        self.assertEqual(f('斗罗大陆最新章节'), f('斗罗大陆'))
        self.assertNotEqual(f('斗罗大陆IV终极斗罗'), f('斗罗大陆'))

    def test_same_book_passes(self):
        """同一本书的另一个源（同章号正文一致）→ 书首组 + 近窗组双双判同。"""
        cli = make_cli({'b.example.com': {'n': 100}})   # 默认 _book_body
        self.assertEqual(self._fill(cli, _entry('b.example.com')), '')

    def test_traditional_variant_same_book_fills(self):
        """繁简书名真同书（斗羅大陸）：正文 n-gram 比较前繁转简 → 双参照判同（rvlblseg R3-1.4 误拒修复）。"""
        cli = make_cli({'b.example.com': {'n': 100, 'title': '斗羅大陸'}})
        self.assertEqual(self._fill(cli, _entry('b.example.com', title='斗羅大陸'),
                                    plan=_plan_entry(title='斗罗大陆')), '')

    def test_title_fold_mismatch_rejected_without_fetch(self):
        """续作 / 异名书：书名折叠不等 → 直接拒、零正文请求。"""
        cli = make_cli({'b.example.com': {'n': 100, 'title': '斗罗大陆IV终极斗罗'}})
        self.assertEqual(self._fill(cli, _entry('b.example.com', title='斗罗大陆IV终极斗罗'),
                                    plan=_plan_entry(title='斗罗大陆')), 'title')
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_same_name_different_book_body_rejected(self):
        """同名、目录也雷同，但正文另一本书（r2_b 形态）→ 书首组正文信号判否，不补段。"""
        cli = make_cli({'b.example.com': {'n': 100, 'body': _other_body}})
        self.assertEqual(self._fill(cli, _entry('b.example.com')), 'body')

    def test_head_same_tail_different_rejected(self):
        """rvlblseg R3 头同尾异：计划源中段有可用章（近窗组，章号 4–7）时，「书首同、近窗换书」的候选被拦。
        候选前 3 章 = 同书、第 4 章起 = 另一本书 → 书首组勉强判同、近窗组判否 → 与门拒。"""
        cli = make_cli({'b.example.com': {'n': 100,
                        'body': lambda i: _book_body(i) if i < 3 else _other_body(i)}})
        self.assertEqual(self._fill(cli, _entry('b.example.com')), 'body')

    def test_title_position_mismatch_via_helper(self):
        """段位置标题核对 _seg_title_mismatch：同章号信息性章名不一致计入分母，辅助/预览标题跳过。"""
        plan = _plan_entry()['chapters']
        cand_ok = _plan_entry()['chapters']
        self.assertEqual(labeler._seg_title_mismatch(plan, cand_ok, {'start': 40, 'end': 46}), 0.0)
        cand_diff = _plan_entry(titles=lambda i: f'第{i + 1}章 迥异篇目{i:04d}')['chapters']
        self.assertGreater(labeler._seg_title_mismatch(plan, cand_diff, {'start': 40, 'end': 46}), 0.20)
        # 计划源该段挂 APP免费/番外 等辅助标题 → 跳过、不据此判不一致（分母 0 → 0.0）
        plan_aux = _plan_entry(titles=lambda i: (f'第{i + 1}章 番外{i}APP免费'
                                                 if 40 <= i < 46 else _chapter_title(i)))['chapters']
        self.assertEqual(labeler._seg_title_mismatch(plan_aux, cand_diff, {'start': 40, 'end': 46}), 0.0)

    def test_shared_generic_toc_rejected_without_fetch(self):
        """同名、仅共享 5 条站方通用条目（关于本书/人物介绍…，r2_d）→ 目录 Jaccard 远低于阈值 → 目录信号判否，
        连候选正文都不抓。"""
        cli = make_cli({'b.example.com': {'n': 100, 'titles': _generic_then('乙情节')}})
        cand = _entry('b.example.com', titles=_generic_then('乙情节'))
        self.assertEqual(self._fill(cli, cand, plan=_plan_entry(titles=_generic_then('甲情节'))), 'toc')
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_first_segment_uses_head_group_only(self):
        """第 1 段窗口在书首、无近窗组：只用书首组判同（同书可过）。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        self.assertEqual(self._fill(cli, _entry('b.example.com'), win={'no': 1, 'start': 0}), '')

    def test_no_reference_rejects(self):
        """计划源无可用参照章（第 1 段 short → hits 不作参照，rvlblseg R3 重点 3）→ 书首组不可判 → 拒、不接管。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        self.assertEqual(self._fill(cli, _entry('b.example.com'), plan_ref_hits=[]), 'body')

    def test_candidate_chapters_capped(self):
        """候选源核验抓章总数（书首组 + 近窗组）≤ SEG_FILL_VERIFY_MAX，且每组 ≤ SEG_FILL_MAX_CHAPTERS。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        self._fill(cli, _entry('b.example.com'))
        self.assertLessEqual(len(_content_calls(cli, 'b.example.com')), labeler.SEG_FILL_VERIFY_MAX)

    def test_candidate_fetch_counts_against_budget(self):
        """判同的候选抓章计入 240s 预算：剩余预算只够 2 次请求就停（_fetch_candidate_hits）。"""
        now = [0.0]
        cli = _TimedCli(now, lambda i: (10, True))    # 每次请求 10s
        cand = _entry('a.example.com')
        labeler._fetch_candidate_hits(cli, cand, [1, 2, 3, 4], deadline=15.0,
                                      clock=lambda: now[0], ch_cache={})
        self.assertEqual(len(_content_calls(cli, 'a.example.com')), 2)
        self.assertLessEqual(now[0], 15.0)

    def test_candidate_ch_cache_avoids_refetch(self):
        """跨段复用候选抓章缓存：同章号第二次核验不再发请求。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        caches = {}
        cand = _entry('b.example.com')
        self._fill(cli, cand, caches=caches)
        n1 = len(_content_calls(cli, 'b.example.com'))
        self._fill(cli, cand, caches=caches, win={'no': 3, 'start': 70})
        self.assertEqual(len(_content_calls(cli, 'b.example.com')), n1)   # 章号 1..7 已缓存

    def test_names_use_douban_informative_titles(self):
        """目录章名口径 = douban_list._informative_toc_titles：纯编号/短章名/辅助条目不计。"""
        chapters = [{'title': t, 'url': 'u'} for t in (
            '第1章', '第2章 起', '第3章 求月票加更', '第4章 少年初入江湖', '上架感言')]
        self.assertEqual(labeler.douban_list._informative_toc_titles(chapters), ['少年初入江湖'])


SEQUEL = '斗罗大陆IV终极斗罗'


def _sequel_book(list_author=AUTHOR):
    return {'url': 'https://a.example.com/book', 'title': '斗罗大陆', 'author': list_author,
            'engine': True, 'source_host': 'a.example.com',
            'engine_alternates': [{'url': 'https://b.example.com/book', 'title': SEQUEL,
                                   'source': 'b.example.com'}]}


def _a_late_4xx(i):
    return None if i >= 40 else _book_body(i)


class TestFillIdentityEndToEnd(_NoSleep):
    """rvlblseg ce2b/ce2c 形态：主源 40 章起 4xx，唯一备选是同作者前缀续作 → 不补段，后段标未取到。"""

    def assert_no_fill(self, cli, book, reason):
        text, chars, used, sampling, _ = _fetch(cli, book)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual(segs[1]['source'], 'a.example.com')
        for no in (2, 3, 4):
            self.assertTrue(segs[no].get('missing'), no)
        self.assertIn(f'b.example.com:identity_{reason}', segs[2]['tried'])
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])
        self.assertNotIn('b.example.com', text)
        self.assertEqual(used['url'], 'https://a.example.com/book')

    def test_same_author_prefix_sequel(self):
        """ce2c：同作者唐家三少、书名前缀兼容 → 旧口径放行；现书名严格不等 → 拒。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': SEQUEL,
                              'titles': lambda i: f'第{i + 1}章 终极篇目{i:04d}'},
        })
        self.assert_no_fill(cli, _sequel_book(), 'title')

    def test_sequel_with_empty_alt_author(self):
        """ce2b V2：备选 toc 作者为空（旧口径双侧非空才比 → 放行）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': SEQUEL, 'author': '',
                              'titles': lambda i: f'第{i + 1}章 终极篇目{i:04d}'},
        })
        self.assert_no_fill(cli, _sequel_book(), 'title')

    def test_sequel_with_empty_list_author(self):
        """ce2b V3：名单作者为空。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'author': '', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': SEQUEL,
                              'titles': lambda i: f'第{i + 1}章 终极篇目{i:04d}'},
        })
        self.assert_no_fill(cli, _sequel_book(list_author=''), 'title')

    def test_same_title_different_toc_rejected(self):
        """同名但目录章名对不上（同名异书）、备选作者为空 → 交给目录判定 → 拒。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': '斗罗大陆', 'author': '',
                              'titles': lambda i: f'第{i + 1}章 别的故事{i:04d}'},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗罗大陆'
        self.assert_no_fill(cli, book, 'toc')

    def test_same_title_same_toc_empty_author_fills(self):
        """同名、目录对得上、正文逐章一致（同一本书） → 可以补段（作者字段不再参与判定，rvlblseg R2-6）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': '斗罗大陆', 'author': ''},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗罗大陆'
        text, chars, used, sampling, _ = _fetch(cli, book)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual([segs[n]['source'] for n in (2, 3, 4)], ['b.example.com'] * 3)
        self.assertEqual(used['url'], 'https://a.example.com/book')

    def test_same_name_different_book_body_rejected(self):
        """rvlblseg r2_b 红线：同名、目录也雷同，但备选是另一本书（正文不同）→ 正文信号判否，不补段、不混书。
        备选正文只在身份核验时被抓 ≤SEG_FILL_MAX_CHAPTERS 章，绝不进入送模文本。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': '斗罗大陆', 'author': '', 'body': _other_body},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗罗大陆'
        text, chars, used, sampling, _ = _fetch(cli, book)
        segs = {s['no']: s for s in sampling['segments']}
        for no in (2, 3, 4):
            self.assertTrue(segs[no].get('missing'), no)
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(used['url'], 'https://a.example.com/book')
        self.assertLessEqual(len(_content_calls(cli, 'b.example.com')), labeler.SEG_FILL_MAX_CHAPTERS)
        self.assertNotIn('女帝苏璃', text)          # _other_body（另一本书）的正文特征绝不出现

    def test_shared_generic_entries_rejected(self):
        """rvlblseg r2_d 红线：同名，仅共享 5 条站方通用条目（关于本书/人物介绍…）→ 目录 Jaccard 远低于阈值
        → 目录信号判否，连备选正文都不抓（同名异书不再靠共享通用条目打穿目录）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx,
                              'titles': _generic_then('甲情节')},
            'b.example.com': {'n': 100, 'title': '斗罗大陆', 'author': '',
                              'titles': _generic_then('乙情节')},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗罗大陆'
        self.assert_no_fill(cli, book, 'toc')

    def test_traditional_variant_same_book_fills(self):
        """繁简真同书：备选书名 斗羅大陸（繁体），章名与正文都与简体主源一致 → 书名折叠后判同、双信号齐过 → 补段。
        身份闸对繁简放宽（_check_toc_identity title_fold），同名异书仍由 same_book 正文信号兜住。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': '斗羅大陸'},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗羅大陸'
        text, chars, used, sampling, _ = _fetch(cli, book)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual([segs[n]['source'] for n in (2, 3, 4)], ['b.example.com'] * 3)
        self.assertEqual(used['url'], 'https://a.example.com/book')

    def test_title_position_mismatch_end_to_end(self):
        """段位置标题核对（端到端）：备选正文是同书正文、目录整体也对得上，但**第 2 段窗口内章名**与计划源
        同章号大面积不一致（盗版站该段换了另一套章名）→ 送模章标题核对不过，弃该候选、该段未取到；
        其余段章名一致 → 照常补段。"""
        diff = lambda i: (f'第{i + 1}章 迥异篇目{i:04d}' if 40 <= i < 46 else _chapter_title(i))
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'titles': diff},   # 正文仍 _book_body（同书），仅第 2 段窗口章名不同
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertTrue(segs[2].get('missing'))
        self.assertIn('b.example.com:title_pos', segs[2]['tried'])
        self.assertEqual(segs[3]['source'], 'b.example.com')   # 第 3 段章名一致 → 照常补段

    def test_numbered_plan_toc_disables_fill(self):
        """计划源目录纯编号（无信息性章名）→ 身份无从核，不按段换源：备选连目录都不取，后段标未取到。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'titles': _numbered_title,
                              'body': lambda i: None if i >= 60 else _chapter_body('a.example.com', i)},
            'b.example.com': {'n': 100, 'titles': _numbered_title},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual([segs[n]['source'] for n in (1, 2)], ['a.example.com'] * 2)
        self.assertTrue(segs[3]['missing'] and segs[4]['missing'])
        self.assertFalse([c for c in cli.calls if labeler._url_host(c[1]) == 'b.example.com'])


class _TimedCli(FakeEngineCli):
    """带 timeout 属性的 CLI 桩：cost(sub, idx) → (耗时秒, 成功?)；传了 timeout 且耗时超过 → 超时失败。"""

    timeout = 60

    def __init__(self, now, cost, n=200):
        self.now, self.cost, self.n = now, cost, n
        super().__init__(self._handle)
        self._kw_timeout = None

    def run(self, subcommand, *args, **kw):
        self._kw_timeout = kw.get('timeout') or self.timeout
        return super().run(subcommand, *args, **kw)

    def _handle(self, sub, url):
        if sub == 'toc':
            self.now[0] += 1
            return _toc_proc('a.example.com', self.n)
        spent, ok = self.cost(_idx(url))
        if spent > self._kw_timeout:
            self.now[0] += self._kw_timeout
            raise subprocess.TimeoutExpired('engine', self._kw_timeout)   # 同 EngineCli 的 subprocess.run
        self.now[0] += spent
        if not ok:
            return _proc(1, '', '模拟失败')
        return _content_proc(_chapter_body('a.example.com', _idx(url)))


class TestSegmentBudget(_NoSleep):
    """时限（rvlblseg 非阻断 1）：单请求超时 = min(CLI 超时, 剩余预算)，退避计入预算。"""

    def test_worst_case_stays_within_budget(self):
        """ce6c 形态：第 2 段每章 46s，第 3 段起每章卡满 60s 超时 → 旧实现 358s；现 ≤ 240s。"""
        now = [0.0]

        def cost(i):
            if i <= 6:
                return 1, True
            if 80 <= i <= 84:
                return 46, True
            return 60, False
        cli = _TimedCli(now, cost)
        text, chars, used, sampling, _ = _fetch(cli, _book(), time_budget_s=240,
                                                clock=lambda: now[0])
        self.assertLessEqual(now[0], 240)
        self.assertIsNone(cli.timeouts[0])                      # 预算宽裕时不传 timeout（同改前）
        self.assertTrue(any(t is not None and t < 60 for t in cli.timeouts))
        self.assertFalse(sampling['segments'][0].get('missing'))

    def test_timeout_is_min_of_cli_and_remaining(self):
        now = [100.0]
        cli = _TimedCli(now, lambda i: (1, True))
        labeler._segment_chapter_text(cli, 'https://a.example.com/c1', deadline=130.0,
                                      clock=lambda: now[0])
        self.assertEqual(cli.timeouts, [30.0])
        cli2 = _TimedCli([0.0], lambda i: (1, True))
        labeler._segment_chapter_text(cli2, 'https://a.example.com/c1', deadline=1000.0,
                                      clock=lambda: 0.0)
        self.assertEqual(cli2.timeouts, [None])

    def test_backoff_counted_against_budget(self):
        """首次失败后剩余 < 退避 + 最短请求 → 不再重试；预算宽裕 → 照常退避重试。"""
        now = [0.0]
        cli = _TimedCli(now, lambda i: (1, False))
        self.assertEqual(labeler._segment_chapter_text(
            cli, 'https://a.example.com/c1', deadline=3.5, clock=lambda: now[0]), '')
        self.assertEqual(len(cli.calls), 1)
        cli2 = _TimedCli([0.0], lambda i: (1, False))
        self.assertEqual(labeler._segment_chapter_text(
            cli2, 'https://a.example.com/c1', deadline=1000.0, clock=lambda: 0.0), '')
        self.assertEqual(len(cli2.calls), labeler.SEG_CHAPTER_ATTEMPTS)

    def test_exhausted_budget_sends_nothing(self):
        cli = _TimedCli([0.0], lambda i: (1, True))
        self.assertEqual(labeler._segment_chapter_text(
            cli, 'https://a.example.com/c1', deadline=0.5, clock=lambda: 0.0), '')
        self.assertEqual(cli.calls, [])


class TestFirstSegmentShortChapters(_NoSleep):
    """开头真短章（rvlblseg ce5 场景 A）：第 1 段按累计有效字数判可用，不按章均误弃。"""

    def test_short_opening_chapters_kept(self):
        def body(i):
            return _chapter_body('a.example.com', i, 250 if i < 3 else 3000)
        cli = make_cli({'a.example.com': {'n': 100, 'body': body}, 'b.example.com': {'n': 100}})
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        seg1 = sampling['segments'][0]
        self.assertEqual((seg1['source'], seg1['switched'], seg1['partial']),
                         ('a.example.com', False, False))
        self.assertEqual(seg1['tried'], ['a.example.com:ok'])
        self.assertTrue(seg1['chapters'].startswith('1-'))
        self.assertNotIn('【第 1 段：未取到】', text)

    def test_preview_source_still_aborts_on_first_segment(self):
        """第 1 段仍能挡住预览源：形如截断预览 → 连续 3 章落空即弃；百余字但不带省略号 → 请求满 10 章按章均弃。
        计划源本身是预览源、没有可信正文参照时，备选无从过 same_book 正文信号 → 不补段、整本放弃
        （rvlblseg R2-6「宁可少救」：主源从第 1 章即预览的书会失采，属可接受的覆盖代价）。"""
        cli = make_cli({'a.example.com': {'n': 100, 'body': lambda i: f'预览{i}' + '字' * 110 + '……'},
                        'b.example.com': {'n': 100}})
        with self.assertRaises(labeler.EngineSourceGaveUp):
            _fetch(cli, _book(alternates=['b.example.com']))
        a_seg1 = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) < 40]
        self.assertEqual(len(a_seg1), labeler.SEG_PROBE_CHAPTERS)
        cli = make_cli({'a.example.com': {'n': 100, 'body': lambda i: f'短章{i}' + '字' * 150},
                        'b.example.com': {'n': 100}})
        with self.assertRaises(labeler.EngineSourceGaveUp):
            _fetch(cli, _book(alternates=['b.example.com']))
        a_seg1 = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) < 40]
        self.assertEqual(len(a_seg1), labeler.SEG_FIRST_PROBE_CHAPTERS)

    def test_usable_first_segment_by_cumulative_chars(self):
        res = {'requested': 30, 'eff_chars': 8_000, 'stop': 'target'}
        self.assertEqual(labeler.segment_usable(res, 20_000, first_segment=True), (True, ''))
        self.assertEqual(labeler.segment_usable(res, 20_000), (False, 'preview'))
        self.assertEqual(labeler.segment_usable(
            {'requested': 10, 'eff_chars': 2_500, 'stop': 'preview'}, 20_000, first_segment=True),
            (False, 'short'))


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

    def test_punctuation_width_insensitive(self):
        """模型把全角逗号/感叹号写成半角（完美世界实测）：仍算原文；但改一个字就不算。"""
        arc = labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': 3, 'quote': '你们一次又一次的震,震了天上,震地下'},
            {'segment': 1, 'quote': '"萧炎舔了舔嘴唇" 迟疑了一下'}]}, self.text())
        self.assertEqual((arc['decline'], arc['checked']['dropped']), ('mild', 0))
        arc = labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': 3, 'quote': '你们一次又一次地震,震了天上,震地下'},
            {'segment': 1, 'quote': self.Q1}]}, self.text())
        self.assertEqual((arc['decline'], arc['checked']['dropped']), ('unknown', 1))

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
            {'segment': 3, 'quote': self.Q3}, {'segment': 3, 'quote': '前面。' + self.Q3[:11]}]},
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


class TestArcEvidenceFloor(unittest.TestCase):
    """arc 证据下限（rvlblseg 非阻断 1b / ce1b）：≥12 个正文字、不认章标题行、不跨章拼接。"""

    TEXT = (
        '【第 1 段：开头，第 1–2 章】\n\n【第一章 少年初入江湖风云再起】\n'
        '他的心中一片宁静然后他抬头看向远方的天空久久不语\n\n'
        '【第二章 归途】\n风起云涌之中他的心中一片宁静继续前行\n\n'
        '【第 2 段：未取到】\n\n'
        '【第 3 段：约 70% 处，第 70–72 章】\n\n【第七十章 中途】\n无关紧要的一些内容放在这里\n\n'
        '【第 4 段：约 90% 处，第 90–92 章】\n\n【第九十章 末路之战血染长空万里】\n'
        '多年以后他的心中一片宁静却也物是人非只剩一声叹息'
    )

    def arc(self, *evidence):
        return labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': s, 'quote': q} for s, q in evidence]}, self.TEXT)

    def test_common_short_phrase_across_segments_rejected(self):
        a = self.arc((1, '他的心中一片宁静'), (4, '他的心中一片宁静'))
        self.assertEqual((a['decline'], a['checked']['dropped']), ('unknown', 2))

    def test_chapter_title_line_not_evidence(self):
        a = self.arc((1, '第一章 少年初入江湖风云再起'), (4, '第九十章 末路之战血染长空万里'))
        self.assertEqual((a['decline'], a['checked']['dropped']), ('unknown', 2))

    def test_quote_spanning_title_line_rejected(self):
        """跨章拼接（第一章末 + 第二章首，中间隔章标题行）不算原文。"""
        a = self.arc((1, '久久不语风起云涌之中他的心中'), (4, '多年以后他的心中一片宁静却也物是人非'))
        self.assertEqual((a['decline'], a['checked']['dropped']), ('unknown', 1))

    def test_twelve_chars_accepted_eleven_dropped(self):
        a = self.arc((1, '他抬头看向远方的天空久久不'), (4, '却也物是人非只剩一声叹息'))
        self.assertEqual((a['decline'], a['checked']['dropped']), ('mild', 0))
        a = self.arc((1, '他抬头看向远方的天空久久不'), (4, '也物是人非只剩一声叹息'))
        self.assertEqual((a['decline'], a['checked']['dropped']), ('unknown', 1))

    def test_multiline_prose_within_chapter_still_matches(self):
        text = self.TEXT.replace('然后他抬头', '然后\n他抬头')
        a = labeler.normalize_arc({'decline': 'mild', 'evidence': [
            {'segment': 1, 'quote': '他的心中一片宁静然后他抬头看向'},
            {'segment': 4, 'quote': '却也物是人非只剩一声叹息'}]}, text)
        self.assertEqual(a['decline'], 'mild')


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
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 60 else _book_body(i)},
            'b.example.com': {'n': 100},
        })
        seen = {}

        def label_fn(text, *a, **k):
            seen['text'], seen['kwargs'] = text, k
            labels = self.base_labels()
            q1 = _book_body(0)[:30]
            q4 = _book_body(90)[:30]
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

    def test_switch_on_record_url_is_plan_source_and_queue_skips(self):
        """rvlblseg ce8：备选供给大半原文时，记录 url/source 仍是计划源（名单主源）；
        下一轮 split_queue 认得出、不重打标；补段来源只在 sampling。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 10 else _book_body(i)},
            'b.example.com': {'n': 100},
        })
        code, recs, *_ = self.run_main('LABELER_SEGMENTED=1\n', cli,
                                       lambda *a, **k: (self.base_labels(), 1))
        self.assertEqual(code, 0)
        rec = recs[0]
        self.assertEqual((rec['url'], rec['source']), ('https://a.example.com/book', 'a.example.com'))
        self.assertEqual([s['source'] for s in rec['sampling']['segments']],
                         ['a.example.com'] + ['b.example.com'] * 3)
        done = labeler.load_done_urls(self.dir / 'labels.jsonl')
        todo, skipped, _ = labeler.split_queue([_book(alternates=['b.example.com'])], done, set())
        self.assertEqual((len(todo), len(skipped)), (0, 1))

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
