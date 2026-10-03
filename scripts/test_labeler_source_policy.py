#!/usr/bin/env python3
"""统一源策略（labeler_source_policy.SourcePolicy）单测（617）。

钉住的契约（任务书 §1–§3 / 主协调裁定）：
  * book15 默认停用（builtin_disabled 装配后 is_disabled 恒真；HTTP 成功不复活）；
    LABELER_BOOK15_ENABLED=1 恢复（resolve_book15_enabled 只认 '1'）。
  * 停用与临时失败分开：blocked = 停用 ∪ 冷却；停用不自动恢复；冷却到期有限恢复。
  * 冷却跨轮复用 DeadHostMemory（dead_host_sink/dead_hosts_reader 注入）：新实例
    （= 新一轮进程）经 reader 仍拦截；TTL 过期自动放行；再失败再进冷却。
  * 正常 miss / 取消 / 预算结束不记 failure（record_success 清计数，miss 不封站）。
  * 状态文件：原子写、坏文件安全降级为空态不崩、条目上限、enable/disable 往返。
  * env 清单解析：合法 host 保留、垃圾项跳过、保序去重。

全离线：不联网、不读 .env、临时目录、假时钟。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -t scripts -p 'test_labeler_source_policy.py'
"""
import contextlib
import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402
import labeler_source_policy as sp  # noqa: E402


class _FakeClock:
    """假时钟：set() 推进、now() 读取（离线单测，不真等时间）。"""

    def __init__(self, start=0.0):
        self._t = float(start)

    def set(self, t):
        self._t = float(t)

    def now(self):
        return self._t


class MemDeadHosts:
    """DeadHostMemory 的最小替身：同一套 add/dead_hosts(now) 语义，内存版（离线单测用）。
    now_fn 注入当前时刻（测试用假时钟）；reader() 按该时刻判 TTL。"""

    def __init__(self, ttl_sec=3600, hosts=None, now_fn=None):
        self.ttl_sec = ttl_sec
        self.hosts = dict(hosts or {})
        self.now_fn = now_fn or time.time

    def sink(self, host, now):
        self.hosts[host] = now

    def reader(self):
        return self.dead_at(self.now_fn())

    def dead_at(self, now):
        return {h for h, t in self.hosts.items() if now - t < self.ttl_sec}


def make_policy(tmpdir, builtin=(), ttl=3600, threshold=sp.COOLDOWN_FAIL_THRESHOLD,
                mem=None, clock=None, extra=(), mem_now=None):
    mem = mem if mem is not None else MemDeadHosts(ttl_sec=ttl, now_fn=mem_now or clock or time.time)
    pol = sp.SourcePolicy(base_dir=tmpdir, builtin_disabled=builtin,
                          extra_disabled=extra, cooldown_ttl=ttl, threshold=threshold,
                          dead_host_sink=mem.sink, dead_hosts_reader=mem.reader,
                          clock=clock)
    return pol, mem


