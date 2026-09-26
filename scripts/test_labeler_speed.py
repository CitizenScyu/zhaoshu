#!/usr/bin/env python3
"""lblspeed41：引擎取文提前止损 + 死源跨轮记忆 单测。

覆盖：
  * resolve_engine_target_chars：默认值、覆盖、坏值回落、质量门下限夹取；
  * fetch_book_text_engine / fetch_engine_book_with_giveup 默认按新上限截断（不再抓满全书）；
    显式传 TARGET_CHARS 仍是旧行为（回退路径）；
  * DeadHostMemory：写入 / 读取 / 过期 / 损坏降级 / ttl<=0 关闸 / 写失败不外抛；
  * 主循环接线：侧车里的死源本轮零请求；本轮新判死的 host 立即落盘（不等轮末）。

全离线：不联网、不真调 CLI、不调 LLM、不读 .env 原文（.env 在本用例里是自造的假值）。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_speed.py'
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
        self.handler = handler
        self.calls = []

    def run(self, subcommand, *args):
        url = args[1] if len(args) >= 2 and args[0] == '--url' else None
        self.calls.append((subcommand, url))
        return self.handler(subcommand, url)


def _toc(host, n, body_chars):
    return _proc(0, json.dumps({'source': host, 'title': '斗罗大陆III龙王传说', 'author': '唐家三少',
                                'chapters': [{'title': f'第{i}章', 'url': f'https://{host}/c{i}'}
                                             for i in range(n)]}, ensure_ascii=False))


def _content(body):
    return _proc(0, json.dumps({'source': 'www.yingsx.com', 'url': 'x', 'text': body},
                               ensure_ascii=False))


def _content_calls(cli):
    return [c for c in cli.calls if c[0] == 'content']


BODY = '正' * 3000          # 3000 字/章

# 每章正文必须**各不相同**：prepare_book_text 会跨章去掉重复的长行（DEDUPE_MIN_LINE=20），
# 用同一段正文会在本地预检里被当「大面积重复」去光（实测 8 章全同 → 只剩 3000 字被拒收）。
def _chapter_body(i: int, n: int = 3000) -> str:
    """第 i 章正文，**恰好 n 字**且各章不同（防跨章去重把样本抽干）。"""
    head, tail = f'第{i}章正文起', f'终{i:06d}'
    return head + '正' * (n - len(head) - len(tail)) + tail


def _realistic_cli(host='www.yingsx.com', chapters=40, per=3000, fail_kind=None):
    """每章正文各不相同的引擎桩（贴近真实抓取：章与章文本不同）。"""
    def handler(sub, url):
        if sub == 'toc':
            return _toc(host, chapters, per)
        if fail_kind is not None:
            return _proc(1, '', f'x\n{{"errorKind": "{fail_kind}"}}\n')
        idx = int(url.rsplit('/c', 1)[1])
        return _content(_chapter_body(idx, per))
    return FakeEngineCli(handler)


# ---------------- 取文止损：默认上限与下限 ----------------
class TestEngineTargetChars(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_default_is_80k_and_at_most_one_segment(self):
        """新默认 = 80000，且 ≤ SEGMENT_CHARS ⇒ label_book 走单段（每本 1 次调用）。"""
        self.assertEqual(labeler.ENGINE_TARGET_CHARS, 80_000)
        self.assertLessEqual(labeler.ENGINE_TARGET_CHARS, labeler.SEGMENT_CHARS)
        self.assertEqual(labeler.MIN_ENGINE_TARGET_CHARS, labeler.PRECHECK_MIN_CHARS)

    def test_engine_default_does_not_fetch_whole_book(self):
        """默认抓 40 章 × 3000 字 = 12 万字，应在 27 章（81000 字）处停，不再抓满。"""
        cli = _realistic_cli(chapters=40, per=3000)
        text, chars = labeler.fetch_book_text_engine(cli, 'https://h.example/b')
        self.assertEqual(len(_content_calls(cli)), 27)
        self.assertEqual(chars, 27 * 3000)

    def test_explicit_old_value_restores_full_fetch(self):
        """回退路径：显式传 TARGET_CHARS（旧值）→ 抓满全部 40 章。"""
        cli = _realistic_cli(chapters=40, per=3000)
        text, chars = labeler.fetch_book_text_engine(cli, 'https://h.example/b',
                                                     target_chars=labeler.TARGET_CHARS)
        self.assertEqual(len(_content_calls(cli)), 40)
        self.assertEqual(chars, 40 * 3000)

    def test_with_giveup_passes_target_chars_through(self):
        """fetch_engine_book_with_giveup 也要把 target_chars 透传给取文（否则换源路径会抓满全书）。"""
        cli = _realistic_cli(chapters=40, per=3000)
        book = {'url': 'https://www.yingsx.com/b/1', 'title': '斗罗大陆III龙王传说',
                'author': '唐家三少', 'engine': True, 'source_host': 'www.yingsx.com'}
        text, chars, used = labeler.fetch_engine_book_with_giveup(
            cli, book, labeler.SourceGiveupTracker(2), giveup_streak=5)
        self.assertEqual(len(_content_calls(cli)), 27)
        self.assertEqual(chars, 27 * 3000)

    def test_resolve_default_override_and_bad_values(self):
        self.assertEqual(labeler.resolve_engine_target_chars({}), labeler.ENGINE_TARGET_CHARS)
        self.assertEqual(labeler.resolve_engine_target_chars(None), labeler.ENGINE_TARGET_CHARS)
        # 覆盖 = 回退旧行为
        self.assertEqual(labeler.resolve_engine_target_chars(
            {'LABELER_ENGINE_TARGET_CHARS': '500000'}), 500_000)
        # 坏值（非数字 / 0 / 负数）→ 回落默认，不抛
        for bad in ('abc', '0', '-1', '  '):
            with self.subTest(bad=bad):
                self.assertEqual(labeler.resolve_engine_target_chars(
                    {'LABELER_ENGINE_TARGET_CHARS': bad}), labeler.ENGINE_TARGET_CHARS)

    def test_resolve_clamps_below_quality_gate_floor(self):
        """低于质量门下限的配置被夹到下限——低于 10000 会把健康书按「字数不足」拒收。"""
        self.assertEqual(labeler.resolve_engine_target_chars(
            {'LABELER_ENGINE_TARGET_CHARS': '3000'}), labeler.MIN_ENGINE_TARGET_CHARS)
        self.assertEqual(labeler.MIN_ENGINE_TARGET_CHARS, 10_000)
        # 恰好等于下限：不再夹（不误报）
        self.assertEqual(labeler.resolve_engine_target_chars(
            {'LABELER_ENGINE_TARGET_CHARS': '10000'}), 10_000)


# ---------------- 死源跨轮记忆：侧车文件 ----------------
class TestDeadHostMemory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / labeler.DEAD_HOSTS_FILENAME

    def test_defaults(self):
        self.assertEqual(labeler.DEAD_HOST_TTL_SEC, 6 * 3600)
        self.assertEqual(labeler.DEAD_HOSTS_FILENAME, 'labels-dead-hosts.json')
        self.assertEqual(labeler.resolve_dead_host_ttl({}), labeler.DEAD_HOST_TTL_SEC)
        self.assertEqual(labeler.resolve_dead_host_ttl({'LABELER_DEAD_HOST_TTL_SEC': '0'}), 0)
        self.assertEqual(labeler.resolve_dead_host_ttl({'LABELER_DEAD_HOST_TTL_SEC': 'abc'}),
                         labeler.DEAD_HOST_TTL_SEC)

    def test_write_then_load_roundtrip(self):
        now = 1_000_000.0
        mem = labeler.DeadHostMemory(self.path, labeler.DEAD_HOST_TTL_SEC)
        mem.add('www.bqquge.org', now=now)
        mem.save()
        payload = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(payload['version'], 1)
        self.assertEqual(payload['hosts'], {'www.bqquge.org': now})
        # 读回：未过期条目保留
        back = labeler.DeadHostMemory.load(self.path, ttl_sec=labeler.DEAD_HOST_TTL_SEC,
                                           now=now + 60)
        self.assertEqual(back.dead_hosts(now=now + 60), {'www.bqquge.org'})

    def test_expired_entries_dropped_on_load(self):
        """过期自动重新尝试：超过有效期的 host 不再进 dead，且净化后的文件落盘。"""
        now = 1_000_000.0
        mem = labeler.DeadHostMemory(self.path, 3600)
        mem.add('old-host.example', now=now)
        mem.save()
        later = now + 3601
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            back = labeler.DeadHostMemory.load(self.path, ttl_sec=3600, now=later)
        self.assertEqual(back.dead_hosts(now=later), set())
        self.assertEqual(back.hosts, {})
        self.assertIn('已过期', err.getvalue())
        # 净化后的文件里没有过期条目
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8'))['hosts'], {})

    def test_missing_file_is_empty_memory(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            mem = labeler.DeadHostMemory.load(self.path, ttl_sec=3600, now=1.0)
        self.assertEqual(mem.dead_hosts(now=1.0), set())
        self.assertEqual(err.getvalue(), '')      # 文件不存在不是「读失败」，不打告警

    def test_corrupt_file_degrades_silently(self):
        """损坏文件 → 空记忆（不跨轮），不抛异常。"""
        self.path.write_text('{ this is not json', encoding='utf-8')
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            mem = labeler.DeadHostMemory.load(self.path, ttl_sec=3600, now=1.0)
        self.assertEqual(mem.dead_hosts(now=1.0), set())
        self.assertIn('死源侧车读取失败', err.getvalue())

    def test_wrong_shape_degrades_silently(self):
        for bad in ('{"version": 1, "hosts": [1,2]}', '{"hosts": null}', 'null', '[1,2]'):
            with self.subTest(bad=bad):
                self.path.write_text(bad, encoding='utf-8')
                with contextlib.redirect_stderr(io.StringIO()):
                    mem = labeler.DeadHostMemory.load(self.path, ttl_sec=3600, now=1.0)
                self.assertEqual(mem.dead_hosts(now=1.0), set())

    def test_non_numeric_timestamps_ignored(self):
        self.path.write_text(json.dumps({'version': 1, 'hosts': {
            'good.example': 100.0, 'bad.example': 'yesterday'}}), encoding='utf-8')
        mem = labeler.DeadHostMemory.load(self.path, ttl_sec=3600, now=200.0)
        self.assertEqual(mem.dead_hosts(now=200.0), {'good.example'})

    def test_ttl_zero_disables_read_and_write(self):
        """关闸：ttl<=0 时不读也不写（与改前行为一致）。"""
        self.path.write_text(json.dumps({'version': 1, 'hosts': {'x.example': 1.0}}),
                             encoding='utf-8')
        mem = labeler.DeadHostMemory.load(self.path, ttl_sec=0, now=1.0)
        self.assertEqual(mem.dead_hosts(now=1.0), set())
        mem.add('y.example', now=1.0)
        mem.save()
        # 文件未被本对象改写
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8'))['hosts'],
                         {'x.example': 1.0})

    def test_save_failure_does_not_raise(self):
        """写失败（目录不可写）只告警、不外抛——跨轮记忆是优化，不能拖垮整轮。"""
        mem = labeler.DeadHostMemory(self.path, 3600)
        mem.add('x.example', now=1.0)
        err = io.StringIO()
        with mock.patch.object(labeler.os, 'replace', side_effect=OSError('disk full')), \
                contextlib.redirect_stderr(err):
            mem.save()                            # 不应抛
        self.assertIn('死源侧车写入失败', err.getvalue())
        # 临时文件不残留（异常路径要清掉）
        leftovers = [p.name for p in Path(self.tmp.name).iterdir() if p.name.startswith('.dead-hosts-')]
        self.assertEqual(leftovers, [])

    def test_save_is_atomic_replace(self):
        """写入走 os.replace（临时文件 + 原子替换），不留半截文件。"""
        mem = labeler.DeadHostMemory(self.path, 3600)
        mem.add('x.example', now=1.0)
        with mock.patch.object(labeler.os, 'replace', wraps=os.replace) as replace:
            mem.save()
        self.assertEqual(replace.call_count, 1)


class TestTrackerOnDeadCallback(unittest.TestCase):
    def test_callback_fires_once_per_host(self):
        fired = []
        tracker = labeler.SourceGiveupTracker(2, on_dead=fired.append)
        tracker.record('a.example')
        self.assertEqual(fired, [])               # 未达阈值
        tracker.record('a.example')
        tracker.record('a.example')               # 已在 dead，不再回调
        self.assertEqual(fired, ['a.example'])

    def test_preseeded_dead_hosts_do_not_fire_callback(self):
        fired = []
        tracker = labeler.SourceGiveupTracker(2, dead={'a.example'}, on_dead=fired.append)
        self.assertEqual(tracker.dead, {'a.example'})

    def test_callback_exception_is_swallowed(self):
        def boom(host):
            raise OSError('no write')
        tracker = labeler.SourceGiveupTracker(1, on_dead=boom)
        with contextlib.redirect_stderr(io.StringIO()):
            tracker.record('a.example')           # 不应抛
        self.assertEqual(tracker.dead, {'a.example'})


# ---------------- 主循环接线 ----------------
class MainHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')

    def run_main(self, books, cli, argv=None):
        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [dict(b) for b in books]
        labels = {'title_guess': '斗罗大陆III龙王传说', 'site_title_match': True,
                  'text_quality': '正常', 'confidence': 0.9}
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, '_build_engine_cli', return_value=cli), \
                mock.patch.object(labeler, 'label_book', return_value=(labels, 1)), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv', argv or
                                  ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        return code, out.getvalue(), err.getvalue()

    def _book(self, host, n=1):
        return {'url': f'https://{host}/b/{n}', 'title': '斗罗大陆III龙王传说',
                'author': '唐家三少', 'engine': True, 'source_host': host}


class TestMainRecallsDeadHosts(MainHarness):
    """侧车里的死源本轮零请求；本轮新判死的 host 立即落盘（不等轮末）。"""

    def _cli(self, dead_hosts):
        def handler(sub, url):
            host = labeler._url_host(url)
            if sub == 'toc':
                return _toc(host, 30, 3000)
            if host in dead_hosts:
                return _proc(1, '', 'x\n{"errorKind": "policy"}\n')
            return _content(_chapter_body(int(url.rsplit('/c', 1)[1])))
        return FakeEngineCli(handler)

    def test_remembered_dead_host_costs_zero_requests(self):
        """侧车里的 host 已在有效期内 → 本轮一个请求都不发。"""
        path = self.dir / labeler.DEAD_HOSTS_FILENAME
        mem = labeler.DeadHostMemory(path, labeler.DEAD_HOST_TTL_SEC)
        mem.add('www.bqquge.org', now=labeler.time.time())
        mem.save()
        cli = self._cli({'www.bqquge.org'})
        code, out, err = self.run_main([self._book('www.bqquge.org')], cli)
        self.assertEqual(cli.calls, [])                       # toc/content 都没发
        self.assertIn('死源跨轮记忆: 1 个 host', out)

    def test_newly_dead_host_is_persisted_immediately(self):
        """本轮两次放弃 → host 判死，立刻写侧车（不等轮末）。"""
        cli = self._cli({'www.bqquge.org'})
        code, out, err = self.run_main(
            [self._book('www.bqquge.org', 1), self._book('www.bqquge.org', 2)], cli)
        self.assertEqual(code, 2)                             # 整轮零成功
        sidecar = self.dir / labeler.DEAD_HOSTS_FILENAME
        self.assertTrue(sidecar.exists())
        hosts = json.loads(sidecar.read_text(encoding='utf-8'))['hosts']
        self.assertIn('www.bqquge.org', hosts)

    def test_second_round_skips_remembered_host(self):
        """跨轮闭环：第一轮判死落盘 → 第二轮（同一数据目录）不再发请求。"""
        cli = self._cli({'www.bqquge.org'})
        self.run_main([self._book('www.bqquge.org', 1), self._book('www.bqquge.org', 2)], cli)
        cli2 = self._cli({'www.bqquge.org'})
        code, out, err = self.run_main([self._book('www.bqquge.org', 3)], cli2)
        self.assertEqual(cli2.calls, [])
        self.assertIn('死源跨轮记忆: 1 个 host', out)

    def test_expired_sidecar_retries_the_host(self):
        """侧车过期 → 该 host 重新被尝试（不再是零请求）。"""
        path = self.dir / labeler.DEAD_HOSTS_FILENAME
        mem = labeler.DeadHostMemory(path, 3600)
        # 比默认 6h 有效期更早判死 → 已过期，本轮应重新尝试
        mem.add('www.yingsx.com', now=labeler.time.time() - labeler.DEAD_HOST_TTL_SEC - 60)
        mem.save()
        cli = self._cli(set())                                      # 现在站点恢复正常
        code, out, err = self.run_main([self._book('www.yingsx.com')], cli)
        self.assertEqual(code, 0)
        self.assertTrue(any(c[0] == 'toc' for c in cli.calls))
        self.assertIn('已过期', err)

    def test_corrupt_sidecar_does_not_break_round(self):
        """损坏侧车 → 降级为不跨轮，整轮照常跑完。"""
        (self.dir / labeler.DEAD_HOSTS_FILENAME).write_text('not json', encoding='utf-8')
        cli = self._cli(set())
        code, out, err = self.run_main([self._book('www.yingsx.com')], cli)
        self.assertEqual(code, 0)
        rec = json.loads((self.dir / 'labels.jsonl').read_text(
            encoding='utf-8').splitlines()[0])
        self.assertEqual(rec['chars'], 27 * 3000)     # 默认 8 万字止损（30 章→27 章）
        self.assertIn('死源侧车读取失败', err)

    def test_ttl_zero_disables_cross_round_memory(self):
        """关闸：LABELER_DEAD_HOST_TTL_SEC=0 → 不读侧车（即使里面有记录也照发请求）。"""
        path = self.dir / labeler.DEAD_HOSTS_FILENAME
        mem = labeler.DeadHostMemory(path, labeler.DEAD_HOST_TTL_SEC)
        mem.add('www.bqquge.org', now=labeler.time.time())
        mem.save()
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n'
                                       'LABELER_DEAD_HOST_TTL_SEC=0\n', encoding='utf-8')
        cli = self._cli({'www.bqquge.org'})
        code, out, err = self.run_main([self._book('www.bqquge.org')], cli)
        self.assertTrue(any(c[0] == 'toc' for c in cli.calls))   # 照常发请求
        self.assertIn('死源跨轮记忆: 关闭', out)


class TestMainUsesEngineTargetChars(MainHarness):
    def test_env_override_reaches_the_fetch(self):
        """LABELER_ENGINE_TARGET_CHARS=25000 → 主循环把 25000 透传到取文（抓 9 章 × 3000）。"""
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n'
                                       'LABELER_ENGINE_TARGET_CHARS=25000\n', encoding='utf-8')
        cli = _realistic_cli(chapters=40, per=3000)
        code, out, err = self.run_main([self._book('www.yingsx.com')], cli)
        self.assertEqual(len(_content_calls(cli)), 9)            # 3000×8=24000<25000，第 9 章后停
        self.assertEqual(code, 0)
        rec = json.loads((self.dir / 'labels.jsonl').read_text(encoding='utf-8').splitlines()[0])
        self.assertEqual(rec['chars'], 27000)

    def test_low_env_value_clamped_to_floor(self):
        """低于下限的配置被夹到 10000，健康书（各章不同、共 3 万字）不被误拒。"""
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n'
                                       'LABELER_ENGINE_TARGET_CHARS=3000\n', encoding='utf-8')
        cli = _realistic_cli(chapters=40, per=3000)
        code, out, err = self.run_main([self._book('www.yingsx.com')], cli)
        self.assertEqual(code, 0)
        self.assertIn('已夹到下限', err)


if __name__ == '__main__':
    unittest.main(verbosity=2)
