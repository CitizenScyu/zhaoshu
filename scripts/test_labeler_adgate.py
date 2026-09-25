#!/usr/bin/env python3
"""labeler.py「含广告注入」拒收修复（lbladfix41）单测。

依据：D:/ClaudeCode/projects/zhaoshu/lbladdiag-41-report.md §2 的脱敏片段（kxdu / yunqi 实抓）。
覆盖：
- A1 非正文目录条目（公告/感言）抓取前跳过；带章号的正文章节保留；
- A2 段内水印子串剥除（首发--无弹出广告 / #百度搜…# / 裸网址行 / 未完待续），正文不误删；
- A3 章节标题清洗（求票括注 / APP免费 / 更新时间），且清洗后的标题进送模型文本；
- A4 试读章丢弃、不计章数与字数，丢完不足门槛按试读源拒收（不调模型）；
- A5 选源排序：yunqi.qq.com / chuangshi.qq.com 排到候选与备选末位（不拉黑）；
- B1 提示词定义「含广告注入」并要求 text_quality_evidence；
- B2 分段打标的 text_quality 合并；
- B3 main 质量门降级入库（quality_flag / evidence），其余异常仍拒收；
- B4 降级入库不计拒收；历史旧门槛的「含广告注入」拒收不再累计钉子户。
全离线：不联网、不真调 CLI、不调 LLM。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_adgate.py'
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


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _line(tag: str, i: int) -> str:
    """一行 ≥ DEDUPE_MIN_LINE 字、彼此不同的叙述正文。"""
    return f'{tag}第{i}段：他沿着山路一直往前走，雪越下越大，远处传来几声狼嚎。'


def _chapter_body(tag: str, n: int = 60) -> str:
    return '\n'.join(_line(tag, i) for i in range(n))


class FakeCli:
    """按 (subcommand, url) 回放的引擎 CLI。calls 记录每次调用。"""

    def __init__(self, toc_chapters, bodies):
        self.toc_chapters, self.bodies, self.calls = toc_chapters, bodies, []

    def run(self, subcommand, *args):
        self.calls.append((subcommand, args))
        if subcommand == 'toc':
            return _proc(0, json.dumps({'chapters': self.toc_chapters}, ensure_ascii=False))
        url = args[1]
        return _proc(0, json.dumps({'text': self.bodies[url]}, ensure_ascii=False))


def _content_urls(cli):
    return [args[1] for sub, args in cli.calls if sub == 'content']


# ---------------- A1 非正文目录条目 ----------------
class TestNonbodyTocTitle(unittest.TestCase):
    # 诊断 §2：kxdu《斗罗大陆》目录前 6 条、《大泼猴》的公告/感言条目
    NONBODY = (
        '上架感言',
        '已出场人物列表',
        '推荐一本好书给大家',
        '关于小舞的身高问题',
        '小三书友团体－"唐门"正式成立。',
        '通知',
        '深夜码字，发个感言',
        '请假条',
        '完本感言',
        '新书发布',
        '25.上架感言',                  # 数字序号不是「第X章」
    )
    # 反例：有章号前缀的正文章节标题，哪怕带关键词也保留
    BODY = (
        '第八十章 上台感言',
        '第一卷 上架',
        '第12章 通知书',
        '正文 第三章 关于那一夜',
        '第三十回 书友',
        '引子',
        '楔子',
        '番外一 小舞',
        '后记',                        # 诊断 §2 鬼吹灯II：作者说明，不是广告，不强删
        '',
    )

    def test_nonbody_titles(self):
        for t in self.NONBODY:
            self.assertTrue(labeler.is_nonbody_toc_title(t), t)

    def test_body_titles_kept(self):
        for t in self.BODY:
            self.assertFalse(labeler.is_nonbody_toc_title(t), t)

    def test_fetch_skips_nonbody_without_request(self):
        body = '正文' * 300
        chapters = [{'url': f'https://kx/c{i}', 'title': t} for i, t in enumerate(
            ['上架感言', '推荐一本好书给大家', '第一章 斗罗大陆', '第八十章 上台感言'])]
        cli = FakeCli(chapters, {c['url']: body for c in chapters})
        stats = {}
        with mock.patch.object(labeler.time, 'sleep'):
            text, chars = labeler.fetch_book_text_engine(cli, 'https://kx/b', stats=stats)
        self.assertEqual(_content_urls(cli), ['https://kx/c2', 'https://kx/c3'])   # 公告条目没发请求
        self.assertEqual(stats['nonbody_chapters'], 2)
        self.assertEqual(chars, 2 * len(body))
        self.assertIn('【第八十章 上台感言】', text)
        self.assertNotIn('上架感言', text)


# ---------------- A2 段内水印 ----------------
class TestInlineNoise(unittest.TestCase):
    STRIP = (
        # (原行, 剥后)
        ('宫殿楼阁连绵，极土木之盛。 首发--无弹出广告(喜欢本书,请收藏)',
         '宫殿楼阁连绵，极土木之盛。'),
        ('他看着远处。 首发--无弹出广告(更新速度最快尽在)', '他看着远处。'),
        ('首发--无弹出广告()', ''),
        ('他们都是孤傲之辈。#百度搜（手打吧）阅读本书最新手打章节#在这个方面，谁也不服谁。',
         '他们都是孤傲之辈。在这个方面，谁也不服谁。'),
        ('http://.cn', ''),
        ('  https://www.example.com/book/1.html  ', ''),
        ('www.xxx.com', ''),
        ('他转身离开了。（未完待续）', '他转身离开了。'),
        ('(未完待续。如果您喜欢这部作品，欢迎您来投推荐票)', ''),
    )
    # 反例：正文 / 对白 / 微博话题 / 句中网址，不动
    KEEP = (
        '他伸手打开了那扇门。',
        '“#号键按下去就行。”他说。',
        '热搜第一是#某某最新消息#，他看了一眼。',
        '#百度热搜第一#挂了一整天。',
        '他在纸上写下 http://example.com 这个地址，递了过去。',
        '首发的那一批货已经卖完了。',
        '故事未完待续，他想。',
        '这广告做得真不错。',
    )

    def test_noise_substrings_are_stripped(self):
        for raw, want in self.STRIP:
            self.assertEqual(labeler._strip_inline_noise(raw), want, raw)

    def test_prose_is_untouched(self):
        for line in self.KEEP:
            self.assertEqual(labeler._strip_inline_noise(line), line, line)

    def test_prepare_strips_inline_noise_only_when_clean(self):
        body = _chapter_body("甲", 400)
        dirty = '极土木之盛。 首发--无弹出广告(喜欢本书,请收藏)'
        text = f'【第1章 起】\n{dirty}\n{body}\nhttp://.cn'
        out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertNotIn('无弹出广告', out)
        self.assertNotIn('http://.cn', out)
        self.assertIn('极土木之盛。', out)                 # 正文部分保留
        self.assertEqual(stats['inline_strips'], 2)
        self.assertEqual(stats['clean_lines'], 1)          # 裸网址行整行删
        out_book15, _, _, _ = labeler.prepare_book_text(text, clean=False)
        self.assertIn('无弹出广告', out_book15)             # book15 路径不走引擎清洗


# ---------------- A3 章节标题 ----------------
class TestChapterTitle(unittest.TestCase):
    CASES = (
        ('第2章 道生（求收藏！）', '第2章 道生'),
        ('第3章 龙王诞（求推荐！）', '第3章 龙王诞'),
        ('第61章 筑基（求月票）', '第61章 筑基'),
        ('第91章 杀破狼（求月票）APP免费', '第91章 杀破狼'),
        ('第61章 罚跪APP免费', '第61章 罚跪'),
        ('第9章 夜宴（为盟主xx加更）', '第9章 夜宴'),
        ('第10章 风起 更新时间：2019-05-01 12:00', '第10章 风起'),
        ('第11章 云涌 2019-05-01', '第11章 云涌'),
    )
    KEEP = (
        '第5章 求而不得',
        '第6章 （求而不得）',
        '第7章 收藏家',
        '第8章 1998年的夏天',
        '第12章 更新换代',
    )

    def test_titles_cleaned(self):
        for raw, want in self.CASES:
            self.assertEqual(labeler.clean_chapter_title(raw), want, raw)
            self.assertEqual(labeler.clean_chapter_title(want), want)   # 幂等

    def test_titles_kept(self):
        for t in self.KEEP:
            self.assertEqual(labeler.clean_chapter_title(t), t, t)

    def test_fetch_uses_cleaned_title(self):
        body = '正文' * 300
        chapters = [{'url': 'https://yq/c2', 'title': '第2章 道生（求收藏！）'}]
        cli = FakeCli(chapters, {'https://yq/c2': body})
        with mock.patch.object(labeler.time, 'sleep'):
            text, _ = labeler.fetch_book_text_engine(cli, 'https://yq/b')
        self.assertEqual(text, f'【第2章 道生】\n{body}')

    def test_prepare_cleans_heads(self):
        text = f'【第2章 道生（求收藏！）】\n{_chapter_body("甲", 400)}'
        out, _, reason, _ = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertTrue(out.startswith('【第2章 道生】\n'))
        self.assertNotIn('求收藏', out)


# ---------------- A4 试读章 ----------------
PREVIEW = '晨曦洒落，风过竹林，满山青翠如波涛缓缓起伏，又是新的一天。' * 3 + '...'


class TestPreviewChapters(unittest.TestCase):
    def test_preview_predicate(self):
        self.assertTrue(labeler.is_preview_chapter('第61章 罚跪APP免费', '正文' * 1000))
        self.assertTrue(labeler.is_preview_chapter('第62章 罚跪', PREVIEW))
        self.assertTrue(labeler.is_preview_chapter('第62章 罚跪', '他走了……'))
        # 反例：正常长章、以省略号结尾的长章、短但不以省略号收尾的章
        self.assertFalse(labeler.is_preview_chapter('第1章 起', '正文' * 1000 + '...'))
        self.assertFalse(labeler.is_preview_chapter('第1章 起', '他走了。' * 10))
        self.assertFalse(labeler.is_preview_chapter('第1章 APP', '正文' * 1000))

    def test_fetch_drops_preview_chapters(self):
        full = '正文' * 300
        chapters = ([{'url': f'https://yq/f{i}', 'title': f'第{i}章 免费'} for i in range(3)]
                    + [{'url': 'https://yq/p1', 'title': '第4章 罚跪APP免费'},
                       {'url': 'https://yq/p2', 'title': '第5章 夜'}])
        bodies = {c['url']: full for c in chapters}
        bodies['https://yq/p2'] = PREVIEW
        cli = FakeCli(chapters, bodies)
        stats = {}
        with mock.patch.object(labeler.time, 'sleep'):
            text, chars = labeler.fetch_book_text_engine(cli, 'https://yq/b', stats=stats)
        self.assertNotIn('https://yq/p1', _content_urls(cli))    # 标题判定：抓取前跳过
        self.assertIn('https://yq/p2', _content_urls(cli))        # 正文判定：抓回来才知道
        self.assertEqual(stats['preview_chapters'], 2)
        self.assertEqual(chars, 3 * len(full))
        self.assertNotIn('APP免费', text)
        self.assertNotIn(PREVIEW, text)

    def test_prepare_drops_preview_chapters_and_keeps_free_part(self):
        free = '\n\n'.join(f'【第{i}章 免费】\n{_chapter_body(f"章{i}", 40)}' for i in range(10))
        previews = '\n\n'.join(f'【第{i}章 罚跪APP免费】\n{PREVIEW}{i}' for i in range(10, 60))
        out, chars, reason, stats = labeler.prepare_book_text(free + '\n\n' + previews, clean=True)
        self.assertIsNone(reason)
        self.assertEqual(stats['preview_chapters'], 50)
        self.assertEqual(stats['chapters_after'], 10)
        self.assertNotIn('APP免费', out)
        self.assertGreater(chars, labeler.PREVIEW_MIN_TOTAL)

    def test_prepare_rejects_when_remaining_too_short(self):
        free = '【第1章 免费】\n' + _chapter_body('甲', 20)
        _, chars, reason, _ = labeler.prepare_book_text(free, clean=True, preview_dropped=40)
        self.assertLess(chars, labeler.PREVIEW_MIN_TOTAL)
        self.assertIn('试读章 40 章已丢弃', reason)
        self.assertTrue(reason.startswith('章节正文过短'))

    def test_no_preview_short_book_keeps_old_reason(self):
        # 反例：没丢过试读章的短书照旧是「清洗去重后仅 N 字」，不冒充试读
        _, _, reason, _ = labeler.prepare_book_text(
            '【第1章 起】\n' + _chapter_body('甲', 20), clean=True)
        self.assertIn('清洗去重后仅', reason)


# ---------------- A5 选源排序 ----------------
class _SearchCli:
    def __init__(self, candidates):
        self.stdout = json.dumps(candidates, ensure_ascii=False)

    def run(self, subcommand, *args):
        return _proc(0, self.stdout)


def _cand(host, author='萧鼎', title='诛仙'):
    return {'source': host, 'title': title, 'author': author,
            'bookUrl': f'https://{host}/book/1'}


class TestSourceDeprioritize(unittest.TestCase):
    def search(self, candidates, author='萧鼎'):
        return labeler.douban_list.search_engine(_SearchCli(candidates), '诛仙', author)

    def test_yunqi_first_is_demoted_to_last_alternate(self):
        hit = self.search([_cand('yunqi.qq.com'), _cand('www.kxdu.net'),
                           _cand('chuangshi.qq.com'), _cand('www.a.com')])
        self.assertEqual(hit['source'], 'www.kxdu.net')
        self.assertEqual([a['source'] for a in hit['alternates']],
                         ['www.a.com', 'yunqi.qq.com', 'chuangshi.qq.com'])

    def test_yunqi_only_candidate_is_still_used(self):
        # 不拉黑：只有 yunqi 一个源时照用
        hit = self.search([_cand('yunqi.qq.com')])
        self.assertEqual(hit['source'], 'yunqi.qq.com')
        self.assertNotIn('alternates', hit)

    def test_order_of_other_hosts_unchanged(self):
        # 反例：没有降权源时顺序与改前一致
        hit = self.search([_cand('www.b.com'), _cand('www.a.com')])
        self.assertEqual(hit['source'], 'www.b.com')
        self.assertEqual([a['source'] for a in hit['alternates']], ['www.a.com'])

    def test_unknown_author_path_also_demotes(self):
        hit = self.search([_cand('yunqi.qq.com'), _cand('www.kxdu.net')], author='')
        self.assertEqual(hit['source'], 'www.kxdu.net')
        self.assertEqual([a['source'] for a in hit['alternates']], ['yunqi.qq.com'])


class MainHarness(unittest.TestCase):
    """main() 离线跑一本引擎条目：fetch_book_text_engine / label_book 被替换。"""

    BOOK = {'url': 'https://www.kxdu.net/book/38822', 'title': '雪中悍刀行',
            'author': '烽火戏诸侯', 'engine': True, 'source_host': 'www.kxdu.net'}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')

    def run_main(self, fetch, labels=None):
        """fetch: fetch_book_text_engine 的 side_effect；labels: label_book 返回的标签。"""
        sent = []

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [dict(self.BOOK)]

        def fake_label(text, *a, **k):
            sent.append(text)
            return dict(labels), 1

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine', side_effect=fetch), \
                mock.patch.object(labeler, 'label_book', side_effect=fake_label), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        return code, sent, out.getvalue()

    def rows(self, name):
        path = self.dir / name
        if not path.exists():
            return []
        return [json.loads(x) for x in path.read_text(encoding='utf-8').splitlines() if x.strip()]


class TestMainPreview(MainHarness):
    def test_all_preview_book_rejected_by_precheck_not_char_shortage(self):
        # yunqi 同形：几乎全是 APP免费 章，抓取层全部跳过 → 字数不足，但按试读源拒（不计钉子户）
        def fetch(cli, url, stats=None, **k):
            stats['preview_chapters'] = 150
            stats['nonbody_chapters'] = 0
            return '【第1章 起】\n' + _chapter_body('甲', 5), 200

        code, sent, out = self.run_main(fetch, labels={})
        self.assertEqual(code, 2)
        self.assertEqual(sent, [])
        rej = self.rows('labels-rejected.jsonl')
        self.assertEqual(len(rej), 1)
        self.assertTrue(rej[0]['reason'].startswith('本地预检: 章节正文过短（试读章 150 章'))
        self.assertIn('取文跳过: 公告/感言条目 0 条，试读章 150 章', out)
        self.assertEqual(labeler.count_rejections(self.dir / 'labels-rejected.jsonl'), {})

    def test_short_book_without_preview_still_char_shortage(self):
        # 反例：没丢试读章的短书仍记「抓取字数不足」
        def fetch(cli, url, stats=None, **k):
            return '【第1章 起】\n' + _chapter_body('甲', 5), 200

        code, sent, _ = self.run_main(fetch, labels={})
        self.assertEqual(code, 2)
        self.assertEqual(self.rows('labels-rejected.jsonl')[0]['reason'], '抓取字数不足: 200')


# ---------------- B1 提示词 ----------------
class TestPrompt(unittest.TestCase):
    def test_prompt_defines_ad_injection_and_asks_evidence(self):
        p = labeler.SYSTEM_PROMPT
        self.assertIn('text_quality_evidence', p)
        self.assertIn('作者感言', p)
        self.assertIn('章节标题里的推广字样', p)
        self.assertIn('不算广告注入', p)
        self.assertIn('50 字', p)

    def test_merge_suffix_judges_quality_on_later_text_only(self):
        self.assertIn('text_quality', labeler.MERGE_PROMPT_SUFFIX)
        self.assertIn('不要沿用前次结论', labeler.MERGE_PROMPT_SUFFIX)


# ---------------- B2 分段合并 ----------------
class TestMergeTextQuality(unittest.TestCase):
    def m(self, *segs):
        return labeler.merge_text_quality(list(segs))

    def test_normal_plus_ad_without_evidence_is_normal(self):
        # 诊断 §3：开头公告让第一段判广告、却给不出证据；第二段正常 → 正常
        self.assertEqual(self.m({'text_quality': '含广告注入'}, {'text_quality': '正常'}),
                         ('正常', []))
        self.assertEqual(self.m({'text_quality': '正常'},
                                {'text_quality': '含广告注入', 'text_quality_evidence': []}),
                         ('正常', []))

    def test_ad_with_evidence_wins_over_normal(self):
        q, ev = self.m({'text_quality': '含广告注入', 'text_quality_evidence': ['首发--无弹出广告']},
                       {'text_quality': '正常'})
        self.assertEqual((q, ev), ('含广告注入', ['首发--无弹出广告']))

    def test_most_severe_kept_and_evidence_merged(self):
        q, ev = self.m({'text_quality': '含广告注入', 'text_quality_evidence': ['a', 'b']},
                       {'text_quality': '大面积重复', 'text_quality_evidence': ['b', 'c', 'd']})
        self.assertEqual(q, '大面积重复')
        self.assertEqual(ev, ['a', 'b', 'c'])            # 去重、至多 3 条

    def test_unknown_value_is_most_severe(self):
        self.assertEqual(self.m({'text_quality': '怪值'}, {'text_quality': '疑似乱码'})[0], '怪值')

    def test_both_normal_and_missing(self):
        self.assertEqual(self.m({'text_quality': '正常'}, {'text_quality': '正常'}), ('正常', []))
        self.assertEqual(self.m({}, {}), (None, []))
        self.assertEqual(self.m({}, {'text_quality': '含广告注入'}), ('含广告注入', []))

    def test_evidence_normalized(self):
        self.assertEqual(labeler.normalize_evidence('x' * 80), ['x' * 50])
        self.assertEqual(labeler.normalize_evidence(['a', 1, '', ' b ', 'c', 'd']), ['a', 'b', 'c'])
        self.assertEqual(labeler.normalize_evidence({'a': 1}), [])

    def test_label_book_two_segments_uses_merged_quality(self):
        replies = [
            {'title_guess': '斗罗大陆', 'text_quality': '含广告注入', 'text_quality_evidence': []},
            {'title_guess': '斗罗大陆', 'text_quality': '正常', 'text_quality_evidence': [],
             'genre': '玄幻'},
        ]
        with mock.patch.object(labeler, '_label_once', side_effect=replies):
            labels, calls = labeler.label_book('字' * (labeler.SEGMENT_CHARS + 10), 'k', ['m'])
        self.assertEqual(calls, 2)
        self.assertEqual(labels['text_quality'], '正常')
        self.assertEqual(labels['genre'], '玄幻')

    def test_label_book_second_segment_evidence_kept(self):
        # 反例：第一段正常、第二段给了证据 → 广告判定保留（不被第一段「正常」洗掉）
        replies = [
            {'text_quality': '正常'},
            {'text_quality': '含广告注入', 'text_quality_evidence': ['#百度搜（手打吧）#']},
        ]
        with mock.patch.object(labeler, '_label_once', side_effect=replies):
            labels, _ = labeler.label_book('字' * (labeler.SEGMENT_CHARS + 10), 'k', ['m'])
        self.assertEqual(labels['text_quality'], '含广告注入')
        self.assertEqual(labels['text_quality_evidence'], ['#百度搜（手打吧）#'])


# ---------------- B3/B4 main 质量门 ----------------
def _good_fetch(cli, url, stats=None, **k):
    text = '\n\n'.join(f'【第{i}章 起】\n{_chapter_body(f"章{i}", 60)}' for i in range(8))
    return text, len(text)


def _labels(quality, conf=0.9, match=True, evidence=('首发--无弹出广告(喜欢本书,请收藏)',)):
    return {'title_guess': '雪中悍刀行', 'site_title_match': match, 'text_quality': quality,
            'text_quality_evidence': list(evidence), 'genre': '武侠', 'confidence': conf,
            'site_title_note': '主角徐凤年、北凉王府设定吻合'}


class TestMainAdGate(MainHarness):
    def test_ad_injection_high_confidence_is_imported_with_flag(self):
        code, sent, out = self.run_main(_good_fetch, _labels('含广告注入'))
        self.assertEqual(code, 0)
        self.assertEqual(len(sent), 1)
        rows = self.rows('labels.jsonl')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['quality_flag'], 'ad_injection')
        self.assertEqual(rows[0]['text_quality_evidence'], ['首发--无弹出广告(喜欢本书,请收藏)'])
        self.assertEqual(rows[0]['labels']['text_quality'], '含广告注入')
        self.assertEqual(self.rows('labels-rejected.jsonl'), [])
        self.assertIn('降级入库', out)
        # 导入端契约：该行能被自动导入放行
        import import_one
        self.assertEqual(import_one.validate_record(rows[0])['status'], 'ready')

    def test_ad_injection_string_confidence_is_parsed(self):
        code, _, _ = self.run_main(_good_fetch, _labels('含广告注入', conf='0.85'))
        self.assertEqual(code, 0)
        self.assertEqual(self.rows('labels.jsonl')[0]['quality_flag'], 'ad_injection')

    def test_ad_injection_low_confidence_still_rejected(self):
        code, _, _ = self.run_main(_good_fetch, _labels('含广告注入', conf=0.7))
        self.assertEqual(code, 2)
        self.assertEqual(self.rows('labels.jsonl'), [])
        rej = self.rows('labels-rejected.jsonl')
        self.assertEqual(rej[0]['reason'], '文本质量异常: 含广告注入')
        self.assertEqual(rej[0]['ad_gate'], 2)
        self.assertEqual(rej[0]['text_quality_evidence'], ['首发--无弹出广告(喜欢本书,请收藏)'])

    def test_ad_injection_without_json_true_match_still_rejected(self):
        # title_guess 与站点书名一致能过书名核验，但 site_title_match 不是 JSON true → 不降级
        code, _, _ = self.run_main(_good_fetch, _labels('含广告注入', match='true'))
        self.assertEqual(code, 2)
        self.assertEqual(self.rows('labels-rejected.jsonl')[0]['ad_gate'], 2)

    def test_other_bad_quality_still_rejected(self):
        for quality in ('大面积重复', '疑似乱码'):
            with self.subTest(quality=quality):
                for name in ('labels.jsonl', 'labels-rejected.jsonl'):
                    (self.dir / name).unlink(missing_ok=True)
                code, _, _ = self.run_main(_good_fetch, _labels(quality, conf=0.99))
                self.assertEqual(code, 2)
                rej = self.rows('labels-rejected.jsonl')
                self.assertEqual(rej[0]['reason'], f'文本质量异常: {quality}')
                self.assertNotIn('ad_gate', rej[0])
                self.assertEqual(self.rows('labels.jsonl'), [])

    def test_normal_row_has_no_flag(self):
        code, _, _ = self.run_main(_good_fetch, _labels('正常', evidence=()))
        self.assertEqual(code, 0)
        row = self.rows('labels.jsonl')[0]
        self.assertNotIn('quality_flag', row)
        self.assertNotIn('text_quality_evidence', row)


class TestPinCounting(unittest.TestCase):
    URL = 'https://www.kxdu.net/book/38822'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'labels-rejected.jsonl'

    def write(self, rows):
        self.path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows),
                             encoding='utf-8')

    def test_old_gate_ad_rejections_do_not_pin(self):
        self.write([{'url': self.URL, 'reason': '文本质量异常: 含广告注入'}] * 6)
        counts = labeler.count_rejections(self.path)
        self.assertEqual(counts, {})
        self.assertEqual(labeler.terminal_urls(counts), set())

    def test_new_gate_ad_rejections_still_pin(self):
        self.write([{'url': self.URL, 'reason': '文本质量异常: 含广告注入', 'ad_gate': 2}] * 5)
        self.assertIn(self.URL, labeler.terminal_urls(labeler.count_rejections(self.path)))

    def test_other_rejections_still_counted(self):
        self.write([{'url': self.URL, 'reason': '文本质量异常: 大面积重复'}] * 3
                   + [{'url': self.URL, 'reason': '抓取字数不足: 10'}] * 2)
        self.assertEqual(labeler.count_rejections(self.path), {self.URL: 5})


class TestMainDowngradeDoesNotPin(MainHarness):
    def test_downgraded_import_is_not_a_rejection(self):
        # 5 次旧门槛广告拒收 + 1 次降级入库：不成钉子户、也不写新的拒收行
        rej = self.dir / 'labels-rejected.jsonl'
        rej.write_text(''.join(json.dumps({'url': self.BOOK['url'],
                                           'reason': '文本质量异常: 含广告注入'},
                                          ensure_ascii=False) + '\n' for _ in range(5)),
                       encoding='utf-8')
        code, sent, out = self.run_main(_good_fetch, _labels('含广告注入'))
        self.assertEqual(code, 0)
        self.assertEqual(len(sent), 1)                     # 没被钉子户挡掉
        self.assertNotIn('钉子户终态：跳过', out)
        self.assertEqual(len(rej.read_text(encoding='utf-8').splitlines()), 5)
        self.assertEqual(labeler.count_rejections(rej), {})


if __name__ == '__main__':
    unittest.main()
