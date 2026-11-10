#!/usr/bin/env python3
"""多平台名单 + 完结优先（plat1105 / finlist1105 / gbkdec1105）单测。

背景（2026-11-05 用户指令）：名单只翻七猫太单一，各大平台都要找；找书尽量先找完结的。
下列 HTML 是按 .88 打标 UA 实测页面结构缩写的合成片段（见 douban_list 中各 parse_* 注释）。
覆盖：各平台解析（作者不串条）、完结标记与升级、完结优先 + 来源轮转排序、入队上限、
条目 status、多平台加深游标轮转、GBK 页解码。
全离线：http_get / urlopen 由测试替身提供。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_plat1105.py
"""
import contextlib
import email.message
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import douban_list as dl  # noqa: E402
import labeler  # noqa: E402
from test_labeler_lists1104 import shuku_html  # noqa: E402

ZH_RANK_HTML = """<div data-id="1" class="zh-modules-rank-book"><p class="book-rank--title-text">
<a title="纵甲" href="//www.zongheng.com/detail/1" class="global-hover">纵甲</a></p>
<div class="book-rank--hover"><a href="//www.zongheng.com/detail/1" class="bookeName">纵甲</a>
<a href="//home.zongheng.com/show/userInfo/9.html" class="global-hover auther"></a>
<div class="slot"><a href="//home.zongheng.com/show/userInfo/9.html" class="global-hover">纵作者</a></div></div></div>
<div data-id="2" class="zh-modules-rank-book"><p class="book-rank--title-text">
<a title="纵乙" href="//www.zongheng.com/detail/2" class="global-hover">纵乙</a></p></div>"""

JJ16_HTML = """<ul><li> <a target="_blank" data-recommendInfo='{"relationNovelid":"1","x":">"}'
 href="onebook.php?novelid=1" alt="晋甲" title="晋甲">晋甲</a> <a style="text-align:right;"
 href="oneauthor.php?authorid=7" title="晋作者甲"> <span class="author">晋作者甲</span> </a> </li>
<li> <a href="onebook.php?novelid=2" title="晋乙">晋乙</a> </li></ul>"""

JJ20_HTML = """<table><tr><td><a title="晋作者丙" href="oneauthor.php?authorid=8">晋作者丙</a> </td>
<td>&nbsp;<a title="晋丙" data-recommendInfo='{"a":"b"}' class="track" href="onebook.php?novelid=3"
 rel="订阅请注意：<br>█【1-220章】为全文<br>" class="tooltip">晋丙</a> </td> <td><font color=red>完结</font></td></tr>
<tr><td><a href="oneauthor.php?authorid=9">晋作者丁</a></td><td><a href="onebook.php?novelid=4">晋丁</a></td></tr></table>"""

HX_HTML = """<li><div class="book-img"><a href="/book/11" target="_blank" title="红甲"><img alt="红甲"></a></div>
<div class="book-info"><h3><a href="/book/11" target="_blank" title="红甲">红甲</a></h3>
<h4><a class="default">红作者甲</a></h4><p class="tag"><span class="pink">已完结</span></p></div></li>
<li><div class="book-info"><h3><a href="/book/12" target="_blank" title="红乙">红乙</a></h3></div></li>"""

XXSY_HTML = """<div class="box-hd"><h3 class="active">潇湘票榜</h3></div><ul>
<li class="n2 n2 xx-stat-recommend-child" data-bookid="21"><span class="piao">潇作者甲</span><span class="num">1</span>
<p><a href="/book/21" target="_blank">潇甲</a></p></li>
<li class="n2 n2 xx-stat-recommend-child" data-bookid="22"><span class="piao">潇作者乙</span><span class="num">2</span>
<p><a href="/book/22" target="_blank">潇乙</a></p></li></ul>
<div class="box-hd"><h3 class="active">完结榜</h3></div><ul>
<li class="n5 n2 xx-stat-recommend-child" data-bookid="22"><span class="piao">潇作者乙</span><span class="num">1</span>
<p><a href="/book/22" target="_blank">潇乙</a></p></li>
<li class="n5 n2 xx-stat-recommend-child" data-bookid="23"><span class="piao">潇作者丙</span><span class="num">2</span>
<p><a href="/book/23" target="_blank">潇丙</a></p></li></ul>
<div class="box-hd"><h3 class="active">阅读榜</h3></div><ul>
<li class="n6 n2 xx-stat-recommend-child" data-bookid="24"><span class="piao">潇作者丁</span><span class="num">1</span>
<p><a href="/book/24" target="_blank">潇丁</a></p></li></ul>"""

