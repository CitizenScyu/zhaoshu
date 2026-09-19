#!/usr/bin/env python3
"""labeler.py 引擎源取正文（T5）单测。

覆盖 fetch_book_text_engine：CLI toc → 逐章 content → 拼接（不过 clean_chapter_text）；
target_chars 截断；单章失败隔离；toc 失败抛错交主循环计失败；引擎正文逐字保留。
全离线：不联网、不真调 CLI、不调 LLM。mock 引擎 CLI（返回 CompletedProcess-like）。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_engine.py'
"""
import json
import os
import sys
import types
import unittest
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