class TestDisabledVsCooldown(unittest.TestCase):
    """停用（持久、不自动复活）与冷却（有界、有限恢复）是两类状态。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_book15_default_disabled_and_no_auto_revive(self):
        pol, _ = make_policy(self.tmp.name, builtin=sp.BOOK15_HOSTS)
        for h in sp.BOOK15_HOSTS:
            self.assertTrue(pol.is_disabled(h))
        # 拿到成功响应也不复活（record_success 只清冷却）
        pol.record_success(sp.BOOK15_HOST)
        self.assertTrue(pol.is_disabled(sp.BOOK15_HOST))
        # 冷却到期也不复活
        pol2, _ = make_policy(self.tmp.name, builtin=sp.BOOK15_HOSTS)
        pol2.record_failure(sp.BOOK15_HOST, 'net', now=1.0)
        self.assertTrue(pol2.is_disabled(sp.BOOK15_HOST))

    def test_book15_enabled_via_env_only(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sp.BOOK15_ENABLED_ENV, None)
            self.assertFalse(sp.resolve_book15_enabled({}))
            self.assertFalse(sp.resolve_book15_enabled({sp.BOOK15_ENABLED_ENV: '0'}))
            self.assertFalse(sp.resolve_book15_enabled({sp.BOOK15_ENABLED_ENV: 'true'}))
            self.assertTrue(sp.resolve_book15_enabled({sp.BOOK15_ENABLED_ENV: '1'}))
            os.environ[sp.BOOK15_ENABLED_ENV] = '1'
            self.assertTrue(sp.resolve_book15_enabled({}))
            os.environ.pop(sp.BOOK15_ENABLED_ENV, None)

    def test_disable_and_enable_roundtrip(self):
        pol, _ = make_policy(self.tmp.name)
        h = 'bad.example'
        self.assertFalse(pol.is_disabled(h))
        self.assertTrue(pol.disable(h, 'ops', now=100.0))
        self.assertTrue(pol.is_disabled(h))
        # 新实例（新进程）仍停用：持久性来自状态文件
        pol2, _ = make_policy(self.tmp.name)
        self.assertTrue(pol2.is_disabled(h))
        self.assertTrue(pol2.enable(h))
        self.assertFalse(pol2.is_disabled(h))
        pol3, _ = make_policy(self.tmp.name)
        self.assertFalse(pol3.is_disabled(h))
        # 幂等：重复 disable/enable 不炸
        self.assertFalse(pol3.enable(h))

    def test_builtin_cannot_be_disabled_twice_or_enabled(self):
        pol, _ = make_policy(self.tmp.name, builtin=sp.BOOK15_HOSTS)
        self.assertFalse(pol.disable(sp.BOOK15_HOST, 'dup'))   # 已 builtin 覆盖
        self.assertFalse(pol.enable(sp.BOOK15_HOST))           # 恢复只能走 env

    def test_disabled_file_persisted_shape(self):
        pol, _ = make_policy(self.tmp.name)
        pol.disable('x.example', 'ops', now=42.0)
        raw = (Path(self.tmp.name) / sp.DISABLED_FILENAME).read_text(encoding='utf-8')
        self.assertIn('"version"', raw)
        self.assertIn('x.example', raw)
        self.assertNotIn('secret', raw)

    def test_bad_disabled_file_degrades_to_empty(self):
        p = Path(self.tmp.name) / sp.DISABLED_FILENAME
        p.write_text('{not json!!', encoding='utf-8')
        with contextlib.redirect_stderr(io.StringIO()):
            pol, _ = make_policy(self.tmp.name)
            pol.disable('fresh.example', 'ops', now=1.0)   # 读取降级后仍可写新清单
        self.assertTrue(pol.is_disabled('fresh.example'))

    def test_missing_file_is_just_empty(self):
        pol, _ = make_policy(self.tmp.name)
        self.assertEqual(pol.disabled_hosts(), set())
        self.assertFalse(pol.blocked('anything.example')[0])

    def test_disabled_hosts_union_builtin_env_file(self):
        pol, _ = make_policy(self.tmp.name, builtin=('b.example',), extra=('e.example',))
        pol.disable('f.example', 'ops', now=1.0)
        self.assertEqual(pol.disabled_hosts(), {'b.example', 'e.example', 'f.example'})


class TestCooldownLifecycle(unittest.TestCase):
    """临时失败 → 冷却（跨轮经 DeadHostMemory）→ 到期有限恢复。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_failures_below_threshold_do_not_block(self):
        pol, _ = make_policy(self.tmp.name, threshold=3)
        pol.record_failure('flaky.example', 'timeout', now=1.0)
        pol.record_failure('flaky.example', 'timeout', now=2.0)
        self.assertFalse(pol.blocked('flaky.example')[0])
        self.assertEqual(pol.fail_count('flaky.example'), 2)

    def test_failures_at_threshold_cool_down_and_sink(self):
        pol, mem = make_policy(self.tmp.name, threshold=3)
        for i in range(3):
            pol.record_failure('flaky.example', 'net', now=float(i))
        blocked, why = pol.blocked('flaky.example')
        self.assertTrue(blocked)
        self.assertEqual(why, '冷却中')
        # 跨轮载体已记（sink 收到 host + 时刻）
        self.assertIn('flaky.example', mem.dead_at(2.5))

    def test_cooldown_crosses_instances_via_dead_host_reader(self):
        # 第一个实例判冷却（落 DeadHostMemory）；新实例（新一轮进程）经 reader 仍拦截。
        # 假时钟推进到 50（仍在 TTL=3600 内），两个实例共享同一 mem。
        clock = _FakeClock(10.0)
        pol1, mem = make_policy(self.tmp.name, threshold=2, clock=clock.now,
                                mem_now=clock.now)
        pol1.record_failure('down.example', '5xx', now=10.0)
        pol1.record_failure('down.example', '5xx', now=11.0)
        clock.set(50.0)
        pol2, _ = make_policy(self.tmp.name, mem=mem, clock=clock.now, mem_now=clock.now)
        with contextlib.redirect_stdout(io.StringIO()):
            blocked, why = pol2.blocked('down.example')
        self.assertTrue(blocked)
        self.assertEqual(why, '冷却中')

    def test_cooldown_expires_and_limited_recovery(self):
        # TTL 过期 → 放行重试；重试再失败一次不会立刻再封（计数重起），连续失败会再封
        clock = _FakeClock(10.0)
        pol1, mem = make_policy(self.tmp.name, ttl=100, threshold=2, clock=clock.now,
                                mem_now=clock.now)
        pol1.record_failure('down.example', 'net', now=10.0)
        pol1.record_failure('down.example', 'net', now=20.0)
        clock.set(200.0)                       # TTL=100 已过
        pol2, _ = make_policy(self.tmp.name, ttl=100, threshold=2, mem=mem,
                              clock=clock.now, mem_now=clock.now)
        self.assertFalse(pol2.blocked('down.example')[0])
        # 到期后 1 次新失败不封（有限恢复 = 允许重试，不是无限放行）
        pol2.record_failure('down.example', 'net', now=200.0)
        self.assertFalse(pol2.blocked('down.example')[0])
        pol2.record_failure('down.example', 'net', now=201.0)
        self.assertTrue(pol2.blocked('down.example')[0])

    def test_record_success_clears_cooldown_counters(self):
        pol, mem = make_policy(self.tmp.name, threshold=3)
        pol.record_failure('flaky.example', 'net', now=1.0)
        pol.record_failure('flaky.example', 'net', now=2.0)
        pol.record_success('flaky.example')          # 拿到页面（含正常 miss）
        self.assertEqual(pol.fail_count('flaky.example'), 0)
        # 成功清计数后：再 1 次失败不足阈值
        pol.record_failure('flaky.example', 'net', now=3.0)
        self.assertFalse(pol.blocked('flaky.example')[0])

    def test_normal_miss_never_blocks(self):
        # 只有 record_failure 会推进计数；正常 miss（不调 failure）永不封站
        pol, _ = make_policy(self.tmp.name, threshold=1)
        for _ in range(50):
            pol.record_success('healthy.example')
        self.assertFalse(pol.blocked('healthy.example')[0])

    def test_disabled_host_failures_not_counted(self):
        pol, mem = make_policy(self.tmp.name, builtin=('book15.net',), threshold=1)
        pol.record_failure('book15.net', '522', now=1.0)
        # 停用覆盖一切：不进冷却记账（避免无意义状态）
        self.assertEqual(pol.fail_count('book15.net'), 0)
        self.assertEqual(mem.hosts, {})

    def test_cooldown_ttl_zero_disables_cooldown_only(self):
        # ttl<=0：冷却整条关（不计数、不拦截），停用门照常
        pol, _ = make_policy(self.tmp.name, builtin=('book15.net',), ttl=0)
        for i in range(5):
            pol.record_failure('flaky.example', 'net', now=float(i))
        self.assertEqual(pol.fail_count('flaky.example'), 0)
        self.assertFalse(pol.blocked('flaky.example')[0])
        self.assertTrue(pol.blocked('book15.net')[0])

    def test_sink_failure_does_not_break_round(self):
        def bad_sink(host, now):
            raise OSError('disk full')
        pol = sp.SourcePolicy(base_dir=self.tmp.name, cooldown_ttl=100, threshold=1,
                              dead_host_sink=bad_sink)
        with contextlib.redirect_stderr(io.StringIO()):
            pol.record_failure('x.example', 'net', now=1.0)   # 不抛
        self.assertTrue(pol.blocked('x.example')[0])          # 本轮仍拦

    def test_no_sink_still_blocks_in_round(self):
        # 无跨轮载体（纯进程内）：达阈值本轮仍拦（只是不跨轮）
        pol = sp.SourcePolicy(cooldown_ttl=100, threshold=1)
        pol.record_failure('x.example', 'net', now=1.0)
        self.assertTrue(pol.blocked('x.example')[0])


