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

    def test_late_4xx_switches_source_near_boundary(self):
        """主源在第 3 段窗口起点(ch71)起 4xx：第 3 段窗口内计划源全不可读，但紧邻窗口起点前 ch70 可读 →
        向前探到近邻参照(nearest_prior)、与备选 b 同章号判同 → b 补第 3 段（已声明的接受残余：分歧点落在
        计划源最后可读章 ch70 与窗口起点 ch71 之间）。第 4 段分歧点距其窗口起点 >4 章 → 探不到参照 → 拒补、
        标未取到（改结构后的覆盖代价：计划源死得离窗口太远的段宁缺不混入）。b 与 a 同书（同章号正文一致）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 70 else _book_body(i)},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[1]['source'], segs[2]['source']), ('a.example.com', 'a.example.com'))
        self.assertEqual((segs[3]['source'], segs[3]['switched'], segs[3].get('ref')),
                         ('b.example.com', True, 'nearest_prior'))
        self.assertTrue(segs[3].get('ref_nums'))                # 记录了近邻参照章号
        self.assertTrue(segs[4].get('missing'))                 # 分歧点距第 4 段窗口 >4 章 → 宁缺
        self.assertEqual(sum(1 for c in cli.calls if c[0] == 'toc'), 2)  # 每源目录只取一次
        self.assertEqual(used['url'], 'https://a.example.com/book')    # 记录源恒为计划源
        self.assertNotIn('【第 3 段：未取到】', text)

    def test_preview_pages_abort_fast(self):
        """阳神型：第 2 段起章章返回 ~120 字预览 → 每段只花 SEG_PROBE_CHAPTERS 个请求就判不可用。
        第 2 段窗口起点前 ch40 仍可读 → 向前探近邻参照补第 2 段(nearest_prior)；第 3/4 段分歧点距窗口
        >4 章 → 探不到参照、标未取到（覆盖代价）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: (f'预览{i}' + '字' * 110 + '……')
                              if i >= 40 else _book_body(i)},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[2]['source'], segs[2].get('ref')), ('b.example.com', 'nearest_prior'))
        self.assertTrue(segs[3].get('missing') and segs[4].get('missing'))
        a_mid = [c for c in _content_calls(cli, 'a.example.com') if 40 <= _idx(c[1]) < 60]
        self.assertEqual(len(a_mid), labeler.SEG_PROBE_CHAPTERS)        # 第 2 段只探一次预览

    def test_record_source_stays_plan_source(self):
        """主源只供开头两段、第 3 段起 4xx（分歧点落在第 2/3 段窗口之间）→ 第 3 段由备选 b 近邻参照补，
        第 4 段分歧点距窗口 >4 章标未取到；返回的源仍是计划源（主源），记录 url 不被补段源改写
        （rvlblseg 必修 2），各段真实来源只记在 sampling。b 与 a 同书（同章号正文一致）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 70 else _book_body(i)},
            'b.example.com': {'n': 100, 'author': '唐家三少著'},
        })
        text, chars, used, sampling, stats = _fetch(cli, _book(alternates=['b.example.com']))
        self.assertEqual(used['url'], 'https://a.example.com/book')
        self.assertEqual([s.get('switched') for s in sampling['segments']],
                         [False, False, True, None])
        self.assertEqual([s.get('url') for s in sampling['segments']],
                         ['https://a.example.com/book', 'https://a.example.com/book',
                          'https://b.example.com/book', None])
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
        a_seg2 = [c for c in _content_calls(cli, 'a.example.com') if 40 <= _idx(c[1]) < 50]
        self.assertEqual(len(a_seg2), 6)
        seg2 = sampling['segments'][1]
        self.assertEqual((seg2['source'], seg2['chapters'], seg2['switched']),
                         ('a.example.com', '41-43', False))

    def test_app_free_titles_skipped_without_requests(self):
        """目录标题带 APP免费 的试读章不发请求；整段都是 → 该段 no_request。
        第 2 段窗口（章 41–70）整段是试读章：标题挂「番外…APP免费」（辅助子串）→ 计划源该窗口内**同章号章名
        全为辅助/不可判**，段位置标题核对分母为 0 → 不可判一律拒（必修 3），该段宁缺（覆盖代价：整段标题
        不可信的段不补）。第 3/4 段计划源章名正常 → 主源 a 照常供给。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'titles': lambda i: (
                f'第{i + 1}章 番外{i}APP免费' if 40 <= i < 70 else _chapter_title(i))},
            'b.example.com': {'n': 100},
        })
        text, chars, used, sampling, stats = _fetch(cli, _book(alternates=['b.example.com']))
        self.assertFalse([c for c in _content_calls(cli, 'a.example.com') if 40 <= _idx(c[1]) < 70])
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual(segs[2]['tried'], ['a.example.com:no_request', 'b.example.com:title_pos'])
        self.assertTrue(segs[2].get('missing'))
        self.assertEqual((segs[3]['source'], segs[4]['source']), ('a.example.com', 'a.example.com'))

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
        """备选源身份不符只跳过，改用下一个（新源必须过 same_book 双信号）：主源 a 在第 3 段窗口起点(ch71)
        起 4xx，向前探到 ch70 近邻参照；b 目录身份过关（同书名）但正文是同名下的另一本书 → 近邻参照正文信号
        判否、只花身份核验的抓章、不补段；c 与 a 同书 → 用 c 补第 3 段（nearest_prior）。第 4 段分歧点距
        窗口 >4 章 → 探不到参照、标未取到（覆盖代价）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 70 else _book_body(i)},
            'b.example.com': {'n': 100, 'body': _other_body},
            'c.example.com': {'n': 100},
        })
        text, chars, used, sampling, _ = _fetch(
            cli, _book(alternates=['b.example.com', 'c.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[3]['source'], segs[3].get('ref')), ('c.example.com', 'nearest_prior'))
        self.assertTrue(segs[4].get('missing'))
        self.assertIn('b.example.com:identity_body', segs[3]['tried'])
        # b 只被抓了近邻参照核验的 ≤SEG_FILL_MAX_CHAPTERS 章，从未拿它补任何段
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
    """补段源身份核验（rvlblseg R4 收口，改结构）：书名折叠 + 目录信号（零请求先判）+ 正文判同**落在
    目标窗口内、或紧邻窗口起点之前**（_plan_window_reference：窗口内有计划源可读章 → window；窗口内不可读
    但向前 ≤4 章能探到可读章 → nearest_prior；分歧区在窗口前即断裂、探不到 → reject）。段位置标题核对
    _seg_title_mismatch 在 fetch_segment 之后按实际送模章做，分母 0 → None → 一律拒（必修 3）。"""

    WIN = {'no': 2, 'start': 40}           # 第 2 段（约 40% 处），窗口起点 = 目录第 41 章

    def _fill(self, cli, cand, plan=None, win=None, caches=None,
              plan_window_hits=None, plan_ch_cache=None):
        reason, _ref, _nums = labeler.fill_source_identity(
            cli, plan or _plan_entry(), cand, win or self.WIN,
            deadline=float('inf'), caches=caches if caches is not None else {},
            plan_window_hits=plan_window_hits,
            plan_ch_cache=plan_ch_cache if plan_ch_cache is not None else {})
        return reason

    def _fill_ref(self, cli, cand, **kw):
        """返回 (reason, ref_mode) 供参照模式断言。"""
        plan = kw.get('plan') or _plan_entry()
        reason, ref, _nums = labeler.fill_source_identity(
            cli, plan, cand, kw.get('win') or self.WIN, deadline=float('inf'),
            caches=kw.get('caches') if kw.get('caches') is not None else {},
            plan_window_hits=kw.get('plan_window_hits'),
            plan_ch_cache=kw.get('plan_ch_cache') if kw.get('plan_ch_cache') is not None else {})
        return reason, ref

    def test_fold_title_traditional_and_decor(self):
        """书名比较做繁简折叠 + 去站点装饰尾缀：斗罗大陆 == 斗羅大陸 == 斗罗大陆最新章节；续作仍不等。"""
        f = labeler._fold_title
        self.assertTrue(f('斗罗大陆'))
        self.assertEqual(f('斗羅大陸'), f('斗罗大陆'))
        self.assertEqual(f('斗罗大陆最新章节'), f('斗罗大陆'))
        self.assertNotEqual(f('斗罗大陆IV终极斗罗'), f('斗罗大陆'))

    def test_nearest_prior_same_book_passes(self):
        """rvlblseg R4 必修 2（改结构）：目标窗口内计划源不可读，但紧邻窗口起点之前 ≤4 章可读 →
        向前探到近邻参照（nearest_prior），与候选同章号正文判同 → 真同书放行（已声明的接受残余：
        分歧点落在计划源最后可读章与窗口起点之间）。"""
        cli = make_cli({'b.example.com': {'n': 100}})   # 默认 _book_body，同书
        # 计划源窗口内(41+)全不可读，但 37–40 已读到（进 plan_ch_cache）→ 向前探命中缓存、不重抓
        cache = {n: _book_body(n - 1) for n in (37, 38, 39, 40)}
        reason, ref = self._fill_ref(cli, _entry('b.example.com'), plan_ch_cache=cache)
        self.assertEqual(reason, '')
        self.assertEqual(ref, 'nearest_prior')

    def test_window_reference_same_book_fills(self):
        """rvlblseg R4 必修 2：计划源在**目标段窗口内**有可读章（plan_window_hits）→ 用窗口内同章号章判同，
        真同书候选放行（ref=window），不退回书首组。"""
        cli = make_cli({'b.example.com': {'n': 100}})   # 同书正文
        win_hits = _ref_hits(nums=[41, 42, 43, 44])     # 计划源第 2 段窗口内读到 41–44 章
        reason, ref = self._fill_ref(cli, _entry('b.example.com'),
                                     plan_window_hits=win_hits)
        self.assertEqual(reason, '')
        self.assertEqual(ref, 'window')

    def test_window_reference_diverged_rejected(self):
        """rvlblseg R4 必修 2：窗口内计划源可读章 vs 候选同章号正文换书 → window 判否，拒补段。"""
        cli = make_cli({'b.example.com': {'n': 100, 'body': _other_body}})
        win_hits = _ref_hits(nums=[41, 42, 43, 44])
        reason, ref = self._fill_ref(cli, _entry('b.example.com'),
                                     plan_window_hits=win_hits)
        self.assertEqual(reason, 'body')
        self.assertEqual(ref, 'window')

    def test_traditional_variant_same_book_fills(self):
        """繁简书名真同书（斗羅大陸）：正文 n-gram 比较前繁转简 → 窗口内参照判同（rvlblseg R3-1.4 误拒修复）。"""
        cli = make_cli({'b.example.com': {'n': 100, 'title': '斗羅大陸'}})
        win_hits = _ref_hits(nums=[41, 42, 43, 44])
        self.assertEqual(self._fill(cli, _entry('b.example.com', title='斗羅大陸'),
                                    plan=_plan_entry(title='斗罗大陆'),
                                    plan_window_hits=win_hits), '')

    def test_title_fold_mismatch_rejected_without_fetch(self):
        """续作 / 异名书：书名折叠不等 → 直接拒、零正文请求。"""
        cli = make_cli({'b.example.com': {'n': 100, 'title': '斗罗大陆IV终极斗罗'}})
        self.assertEqual(self._fill(cli, _entry('b.example.com', title='斗罗大陆IV终极斗罗'),
                                    plan=_plan_entry(title='斗罗大陆')), 'title')
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_same_name_different_book_body_rejected(self):
        """同名、目录也雷同，但正文另一本书（r2_b 形态）→ 窗口内正文信号判否，不补段。"""
        cli = make_cli({'b.example.com': {'n': 100, 'body': _other_body}})
        self.assertEqual(self._fill(cli, _entry('b.example.com'),
                                    plan_window_hits=_ref_hits(nums=[41, 42, 43, 44])), 'body')

    def test_dead_zone_before_window_rejects(self):
        """rvlblseg R4 必修 2（红线，改结构，第四轮 E1 结构性拦截）：计划源在窗口起点之前已进死区
        （46 起 4xx），目标窗口内也无可读章 → 向前探最近可读章遇 4xx 即停、探不到参照 → ref=reject，
        不拿分歧点之前的书首/近窗组给后段背书，候选正文一次都不抓。"""
        cli = make_cli({'plan': {'n': 100, 'body': lambda i: _book_body(i) if i < 45 else None},
                        'b.example.com': {'n': 100,
                            'body': lambda i: _book_body(i) if i < 45 else _other_body(i)}})
        reason, ref = self._fill_ref(cli, _entry('b.example.com'), win={'no': 3, 'start': 70})
        self.assertEqual(reason, 'body')
        self.assertEqual(ref, 'reject')
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_title_position_mismatch_via_helper(self):
        """段位置标题核对 _seg_title_mismatch：同章号信息性章名不一致计入分母，辅助/预览标题跳过。
        rvlblseg R4 必修 3：无可比章（分母 0）→ **None（不可判）**，调用方按「一律拒」处理。"""
        plan = _plan_entry()['chapters']
        cand_ok = _plan_entry()['chapters']
        self.assertEqual(labeler._seg_title_mismatch(plan, cand_ok, {'start': 40, 'end': 46}), 0.0)
        cand_diff = _plan_entry(titles=lambda i: f'第{i + 1}章 迥异篇目{i:04d}')['chapters']
        self.assertGreater(labeler._seg_title_mismatch(plan, cand_diff, {'start': 40, 'end': 46}), 0.20)
        # 计划源该段挂 APP免费/番外 等辅助标题 → 跳过、不据此判 → 分母 0 → None（不可判，必修 3）
        plan_aux = _plan_entry(titles=lambda i: (f'第{i + 1}章 番外{i}APP免费'
                                                 if 40 <= i < 46 else _chapter_title(i)))['chapters']
        self.assertIsNone(labeler._seg_title_mismatch(plan_aux, cand_diff, {'start': 40, 'end': 46}))

    def test_title_mismatch_skips_unnumbered_chapters(self):
        """rvlblseg R4 必修 1：候选/计划源含无章号章（楔子/序章 → num=None）时不崩溃、不参与同章号比对。"""
        plan = ([{'title': '楔子 少年初见', 'url': 'u'}]
                + [{'title': _chapter_title(i), 'url': 'u'} for i in range(1, 100)])
        cand = ([{'title': '序章', 'url': 'u'}]
                + [{'title': _chapter_title(i), 'url': 'u'} for i in range(1, 100)])
        # 不抛异常；num=None 的首条不计入分母
        self.assertEqual(labeler._seg_title_mismatch(plan, cand, {'start': 0, 'end': 6}), 0.0)

    def test_plan_window_reference_skips_none_num(self):
        """rvlblseg R4 必修 1：plan_window_hits 含 num=None 章（楔子/序章）时，_plan_window_reference
        不崩溃、无编号章不参与按章号取参照。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        hits = [{'num': None, 'text': _book_body(0)}] + _ref_hits(nums=[41, 42, 43, 44])
        groups, ref = labeler._plan_window_reference(
            cli, _plan_entry(), hits, self.WIN, float('inf'), lambda: 0.0, {})
        self.assertNotIn(None, [h['num'] for h in groups])
        self.assertEqual(ref, 'window')

    def test_plan_window_reference_nearest_prior_skips_none_num(self):
        """rvlblseg R4 必修 1：向前探时遇 num=None 的无编号章跳过、继续向前，不崩溃。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        # 计划源目录：窗口起点前一条是「楔子」（num=None）→ 探测须跳过它继续向前
        plan = _plan_entry(titles=lambda i: ('楔子 少年初见' if i == 39 else _chapter_title(i)))
        cache = {n: _book_body(n - 1) for n in (37, 38, 39)}     # 40 号位是楔子无章号
        groups, ref = labeler._plan_window_reference(
            cli, plan, None, self.WIN, float('inf'), lambda: 0.0, cache)
        self.assertNotIn(None, [h['num'] for h in groups])
        self.assertEqual(ref, 'nearest_prior')

    def test_shared_generic_toc_rejected_without_fetch(self):
        """同名、仅共享 5 条站方通用条目（关于本书/人物介绍…，r2_d）→ 目录 Jaccard 远低于阈值 → 目录信号判否，
        连候选正文都不抓。"""
        cli = make_cli({'b.example.com': {'n': 100, 'titles': _generic_then('乙情节')}})
        cand = _entry('b.example.com', titles=_generic_then('乙情节'))
        self.assertEqual(self._fill(cli, cand, plan=_plan_entry(titles=_generic_then('甲情节'))), 'toc')
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_first_segment_uses_head_group_only(self):
        """第 1 段窗口在书首：用窗口内章（书首即窗口）判同（同书可过，ref=window）。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        reason, ref = self._fill_ref(cli, _entry('b.example.com'), win={'no': 1, 'start': 0},
                                     plan_window_hits=_ref_hits(nums=[1, 2, 3, 4]))
        self.assertEqual(reason, '')
        self.assertEqual(ref, 'window')

    def test_no_reference_rejects(self):
        """计划源无任何可用参照章（窗口内空 + 窗口起点即书首、无从向前探）→ ref=reject → 拒、不接管，
        候选正文一次都不抓。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        reason, ref = self._fill_ref(cli, _entry('b.example.com'),
                                     win={'no': 1, 'start': 0}, plan_window_hits=[])
        self.assertEqual(reason, 'body')
        self.assertEqual(ref, 'reject')
        self.assertEqual(_content_calls(cli, 'b.example.com'), [])

    def test_candidate_chapters_capped(self):
        """候选源核验抓章总数 ≤ SEG_FILL_VERIFY_MAX。"""
        cli = make_cli({'b.example.com': {'n': 100}})
        self._fill(cli, _entry('b.example.com'), plan_window_hits=_ref_hits(nums=[41, 42, 43, 44]))
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
        wh = _ref_hits(nums=[41, 42, 43, 44])
        self._fill(cli, cand, caches=caches, plan_window_hits=wh)
        n1 = len(_content_calls(cli, 'b.example.com'))
        self._fill(cli, cand, caches=caches, win={'no': 3, 'start': 70}, plan_window_hits=wh)
        self.assertEqual(len(_content_calls(cli, 'b.example.com')), n1)   # 章号 41..44 已缓存

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
        """同名、目录对得上、正文逐章一致（同一本书） → 可以补段（作者字段不再参与判定，rvlblseg R2-6）。
        主源 a 在 ch41 起 4xx → 第 2 段向前探近邻参照(nearest_prior)判同、b 补第 2 段；第 3/4 段分歧点距窗口
        >4 章 → 探不到参照、标未取到（改结构后的覆盖代价）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': '斗罗大陆', 'author': ''},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗罗大陆'
        text, chars, used, sampling, _ = _fetch(cli, book)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[2]['source'], segs[2].get('ref')), ('b.example.com', 'nearest_prior'))
        self.assertTrue(segs[3].get('missing') and segs[4].get('missing'))
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
        """繁简真同书：备选书名 斗羅大陸（繁体），章名与正文都与简体主源一致 → 书名折叠后判同、双信号齐过。
        主源 a 在 ch41 起 4xx（分歧点落在第 1/2 段窗口之间）→ 第 2 段向前探近邻参照(nearest_prior)补，
        繁体正文经繁简折叠后判同 → b 补第 2 段；第 3/4 段分歧点距窗口 >4 章 → 探不到参照、标未取到（覆盖代价）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'title': '斗罗大陆', 'body': _a_late_4xx},
            'b.example.com': {'n': 100, 'title': '斗羅大陸'},
        })
        book = _sequel_book()
        book['engine_alternates'][0]['title'] = '斗羅大陸'
        text, chars, used, sampling, _ = _fetch(cli, book)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[2]['source'], segs[2].get('ref')), ('b.example.com', 'nearest_prior'))
        self.assertTrue(segs[3].get('missing') and segs[4].get('missing'))
        self.assertEqual(used['url'], 'https://a.example.com/book')

    def test_title_position_mismatch_end_to_end(self):
        """段位置标题核对（端到端）：备选正文是同书正文、目录整体也对得上，但**第 2 段窗口内章名**与计划源
        同章号大面积不一致（盗版站该段换了另一套章名）→ 送模章标题核对不过，弃该候选、该段未取到；
        计划源正文在第 2、3 段窗口内各局部 4xx（窗口起点前一章可读）→ 两段都靠近邻参照判同，第 3 段章名一致
        → 照常补段。"""
        diff = lambda i: (f'第{i + 1}章 迥异篇目{i:04d}' if 40 <= i < 46 else _chapter_title(i))
        a_dead = lambda i: None if (40 <= i < 45) or (70 <= i < 74) else _book_body(i)
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': a_dead},
            'b.example.com': {'n': 100, 'titles': diff},   # 正文仍 _book_body（同书），仅第 2 段窗口章名不同
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertTrue(segs[2].get('missing'))
        self.assertIn('b.example.com:title_pos', segs[2]['tried'])
        self.assertEqual((segs[3]['source'], segs[3].get('ref')), ('b.example.com', 'nearest_prior'))

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


_AD_LINE = '本站永久域名请记住并推荐给书友多多支持正版订阅谢谢大家的厚爱与陪伴一路相随。'
_DIV_POOL = ('风云雷电山河湖海剑气刀光血月妖魔仙神魂魄天地玄黄宇宙洪荒'
             '少年白发红颜青丝古道西风瘦马小桥流水人家断肠天涯明月清泉')


def _diverge_after(keep_upto):
    """b 侧正文：章号 ≤keep_upto 与计划源逐字相同（_book_body），其后换另一本书（_other_body）。
    分歧点 = ch(keep_upto+1)。参照 = nearest_prior[37,38,39,40]：keep_upto=38→分歧 ch39=L−1（F1/d=2），
    =39→分歧 ch40=L（d=1）。"""
    return lambda i: _book_body(i) if (i + 1) <= keep_upto else _other_body(i)


def _diverse_body(i, n=2000):
    """逐章各异的伪随机中文正文（n-gram 集丰富，贴近真实章节，非重复短句夹具）；同 i 稳定复现
    → 同书跨源同章一致。用于「真同书 + 参照章带广告噪声」硬正例：真实章节噪声不该把 Jaccard 打崩。"""
    import random
    r = random.Random(90_000 + i)
    head = f'第{i}章起。'
    return head + ''.join(r.choice(_DIV_POOL) for _ in range(n - len(head)))


def _poll_other(text):
    """异书特征句命中数（_OTHER 情节句出现在送模文本里的条数）→ >0 即混书。"""
    return sum(1 for s in _OTHER if s in text)


class TestFillIdentityAndGate(_NoSleep):
    """rvlblseg R5 必修 F1（改结构=与门）端到端回归：`_body_decides` 只数「≥2 互异匹配章对」，分歧点落在
    参照章之内（L−1、L）时前若干章仍匹配、凑够 2 对即被旧逻辑放行 → 分歧章及其后异书正文被拼入。
    与门加两道否决：(a) 任一可判且不匹配章对 → 拒；(b) 最靠近窗口的参照章必须可判且匹配。
    夹具：a 读 ch1..40（ch41 起 4xx）→ seg2 窗口(41+)不可读 → 向前探近邻参照 nearest_prior=[37,38,39,40]。"""

    def _run(self, b_body, **b_spec):
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': _a_late_4xx},
            'b.example.com': dict({'n': 100, 'body': b_body}, **b_spec),
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        return text, {s['no']: s for s in sampling['segments']}

    def test_f1_diverge_at_L_minus_1_rejected(self):
        """必修 F1 == 边界 d=2：b 与 a 同到 ch38、ch39(=L−1)起换书。参照 [37,38,39,40] 里 37/38 匹配、
        39/40 可判且不匹配 → 与门条件 (a) 否决 → 拒补段，异书正文不混入（旧逻辑：2 对匹配即放行 → 泄漏）。"""
        text, segs = self._run(_diverge_after(38))
        self.assertTrue(segs[2].get('missing'))
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(_poll_other(text), 0)
        self.assertNotIn('b.example.com', text)

    def test_diverge_at_L_rejected(self):
        """边界 d=1：b 与 a 同到 ch39、ch40(=L，最靠近窗口的参照章)起换书。参照 37/38/39 匹配、ch40 可判且
        不匹配 → 与门条件 (a) 与 (b) 同时否决 → 拒补段（旧逻辑：3 对匹配即放行 → 泄漏）。"""
        text, segs = self._run(_diverge_after(39))
        self.assertTrue(segs[2].get('missing'))
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(_poll_other(text), 0)

    def test_deep_diverge_stays_rejected(self):
        """边界 d=3：b 与 a 只同到 ch37、ch38 起换书 → 参照里只有 1 对匹配 → `_body_decides` 本就判否
        （与门前已安全，回归护栏防未来放松）。"""
        text, segs = self._run(_diverge_after(37))
        self.assertTrue(segs[2].get('missing'))
        self.assertEqual(_poll_other(text), 0)

    def test_same_book_with_ad_noise_still_fills(self):
        """新硬正例（如实报）：真同书镜像，唯独**最靠近窗口的参照章 ch40** 正文尾部塞 800 字站点广告。
        用**多样化正文**（贴近真实章节）：广告噪声后同章 Jaccard 仍 ≥阈值 → 与门不误拒、seg2 照常补段。
        （用重复短句夹具则噪声会把稀疏 n-gram 集的并集撑大、Jaccard 崩 → 那是夹具假象，见 §11 覆盖率代价。）"""
        def a_body(i):
            return _diverse_body(i) if i < 40 else None       # a 读 1..40，ch41 起 4xx

        def b_body(i):
            base = _diverse_body(i)                            # b 全本真同书镜像
            if i == 39:                                        # ch40：尾部塞 800 字广告
                return base + '\n' + (_AD_LINE * (800 // len(_AD_LINE) + 1))[:800]
            return base
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': a_body},
            'b.example.com': {'n': 100, 'body': b_body},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual((segs[2]['source'], segs[2].get('ref')), ('b.example.com', 'nearest_prior'))
        self.assertEqual(_poll_other(text), 0)                # 真同书，不含异书特征句


def _short_escape_body(short_chars):
    """候选正文（nearest_prior 短章逃逸形态，i2/i2b）：ch1..38 同书、ch39 = 另一本书但仅 short_chars 字、
    ch40 回同书、ch41+ 异书。计划源(_a_late_4xx) ch39 可判(3000)，全称与门要求候选 ch39 也可判且匹配。"""
    def b(i):
        ch = i + 1
        if ch <= 38:
            return _book_body(i)
        if ch == 39:
            return _other_body(i, short_chars)
        if ch == 40:
            return _book_body(i)
        return _other_body(i)
    return b


class TestFillIdentityWindowPath(_NoSleep):
    """rvlblseg R7：补齐 ref=window 路径的与门端到端回归（第六轮复审指出上轮 4 条新测全落 nearest_prior）。
    R7 结构：window 参照集改取窗口内计划源可判章的**最后** ≤4 章（以 L 收尾），全称与门要求参照集每章
    （计划源侧可判）在候选侧都可判且匹配 → 分歧点 ≤ L 必在 L 章暴露 → 拒补。夹具：计划源读入 seg2 窗口
    若干章后判 short（<40% target）触发补段且 ref=window；短章逃逸两条走 nearest_prior。"""

    def _run_np(self, b_body):
        """nearest_prior 形态：a 读 ch1..40（ch41 起 4xx）→ ref=nearest_prior[37,38,39,40]。"""
        cli = make_cli({'a.example.com': {'n': 100, 'body': _a_late_4xx},
                        'b.example.com': {'n': 100, 'body': b_body}})
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        return text, {s['no']: s for s in sampling['segments']}

    def test_window_gap_diverge_at_L_rejected(self):
        """i1_window_gap W-GAP：计划源窗口内读 ch41..45（5×800=4000<6000 short）→ ref=window 收尾于 L=45；
        候选同到 ch44、ch45(=L)起换书。旧版参照截到窗口最前 4 章 [41..44] 看不到 ch45 → 泄漏；
        R7 参照 = 末 4 章 [42..45] 含 L → ch45 不匹配 → 拒补，异书正文不混入。"""
        a = lambda i: _book_body(i, 800) if i < 45 else None
        b = lambda i: _book_body(i, 800) if (i + 1) <= 44 else _other_body(i, 800)
        cli = make_cli({'a.example.com': {'n': 100, 'body': a},
                        'b.example.com': {'n': 100, 'body': b}})
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertNotEqual(segs[2].get('source'), 'b.example.com')   # b 被拒，seg2 退回计划源短读
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(_poll_other(text), 0)

    def test_window_bigtotal_2000char_diverge_rejected(self):
        """i1h total=240000（短阈值 18000，窗口 ch81..140）：计划源读 ch1..85 @2000 → 窗口读 5 章=10000<18000
        short → ref=window 收尾于 L=85；候选同到 ch84、ch85(=L)起换书 → ch85 不匹配 → 拒补。"""
        a = lambda i: _book_body(i, 2000) if i < 85 else None
        b = lambda i: _book_body(i, 2000) if (i + 1) <= 84 else _other_body(i, 2000)
        cli = make_cli({'a.example.com': {'n': 200, 'body': a},
                        'b.example.com': {'n': 200, 'body': b}})
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']),
                                                total_chars=240_000)
        segs = {s['no']: s for s in sampling['segments']}
        self.assertNotEqual(segs[2].get('source'), 'b.example.com')   # b 被拒，seg2 退回计划源短读
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(_poll_other(text), 0)

    def test_short_escape_candidate_499char_rejected(self):
        """i2b 499 字分歧章：候选 ch39 = 异书但仅 499 字(<500 不可判)。旧版 ch39「不可判」→ 与门 (a) 看不到
        分歧、ch40 匹配即放行 → 泄漏；R7 全称与门：计划源 ch39 可判(3000)而候选 ch39 不可判 → 拒补。"""
        text, segs = self._run_np(_short_escape_body(499))
        self.assertTrue(segs[2].get('missing'))
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(_poll_other(text), 0)

    def test_short_escape_v1_candidate_300char_rejected(self):
        """i2 V1 形态：候选 ch39 = 异书但仅 300 字(<500 不可判) → 同上，拒补、异书不混入。"""
        text, segs = self._run_np(_short_escape_body(300))
        self.assertTrue(segs[2].get('missing'))
        self.assertIn('b.example.com:identity_body', segs[2]['tried'])
        self.assertEqual(_poll_other(text), 0)

    def test_window_same_book_with_ad_noise_still_fills(self):
        """window 路径硬正例（如实报）：真同书镜像，计划源窗口内读 ch41..45(5×800 short)→ ref=window[42..45]；
        候选 b 全本同书、唯 L 章(ch45)尾部塞带标点的站点广告 → 用多样化正文 Jaccard 仍过阈 →
        与门不误拒、seg2 由 b 补、异书混入 0。"""
        def a(i):
            return _diverse_body(i, 800) if i < 45 else None

        def b(i):
            base = _diverse_body(i, 800)
            if i == 44:                                    # ch45 = L：尾部塞 800 字带标点广告
                return base + '。' + (_AD_LINE * (800 // len(_AD_LINE) + 1))[:800]
            return base
        cli = make_cli({'a.example.com': {'n': 100, 'body': a},
                        'b.example.com': {'n': 100, 'body': b}})
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        segs = {s['no']: s for s in sampling['segments']}
        self.assertEqual(segs[2].get('source'), 'b.example.com')      # 真同书：seg2 由 b 补
        self.assertNotEqual(segs[2].get('ref'), 'nearest_prior')      # 计划源读入窗口 → 走 window 分支
        self.assertEqual(_poll_other(text), 0)


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
        # 只数第 1 段窗口本身的请求（<10）：后段补段判同会向前探计划源近邻章（idx 36–39 等），不算第 1 段
        a_seg1 = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) < 30]
        self.assertEqual(len(a_seg1), labeler.SEG_PROBE_CHAPTERS)
        cli = make_cli({'a.example.com': {'n': 100, 'body': lambda i: f'短章{i}' + '字' * 150},
                        'b.example.com': {'n': 100}})
        with self.assertRaises(labeler.EngineSourceGaveUp):
            _fetch(cli, _book(alternates=['b.example.com']))
        a_seg1 = [c for c in _content_calls(cli, 'a.example.com') if _idx(c[1]) < 30]
        self.assertEqual(len(a_seg1), labeler.SEG_FIRST_PROBE_CHAPTERS)

    def test_usable_first_segment_by_cumulative_chars(self):
        res = {'requested': 30, 'eff_chars': 8_000, 'stop': 'target'}
        self.assertEqual(labeler.segment_usable(res, 20_000, first_segment=True), (True, ''))
        self.assertEqual(labeler.segment_usable(res, 20_000), (False, 'preview'))
        self.assertEqual(labeler.segment_usable(
            {'requested': 10, 'eff_chars': 2_500, 'stop': 'preview'}, 20_000, first_segment=True),
            (False, 'short'))


# ---- lblsegfix42：付费墙计划源换锚补段 ----
# 真书形态（lblsegreal42）：计划源 book.qq.com 第 1 段免费，后段章正文是 ~197 字预览（is_preview_body 命中），
# 窗口内与向前探 4 章都拿不到可判参照 → ref_mode='reject'。换锚：在计划源可读区与计划源正文判同成立的候选作锚，
# 另过防护 B（窗口目录有序一致）与 C（锚段首/末章开头 vs 计划源同章号预览开头）。
_HEAD_POOL = sorted(set(''.join(_PLOT + _OTHER)) - set('。'))


def _seeded_head(seed: int, i: int, n: int = 150) -> str:
    """章开头 n 字：按 (书, 章) 伪随机排字 → 4-gram 几乎全唯一（预览探针可比，异书/异章几乎不重合）。"""
    return ''.join(_HEAD_POOL[(seed * 131 + i * 977 + k * k * 31 + k * 7) % len(_HEAD_POOL)]
                   for k in range(n))


def _headed_body(seed: int, pool_body):
    """正文 = 伪随机开头 150 字 + 。 + 原夹具正文（逐章各异、同书跨源一致）。"""
    return lambda i: _seeded_head(seed, i) + '。' + pool_body(i, 3000 - 151)


_BOOK_A = _headed_body(1, _book_body)       # 本书
_BOOK_X = _headed_body(2, _other_body)      # 另一本书（开头与正文都不同）


def _paywall(body, free_upto: int = 10):
    """计划源付费墙：前 free_upto 章全文，其后每章只给开头 150 字 + 省略号（形如 book.qq.com 预览）。"""
    return lambda i: body(i) if i < free_upto else body(i)[:150] + '……'


class TestAnchorFill(_NoSleep):
    """换锚补段端到端：正例、无锚拒补、锚源后段换书（目录换 / 正文换）被拦、计划源 4xx 无预览 → 拒。"""

    def _run(self, b_spec, a_body=None):
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': a_body or _paywall(_BOOK_A)},
            'b.example.com': {'n': 100, **b_spec},
        })
        text, chars, used, sampling, _ = _fetch(cli, _book(alternates=['b.example.com']))
        return cli, text, used, {s['no']: s for s in sampling['segments']}

    def test_anchor_fills_paywalled_segments(self):
        """正例：a 只有前 10 章可读（第 1 段读 ch1–7），后段全是预览 → 窗口内 + 向前 4 章皆预览 → reject；
        b 在 a 可读区 ch4–7 过全称与门 → 作锚补第 2/3/4 段，记录 ref=anchor、ref_src=b、参照章号与预览核对章号。"""
        cli, text, used, segs = self._run({'body': _BOOK_A})
        self.assertEqual(segs[1]['source'], 'a.example.com')
        self.assertEqual(segs[1]['ref_src'], 'https://a.example.com/book')
        for no in (2, 3, 4):
            self.assertEqual((segs[no]['source'], segs[no].get('ref'), segs[no]['ref_src']),
                             ('b.example.com', 'anchor', 'https://b.example.com/book'), no)
            self.assertEqual(segs[no]['ref_nums'], [4, 5, 6, 7], no)   # 计划源可读区以 L=ch7 收尾
            self.assertTrue(segs[no]['head_nums'], no)                # 防护 C 核对过计划源预览
            self.assertIn('b.example.com:identity_body', segs[no]['tried'])
        self.assertEqual(used['url'], 'https://a.example.com/book')    # 记录源恒为计划源
        self.assertNotIn('【第 2 段：未取到】', text)

    def test_no_anchor_rejects(self):
        """无锚拒补：b 同名、目录一致，但正文是另一本书 → 在 a 可读区判否 → 不作锚，第 2/3/4 段 MISSING。"""
        cli, text, used, segs = self._run({'body': _BOOK_X})
        for no in (2, 3, 4):
            self.assertTrue(segs[no].get('missing'), no)
        self.assertIn('b.example.com:anchor_body', segs[2]['tried'])
        self.assertNotIn('女帝苏璃', text)
        # b 只被抓锚核验的 ≤SEG_FILL_MAX_CHAPTERS 章（缓存跨段复用），从未抓它的段窗口
        self.assertEqual(len(_content_calls(cli, 'b.example.com')), labeler.SEG_FILL_MAX_CHAPTERS)

    def test_anchor_switching_toc_later_blocked(self):
        """锚源后段换书（目录也换）：b 前 90 章 = 本书，ch91 起目录与正文都是另一本书（整本目录仍判同：
        换书部分只占 10%）→ 第 2/3 段照常换锚补，第 4 段被防护 B（窗口目录有序一致）拦下 → MISSING，
        另一本书正文绝不进送模文本。"""
        cli, text, used, segs = self._run({
            'titles': lambda i: _chapter_title(i) if i < 90 else f'第{i + 1}章 别的故事{i:04d}',
            'body': lambda i: _BOOK_A(i) if i < 90 else _BOOK_X(i)})
        for no in (2, 3):
            self.assertEqual((segs[no]['source'], segs[no].get('ref')), ('b.example.com', 'anchor'), no)
        self.assertTrue(segs[4].get('missing'))
        self.assertIn('b.example.com:anchor_toc_window', segs[4]['tried'])
        self.assertNotIn('女帝苏璃', text)

    def test_anchor_switching_body_later_blocked(self):
        """锚源后段换书（目录不变、正文换）：目录层面（防护 B、段位置标题核对）看不出 → 由防护 C 拦：
        锚段首/末章开头与计划源同章号预览开头不符 → 弃，第 3/4 段 MISSING。"""
        cli, text, used, segs = self._run({'body': lambda i: _BOOK_A(i) if i < 70 else _BOOK_X(i)})
        self.assertEqual((segs[2]['source'], segs[2].get('ref')), ('b.example.com', 'anchor'))
        for no in (3, 4):
            self.assertTrue(segs[no].get('missing'), no)
            self.assertIn('b.example.com:anchor_head', segs[no]['tried'])
        self.assertNotIn('女帝苏璃', text)

    def test_anchor_switch_mid_segment_caught_by_last_chapter(self):
        """送模区间中途换书：b 从第 3 段窗口第 3 章（ch73）起正文换书 → 首章开头仍对得上，末章对不上 → 弃。"""
        cli, text, used, segs = self._run({'body': lambda i: _BOOK_A(i) if i < 72 else _BOOK_X(i)})
        self.assertTrue(segs[3].get('missing'))
        self.assertIn('b.example.com:anchor_head', segs[3]['tried'])
        self.assertNotIn('女帝苏璃', text)

    def test_plan_4xx_without_preview_rejects(self):
        """计划源后段直接 4xx（无预览可比）：锚核验虽过，防护 C 无探针 → 不可判一律拒，且不抓锚段正文。"""
        cli, text, used, segs = self._run(
            {'body': _BOOK_A}, a_body=lambda i: _BOOK_A(i) if i < 10 else None)
        for no in (2, 3, 4):
            self.assertTrue(segs[no].get('missing'), no)
            self.assertIn('b.example.com:anchor_head_noref', segs[no]['tried'])
        self.assertEqual(len(_content_calls(cli, 'b.example.com')), labeler.SEG_FILL_MAX_CHAPTERS)

    def test_no_readable_reference_is_noref(self):
        """计划源可读区为空（连第 1 段都没读到可判章）→ anchor_identity 返回 noref，不作锚。"""
        why, nums = labeler.anchor_identity(
            make_cli({}), _plan_entry(), _entry('b.example.com'), float('inf'),
            caches={}, plan_ch_cache={40: '预览' * 60 + '……'})
        self.assertEqual((why, nums), ('noref', []))


class TestAnchorWindowToc(unittest.TestCase):
    """防护 B：按章名对齐后比窗口目录；两站目录条数略有出入（窗口起点错开）不误拒，换书 / 对不齐一律拒。"""

    WIN = {'no': 3, 'start': 70, 'end': 90}

    def test_same_toc(self):
        self.assertTrue(labeler._anchor_window_toc_ok(
            _plan_entry()['chapters'], self.WIN, _entry('b.example.com')['chapters']))

    def test_offset_toc_aligned_by_name(self):
        """锚源目录多 5 条（前面多了卷首语类条目）→ 按首个信息性章名对齐，仍判一致。"""
        shifted = [{'title': f'卷首语{k}', 'url': f'https://b/x{k}'} for k in range(5)] \
            + _entry('b.example.com')['chapters']
        self.assertTrue(labeler._anchor_window_toc_ok(_plan_entry()['chapters'], self.WIN, shifted))

    def test_switched_toc_rejected(self):
        other = _entry('b.example.com', titles=lambda i: _chapter_title(i) if i < 75
                       else f'第{i + 1}章 别的故事{i:04d}')['chapters']
        self.assertFalse(labeler._anchor_window_toc_ok(_plan_entry()['chapters'], self.WIN, other))

    def test_numbered_only_window_rejected(self):
        plan = _plan_entry(titles=lambda i: _numbered_title(i) if i >= 70 else _chapter_title(i))
        self.assertFalse(labeler._anchor_window_toc_ok(
            plan['chapters'], self.WIN, _entry('b.example.com')['chapters']))


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
        # 主源 a 在第 4 段窗口起点(ch91)起 4xx：前三段 a 供给，第 4 段窗口内计划源不可读、但紧邻 ch90 可读
        # → 向前探近邻参照补第 4 段(nearest_prior)，b 与 a 同书。
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 90 else _book_body(i)},
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
                         ['a.example.com', 'a.example.com', 'a.example.com', 'b.example.com'])
        self.assertEqual(segs[3].get('ref'), 'nearest_prior')
        self.assertEqual(rec['url'], 'https://a.example.com/book')
        self.assertEqual(rec['label_source'], 'text_engine')
        self.assertIn('分布式采样', out)
        self.assertIn('第4段 b.example.com', out)

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
        """rvlblseg ce8：备选补某段时，记录 url/source 仍是计划源（名单主源）；
        下一轮 split_queue 认得出、不重打标；补段来源只在 sampling。
        主源 a 在 ch41 起 4xx（分歧点落在第 1/2 段窗口之间）→ b 近邻参照补第 2 段，第 3/4 段分歧点距窗口
        >4 章 → 标未取到（覆盖代价）。"""
        cli = make_cli({
            'a.example.com': {'n': 100, 'body': lambda i: None if i >= 40 else _book_body(i)},
            'b.example.com': {'n': 100},
        })
        code, recs, *_ = self.run_main('LABELER_SEGMENTED=1\n', cli,
                                       lambda *a, **k: (self.base_labels(), 1))
        self.assertEqual(code, 0)
        rec = recs[0]
        self.assertEqual((rec['url'], rec['source']), ('https://a.example.com/book', 'a.example.com'))
        self.assertEqual([s.get('source') for s in rec['sampling']['segments']],
                         ['a.example.com', 'b.example.com', None, None])
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