CWM_HTML = """<li class="top1"><div class="info"><h3><a href="https://www.ciweimao.com/book/31" target="_blank"
 title="刺甲">刺甲</a></h3><p class="author"><a href="https://www.ciweimao.com/reader/5" target="_blank">刺作者</a></p>
</div><a class="img" href="https://www.ciweimao.com/book/31" target="_blank" title="刺甲"></a></li>
<li class="top"><a href="https://www.ciweimao.com/book/32" target="_blank" title="刺乙">
<i class="icon-top">2</i><b>[玄幻奇幻]</b>刺乙 <span class="num">7538</span></a></li>"""

TADU_HTML = """<li><a href="/book/41/" target="_blank"><img></a><div class="rtList">
<a href="/book/41/" class="bookNm" target="_blank">塔甲</a><a href="/book/41/" class="bookIntro">简介</a>
<div><a href="javascript:void(0);" class="authorNm" ><i></i>塔作者</a>
<div class="condition"><a href="/store/98-f-0-5-a-20-p-1-98">完结</a></div></div></div></li>"""

SF_HTML = """<ul class="Comic_Pic_List"><li><a href="/Novel/51/" target="_blank"><img alt="菠甲"></a></li>
<li><strong><a href="/Novel/51/" target="_blank" style="font-size: 14px;">菠甲</a></strong><br />
 作 者： <a href="/Club/6/" target="_blank">菠作者</a><br /> 综合信息</li></ul>"""

FALOO_HTML = """<div class="SearchCenterDiv2"><a href="https://b.faloo.com/99.html" title="搜索推荐">搜索推荐</a></div>
<div class="TwoBox02_02"><div class="TwoBox02_03"><a href="//b.faloo.com/61.html" title="飞甲"><img></a></div>
<h1 class="fontSize17andHei" title="飞甲"><a href="//b.faloo.com/61.html" target="_blank" title="飞甲">飞甲</a></h1>
<a href="//b.faloo.com/l_0_1.html?t=2&k=abc" title="飞作者">飞作者</a>
<a href="//b.faloo.com/l_4_45_1.html" title="都市异能">都市异能</a></div>"""


