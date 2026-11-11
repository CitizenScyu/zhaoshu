#!/usr/bin/env python3
"""书源失败不判渠道坏 + 跑完不再探测（srcfail1105）单测。

背景：2026-11-03～05 名单只剩几本只有死源的书，labeler 每轮 0 成功、失败全是「源失效放弃」（模型一次没调），
旧口径照样退 2「渠道转坏」，门卫每圈回去做 PASS_N × 整链 25 万字段探测——三天 423 次、标价约 $6700。
现在 labeler 在调用方 opt-in（进程环境 LABELER_EXIT_DETAIL=1）时细分退出码，门卫只在模型链真的耗尽
（2）或异常退出时才探测。
覆盖：
- labeler：零成功全书源失败 → EXIT_SOURCE_ONLY；零成功含模型链耗尽 → 2；有成功有失败 → EXIT_PARTIAL；
  连续 LLM_FAIL_BREAK 本模型链耗尽 → 提前收轮退 2（中间夹书源失败不清零）；不 opt-in 时照旧 0/1/2、不熔断。
- gatekeeper：书源失败/跑完/部分失败后不探测、直接待机试跑；2 才回探测；恢复分支同口径；子进程带 opt-in。
全离线：不联网、不调模型、不起进程。
复跑：PYTHONIOENCODING=utf-8 python scripts/test_labeler_srcfail1105.py
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
from test_labeler_adgate import MainHarness, _good_fetch, _labels  # noqa: E402

LLM_DOWN = RuntimeError('打标失败: 模型链 [\'m-1\'] 全部耗尽, 最后错误: HTTP 524')


class LabelerDetailExitTest(MainHarness):
    def _run(self, plan, detail=True):
        """plan: 每本书的结局 'ok' / 'src' / 'llm'。返回 (退出码, 实际处理到第几本)。"""
        books = [dict(self.BOOK, url=f'https://www.kxdu.net/book/{n}', title=f'书{n}')
                 for n in range(len(plan))]
        by_url = {b['url']: kind for b, kind in zip(books, plan)}
        seen = []

        def fake_build(*a, **k):
            return [dict(b) for b in books]

        def fetch(cli, url, stats=None, **k):
            seen.append(url)
            if by_url.get(url) == 'src':
                raise labeler.EngineSourceGaveUp('so.ihuaben.com', 'no_source', '目录不可用')
            return _good_fetch(cli, url, stats, **k)

        def fake_label(text, *a, **k):
            if by_url.get(seen[-1]) == 'llm':
                raise LLM_DOWN
            return dict(_labels('正常', evidence=())), 1

        env = {'LABELER_DATA_DIR': str(self.dir)}
        if detail:
            env[labeler.DETAIL_EXIT_ENV] = '1'
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue', side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine', side_effect=fetch), \
                mock.patch.object(labeler, 'label_book', side_effect=fake_label), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if not detail:
                os.environ.pop(labeler.DETAIL_EXIT_ENV, None)
            return labeler.main(), len(seen)

    def test_all_source_failures_are_not_a_channel_failure(self):
        self.assertEqual(self._run(['src', 'src']), (labeler.EXIT_SOURCE_ONLY, 2))

    def test_zero_success_with_llm_exhaustion_is_still_2(self):
        self.assertEqual(self._run(['src', 'llm', 'src']), (2, 3))

    def test_partial_success_is_partial(self):
        self.assertEqual(self._run(['ok', 'src']), (labeler.EXIT_PARTIAL, 2))

    def test_all_success_is_zero(self):
        self.assertEqual(self._run(['ok', 'ok']), (0, 2))

    def test_consecutive_llm_exhaustion_breaks_the_round(self):
        # 中间夹的书源失败不清零；第二次耗尽即收轮，后面的书不再取文
        self.assertEqual(self._run(['llm', 'src', 'llm', 'ok', 'ok']), (2, 3))

    def test_success_resets_the_llm_streak(self):
        self.assertEqual(self._run(['llm', 'ok', 'llm', 'ok']), (labeler.EXIT_PARTIAL, 4))

    # 不 opt-in（手动跑、旧门卫）：退出码与流程照旧。每用例一个数据目录（同目录连跑会被跨轮记忆影响）。
    def test_without_opt_in_source_only_stays_2(self):
        self.assertEqual(self._run(['src', 'src'], detail=False), (2, 2))

    def test_without_opt_in_partial_stays_1(self):
        self.assertEqual(self._run(['ok', 'src'], detail=False), (1, 2))

    def test_without_opt_in_no_breaker(self):
        self.assertEqual(self._run(['llm', 'llm', 'ok'], detail=False), (1, 3))


class GatekeeperDetailTest(unittest.TestCase):
    def _main(self, codes, round_secs=0.0):
        """codes 依次作 labeler 退出码；用完即停。返回 (事件序列 probe / sleep:N / run, 子进程环境列表)。
        round_secs：每轮 labeler 的假用时（roundgap1112 按长短轮决定跑完后的间隔）。"""
        events, envs = [], []
        clock = [0.0]

        def fake_time():
            return clock[0]
        queue = list(codes)

        class _Stop(Exception):
            pass

        def fake_run(cmd, **kw):
            if not queue:
                raise _Stop
            events.append('run')
            envs.append(kw.get('env') or {})
            clock[0] += round_secs
            return SimpleNamespace(returncode=queue.pop(0))

        def fake_probe(api_key, models, llm_url):
            events.append('probe')
            return True

        with mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value={'LLM_API_KEY': 'k', 'LLM_MODELS': 'm-1'}), \
             mock.patch.object(gatekeeper, 'probe', side_effect=fake_probe), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=fake_run), \
             mock.patch.object(gatekeeper.time, 'time', side_effect=fake_time), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda s: events.append(f'sleep:{s}')):
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(_Stop):
                    gatekeeper.main()
        return events, envs

    def window(self):
        return (['probe', f'sleep:{gatekeeper.PROBE_INTERVAL}'] * (gatekeeper.PASS_N - 1)
                + ['probe'])

    def test_source_only_standby_without_probing(self):
        events, _ = self._main([gatekeeper.EXIT_SOURCE_ONLY, gatekeeper.EXIT_SOURCE_ONLY])
        idle = f'sleep:{gatekeeper.IDLE_SLEEP}'
        self.assertEqual(events, self.window() + ['run', idle, 'run', idle])

    def test_done_and_partial_rerun_without_probing(self):
        events, _ = self._main([0, gatekeeper.EXIT_PARTIAL])
        nap = f'sleep:{gatekeeper.PROBE_INTERVAL}'
        self.assertEqual(events, self.window() + ['run', nap, 'run', nap])

    def test_only_llm_exhaustion_goes_back_to_probing(self):
        events, _ = self._main([0, 2])
        self.assertEqual(events, self.window() + ['run', f'sleep:{gatekeeper.PROBE_INTERVAL}', 'run']
                         + self.window())

    def test_recovery_branch_uses_the_same_mapping(self):
        events, _ = self._main([1, gatekeeper.EXIT_SOURCE_ONLY])
        self.assertEqual(events, self.window() + ['run', 'probe', 'run', f'sleep:{gatekeeper.IDLE_SLEEP}'])

    def test_child_env_opts_in(self):
        _, envs = self._main([0])
        self.assertEqual(envs[0].get(gatekeeper.DETAIL_EXIT_ENV), '1')
        self.assertEqual(envs[0].get(gatekeeper.IDLE_EXIT_ENV), '1')

    def test_long_round_only_takes_short_gap(self):
        # roundgap1112：长轮跑完只歇 ROUND_GAP；书源失败/空队列的长待机不受影响
        long = gatekeeper.SHORT_ROUND_SECS
        events, _ = self._main([0, gatekeeper.EXIT_PARTIAL, gatekeeper.EXIT_SOURCE_ONLY], round_secs=long)
        gap = f'sleep:{gatekeeper.ROUND_GAP}'
        self.assertEqual(events, self.window() + ['run', gap, 'run', gap, 'run',
                                                  f'sleep:{gatekeeper.IDLE_SLEEP}'])

    def test_short_round_keeps_old_pacing(self):
        events, _ = self._main([0, 0], round_secs=gatekeeper.SHORT_ROUND_SECS - 1)
        nap = f'sleep:{gatekeeper.PROBE_INTERVAL}'
        self.assertEqual(events, self.window() + ['run', nap, 'run', nap])
        self.assertLess(gatekeeper.ROUND_GAP, gatekeeper.PROBE_INTERVAL)

    def test_literals_match_labeler(self):
        self.assertEqual(gatekeeper.EXIT_SOURCE_ONLY, labeler.EXIT_SOURCE_ONLY)
        self.assertEqual(gatekeeper.EXIT_PARTIAL, labeler.EXIT_PARTIAL)
        self.assertEqual(gatekeeper.DETAIL_EXIT_ENV, labeler.DETAIL_EXIT_ENV)
        used = (0, 1, 2, gatekeeper.EXIT_NO_MODELS, gatekeeper.EXIT_VERSION_MISMATCH,
                gatekeeper.EXIT_COMPANION_TOO_OLD, gatekeeper.EXIT_IDLE)
        self.assertNotIn(gatekeeper.EXIT_SOURCE_ONLY, used)
        self.assertNotIn(gatekeeper.EXIT_PARTIAL, used + (gatekeeper.EXIT_SOURCE_ONLY,))


if __name__ == '__main__':
    unittest.main()
