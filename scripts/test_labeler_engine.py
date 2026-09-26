#!/usr/bin/env python3
"""labeler.py 引擎源取正文（T5）单测。

覆盖 fetch_book_text_engine：CLI toc → 逐章 content → 拼接（不过 clean_chapter_text）；
target_chars 截断；单章失败隔离；toc 失败抛错交主循环计失败；引擎正文逐字保留。
全离线：不联网、不真调 CLI、不调 LLM。mock 引擎 CLI（返回 CompletedProcess-like）。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_engine.py'
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


class FakeEngineCli:
    """引擎 CLI 桩：按 (subcommand, url) 返回预置结果，记录调用。"""

    def __init__(self, handler):
        self.handler = handler       # callable(subcommand, url) -> SimpleNamespace
        self.calls = []

    def run(self, subcommand, *args):
        url = args[1] if len(args) >= 2 and args[0] == '--url' else None
        self.calls.append((subcommand, url))
        return self.handler(subcommand, url)


def _toc(chapters):
    return _proc(0, json.dumps({'source': 'www.yingsx.com', 'title': '斗破苍穹',
                                'author': '天蚕土豆', 'chapters': chapters},
                               ensure_ascii=False))


def _content(text):
    return _proc(0, json.dumps({'source': 'www.yingsx.com', 'url': 'x', 'text': text},
                               ensure_ascii=False))


class TestFetchBookTextEngine(unittest.TestCase):
    def setUp(self):
        # 抓章间隔/重试退避不等真 sleep
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_toc_then_content_concatenated(self):
        body1 = '第一章正文' + '甲' * 200
        body2 = '第二章正文' + '乙' * 200

        def handler(sub, url):
            if sub == 'toc':
                return _toc([{'index': 0, 'title': '第一章 起', 'url': 'https://y/c1'},
                             {'index': 1, 'title': '第二章 承', 'url': 'https://y/c2'}])
            return _content(body1 if url == 'https://y/c1' else body2)

        cli = FakeEngineCli(handler)
        text, chars = labeler.fetch_book_text_engine(cli, 'https://www.yingsx.com/book/1')
        self.assertEqual(text, f'【第一章 起】\n{body1}\n\n【第二章 承】\n{body2}')
        self.assertEqual(chars, len(body1) + len(body2))
        self.assertEqual(cli.calls[0], ('toc', 'https://www.yingsx.com/book/1'))

    def test_target_chars_stops_early(self):
        body = '正' * 300

        def handler(sub, url):
            if sub == 'toc':
                return _toc([{'title': f'第{i}章', 'url': f'https://y/c{i}'}
                             for i in range(5)])
            return _content(body)

        cli = FakeEngineCli(handler)
        text, chars = labeler.fetch_book_text_engine(
            cli, 'https://y/book', target_chars=500)
        # 抓到 >= target 就停：300 -> 600 >= 500，取两章
        self.assertEqual(chars, 600)
        content_calls = [c for c in cli.calls if c[0] == 'content']
        self.assertEqual(len(content_calls), 2)

    def test_engine_text_is_not_cleaned(self):
        # 引擎正文逐字保留（不过 clean_chapter_text）：UI 样式行照样留在文本里
        raw = '章节目录 阅读设置\n他推开窗，雨点打在青瓦上。\n' + '正' * 200

        def handler(sub, url):
            return _toc([{'title': 'C', 'url': 'https://y/c'}]) if sub == 'toc' \
                else _content(raw)

        text, _ = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://y/b')
        self.assertIn('章节目录 阅读设置', text)   # 未被清洗

    def test_short_chapter_is_dropped(self):
        # 单章正文 <=100 字视为无效，跳过（与 book15 路径同门槛），其余章照收
        good = '正' * 200

        def handler(sub, url):
            if sub == 'toc':
                return _toc([{'title': 'A', 'url': 'https://y/a'},
                             {'title': 'B', 'url': 'https://y/b'}])
            return _content('太短' if url == 'https://y/a' else good)

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://y/x')
        self.assertEqual(text, f'【B】\n{good}')
        self.assertEqual(chars, len(good))

    def test_chapter_content_failure_is_isolated(self):
        # 单章 content 退出码 1（空正文）→ 重试后跳过，不拖垮整本
        good = '正' * 200

        def handler(sub, url):
            if sub == 'toc':
                return _toc([{'title': 'A', 'url': 'https://y/a'},
                             {'title': 'B', 'url': 'https://y/b'}])
            return _proc(1, '', '空正文') if url == 'https://y/a' else _content(good)

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://y/x')
        self.assertEqual(text, f'【B】\n{good}')

    def test_toc_failure_raises(self):
        # toc 退出码非 0 → 抛错，交主循环计失败（不静默产空文本）
        cli = FakeEngineCli(lambda sub, url: _proc(2, '', '引擎源池不可用'))
        with self.assertRaises(RuntimeError):
            labeler.fetch_book_text_engine(cli, 'https://y/x')

    def test_empty_toc_yields_empty_text(self):
        cli = FakeEngineCli(lambda sub, url: _toc([]))
        text, chars = labeler.fetch_book_text_engine(cli, 'https://y/x')
        self.assertEqual((text, chars), ('', 0))


class TestEngineIdentityVerification(unittest.TestCase):
    """N02 第二层：toc 后二次校验（EngineIdentityMismatch）。"""

    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _toc_proc(title, author, chapters=None):
        out = {'source': 'www.yingsx.com', 'title': title, 'author': author,
               'chapters': chapters or [{'title': 'A', 'url': 'https://y/a'}]}
        return _proc(0, json.dumps(out, ensure_ascii=False))

    def test_toc_author_mismatch_raises_before_any_content(self):
        # toc 返回异作者 → 抛 EngineIdentityMismatch，且没有任何 content 调用
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('斗破苍穹', '别人') if sub == 'toc'
            else _content('正' * 200))
        with self.assertRaises(labeler.EngineIdentityMismatch):
            labeler.fetch_book_text_engine(cli, 'https://y/x',
                                           expect_title='斗破苍穹',
                                           expect_author='天蚕土豆')
        self.assertEqual([c[0] for c in cli.calls], ['toc'])   # 没发起 content

    def test_toc_title_incompatible_raises_before_any_content(self):
        # toc title 不兼容（中部命中的同人书标题）→ 同上
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('一切从斗破苍穹开始', '天蚕土豆')
            if sub == 'toc' else _content('正' * 200))
        with self.assertRaises(labeler.EngineIdentityMismatch):
            labeler.fetch_book_text_engine(cli, 'https://y/x',
                                           expect_title='斗破苍穹',
                                           expect_author='天蚕土豆')
        self.assertEqual([c[0] for c in cli.calls], ['toc'])

    def test_mismatch_message_contains_both_ends(self):
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('斗破苍穹', '别人'))
        with self.assertRaises(labeler.EngineIdentityMismatch) as ctx:
            labeler.fetch_book_text_engine(cli, 'https://y/x',
                                           expect_title='斗破苍穹',
                                           expect_author='天蚕土豆')
        msg = str(ctx.exception)
        self.assertIn('天蚕土豆', msg)
        self.assertIn('别人', msg)

    def test_missing_toc_identity_skips_verification(self):
        # toc JSON 里 title/author 缺失（空串）→ 校验不触发（双侧非空才比对）
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('', '') if sub == 'toc'
            else _content('正' * 200))
        text, chars = labeler.fetch_book_text_engine(
            cli, 'https://y/x',
            expect_title='斗破苍穹', expect_author='天蚕土豆')
        self.assertEqual(chars, 200)                    # 正文照常取

    def test_no_expect_values_keeps_legacy_behavior(self):
        # 不传 expect_title/expect_author（既有调用形态）：不校验，行为不变
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('斗破苍穹', '天蚕土豆') if sub == 'toc'
            else _content('正' * 200))
        text, chars = labeler.fetch_book_text_engine(cli, 'https://y/x')
        self.assertEqual(chars, 200)

    def test_compatible_prefix_title_passes(self):
        # title 校验复用 title_compatible 语义：系列卷号形态放行
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('斗罗大陆IV终极斗罗', '唐家三少')
            if sub == 'toc' else _content('正' * 200))
        text, chars = labeler.fetch_book_text_engine(
            cli, 'https://y/x',
            expect_title='斗罗大陆', expect_author='唐家三少')
        self.assertEqual(chars, 200)

    def test_author_form_difference_passes_verification(self):
        # author 校验用 _norm_author 归一化比对：国籍前缀写法差过
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('冰与火之歌', '（美）乔治·R·R·马丁')
            if sub == 'toc' else _content('正' * 200))
        text, chars = labeler.fetch_book_text_engine(
            cli, 'https://y/x',
            expect_title='冰与火之歌', expect_author='乔治·R·R·马丁')
        self.assertEqual(chars, 200)

    def test_author_label_prefix_passes_verification(self):
        # labelerdiag41 原样：名单 风凌天下 vs 目录 作者：风凌天下 曾被判「作者不符」
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('九君齐天', '作者：风凌天下')
            if sub == 'toc' else _content('正' * 200))
        text, chars = labeler.fetch_book_text_engine(
            cli, 'https://y/x',
            expect_title='九君齐天', expect_author='风凌天下')
        self.assertEqual(chars, 200)

    def test_toc_uses_same_author_rules_as_candidate_filter(self):
        # authfix41：候选阶段靠 author_matches 放行的写法（多署名/外文末节），toc 二次校验
        # 必须同口径——否则候选收了、toc 又判「作者不符」，修了等于没修。
        for title, expect, toc_author in (
                ('风起陇西', '马伯庸', '马伯庸著 刘巴布编绘'),
                ('冰与火之歌', '[美]乔治·R.R.马丁', '马丁')):
            with self.subTest(toc_author=toc_author):
                cli = FakeEngineCli(
                    lambda sub, url, t=title, a=toc_author: self._toc_proc(t, a)
                    if sub == 'toc' else _content('正' * 200))
                _, chars = labeler.fetch_book_text_engine(
                    cli, 'https://y/x', expect_title=title, expect_author=expect)
                self.assertEqual(chars, 200)

    def test_toc_still_rejects_containment(self):
        # 放宽规则不做子串包含：金庸 vs 金庸新 仍判作者不符
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('天龙八部', '金庸新') if sub == 'toc'
            else _content('正' * 200))
        with self.assertRaises(labeler.EngineIdentityMismatch):
            labeler.fetch_book_text_engine(cli, 'https://y/x',
                                           expect_title='天龙八部', expect_author='金庸')
        self.assertEqual([c[0] for c in cli.calls], ['toc'])


class TestEngineTocAuthorWriteback(unittest.TestCase):
    """author17k41：名单作者为空时用已过身份校验的 toc 自报作者回写记录 author。"""

    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _toc_proc(title, author):
        out = {'source': 'www.yingsx.com', 'title': title, 'author': author,
               'chapters': [{'title': 'A', 'url': 'https://y/a'}]}
        return _proc(0, json.dumps(out, ensure_ascii=False))

    def test_writeback_applies_when_list_author_empty(self):
        # 名单作者空 + 书名完全相等 + toc 作者非空 → 回写
        self.assertEqual(labeler.engine_author_writeback('', '唐家三少', '斗罗大陆', '斗罗大陆'),
                         '唐家三少')

    def test_no_writeback_when_list_author_present(self):
        # 名单有作者 → 恒不回写（行为完全不变）
        self.assertEqual(labeler.engine_author_writeback('金庸', '唐家三少', '书', '书'), '')

    def test_no_writeback_when_toc_author_empty(self):
        self.assertEqual(labeler.engine_author_writeback('', '', '书', '书'), '')
        self.assertEqual(labeler.engine_author_writeback('', '作者：', '书', '书'), '')  # 只标签→清洗空

    def test_writeback_normalizes_label_and_suffix(self):
        # 带「作者：」前缀 / 「著」尾缀被剥；保留大小写与「·」（不做身份比对式强归一）
        self.assertEqual(labeler.engine_author_writeback('', '作者：唐家三少 著', '书', '书'), '唐家三少')
        self.assertEqual(labeler.engine_author_writeback('', '乔治·奥威尔', '书', '书'), '乔治·奥威尔')

    def test_no_writeback_when_only_prefix_compatible_title(self):
        # rvauthor CE3：书名只前缀兼容（可能是另一本书）→ 不回写，保持作者空进 review
        self.assertEqual(
            labeler.engine_author_writeback('', '另一作者', '万古仙穹', '万古仙穹外传'), '')
        # 完全相等才回写
        self.assertEqual(
            labeler.engine_author_writeback('', '观棋', '万古仙穹', '万古仙穹'), '观棋')

    def test_no_writeback_when_toc_title_missing(self):
        # 源未自报 toc 标题 → 无从确认完全相等 → 不回写（保守）
        self.assertEqual(labeler.engine_author_writeback('', '观棋', '万古仙穹', ''), '')

    def test_no_writeback_for_placeholder_author(self):
        # rvauthor 建议 4：占位作者视同空作者，不回写（含繁体形态 無名氏/暫無/無）
        for a in ('佚名', '未知', '未知作者', '暂无', '匿名', '無名氏', '暫無', '無'):
            with self.subTest(a=a):
                self.assertEqual(labeler.engine_author_writeback('', a, '书', '书'), '')
                self.assertEqual(labeler._clean_engine_author(a), '')

    def test_toc_author_and_title_exposed_in_stats_on_success(self):
        # 身份校验通过 → toc_author/toc_title 进 stats，供记录组装层回写
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('斗罗大陆', '作者：唐家三少')
            if sub == 'toc' else _content('正' * 200))
        stats = {}
        labeler.fetch_book_text_engine(cli, 'https://y/x',
                                       expect_title='斗罗大陆', stats=stats)
        self.assertEqual(stats.get('toc_author'), '作者：唐家三少')
        self.assertEqual(stats.get('toc_title'), '斗罗大陆')
        # 组装层清洗 + 书名相等校验后回写
        self.assertEqual(
            labeler.engine_author_writeback('', stats['toc_author'], '斗罗大陆', stats['toc_title']),
            '唐家三少')

    def test_no_toc_author_in_stats_on_identity_mismatch(self):
        # 身份不符 → 抛异常、stats 里不出现 toc_author（记录组装根本不会执行 → 不回写）
        cli = FakeEngineCli(
            lambda sub, url: self._toc_proc('斗破苍穹', '别人') if sub == 'toc'
            else _content('正' * 200))
        stats = {}
        with self.assertRaises(labeler.EngineIdentityMismatch):
            labeler.fetch_book_text_engine(cli, 'https://y/x',
                                           expect_title='斗破苍穹',
                                           expect_author='天蚕土豆', stats=stats)
        self.assertNotIn('toc_author', stats)


class TestBuildEngineCli(unittest.TestCase):
    """_build_engine_cli：开关 + 必要配置齐备才返回 EngineCli，否则降级 None。"""

    def test_disabled_when_switch_off(self):
        self.assertIsNone(labeler._build_engine_cli({'DATABASE_URL': 'postgres://x',
                                                     'LABELER_ENGINE_CLI': '/a/b.mjs'}))

    def test_disabled_when_cli_path_missing(self):
        env = {labeler.douban_list.ENGINE_FALLBACK_ENV: '1',
               'DATABASE_URL': 'postgres://x'}
        self.assertIsNone(labeler._build_engine_cli(env))

    def test_disabled_when_database_url_missing(self):
        env = {labeler.douban_list.ENGINE_FALLBACK_ENV: '1',
               'LABELER_ENGINE_CLI': '/a/b.mjs'}
        self.assertIsNone(labeler._build_engine_cli(env))

    def test_built_when_all_present(self):
        env = {labeler.douban_list.ENGINE_FALLBACK_ENV: '1',
               'LABELER_ENGINE_CLI': '/repo/scripts/engine-fetch.mjs',
               'LABELER_ENGINE_NODE': '/usr/bin/node',
               'DATABASE_URL': 'postgres://user:pw@host/db'}
        with mock.patch.object(labeler.douban_list, 'validate_engine') as validate:
            cli = labeler._build_engine_cli(env)
        self.assertIsNotNone(cli)
        self.assertEqual(cli.node, '/usr/bin/node')
        self.assertEqual(cli.script_path, '/repo/scripts/engine-fetch.mjs')
        validate.assert_called_once_with(cli)

    def test_probe_failure_disables_engine_with_clear_error(self):
        env = {labeler.douban_list.ENGINE_FALLBACK_ENV: '1',
               'LABELER_ENGINE_CLI': '/repo/scripts/engine-fetch.mjs',
               'DATABASE_URL': 'postgres://user:pw@host/db'}
        err = io.StringIO()
        with mock.patch.object(labeler.douban_list, 'validate_engine',
                               side_effect=labeler.douban_list.EngineUnavailable(
                                   '引擎启动探针失败（rc=1）: Unknown file extension')), \
                contextlib.redirect_stderr(err):
            cli = labeler._build_engine_cli(env)
        self.assertIsNone(cli)
        self.assertIn('引擎启动探针失败', err.getvalue())
        self.assertNotIn('pw@host', err.getvalue())



class TestMainRejectsIdentityMismatch(unittest.TestCase):
    """N02 第三层：主循环专门 catch EngineIdentityMismatch → labels-rejected.jsonl
    新增一行（reason 含「引擎目录身份不符」）、不调 LLM、不写 labels.jsonl。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')

    def test_identity_mismatch_is_rejected_without_llm_call(self):
        book = {'url': 'https://www.yingsx.com/book/1', 'title': '斗破苍穹',
                'author': '天蚕土豆', 'engine': True,
                'source_host': 'www.yingsx.com'}
        llm_called = []

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [book]

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine',
                                  side_effect=labeler.EngineIdentityMismatch(
                                      '引擎目录身份不符: 名单《斗破苍穹》/天蚕土豆'
                                      ' vs 目录《斗破苍穹》/别人')), \
                mock.patch.object(labeler, 'label_book',
                                  side_effect=lambda *a, **k: llm_called.append(1)), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel',
                                   '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        self.assertEqual(code, 2)                       # 整轮零成功
        self.assertEqual(llm_called, [])                # 没调模型
        rej_path = self.dir / 'labels-rejected.jsonl'
        lines = [json.loads(x) for x in
                 rej_path.read_text(encoding='utf-8').splitlines() if x]
        self.assertEqual(len(lines), 1)
        rec = lines[0]
        self.assertEqual(rec['site_title'], '斗破苍穹')
        self.assertEqual(rec['author'], '天蚕土豆')
        self.assertEqual(rec['url'], 'https://www.yingsx.com/book/1')
        self.assertIn('引擎目录身份不符', rec['reason'])
        self.assertFalse((self.dir / 'labels.jsonl').exists())   # 未入库
        self.assertIn('引擎目录身份不符', out.getvalue())

    def test_generic_exception_still_works(self):
        # 对照：普通异常仍走通用 except（打 stderr、不写 rejected）——分层不互相吃
        book = {'url': 'https://www.yingsx.com/book/1', 'title': '斗破苍穹',
                'author': '天蚕土豆', 'engine': True}

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [book]

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine',
                                  side_effect=RuntimeError('boom')), \
                mock.patch.object(labeler, 'label_book', return_value=({}, 1)), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel',
                                   '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        self.assertEqual(code, 2)
        self.assertIn('失败: boom', err.getvalue())
        self.assertFalse((self.dir / 'labels-rejected.jsonl').exists())