class PlatformParseTest(unittest.TestCase):
    def pairs(self, books):
        return [(b['title'], b['author']) for b in books]

    def test_zongheng_rank_author_from_hover_link_only_within_entry(self):
        self.assertEqual(self.pairs(dl.parse_zongheng_rank(ZH_RANK_HTML)),
                         [('纵甲', '纵作者'), ('纵乙', '')])

    def test_jjwxc_both_layouts_and_quoted_angle_brackets(self):
        self.assertEqual(self.pairs(dl.parse_jjwxc_topten(JJ16_HTML)),
                         [('晋甲', '晋作者甲'), ('晋乙', '')])
        self.assertEqual(self.pairs(dl.parse_jjwxc_topten(JJ20_HTML)),
                         [('晋丙', '晋作者丙'), ('晋丁', '晋作者丁')])

    def test_hongxiu_tadu_sfacg_faloo_ciweimao(self):
        self.assertEqual(self.pairs(dl.parse_hongxiu_books(HX_HTML)), [('红甲', '红作者甲'), ('红乙', '')])
        self.assertEqual(self.pairs(dl.parse_tadu_store(TADU_HTML)), [('塔甲', '塔作者')])
        self.assertEqual(self.pairs(dl.parse_sfacg_list(SF_HTML)), [('菠甲', '菠作者')])
        self.assertEqual(self.pairs(dl.parse_faloo_list(FALOO_HTML)), [('飞甲', '飞作者')])  # 搜索推荐不收
        self.assertEqual(self.pairs(dl.parse_ciweimao_rank(CWM_HTML)), [('刺甲', '刺作者'), ('刺乙', '')])

    def test_xxsy_finish_section_marks_finished_and_upgrades_duplicates(self):
        books = dl.parse_xxsy_rank(XXSY_HTML)
        self.assertEqual(self.pairs(books), [('潇甲', '潇作者甲'), ('潇乙', '潇作者乙'),
                                             ('潇丙', '潇作者丙'), ('潇丁', '潇作者丁')])
        self.assertEqual([b.get('finished', False) for b in books], [False, True, True, False])

    def test_unrelated_pages_yield_nothing(self):
        for parse in (dl.parse_zongheng_rank, dl.parse_jjwxc_topten, dl.parse_hongxiu_books,
                      dl.parse_xxsy_rank, dl.parse_ciweimao_rank, dl.parse_tadu_store,
                      dl.parse_sfacg_list, dl.parse_faloo_list):
            self.assertEqual(parse('<html><a href="/book/1">x</a></html>'), [], parse.__name__)


class CompletedFirstQueueTest(unittest.TestCase):
    def setUp(self):
        self.out = io.StringIO()
        self.seen = []

    def http_get(self, url):
        self.seen.append(url)
        pages = {
            dl.QIMAO_BASE + '/paihang/boy/over/date/':
                '<a href="https://www.qimao.com/shuku/1/" class="s-book-title">七完甲</a>',
            dl.QIMAO_BASE + '/paihang/boy/hot/date/':
                '<a href="https://www.qimao.com/shuku/2/" class="s-book-title">七热甲</a>'
                '<a href="https://www.qimao.com/shuku/3/" class="s-book-title">潇乙</a>'
                '<a href="https://www.qimao.com/shuku/4/" class="s-book-title">七热乙</a>',
            dl.JJWXC_BASE + '/topten.php?orderstr=16&t=1': JJ16_HTML,
            dl.HONGXIU_BASE + '/finish': HX_HTML,
            dl.XXSY_BASE + '/rank': XXSY_HTML,
            dl.ZONGHENG_BASE + '/rank': ZH_RANK_HTML,
            dl.CIWEIMAO_BASE + '/rank-index': CWM_HTML,
        }
        if url == dl.JJWXC_BASE + '/topten.php?orderstr=20&t=1':
            raise ConnectionError('synthetic down')
        return pages.get(url, '<html></html>')

    def build(self, **kw):
        captured = {}

        def fake_resolve(candidates, *_a, **k):
            captured['candidates'] = list(candidates)
            captured['limit'] = k.get('limit')
            return []

        with contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.out), \
                mock.patch.object(dl, '_resolve_candidates', fake_resolve):
            dl.build_webnovel_queue(self.http_get, include_douban=False, **kw)
        return captured

    def test_all_platforms_feed_candidates_completed_first_and_interleaved(self):
        got = self.build(queue_max=50)
        cands = got['candidates']
        self.assertEqual(got['limit'], 50)
        fin = [c['title'] for c in cands if c.get('finished')]
        rest = [c['title'] for c in cands if not c.get('finished')]
        self.assertEqual([c['title'] for c in cands], fin + rest)          # 完结整体在前
        # 完结档：七猫完结榜 / 晋江 / 红袖 / 潇湘完结榜 交替出书（不是一个平台排完再下一个）
        self.assertEqual(fin[:3], ['七完甲', '晋甲', '红甲'])
        self.assertIn('潇丙', fin)
        # 「潇乙」先出现在七猫热榜（连载档）、后在潇湘完结榜 → 认完结，归属不变
        by_title = {c['title']: c for c in cands}
        self.assertTrue(by_title['潇乙'].get('finished'))
        self.assertEqual(by_title['潇乙']['origin'], '七猫榜单')
        self.assertEqual(rest[:3], ['七热甲', '纵甲', '潇甲'])
        self.assertIn('刺甲', rest)
        log = self.out.getvalue()
        self.assertIn('晋江[orderstr=20] 拉取失败', log)                     # 单页失败不连坐
        self.assertIn('完结优先: 完结', log)
        for url in (dl.QIMAO_BASE + '/paihang/girl/over/date/',
                    dl.QIMAO_BASE + '/paihang/girl/hot/date/'):
            self.assertIn(url, self.seen)

    def test_order_completed_first_keeps_relative_order_within_origin(self):
        cands = [{'title': 'a1', 'origin': 'A'}, {'title': 'a2', 'origin': 'A', 'finished': True},
                 {'title': 'a3', 'origin': 'A'}, {'title': 'b1', 'origin': 'B'},
                 {'title': 'b2', 'origin': 'B', 'finished': True}]
        self.assertEqual([c['title'] for c in dl.order_completed_first(cands)],
                         ['a2', 'b2', 'a1', 'b1', 'a3'])
        self.assertEqual(dl.order_completed_first([]), [])

    def test_resolve_list_queue_max(self):
        self.assertEqual(dl.resolve_list_queue_max({}), dl.LIST_QUEUE_MAX)
        self.assertEqual(dl.resolve_list_queue_max({dl.LIST_QUEUE_MAX_ENV: '0'}), 0)
        self.assertEqual(dl.resolve_list_queue_max({dl.LIST_QUEUE_MAX_ENV: '30'}), 30)
        self.assertEqual(dl.resolve_list_queue_max({dl.LIST_QUEUE_MAX_ENV: 'x'}), dl.LIST_QUEUE_MAX)


