#!/usr/bin/env python3
"""付费墙只源不打标（paywall1104）单测。

背景（2026-11-04 生产实测）：6373 条打标里 book.qq.com 2502、yunqi.qq.com 2251；下载机全局排除
PAYWALL_HOSTS、全池无免费镜像，这些书打完标永远下不到全本、进不了书库。
覆盖：
- PAYWALL_HOSTS 与下载侧 src/lib/source-host-health.ts 逐字一致；降权集合即付费墙集合。
- 主源 + 备选全是付费墙 ⇒ 不入队、记引擎 miss 记忆、轮末汇总带计数。
- 有任一免费源 ⇒ 照常入队且主源取免费源；book.qq.com 现在同样降权。
- LABELER_PAYWALL_SKIP=0 关闭时行为与改前一致（付费墙书照常入队）。
全离线：不联网、不起进程。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_paywall1104.py
"""
import contextlib
import io
import json
import os
import re
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import douban_list as dl  # noqa: E402
import labeler_source_policy as sp  # noqa: E402

TS_SOURCE = Path(__file__).resolve().parent.parent / 'src' / 'lib' / 'source-host-health.ts'


class HostsCli:
    """引擎 search 返回给定 host 列表的同名同作者候选（合成数据）。"""

    def __init__(self, hosts):
        self.hosts = hosts
        self.calls = []

    def run(self, command, *args):
        self.calls.append((command, args))
        title = args[args.index('--title') + 1]
        return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps([
            {'title': title, 'author': '甲作者', 'source': host,
             'bookUrl': f'https://{host}/book/{i}'} for i, host in enumerate(self.hosts, 1)
        ]))


class PaywallSkipTest(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        stack.enter_context(mock.patch('urllib.request.urlopen', side_effect=AssertionError('real HTTP forbidden')))
        stack.enter_context(mock.patch('subprocess.run', side_effect=AssertionError('real subprocess forbidden')))
        stack.enter_context(mock.patch.object(dl.time, 'sleep', lambda _seconds: None))
        self.out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.http = mock.Mock(side_effect=AssertionError('retired HTTP must not be called'))
        self.policy = sp.SourcePolicy(builtin_disabled=sp.RETIRED_HOSTS)

    def resolve(self, hosts, memo=None):
        cli = HostsCli(hosts)
        queue = dl._resolve_candidates([{'title': '合成书', 'author': '甲作者'}], self.http,
                                       done_index={}, engine_cli=cli, source_policy=self.policy,
                                       engine_miss=memo)
        self.assertEqual(len(cli.calls), 1)
        return queue

    def test_hosts_match_download_side(self):
        text = TS_SOURCE.read_text(encoding='utf-8')
        block = re.search(r'PAYWALL_HOSTS[^=]*=\s*\[(.*?)\]', text, re.S)
        self.assertIsNotNone(block)
        self.assertEqual(set(re.findall(r"'([^']+)'", block.group(1))), set(dl.PAYWALL_HOSTS))
        self.assertEqual(dl.DEPRIORITIZED_SOURCE_HOSTS, dl.PAYWALL_HOSTS)

    def test_paywall_only_hit_is_not_queued_and_is_remembered(self):
        memo = mock.Mock()
        memo.recent.return_value = False
        self.assertEqual(self.resolve(['book.qq.com', 'yunqi.qq.com'], memo), [])
        memo.record.assert_called_once_with('合成书', '甲作者')
        self.assertIn('只有付费墙源', self.out.getvalue())
        self.assertIn('1 本只有付费墙源，未打标', self.out.getvalue())

    def test_any_free_source_keeps_the_book_and_becomes_primary(self):
        queue = self.resolve(['book.qq.com', 'free.example'])
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]['source_host'], 'free.example')
        self.assertEqual([a['source'] for a in queue[0]['engine_alternates']], ['book.qq.com'])

    def test_switch_off_restores_old_behaviour(self):
        with mock.patch.dict(os.environ, {dl.PAYWALL_SKIP_ENV: '0'}):
            queue = self.resolve(['book.qq.com'])
        self.assertEqual([e['source_host'] for e in queue], ['book.qq.com'])
        self.assertNotIn('只有付费墙源', self.out.getvalue())

    def test_is_paywall_only_unit(self):
        self.assertTrue(dl.is_paywall_only({'source': 'BOOK.QQ.COM'}))
        self.assertTrue(dl.is_paywall_only({'source': '', 'url': 'https://ubook.reader.qq.com/x'}))
        self.assertFalse(dl.is_paywall_only({'source': 'yunqi.qq.com',
                                             'alternates': [{'source': 'free.example'}]}))
        self.assertFalse(dl.is_paywall_only({'source': 'x.book.qq.com'}))


if __name__ == '__main__':
    unittest.main()