class TestUrlAndHost(unittest.TestCase):
    """host_of / blocked_url / blocked 优先级。"""

    def test_host_of(self):
        self.assertEqual(sp.host_of('https://Book15.net/books/x.html'), 'book15.net')
        self.assertEqual(sp.host_of('https://u:p@www.example.com:443/a'), 'www.example.com')
        self.assertEqual(sp.host_of('not a url'), '')
        self.assertEqual(sp.host_of(''), '')

    def test_blocked_url_routes_by_host(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        pol, _ = make_policy(tmp.name, builtin=sp.BOOK15_HOSTS)
        self.assertTrue(pol.blocked_url('https://book15.net/books/search.html?kw=x')[0])
        self.assertTrue(pol.blocked_url('https://www.book15.net/chapter/index1-1.html')[0])
        self.assertFalse(pol.blocked_url('https://other.example/x')[0])
        self.assertFalse(pol.blocked_url('')[0])

    def test_disabled_takes_priority_over_cooldown_reason(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        pol, _ = make_policy(tmp.name, builtin=('x.example',), threshold=1)
        pol.record_failure('x.example', 'net', now=1.0)
        blocked, why = pol.blocked('x.example')
        self.assertTrue(blocked)
        self.assertEqual(why, '停用')

    def test_empty_host_never_blocked(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        pol, _ = make_policy(tmp.name, builtin=('',))
        self.assertFalse(pol.blocked('')[0])


class TestEnvDisabledList(unittest.TestCase):
    """LABELER_SOURCE_DISABLED_HOSTS 解析：合法保留、垃圾跳过、保序去重。"""

    ENV = sp.DISABLED_HOSTS_ENV

    def test_empty_and_missing(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(self.ENV, None)
            self.assertEqual(sp.parse_disabled_hosts({}), ())
            self.assertEqual(sp.parse_disabled_hosts({self.ENV: ''}), ())
            self.assertEqual(sp.parse_disabled_hosts({self.ENV: ','}), ())

    def test_parses_valid_hosts_dedup_ordered(self):
        self.assertEqual(sp.parse_disabled_hosts({self.ENV: 'B.example, a.example,b.example'}),
                         ('b.example', 'a.example'))

    def test_skips_garbage_entries(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err):
            got = sp.parse_disabled_hosts({self.ENV: 'ok.example, bad host!, .., good.example'})
        self.assertEqual(got, ('ok.example', 'good.example'))
        self.assertIn('不是合法 host', err.getvalue())

    def test_env_list_feeds_policy(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        pol, _ = make_policy(tmp.name, extra=sp.parse_disabled_hosts(
            {self.ENV: 'x.example, y.example'}))
        self.assertTrue(pol.is_disabled('x.example'))
        self.assertFalse(pol.is_disabled('z.example'))


class TestCapAndOps(unittest.TestCase):
    """状态文件条目上限与运维摘要。"""

    def test_disabled_file_capped(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        pol, _ = make_policy(tmp.name)
        for i in range(sp.MAX_HOSTS + 20):
            pol.disable(f'h{i}.example', 'ops', now=float(i))
        pol2, _ = make_policy(tmp.name)
        self.assertEqual(len(pol2.disabled_hosts()), sp.MAX_HOSTS)
        # 保留的是时间较新的（i 大的）
        self.assertIn(f'h{sp.MAX_HOSTS + 19}.example', pol2.disabled_hosts())
        self.assertNotIn('h0.example', pol2.disabled_hosts())

    def test_summary_line_mentions_book15(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        pol_on, _ = make_policy(tmp.name, builtin=sp.BOOK15_HOSTS)
        self.assertIn('book15 停用', pol_on.summary_line())
        pol_off, _ = make_policy(tmp.name)
        self.assertIn('book15 启用', pol_off.summary_line())

    def test_real_dead_host_memory_compatible(self):
        """与真 DeadHostMemory 接线（同 labeler main 的装配形态）：sink=mem.add、reader=dead_hosts。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / labeler.DEAD_HOSTS_FILENAME
        with contextlib.redirect_stdout(io.StringIO()):
            mem = labeler.DeadHostMemory.load(path, ttl_sec=3600, now=1000.0)
        pol = sp.SourcePolicy(base_dir=Path(tmp.name), cooldown_ttl=3600, threshold=2,
                              dead_host_sink=lambda h, now: (mem.add(h, now=now), mem.save()),
                              dead_hosts_reader=lambda: mem.dead_hosts(now=1001.0),
                              clock=lambda: 1001.0)
        pol.record_failure('real.example', 'net', now=1000.5)
        pol.record_failure('real.example', 'net', now=1000.9)
        # 跨轮：新进程从同一文件读
        with contextlib.redirect_stdout(io.StringIO()):
            mem2 = labeler.DeadHostMemory.load(path, ttl_sec=3600, now=2000.0)
        pol2 = sp.SourcePolicy(base_dir=Path(tmp.name), cooldown_ttl=3600,
                               dead_hosts_reader=lambda: mem2.dead_hosts(now=2000.0))
        self.assertTrue(pol2.blocked('real.example')[0])
        # TTL 过期（6h+ 后的新进程）→ 放行
        with contextlib.redirect_stdout(io.StringIO()):
            mem3 = labeler.DeadHostMemory.load(path, ttl_sec=3600, now=10000.0)
        pol3 = sp.SourcePolicy(base_dir=Path(tmp.name), cooldown_ttl=3600,
                               dead_hosts_reader=lambda: mem3.dead_hosts(now=10000.0))
        self.assertFalse(pol3.blocked('real.example')[0])


class TestSourceBlockedError(unittest.TestCase):
    def test_message_has_no_credentials(self):
        e = sp.SourceBlockedError('https://x.example/a?token=zzz', '停用')
        self.assertIn('x.example', str(e))
        self.assertIn('未发请求', str(e))
        self.assertEqual(e.reason, '停用')


if __name__ == '__main__':
    unittest.main(verbosity=2)