class ResolveStatusAndLimitTest(unittest.TestCase):
    def run_resolve(self, candidates, **kw):
        calls = []

        def fake_search(_get, title, **_k):
            calls.append(title)
            return {'url': f'https://book15.net/book/{len(calls)}', 'title': title}

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out), \
                mock.patch.object(dl, 'search_book15', fake_search), \
                mock.patch.object(dl, 'SEARCH_DELAY', 0):
            queue = dl._resolve_candidates(candidates, lambda u: '', **kw)
        return queue, calls, out.getvalue()

    def test_finished_candidates_carry_status_and_limit_stops_searching(self):
        cands = [{'title': '完书', 'author': '甲', 'origin': 'X', 'finished': True},
                 {'title': '连书', 'author': '乙', 'origin': 'Y'},
                 {'title': '剩书', 'author': '丙', 'origin': 'Y'}]
        queue, calls, log = self.run_resolve(cands, limit=2)
        self.assertEqual([(q['title'], q['status']) for q in queue], [('完书', '完结'), ('连书', '')])
        self.assertEqual(calls, ['完书', '连书'])                       # 第 3 本不搜
        self.assertIn('入队 2/2 本、引擎搜索 0/4 次）、1 本候选留待下轮', log)
        queue, calls, log = self.run_resolve([dict(c) for c in cands])
        self.assertEqual(len(queue), 3)
        self.assertNotIn('留待下轮', log)


    def test_engine_search_budget_bounds_low_hit_lists(self):
        engine_calls = []

        def fake_engine(_cli, title, *_a, **_k):
            engine_calls.append(title)
            return None

        cands = [{'title': f'冷书{i}', 'author': '某', 'origin': '晋江完结榜', 'finished': True}
                 for i in range(5)]
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out),                 mock.patch.object(dl, 'search_book15', return_value=None),                 mock.patch.object(dl, 'search_engine', fake_engine),                 mock.patch.object(dl, 'SEARCH_DELAY', 0):
            queue = dl._resolve_candidates(cands, lambda u: '', engine_cli=object(), limit=1)
        self.assertEqual(queue, [])
        self.assertEqual(engine_calls, ['冷书0', '冷书1'])               # 2×上限 次即停
        self.assertIn('引擎搜索 2/2 次）、3 本候选留待下轮', out.getvalue())

