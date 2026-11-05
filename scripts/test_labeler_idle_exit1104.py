#!/usr/bin/env python3
"""空队列退出码（idleexit1104）单测。

背景：名单源抽干后每轮 0 本（2026-11-04 生产实测），门卫旧逻辑每圈仍「睡 10 分钟 + PASS_N 次
整链 25 万字段探测」。现在 labeler 在调用方 opt-in（进程环境 LABELER_EXIT_IDLE=1）时以
EXIT_IDLE 报空队列，门卫据此待机 IDLE_SLEEP 后直接试跑、不探测。
覆盖：
- labeler：空队列 + opt-in → EXIT_IDLE；不 opt-in → 0（手动跑、旧门卫行为不变）；有书时不报空闲。
- gatekeeper：空闲后下一圈不探测、只睡 IDLE_SLEEP；空闲后的试跑若有活（0）照常回到探测；
  恢复分支里的空闲同样走待机；子进程环境带 opt-in；两边字面值一致。
全离线：不联网、不调模型、不起进程。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_idle_exit1104.py
"""
import contextlib
import io
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatekeeper  # noqa: E402
import labeler  # noqa: E402
from test_labeler_adgate import MainHarness  # noqa: E402


class LabelerIdleExitTest(MainHarness):
    def _run(self, books, env_flag):
        def fake_build(*a, **k):
            return [dict(b) for b in books]

        env = {'LABELER_DATA_DIR': str(self.dir)}
        if env_flag:
            env[labeler.IDLE_EXIT_ENV] = '1'
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine',
                                  side_effect=RuntimeError('fetch boom')), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            if not env_flag:
                os.environ.pop(labeler.IDLE_EXIT_ENV, None)
            return labeler.main()

    def test_empty_queue_with_opt_in_is_idle(self):
        self.assertEqual(self._run([], env_flag=True), labeler.EXIT_IDLE)

    def test_empty_queue_without_opt_in_stays_zero(self):
        self.assertEqual(self._run([], env_flag=False), 0)

    def test_non_empty_queue_is_never_idle(self):
        self.assertEqual(self._run([self.BOOK], env_flag=True), 2)


class GatekeeperIdleTest(unittest.TestCase):
    def _main(self, codes):
        """codes 依次作 labeler 退出码；用完即停。返回事件序列 probe / sleep:N / run。"""
        events = []
        queue = list(codes)

        class _Stop(Exception):
            pass

        def fake_run(cmd, **kw):
            if not queue:
                raise _Stop
            events.append('run')
            return SimpleNamespace(returncode=queue.pop(0))

        def fake_probe(api_key, models, llm_url):
            events.append('probe')
            return True

        with mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value={'LLM_API_KEY': 'k', 'LLM_MODELS': 'm-1'}), \
             mock.patch.object(gatekeeper, 'probe', side_effect=fake_probe), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=fake_run), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda s: events.append(f'sleep:{s}')):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                with self.assertRaises(_Stop):
                    gatekeeper.main()
        return events, out.getvalue()

    def window(self):
        return (['probe', f'sleep:{gatekeeper.PROBE_INTERVAL}'] * (gatekeeper.PASS_N - 1)
                + ['probe'])

    def test_idle_skips_probes_and_sleeps_idle_interval(self):
        events, out = self._main([gatekeeper.EXIT_IDLE, gatekeeper.EXIT_IDLE])
        idle = f'sleep:{gatekeeper.IDLE_SLEEP}'
        self.assertEqual(events, self.window() + ['run', idle, 'run', idle])
        self.assertIn('空队列待机', out)

    def test_work_after_idle_reruns_without_probing(self):
        # srcfail1105：跑完一轮（0）已证渠道可用，下一轮不再探测（旧口径回到探测，见 test_labeler_srcfail1105）
        events, _ = self._main([gatekeeper.EXIT_IDLE, 0])
        self.assertEqual(
            events,
            self.window() + ['run', f'sleep:{gatekeeper.IDLE_SLEEP}', 'run',
                             f'sleep:{gatekeeper.PROBE_INTERVAL}'])

    def test_idle_in_recovery_branch_also_idles(self):
        events, _ = self._main([1, gatekeeper.EXIT_IDLE])
        self.assertEqual(
            events,
            self.window() + ['run', 'probe', 'run', f'sleep:{gatekeeper.IDLE_SLEEP}'])

    def test_literals_match_labeler(self):
        self.assertEqual(gatekeeper.EXIT_IDLE, labeler.EXIT_IDLE)
        self.assertEqual(gatekeeper.IDLE_EXIT_ENV, labeler.IDLE_EXIT_ENV)
        self.assertNotIn(gatekeeper.EXIT_IDLE, (0, 1, 2, gatekeeper.EXIT_COMPANION_TOO_OLD))


if __name__ == '__main__':
    unittest.main()