class TestFailureClassification(unittest.TestCase):
    """labelerdiag41 P3：每轮失败按类别计数，轮末单独一行（「完成」行逐字不变）。"""

    def test_classify_failure(self):
        truncated = None
        try:
            json.loads('{"chapters": [{"title": "第一章')
        except json.JSONDecodeError as e:
            truncated = e
        cases = (
            (truncated, '引擎输出截断'),
            (UnicodeDecodeError('utf-8', b'\xef', 0, 1, 'unexpected end of data'), '引擎输出截断'),
            (labeler.EngineIdentityMismatch('引擎目录身份不符: …（作者不符）'), '目录作者不符'),
            (labeler.EngineIdentityMismatch('引擎目录身份不符: …（标题不兼容）'), '目录标题不符'),
            (RuntimeError("打标失败: 模型链 ['a'] 全部耗尽, 最后错误: Unterminated string"),
             'LLM链耗尽'),
            (RuntimeError('引擎 toc 失败 rc=1: 仅支持 HTTPS 精确域名和默认端口/443'), '非HTTPS源'),
            (TimeoutError('read'), '书源超时'),
            (OSError('<urlopen error timed out>'), '书源超时'),
            (RuntimeError('boom'), '其他'),
        )
        for error, kind in cases:
            with self.subTest(kind=kind, error=str(error)):
                self.assertEqual(labeler.classify_failure(error), kind)

    def test_format_failure_kinds(self):
        self.assertEqual(labeler.format_failure_kinds({'其他': 1, 'LLM链耗尽': 3, '书源超时': 1}),
                         '失败分类: LLM链耗尽 3 / 书源超时 1 / 其他 1')

    def test_main_prints_failure_kinds_after_unchanged_done_line(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        books = [{'url': f'https://www.yingsx.com/book/{i}', 'title': f'书{i}',
                  'author': '某人', 'engine': True, 'source_host': 'www.yingsx.com'}
                 for i in range(4)]
        truncated = json.JSONDecodeError('Unterminated string starting at', '{"a', 1)
        errors = iter([truncated, truncated,
                       labeler.EngineIdentityMismatch('引擎目录身份不符: x（作者不符）'),
                       RuntimeError('boom')])

        def fake_fetch(*a, **k):
            raise next(errors)

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return list(books)

        out = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(d)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine', side_effect=fake_fetch), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = labeler.main()
        self.assertEqual(code, 2)
        text = out.getvalue()
        self.assertIn('完成: 成功 0 / 失败 4 / 残本候选跳过 0，结果在 labels.jsonl\n'
                      '失败分类: 引擎输出截断 2 / 其他 1 / 目录作者不符 1', text)


class TestMainWiresBook15Breaker(unittest.TestCase):
    """labelerdiag41：名单线把按 .env 阈值装配的 book15 熔断器交给队列构建。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def _run(self, env_text):
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n' + env_text,
                                       encoding='utf-8')
        seen = []

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            seen.append(book15_breaker)
            return []

        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel',
                                   '--no-db-model', '--dry-run']), \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            os.environ.pop(labeler.douban_list.BOOK15_BREAKER_ENV, None)
            labeler.main()
        self.assertEqual(len(seen), 1)
        return seen[0]

    def test_default_threshold(self):
        breaker = self._run('')
        self.assertIsInstance(breaker, labeler.douban_list.Book15Breaker)
        self.assertEqual(breaker.threshold, labeler.douban_list.BOOK15_BREAKER_DEFAULT)

    def test_env_threshold(self):
        self.assertEqual(self._run('LABELER_BOOK15_BREAKER=2\n').threshold, 2)



# ---- giveup41：源整站失效提前放弃 ----
POLICY_STDERR = '仅支持 HTTPS 精确域名和默认端口/443\n{"errorKind": "policy"}\n'
# 旧 CLI（改前）同一故障的 stderr：只有原因行，没有 errorKind 行
POLICY_STDERR_LEGACY = '仅支持 HTTPS 精确域名和默认端口/443\n'


def _kind(kind):
    return _proc(1, '', f'x\n{{"errorKind": "{kind}"}}\n')


def _toc_on(host, n):
    return _proc(0, json.dumps({'source': host, 'title': '斗罗大陆III龙王传说', 'author': '唐家三少',
                                'chapters': [{'title': f'第{i}章', 'url': f'https://{host}/c{i}'}
                                             for i in range(n)]}, ensure_ascii=False))


def _content_calls(cli):
    return [c for c in cli.calls if c[0] == 'content']


class TestEngineErrorKindParsing(unittest.TestCase):
    def test_kind_line_is_parsed_and_excluded_from_summary(self):
        cli = FakeEngineCli(lambda sub, url: _proc(1, '', POLICY_STDERR))
        with self.assertRaises(labeler.EngineCliError) as ctx:
            labeler._engine_json(cli, 'content', '--url', 'https://h/c')
        self.assertEqual(ctx.exception.kind, 'policy')
        self.assertEqual(str(ctx.exception), '引擎 content 失败 rc=1: 仅支持 HTTPS 精确域名和默认端口/443')
        self.assertIsInstance(ctx.exception, RuntimeError)      # 旧 except RuntimeError 仍接得住

    def test_legacy_stderr_has_no_kind_and_same_summary(self):
        # 旧 CLI 兼容：没有 errorKind 行 → kind=''，摘要与改前逐字相同
        summary, kind = labeler._split_engine_stderr('引擎源池不可用：[redacted-url]\n  第二行  ')
        self.assertEqual((summary, kind), ('引擎源池不可用：[redacted-url] 第二行', ''))

    def test_non_kind_json_line_is_kept_as_text(self):
        summary, kind = labeler._split_engine_stderr('原因\n{"other": 1}')
        self.assertEqual((summary, kind), ('原因 {"other": 1}', ''))
        summary, kind = labeler._split_engine_stderr('原因\n{broken')
        self.assertEqual((summary, kind), ('原因 {broken', ''))


class TestSourceGiveup(unittest.TestCase):
    """连续 N 章同一确定性错误 → 放弃该源；抖动不触发；成功一章清零；toc 确定性失败直接放弃。"""

    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_counterexample_legacy_cli_hammers_every_chapter(self):
        # 反例（改前行为）：旧 CLI 不给类别 → 无法判定确定性，逐章 × CHUNK_RETRY 打满整本目录
        cli = FakeEngineCli(lambda sub, url: _toc_on('www.bqquge.org', 40) if sub == 'toc'
                            else _proc(1, '', POLICY_STDERR_LEGACY))
        text, chars = labeler.fetch_book_text_engine(cli, 'https://www.bqquge.org/b/1')
        self.assertEqual((text, chars), ('', 0))
        self.assertEqual(len(_content_calls(cli)), 40 * labeler.CHUNK_RETRY)

    def test_gives_up_at_nth_chapter_without_retry(self):
        cli = FakeEngineCli(lambda sub, url: _toc_on('www.bqquge.org', 40) if sub == 'toc'
                            else _proc(1, '', POLICY_STDERR))
        with self.assertRaises(labeler.EngineSourceGaveUp) as ctx:
            labeler.fetch_book_text_engine(cli, 'https://www.bqquge.org/b/1', giveup_streak=5)
        e = ctx.exception
        self.assertEqual((e.host, e.kind, e.chars), ('www.bqquge.org', 'policy', 0))
        # 第 5 章放弃；确定性错误不重试：恰好 5 次 content 调用（改前是 40×3=120 次）
        self.assertEqual(len(_content_calls(cli)), 5)
        self.assertEqual(_content_calls(cli)[-1], ('content', 'https://www.bqquge.org/c4'))
        self.assertIn('连续 5 章 policy', str(e))

    def test_default_streak_constant(self):
        self.assertEqual(labeler.SOURCE_GIVEUP_STREAK, 5)
        cli = FakeEngineCli(lambda sub, url: _toc_on('h.example', 40) if sub == 'toc' else _kind('http_4xx'))
        with self.assertRaises(labeler.EngineSourceGaveUp):
            labeler.fetch_book_text_engine(cli, 'https://h.example/b')
        self.assertEqual(len(_content_calls(cli)), labeler.SOURCE_GIVEUP_STREAK)

    def test_jitter_kinds_never_trigger_giveup(self):
        # 抖动（超时 / 未知类别）不参与放弃：照旧重试、逐章继续，不抛（5xx 见 TestServerErrorGiveup）
        for kind in ('timeout', 'other', 'empty', 'usage', 'pool'):
            with self.subTest(kind=kind):
                cli = FakeEngineCli(lambda sub, url, k=kind: _toc_on('h.example', 12)
                                    if sub == 'toc' else _kind(k))
                text, chars = labeler.fetch_book_text_engine(cli, 'https://h.example/b', giveup_streak=5)
                self.assertEqual(chars, 0)
                self.assertEqual(len(_content_calls(cli)), 12 * labeler.CHUNK_RETRY)

    def test_success_in_between_resets_streak(self):
        # 每 4 章确定性失败夹 1 章成功：永远到不了 5 连 → 不放弃，成功章全收
        good = '正' * 200

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 20)
            i = int(url.rsplit('c', 1)[1])
            return _content(good) if i % 5 == 4 else _kind('policy')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b',
                                                     giveup_streak=5)
        self.assertEqual(chars, 4 * len(good))

    def test_jitter_in_between_also_breaks_consecutive_run(self):
        # 「连续」= 相邻章同一确定性类别；中间夹一章超时即不连续（保守，防误杀）
        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 10)
            i = int(url.rsplit('c', 1)[1])
            return _kind('timeout') if i == 4 else _kind('policy')

        cli = FakeEngineCli(handler)
        with self.assertRaises(labeler.EngineSourceGaveUp):
            labeler.fetch_book_text_engine(cli, 'https://h.example/b', giveup_streak=5)
        # c0-c3 policy(4) → c4 timeout 清零 → c5-c9 policy 第 5 章放弃
        self.assertEqual(_content_calls(cli)[-1], ('content', 'https://h.example/c9'))

    def test_different_deterministic_kinds_do_not_add_up(self):
        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 10)
            i = int(url.rsplit('c', 1)[1])
            return _kind('policy' if i % 2 else 'http_4xx')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b',
                                                     giveup_streak=5)
        self.assertEqual(chars, 0)

    def test_deterministic_toc_failure_gives_up_immediately(self):
        cli = FakeEngineCli(lambda sub, url: _proc(1, '', POLICY_STDERR))
        with self.assertRaises(labeler.EngineSourceGaveUp) as ctx:
            labeler.fetch_book_text_engine(cli, 'https://www.bqquge.org/b/1')
        self.assertEqual(ctx.exception.kind, 'policy')
        self.assertEqual(_content_calls(cli), [])

    def test_non_deterministic_toc_failure_keeps_legacy_error(self):
        cli = FakeEngineCli(lambda sub, url: _kind('timeout'))
        with self.assertRaises(RuntimeError) as ctx:
            labeler.fetch_book_text_engine(cli, 'https://h.example/b')
        self.assertNotIsInstance(ctx.exception, labeler.EngineSourceGaveUp)

    def test_partial_text_is_carried_on_giveup(self):
        good = '正' * 3000

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 20)
            return _content(good) if int(url.rsplit('c', 1)[1]) < 4 else _kind('policy')

        with self.assertRaises(labeler.EngineSourceGaveUp) as ctx:
            labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b', giveup_streak=5)
        self.assertEqual(ctx.exception.chars, 4 * 3000)
        self.assertTrue(ctx.exception.text.startswith('【第0章】'))


def _multi_host_cli(dead_hosts, good_text='正' * 200, identity_bad_hosts=()):
    """dead_hosts 上 toc 正常、content 全是 policy；其他 host 正常出正文。"""
    def handler(sub, url):
        host = labeler._url_host(url)
        if sub == 'toc':
            if host in identity_bad_hosts:
                return _proc(0, json.dumps({'source': host, 'title': '别的书', 'author': '别人',
                                            'chapters': [{'title': 'x', 'url': f'https://{host}/c0'}]},
                                           ensure_ascii=False))
            return _toc_on(host, 30)
        return _proc(1, '', POLICY_STDERR) if host in dead_hosts else _content(good_text)
    return FakeEngineCli(handler)


def _book(url='https://www.bqquge.org/b/1', alternates=()):
    return {'url': url, 'title': '斗罗大陆III龙王传说', 'author': '唐家三少', 'engine': True,
            'source_host': labeler._url_host(url),
            **({'engine_alternates': list(alternates)} if alternates else {})}


ALT = {'url': 'https://www.yingsx.com/b/9', 'title': '斗罗大陆III龙王传说', 'source': 'www.yingsx.com'}


class TestSourceSwitch(unittest.TestCase):
    """放弃后换源：按 engine_alternates 顺序换；本轮失效 host 零请求；主源身份不符行为不变。"""

    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.out = io.StringIO()
        redirect = contextlib.redirect_stdout(self.out)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def test_switches_to_alternate_after_giveup(self):
        cli = _multi_host_cli({'www.bqquge.org'})
        tracker = labeler.SourceGiveupTracker(2)
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, _book(alternates=[ALT]), tracker, giveup_streak=5)
        self.assertEqual(used, ALT)
        self.assertGreater(chars, 0)
        self.assertEqual(tracker.counts, {'www.bqquge.org': 1})
        self.assertEqual(tracker.dead, set())
        bq_content = [c for c in _content_calls(cli) if 'bqquge' in c[1]]
        self.assertEqual(len(bq_content), 5)
        self.assertIn('换源: www.yingsx.com', self.out.getvalue())

    def test_no_alternate_fails_book_with_giveup_error(self):
        cli = _multi_host_cli({'www.bqquge.org'})
        with self.assertRaises(labeler.EngineSourceGaveUp) as ctx:
            labeler.fetch_engine_book_with_giveup(cli, _book(), labeler.SourceGiveupTracker(2),
                                                  giveup_streak=5)
        self.assertEqual(labeler.classify_failure(ctx.exception), '源失效放弃')

    def test_host_dead_after_two_giveups_skips_later_books_without_requests(self):
        cli = _multi_host_cli({'www.bqquge.org'})
        tracker = labeler.SourceGiveupTracker(2)
        for n in (1, 2):
            with self.assertRaises(labeler.EngineSourceGaveUp):
                labeler.fetch_engine_book_with_giveup(
                    cli, _book(f'https://www.bqquge.org/b/{n}'), tracker, giveup_streak=5)
        self.assertEqual(tracker.dead, {'www.bqquge.org'})
        self.assertIn('源失效（本轮）: www.bqquge.org', self.out.getvalue())
        before = len(cli.calls)
        # 第 3 本：主源在失效 host 上 → 一个请求都不发，直接用备选
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, _book('https://www.bqquge.org/b/3', alternates=[ALT]), tracker, giveup_streak=5)
        self.assertEqual(used, ALT)
        self.assertFalse(any('bqquge' in (c[1] or '') for c in cli.calls[before:]))
        # 第 4 本：无备选 → 直接失败，零请求
        before = len(cli.calls)
        with self.assertRaises(labeler.EngineSourceGaveUp):
            labeler.fetch_engine_book_with_giveup(
                cli, _book('https://www.bqquge.org/b/4'), tracker, giveup_streak=5)
        self.assertEqual(len(cli.calls), before)

    def test_alternate_on_dead_host_is_skipped(self):
        cli = _multi_host_cli({'www.bqquge.org', 'm.cuoceng.com'})
        tracker = labeler.SourceGiveupTracker(2)
        tracker.dead.add('m.cuoceng.com')
        dead_alt = {'url': 'https://m.cuoceng.com/b/2', 'title': 'x', 'source': 'm.cuoceng.com'}
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, _book(alternates=[dead_alt, ALT]), tracker, giveup_streak=5)
        self.assertEqual(used, ALT)
        self.assertFalse(any('cuoceng' in (c[1] or '') for c in cli.calls))

    def test_primary_identity_mismatch_still_propagates(self):
        # 主源身份不符：行为同改前（主循环写 rejected），不换源
        cli = _multi_host_cli(set(), identity_bad_hosts={'www.bqquge.org'})
        with self.assertRaises(labeler.EngineIdentityMismatch):
            labeler.fetch_engine_book_with_giveup(cli, _book(alternates=[ALT]),
                                                  labeler.SourceGiveupTracker(2))
        self.assertFalse(any('yingsx' in (c[1] or '') for c in cli.calls))

    def test_alternate_identity_mismatch_is_skipped(self):
        cli = _multi_host_cli({'www.bqquge.org'}, identity_bad_hosts={'bad.example'})
        bad_alt = {'url': 'https://bad.example/b', 'title': 'x', 'source': 'bad.example'}
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, _book(alternates=[bad_alt, ALT]), labeler.SourceGiveupTracker(2), giveup_streak=5)
        self.assertEqual(used, ALT)

    def test_primary_ok_is_unchanged(self):
        cli = _multi_host_cli(set())
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, _book(alternates=[ALT]), labeler.SourceGiveupTracker(2))
        self.assertEqual(used['url'], 'https://www.bqquge.org/b/1')
        self.assertFalse(any('yingsx' in (c[1] or '') for c in cli.calls))

    def test_enough_partial_text_is_used_without_switch(self):
        big = '正' * 4000

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on(labeler._url_host(url), 30)
            i = int(url.rsplit('c', 1)[1])
            return _content(big) if i < 3 else _proc(1, '', POLICY_STDERR)

        cli = FakeEngineCli(handler)
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, _book(alternates=[ALT]), labeler.SourceGiveupTracker(2), giveup_streak=5)
        self.assertEqual(chars, 12000)
        self.assertEqual(used['source'], 'www.bqquge.org')
        self.assertFalse(any('yingsx' in (c[1] or '') for c in cli.calls))

    def test_enough_partial_text_does_not_count_as_giveup(self):
        # 反例：两本都「抓够字数但后段失效」→ 都算成功，host 不记放弃、不被判失效
        big = '正' * 4000

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on(labeler._url_host(url), 30)
            return _content(big) if int(url.rsplit('c', 1)[1]) < 3 else _proc(1, '', POLICY_STDERR)

        tracker = labeler.SourceGiveupTracker(2)
        for n in (1, 2):
            text, chars, used = labeler.fetch_engine_book_with_giveup(
                FakeEngineCli(handler), _book(f'https://www.bqquge.org/b/{n}'), tracker, giveup_streak=5)
            self.assertEqual(chars, 12000)
        self.assertEqual(tracker.counts, {})
        self.assertEqual(tracker.dead, set())


class TestMainSwitchesSourceAndRecordsIt(unittest.TestCase):
    """主循环接线：主源失效换源后 labels.jsonl 记实际来源；无备选的书计「源失效放弃」、不写 rejected。"""

    def test_main_records_alternate_source(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        books = [_book(alternates=[ALT]), _book('https://www.bqquge.org/b/2')]
        cli = _multi_host_cli({'www.bqquge.org'}, good_text='正' * 11000)
        labels = {'title_guess': '斗罗大陆III龙王传说', 'site_title_match': True, 'text_quality': '正常'}

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [dict(b) for b in books]

        out = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(d)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue', side_effect=fake_build), \
                mock.patch.object(labeler, '_build_engine_cli', return_value=cli), \
                mock.patch.object(labeler, 'label_book', return_value=(labels, 1)), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = labeler.main()
        self.assertEqual(code, 1)                                   # 1 成功 1 失败
        rec = json.loads((d / 'labels.jsonl').read_text(encoding='utf-8').splitlines()[0])
        self.assertEqual(rec['url'], ALT['url'])
        self.assertEqual(rec['source'], 'www.yingsx.com')
        self.assertFalse((d / 'labels-rejected.jsonl').exists())    # 源失效不进钉子户计数
        text = out.getvalue()
        self.assertIn('失败分类: 源失效放弃 1', text)
        self.assertIn('源失效（本轮）: www.bqquge.org', text)       # 两本各放弃一次 → 本轮判失效


class TestMainWritebackUsesListTitle(unittest.TestCase):
    """rvauthor 增量必修：回写书名收紧要走真实路径。引擎条目由 _resolve_candidates 构造
    （名单书名进 list_title、候选站点标题进 title），主循环回写点用 list_title 与 toc 标题比
    「完全相等」——只前缀兼容的错书不回写。不直接给 engine_author_writeback 传参。"""

    def _cli(self, toc_title, toc_author):
        def handler(sub, url):
            if sub == 'toc':
                return _proc(0, json.dumps(
                    {'source': labeler._url_host(url), 'title': toc_title, 'author': toc_author,
                     'chapters': [{'title': '第一章', 'url': url + '/c1'}]}, ensure_ascii=False))
            return _content('正' * 11000)
        return FakeEngineCli(handler)

    def _resolve_entry(self, cli, list_title, cand_title, cand_url='https://src.example.com/b/x'):
        """真实跑 _resolve_candidates（stub 掉搜索）建引擎条目。"""
        with mock.patch.object(labeler.douban_list, 'search_book15', return_value=None), \
                mock.patch.object(labeler.douban_list, 'search_engine',
                                  return_value={'url': cand_url, 'title': cand_title,
                                                'source': 'src.example.com'}), \
                mock.patch.object(labeler.douban_list.time, 'sleep'):
            queue = labeler.douban_list._resolve_candidates(
                [{'title': list_title, 'author': '', 'origin': '17K完本', 'douban_url': ''}],
                http_get=lambda *a, **k: '', origin='17K完本', engine_cli=cli)
        return queue[0]

    def test_entry_preserves_list_title(self):
        # 条目 title = 候选站点标题；名单书名另存 list_title（否则回写点无从比对）
        entry = self._resolve_entry(self._cli('万古仙穹外传', '另一作者'), '万古仙穹', '万古仙穹外传')
        self.assertEqual(entry['title'], '万古仙穹外传')
        self.assertEqual(entry['list_title'], '万古仙穹')
        self.assertTrue(entry['engine'])

    def _run_main_and_read_record(self, entry, cli):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        labels = {'title_guess': entry['title'], 'site_title_match': True, 'text_quality': '正常'}
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(d)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=lambda *a, **k: [dict(entry)]), \
                mock.patch.object(labeler, '_build_engine_cli', return_value=cli), \
                mock.patch.object(labeler, 'label_book', return_value=(labels, 1)), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            labeler.main()
        return json.loads((d / 'labels.jsonl').read_text(encoding='utf-8').splitlines()[0])

    def test_prefix_compatible_wrong_book_is_not_written_back(self):
        # 名单《万古仙穹》命中候选《万古仙穹外传》（另一本）→ toc 标题≠名单书名 → 不回写，作者留空
        cli = self._cli('万古仙穹外传', '另一作者')
        entry = self._resolve_entry(cli, '万古仙穹', '万古仙穹外传')
        rec = self._run_main_and_read_record(entry, cli)
        self.assertEqual(rec['author'], '')
        self.assertNotIn('author_source', rec)

    def test_exact_title_match_writes_back(self):
        # 名单《万古仙穹》命中同名候选，toc 标题=名单书名 → 回写 toc 作者
        cli = self._cli('万古仙穹', '观棋')
        entry = self._resolve_entry(cli, '万古仙穹', '万古仙穹')
        rec = self._run_main_and_read_record(entry, cli)
        self.assertEqual(rec['author'], '观棋')
        self.assertEqual(rec['author_source'], 'engine_toc')


class TestContentMatchAuditPassthrough(unittest.TestCase):
    """authcv41：内容比对救回条目的审计链——labels.jsonl 记录透传 content_match 诊断详情，
    且 toc 作者回写不得把 author_source 从 content_match 覆盖成 engine_toc（另记 toc 回写发生过）。
    非救回条目不带这些字段。全走主循环真实路径，不直接给 b_out 组装传参。"""

    def _cli(self, toc_title, toc_author):
        def handler(sub, url):
            if sub == 'toc':
                return _proc(0, json.dumps(
                    {'source': labeler._url_host(url), 'title': toc_title, 'author': toc_author,
                     'chapters': [{'title': '第一章', 'url': url + '/c1'}]}, ensure_ascii=False))
            return _content('正' * 11000)
        return FakeEngineCli(handler)

    def _base_entry(self, author=''):
        return {'url': 'https://src.example.com/b/x', 'title': '万古仙穹',
                'list_title': '万古仙穹', 'author': author, 'category': '17K完本',
                'status': '', 'douban_url': '', 'engine': True,
                'source_host': 'src.example.com'}

    def _run_main_and_read_record(self, entry, cli):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')
        labels = {'title_guess': entry['title'], 'site_title_match': True, 'text_quality': '正常'}
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(d)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=lambda *a, **k: [dict(entry)]), \
                mock.patch.object(labeler, '_build_engine_cli', return_value=cli), \
                mock.patch.object(labeler, 'label_book', return_value=(labels, 1)), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            labeler.main()
        return json.loads((d / 'labels.jsonl').read_text(encoding='utf-8').splitlines()[0])

    def test_rescued_entry_passes_through_details_and_keeps_marker(self):
        # 救回条目（作者空、toc 回写补作者）：content_match 详情原样透传，author_source 保持
        # content_match 不被 engine_toc 覆盖，另记 toc_author_writeback。
        entry = self._base_entry(author='')
        entry['author_source'] = 'content_match'
        entry['content_match'] = {'toc': 0.91, 'body_pairs': 3, 'basis': 'toc+body'}
        rec = self._run_main_and_read_record(entry, self._cli('万古仙穹', '观棋'))
        self.assertEqual(rec['author'], '观棋')                       # toc 回写仍补上作者串
        self.assertEqual(rec['author_source'], 'content_match')       # 标记不被覆盖
        self.assertEqual(rec['content_match'],
                         {'toc': 0.91, 'body_pairs': 3, 'basis': 'toc+body'})
        self.assertTrue(rec['toc_author_writeback'])

    def test_rescued_entry_with_author_needs_no_writeback(self):
        # 救回条目名单已带作者 → 不触发 toc 回写：content_match 照样透传，author_source 仍是
        # content_match，无 toc_author_writeback。（toc 作者取与名单一致以过 N02 身份校验）
        entry = self._base_entry(author='原作者')
        entry['author_source'] = 'content_match'
        entry['content_match'] = {'toc': 0.88, 'body_pairs': 2, 'basis': 'toc+body'}
        rec = self._run_main_and_read_record(entry, self._cli('万古仙穹', '原作者'))
        self.assertEqual(rec['author'], '原作者')
        self.assertEqual(rec['author_source'], 'content_match')
        self.assertEqual(rec['content_match'],
                         {'toc': 0.88, 'body_pairs': 2, 'basis': 'toc+body'})
        self.assertNotIn('toc_author_writeback', rec)

    def test_non_rescued_entry_has_no_audit_fields(self):
        # 非救回条目（普通 engine_toc 回写）：不带 content_match / toc_author_writeback。
        entry = self._base_entry(author='')
        rec = self._run_main_and_read_record(entry, self._cli('万古仙穹', '观棋'))
        self.assertEqual(rec['author_source'], 'engine_toc')
        self.assertNotIn('content_match', rec)
        self.assertNotIn('toc_author_writeback', rec)


class TestServerErrorGiveup(unittest.TestCase):
    """giveuprev41：重试后仍 5xx 的章用更长的连续阈值（默认 8）放弃；超时仍不参与。"""

    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_constant(self):
        self.assertEqual(labeler.SERVER_ERROR_GIVEUP_STREAK, 8)
        self.assertGreater(labeler.SERVER_ERROR_GIVEUP_STREAK, labeler.SOURCE_GIVEUP_STREAK)

    def test_whole_site_502_gives_up_at_8th_chapter(self):
        # 反例：改前整站 502 → 30 章 × CHUNK_RETRY 全打满；改后第 8 章（c7）放弃
        cli = FakeEngineCli(lambda sub, url: _toc_on('h.example', 30) if sub == 'toc'
                            else _kind('http_5xx'))
        with self.assertRaises(labeler.EngineSourceGaveUp) as ctx:
            labeler.fetch_book_text_engine(cli, 'https://h.example/b')
        self.assertEqual(ctx.exception.kind, 'http_5xx')
        self.assertEqual(_content_calls(cli)[-1], ('content', 'https://h.example/c7'))
        # 5xx 章照旧重试（抖动类仍给重试机会）：8 章 × CHUNK_RETRY 次
        self.assertEqual(len(_content_calls(cli)), 8 * labeler.CHUNK_RETRY)

    def test_5xx_does_not_use_the_shorter_deterministic_streak(self):
        # 7 连 5xx 后成功一章：确定性阈值 5 不适用于 5xx → 不放弃
        good = '正' * 200

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 8)
            return _content(good) if url.endswith('/c7') else _kind('http_5xx')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b')
        self.assertEqual(chars, len(good))

    def test_success_between_5xx_resets(self):
        # 每 7 章 5xx 夹 1 章成功：永远到不了 8 连
        good = '正' * 200

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 32)
            return _content(good) if int(url.rsplit('c', 1)[1]) % 8 == 7 else _kind('http_5xx')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b')
        self.assertEqual(chars, 4 * len(good))

    def test_timeout_never_triggers_even_past_8(self):
        cli = FakeEngineCli(lambda sub, url: _toc_on('h.example', 20) if sub == 'toc'
                            else _kind('timeout'))
        text, chars = labeler.fetch_book_text_engine(cli, 'https://h.example/b')
        self.assertEqual(chars, 0)
        self.assertEqual(len(_content_calls(cli)), 20 * labeler.CHUNK_RETRY)

    def test_timeout_chapter_between_5xx_resets(self):
        # 7 章 5xx + 1 章超时 + 7 章 5xx：超时章不计入且打断连续 → 不放弃
        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 15)
            return _kind('timeout') if url.endswith('/c7') else _kind('http_5xx')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b')
        self.assertEqual(chars, 0)

    def test_chapter_counts_only_if_final_attempt_is_5xx(self):
        # 每章前几次 5xx、最后一次超时 → 该章不算 5xx 章，永不放弃
        attempts = {}

        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 12)
            attempts[url] = attempts.get(url, 0) + 1
            return _kind('timeout') if attempts[url] == labeler.CHUNK_RETRY else _kind('http_5xx')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b')
        self.assertEqual(chars, 0)

    def test_5xx_and_policy_do_not_add_up(self):
        def handler(sub, url):
            if sub == 'toc':
                return _toc_on('h.example', 20)
            return _kind('policy' if int(url.rsplit('c', 1)[1]) % 2 else 'http_5xx')

        text, chars = labeler.fetch_book_text_engine(FakeEngineCli(handler), 'https://h.example/b')
        self.assertEqual(chars, 0)


class TestDeadHostSkipKind(unittest.TestCase):
    def test_all_options_on_dead_hosts_uses_dedicated_kind(self):
        tracker = labeler.SourceGiveupTracker(2)
        tracker.dead.update({'www.bqquge.org', 'www.yingsx.com'})
        cli = _multi_host_cli(set())
        with contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(labeler.EngineSourceGaveUp) as ctx:
            labeler.fetch_engine_book_with_giveup(cli, _book(alternates=[ALT]), tracker)
        self.assertEqual(ctx.exception.kind, labeler.DEAD_HOST_SKIP_KIND)
        self.assertNotIn(labeler.DEAD_HOST_SKIP_KIND, labeler.DETERMINISTIC_ENGINE_ERRORS)
        self.assertEqual(cli.calls, [])
        self.assertEqual(labeler.classify_failure(ctx.exception), '源失效放弃')


if __name__ == '__main__':
    unittest.main(verbosity=2)
