#!/usr/bin/env python3
"""gatekeeper.py 单测（41-gkfix：探测模型表改读 .env 的 LLM_MODELS）。

覆盖：
- resolve_probe_models：LLM_MODELS 优先；旧 LLM_MODEL 单值兜底；两者都缺/为空 -> ([], 'none')。
- probe：逐模型探测、任一通过即放行；全挂不放行；每个模型都真的被探到。
- main：模型链缺失时 fail-closed（返回 EXIT_NO_MODELS、不启动 labeler）；
        模型链存在时按 .env 链启动 labeler。

全离线：probe_one 与 subprocess.run 被替换，不联网、不调真模型、不起进程。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -t scripts -p 'test_gatekeeper.py'
"""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatekeeper  # noqa: E402

FAKE_KEY = 'test-key-not-real-0123456789'


def _env(**kw) -> dict:
    env = {'LLM_API_KEY': FAKE_KEY}
    env.update(kw)
    return env


class ResolveProbeModelsTest(unittest.TestCase):
    def test_prefers_llm_models(self):
        env = _env(LLM_MODELS='a-1,b-2 , c-3', LLM_MODEL='legacy-9')
        models, src = gatekeeper.resolve_probe_models(env)
        self.assertEqual(models, ['a-1', 'b-2', 'c-3'])   # 逗号列表，去空白
        self.assertEqual(src, 'LLM_MODELS')

    def test_legacy_single_model_fallback(self):
        env = _env(LLM_MODEL='legacy-9')
        models, src = gatekeeper.resolve_probe_models(env)
        self.assertEqual(models, ['legacy-9'])
        self.assertEqual(src, 'LLM_MODEL')

    def test_legacy_model_that_is_a_constant_member_fails_closed(self):
        """F1：LLM_MODEL 恰为 labeler.MODELS 成员时，labeler 实际会走硬编码常量链，
        门卫若照单全收就会拿常量链放行、日志却标来源 'LLM_MODEL'（误导 + 与 fail-closed 声称不符）。
        必须 fail-closed。"""
        for legacy in gatekeeper.labeler.MODELS:
            with self.subTest(legacy=legacy):
                models, src = gatekeeper.resolve_probe_models(_env(LLM_MODEL=legacy))
                self.assertEqual(models, [])
                self.assertEqual(src, 'none')

    def test_missing_both_is_none(self):
        models, src = gatekeeper.resolve_probe_models(_env())
        self.assertEqual(models, [])
        self.assertEqual(src, 'none')

    def test_llm_models_wins_over_constant_member_legacy(self):
        """LLM_MODELS 在时优先；即便旧 LLM_MODEL 是常量成员也不影响（走 LLM_MODELS 分支）。"""
        env = _env(LLM_MODELS='m-1,m-2', LLM_MODEL=gatekeeper.labeler.MODELS[0])
        models, src = gatekeeper.resolve_probe_models(env)
        self.assertEqual(models, ['m-1', 'm-2'])
        self.assertEqual(src, 'LLM_MODELS')

    def test_blank_values_are_none(self):
        # LLM_MODELS 只有逗号/空格 = 没有模型；不能退回硬编码链（fail-closed）
        for blank in ('', '   ', ',', ' , , '):
            with self.subTest(blank=blank):
                models, src = gatekeeper.resolve_probe_models(_env(LLM_MODELS=blank))
                self.assertEqual(models, [])
                self.assertEqual(src, 'none')

    def test_reuses_labeler_resolver(self):
        """证明走的是 labeler 的解析途径，而不是门卫自带的一套。"""
        env = _env(LLM_MODELS='x-1,y-2')
        with mock.patch.object(gatekeeper.labeler, 'resolve_models',
                               return_value=(['sentinel-1'], 'environment')) as m:
            models, _ = gatekeeper.resolve_probe_models(env)
        self.assertEqual(models, ['sentinel-1'])
        self.assertTrue(m.called)
        # use_db 必须与 labeler 运行时一致（F2）：门卫探测的就是 labeler 会跑的链。
        self.assertEqual(m.call_args.kwargs.get('use_db'), gatekeeper.USE_DB_MODEL)
        self.assertEqual(gatekeeper.USE_DB_MODEL, True)