def deep_url(i, page):
    return dl._deep_url(dl.LIST_DEEP_SOURCES[i][1], page)


def deep_prefix(src):
    url_fmt = src[1]
    return url_fmt.split('{page}')[0] if isinstance(url_fmt, str) else url_fmt(1).split('page_index')[0]


class MultiSourceDeepenTest(unittest.TestCase):
    """多平台完结书库按游标轮转：每次加深从下一个平台起，单站失败/空页不影响其他站。"""

    def setUp(self):
        self.cursor_path = Path(tempfile.mkdtemp()) / dl.LIST_CURSOR_FILENAME
        self.seen = []
        self.pages = {}
        self.down = set()
        self.out = io.StringIO()

    def http_get(self, url):
        self.seen.append(url)
        if url in self.down:
            raise ConnectionError('synthetic down')
        return self.pages.get(url, '<html></html>')

    def deep_seen(self):
        prefixes = [deep_prefix(s) for s in dl.LIST_DEEP_SOURCES]
        return [u for u in self.seen if any(u.startswith(p) for p in prefixes)]

    def build(self, cursor, deepen_min=50):
        def fake_resolve(candidates, *_a, **_k):
            return [{'title': b['title'], 'url': f'u:{b["title"]}', 'origin': b['origin'],
                     'finished': b.get('finished')} for b in candidates]

        # 轮转/游标语义按 4 页预算钉（deep1110 生产默认改 6 页，不影响这里的逻辑断言）
        with contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.out), \
                mock.patch.object(dl, '_resolve_candidates', fake_resolve), \
                mock.patch.object(dl, 'LIST_DEEPEN_MAX_PAGES', 4), \
                mock.patch.object(dl, 'LIST_DEEPEN_PAGE_DELAY', 0):
            return dl.build_webnovel_queue(self.http_get, include_douban=False,
                                           list_cursor=cursor, deepen_min=deepen_min)

    def test_rotates_across_platforms_and_start_moves_each_time(self):
        self.pages = {deep_url(0, 1): shuku_html(('七库甲', 'a')),
                      deep_url(1, 1): '<a href="//www.17k.com/book/1.html">一七甲</a>作者：'
                                      '<a href="//user.17k.com/see/www/1.html">k</a>',
                      deep_url(2, 1): HX_HTML, deep_url(3, 1): TADU_HTML}
        cursor = dl.ListCursor(self.cursor_path)
        queue = self.build(cursor)
        self.assertEqual(self.deep_seen(), [deep_url(i, 1) for i in range(4)])
        self.assertEqual(len(self.deep_seen()), 4)          # = build() 里钉的页预算
        titles = [q['title'] for q in queue]
        self.assertEqual(titles, ['七库甲', '一七甲', '红甲', '红乙', '塔甲'])
        self.assertTrue(all(q['finished'] for q in queue))
        self.assertEqual([cursor.get(s[0]) for s in dl.LIST_DEEP_SOURCES], [2, 2, 2, 2, 1, 1, 1])
        self.assertEqual(cursor.get(dl.LIST_CURSOR_ROTATE), 2)
        # 下次从第 2 个平台起
        self.seen.clear()
        self.build(cursor)
        self.assertEqual(self.deep_seen()[0], deep_url(1, 2))

    def test_failure_skips_platform_keeps_its_cursor_and_empty_page_resets(self):
        cursor = dl.ListCursor(self.cursor_path, {dl.LIST_DEEP_SOURCES[0][0]: 5,
                                                  dl.LIST_DEEP_SOURCES[1][0]: 9})
        self.down = {deep_url(0, 5)}
        self.pages = {deep_url(2, 1): HX_HTML}
        queue = self.build(cursor)
        self.assertEqual(self.deep_seen(),
                         [deep_url(0, 5), deep_url(1, 9), deep_url(2, 1), deep_url(3, 1)])
        self.assertEqual([q['title'] for q in queue], ['红甲', '红乙'])
        self.assertEqual(cursor.get(dl.LIST_DEEP_SOURCES[0][0]), 5)     # 失败：游标不动
        self.assertEqual(cursor.get(dl.LIST_DEEP_SOURCES[1][0]), 1)     # 空页：回第 1 页
        self.assertEqual(cursor.get(dl.LIST_DEEP_SOURCES[2][0]), 2)
        self.assertNotIn(dl.LIST_DEEP_SOURCES[3][0], cursor.pages)      # 本就第 1 页：不写
        log = self.out.getvalue()
        self.assertIn('游标留在本页', log)
        self.assertIn('第 9 页无书', log)

    def test_empty_platforms_count_against_page_budget_and_page_cap_resets(self):
        self.pages = {deep_url(0, p): shuku_html((f'库{p}', 'x')) for p in range(1, 10)}
        cursor = dl.ListCursor(self.cursor_path)
        self.build(cursor)
        self.assertEqual(self.deep_seen(), [deep_url(0, 1)] + [deep_url(i, 1) for i in range(1, 4)])
        cursor = dl.ListCursor(self.cursor_path, {dl.LIST_DEEP_SOURCES[0][0]: dl.LIST_DEEPEN_PAGE_CAP + 1})
        self.seen.clear()
        self.build(cursor)
        self.assertNotIn(deep_url(0, dl.LIST_DEEPEN_PAGE_CAP + 1), self.seen)  # 超上限不请求
        self.assertEqual(cursor.get(dl.LIST_DEEP_SOURCES[0][0]), 1)

    def test_deep_source_keys_are_unique_and_templates_have_page(self):
        keys = [s[0] for s in dl.LIST_DEEP_SOURCES]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertNotIn(dl.LIST_CURSOR_ROTATE, keys)
        for s in dl.LIST_DEEP_SOURCES:
            self.assertTrue(callable(s[1]) or '{page}' in s[1], s[0])


