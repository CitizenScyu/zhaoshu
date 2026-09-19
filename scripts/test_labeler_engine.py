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
        cli = labeler._build_engine_cli(env)
        self.assertIsNotNone(cli)
        self.assertEqual(cli.node, '/usr/bin/node')
        self.assertEqual(cli.script_path, '/repo/scripts/engine-fetch.mjs')



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
                       engine_cli=None):
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
                       engine_cli=None):
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