class ProbeTest(unittest.TestCase):
    def test_one_pass_releases(self):
        calls = []

        def fake(api_key, model):
            calls.append(model)
            return model == 'b-2'          # 只有链中第二个通过

        with mock.patch.object(gatekeeper, 'probe_one', side_effect=fake):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                passed = gatekeeper.probe(FAKE_KEY, ['a-1', 'b-2', 'c-3'])
        self.assertTrue(passed)                       # 任一通过即放行
        self.assertEqual(calls, ['a-1', 'b-2', 'c-3'])  # 每个模型都被探到
        text = out.getvalue()
        for m in ('a-1', 'b-2', 'c-3'):
            self.assertIn(m, text)                    # 逐模型记录结果

    def test_all_fail_blocks(self):
        with mock.patch.object(gatekeeper, 'probe_one', return_value=False):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                passed = gatekeeper.probe(FAKE_KEY, ['a-1', 'b-2'])
        self.assertFalse(passed)
        self.assertIn('全灭', out.getvalue())


class MainFailClosedTest(unittest.TestCase):
    def test_missing_models_exits_without_launching(self):
        # F4：patch time.sleep，否则「fail-closed 失效」类变异会让 main 进入无限循环并真 sleep(600)，
        # 表现为测试挂死（CI/pre-push 卡住）而不是报红。subprocess.run 一旦被调用就抛异常，
        # 使「错误放行」立即以失败暴露。
        def must_not_launch(*a, **kw):
            raise AssertionError('fail-closed 失效：不应启动 labeler')

        with mock.patch.object(gatekeeper.labeler, 'load_env', return_value=_env()), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=must_not_launch), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda *_: None), \
             mock.patch.object(gatekeeper, 'probe_one', return_value=True):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                rc = gatekeeper.main()
        self.assertEqual(rc, gatekeeper.EXIT_NO_MODELS)   # fail-closed
        self.assertIn('fail-closed', err.getvalue())

    def test_legacy_constant_member_fails_closed_at_main(self):
        """F1 端到端：LLM_MODEL 是常量成员时 main 必须 fail-closed、不启动 labeler。"""
        def must_not_launch(*a, **kw):
            raise AssertionError('fail-closed 失效：不应启动 labeler')

        with mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value=_env(LLM_MODEL=gatekeeper.labeler.MODELS[0])), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=must_not_launch), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda *_: None), \
             mock.patch.object(gatekeeper, 'probe_one', return_value=True):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                rc = gatekeeper.main()
        self.assertEqual(rc, gatekeeper.EXIT_NO_MODELS)
        self.assertIn('fail-closed', err.getvalue())

    def test_models_from_env_drive_labeler(self):
        launched = []
        probed = []

        class _Stop(Exception):
            pass

        def fake_run(cmd, **kw):
            launched.append(cmd)
            raise _Stop                                  # 首次启动即跳出无限循环

        def fake_probe(api_key, models):
            probed.append(list(models))                  # F3：记录 main 实际探测的链
            return True

        with mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value=_env(LLM_MODELS='m-1,m-2')), \
             mock.patch.object(gatekeeper, 'probe', side_effect=fake_probe), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=fake_run), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda *_: None):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                with self.assertRaises(_Stop):
                    gatekeeper.main()
        self.assertEqual(launched, [gatekeeper.LABELER_CMD])
        self.assertIn('LLM_MODELS', out.getvalue())       # 打印来源
        # F3：main 探测的必须**就是** .env 解析出的链，而不是任何硬编码常量链。
        # 变异 M7（把 probe(key, models) 改回 probe(key, list(labeler.MODELS))）会在此变红。
        self.assertTrue(probed, 'main 从未调用 probe')
        for chain in probed:
            self.assertEqual(chain, ['m-1', 'm-2'])
            for const_model in gatekeeper.labeler.MODELS:
                self.assertNotIn(const_model, chain)


if __name__ == '__main__':
    unittest.main()