_FQ_REVERSE = {ch: chr(dl._FANQIE_FONT_FIRST + i) for i, ch in reversed(list(enumerate(dl._FANQIE_FONT)))
               if ch != '\x00'}
_FQ_UNMAPPED = chr(dl._FANQIE_FONT_FIRST + dl._FANQIE_FONT.index('\x00'))


def fq(text):
    """按解码表把明文混淆回私用区字符（表里没有的字原样保留，与接口实际返回一致）。"""
    return ''.join(_FQ_REVERSE.get(c, c) for c in text)


def fq_list(*books):
    return json.dumps({'code': 0, 'data': {'book_list': [
        {'book_id': bid, 'book_name': name, 'author': author, 'creation_status': cs}
        for bid, name, author, cs in books]}}, ensure_ascii=False)


class FanqieListTest(unittest.TestCase):
    """番茄书库接口：私用区混淆解码、详情页逐轮核对、核对不过整站停用、加深页码映射。"""

    def setUp(self):
        patcher = mock.patch.object(dl, '_fanqie_font_ok', None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.out = io.StringIO()
        self.seen = []
        self.detail_title = '我不是戏神'
        self.lists = {
            1: fq_list(('11', fq('我不是戏神'), fq('三九音域'), 0),
                       ('12', fq('十日终焉'), fq('杀虫队队员'), 0),
                       ('13', fq('书名') + _FQ_UNMAPPED, fq('某人'), 0)),         # 未对齐码位：不收
            0: fq_list(('21', fq('备用联系人'), fq('绒绒') + _FQ_UNMAPPED, 0),   # 作者不可信：留空
                       ('22', fq('十日终焉'), fq('杀虫队队员'), 0)),             # 跨性别重复：去重
        }

    def http_get(self, url):
        self.seen.append(url)
        if url == dl.FANQIE_BASE + '/page/11':
            return f'<html><title>{self.detail_title}完整版在线免费阅读_{self.detail_title}小说_番茄小说官网</title>'
        for gender, body in self.lists.items():
            if url == dl.FANQIE_LIBRARY_URL.format(count=dl.FANQIE_TOP_COUNT, index=0, gender=gender):
                return body
        raise ConnectionError('synthetic down')

    def fetch(self):
        with contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.out):
            return dl.fetch_fanqie_finish_books(self.http_get)

    def test_decodes_titles_and_authors_and_checks_detail_page(self):
        books = self.fetch()
        self.assertTrue(dl._fanqie_font_ok)
        self.assertEqual([(b['title'], b['author']) for b in books],
                         [('我不是戏神', '三九音域'), ('十日终焉', '杀虫队队员'), ('备用联系人', '')])
        self.assertTrue(all(b['finished'] for b in books))
        self.assertIn(dl.FANQIE_BASE + '/page/11', self.seen)           # 核对的是首本书

    def test_detail_mismatch_or_failure_disables_fanqie_for_the_round(self):
        self.detail_title = '我不是戏'
        self.assertEqual(self.fetch(), [])
        self.assertFalse(dl._fanqie_font_ok)
        self.assertIn('核对不通过', self.out.getvalue())
        with self.assertRaises(RuntimeError):                         # 加深也不用
            dl.parse_fanqie_library(self.lists[1])
        self.lists = {}                                               # 名单全拉不到：同样停用、不请求详情页
        self.seen.clear()
        self.assertEqual(self.fetch(), [])
        self.assertNotIn(dl.FANQIE_BASE + '/page/11', self.seen)

    def test_deep_page_follows_the_top_hundred_and_parses_after_check(self):
        self.assertIn('page_count=10&page_index=10&', dl.fanqie_deep_url(1))
        self.assertIn('page_count=10&page_index=12&', dl.fanqie_deep_url(3))
        self.assertIn('creation_status=0', dl.fanqie_deep_url(1))
        with self.assertRaises(RuntimeError):                         # 本轮还没核对
            dl.parse_fanqie_library(self.lists[0])
        self.fetch()
        self.assertEqual([b['title'] for b in dl.parse_fanqie_library(self.lists[0])],
                         ['备用联系人', '十日终焉'])

    def test_decode_leaves_non_pua_text_untouched(self):
        self.assertEqual(dl._fanqie_decode('Ab，1' + fq('我')), 'Ab，1我')
        self.assertEqual(dl._fanqie_decode(_FQ_UNMAPPED), _FQ_UNMAPPED)


