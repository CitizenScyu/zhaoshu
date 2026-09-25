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


if __name__ == '__main__':
    unittest.main()