class _Resp:
    def __init__(self, body: bytes, content_type: str | None):
        self.body = body
        self.headers = email.message.Message()
        if content_type:
            self.headers['Content-Type'] = content_type

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class GbkDecodeTest(unittest.TestCase):
    def get(self, body, content_type):
        with mock.patch.object(labeler.urllib.request, 'urlopen', return_value=_Resp(body, content_type)), \
                mock.patch.object(labeler, 'SOURCE_POLICY', None):
            return labeler.http_get('https://www.jjwxc.net/topten.php')

    def test_gbk_by_header_or_meta_and_utf8_unchanged(self):
        gbk = '<html>完结金榜：晋甲</html>'.encode('gbk')
        self.assertEqual(self.get(gbk, 'text/html; charset=GBK'), '<html>完结金榜：晋甲</html>')
        meta = b'<meta http-equiv="Content-Type" content="text/html; charset=gb2312">' + '飞卢'.encode('gbk')
        self.assertTrue(self.get(meta, 'text/html').endswith('飞卢'))
        utf8 = '<meta charset="gbk">书名'.encode('utf-8')                 # 声明错但字节是合法 UTF-8
        self.assertEqual(self.get(utf8, 'text/html; charset=gbk'), '<meta charset="gbk">书名')
        bad = '书名'.encode('gbk')                                         # 无声明：照旧 UTF-8 replace
        self.assertEqual(self.get(bad, None), bad.decode('utf-8', 'replace'))


if __name__ == '__main__':
    unittest.main()
