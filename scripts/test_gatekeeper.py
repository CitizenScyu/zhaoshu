#!/usr/bin/env python3
"""gatekeeper.py 单测（41-gkfix：探测模型表改读 .env 的 LLM_MODELS）。

覆盖：
- resolve_probe_models：LLM_MODELS 优先；旧 LLM_MODEL 单值兜底；两者都缺/为空 -> ([], 'none')。
- probe：逐模型探测、任一通过即放行；全挂不放行；每个模型都真的被探到。
- 端点：probe_one 真把传进来的 llm_url 发到线上；默认端点是部署机本机 NewAPI 的 loopback 入口
        （断言字面值）；main 把 .env 的 LLM_URL 解析结果透传给 probe —— **两处**调用点都钉
        （等窗口阶段 + labeler 异常退出后的恢复阶段）；llm_url 在 probe/probe_one 上是必填参数。
- resolve_probe_endpoint：复用 labeler.resolve_llm_url；labeler.py 太旧（缺该函数）时抛
        LabelerTooOld，由 main 转成 EXIT_VERSION_MISMATCH 并 fail-closed 不启动 labeler。
- main：模型链缺失时 fail-closed（返回 EXIT_NO_MODELS、不启动 labeler）；
        模型链存在时按 .env 链启动 labeler。

全离线：probe_one 与 subprocess.run 被替换，不联网、不调真模型、不起进程。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -t scripts -p 'test_gatekeeper.py'
"""
import contextlib
import inspect
import io
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatekeeper  # noqa: E402

FAKE_KEY = 'test-key-not-real-0123456789'
FAKE_URL = 'http://127.0.0.1:13999/v1/chat/completions'   # 端口刻意与真实中转不同，防串台


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

        def fake(api_key, model, llm_url):
            calls.append(model)
            return model == 'b-2'          # 只有链中第二个通过

        with mock.patch.object(gatekeeper, 'probe_one', side_effect=fake):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                passed = gatekeeper.probe(FAKE_KEY, ['a-1', 'b-2', 'c-3'], FAKE_URL)
        self.assertTrue(passed)                       # 任一通过即放行
        self.assertEqual(calls, ['a-1', 'b-2', 'c-3'])  # 每个模型都被探到
        text = out.getvalue()
        for m in ('a-1', 'b-2', 'c-3'):
            self.assertIn(m, text)                    # 逐模型记录结果

    def test_all_fail_blocks(self):
        with mock.patch.object(gatekeeper, 'probe_one', return_value=False):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                passed = gatekeeper.probe(FAKE_KEY, ['a-1', 'b-2'], FAKE_URL)
        self.assertFalse(passed)
        self.assertIn('全灭', out.getvalue())

    def test_probe_forwards_one_url_to_every_model(self):
        """端点必须逐模型透传：漏一个就是「探测的端点 != 运行的端点」。"""
        seen = []

        def fake(api_key, model, llm_url):
            seen.append(llm_url)
            return True

        with mock.patch.object(gatekeeper, 'probe_one', side_effect=fake):
            with contextlib.redirect_stdout(io.StringIO()):
                gatekeeper.probe(FAKE_KEY, ['a-1', 'b-2'], FAKE_URL)
        self.assertEqual(seen, [FAKE_URL, FAKE_URL])


class _FirstByteOk:
    """urlopen 替身：记录请求打到的 URL，返回一个「首字节即到」的响应（probe_one 据此判活）。"""

    def __init__(self, seen):
        self.seen = seen

    def __call__(self, req, timeout=None):
        self.seen.append(req.full_url)
        return io.BytesIO(b'data: {"choices": []}\n')


class ProbeEndpointTest(unittest.TestCase):
    def test_probe_one_requests_the_url_it_was_given(self):
        seen = []
        with mock.patch.object(gatekeeper.urllib.request, 'urlopen', _FirstByteOk(seen)):
            ok = gatekeeper.probe_one(FAKE_KEY, 'm-1', FAKE_URL)
        self.assertTrue(ok)
        self.assertEqual(seen, [FAKE_URL])

    def test_default_endpoint_is_the_local_newapi(self):
        """回归护栏：默认端点必须是本机 loopback，不能是另一台实例的公网入口。

        2026-10-23 之前这里硬编码 api.cloud.us.kg——那是 phoenix 上的 new-api-phx（自家另一台
        实例，不是打标机本机那台；一手核实方式见 labeler.py 的 LLM_URL 注释），而生产实际跑的
        是部署机上两处**未版本化**的就地改文件（127.0.0.1:13001）。谁把默认值改回公网主机名，
        这条就红。

        断言的是**字面值**而不是 `labeler.LLM_URL` 常量：待测的就是那个常量，拿它断言它是
        同义反复——变异「默认端口 13001 改成 13998」两边一起变、测试照绿（实测存活）。"""
        url = gatekeeper.labeler.resolve_llm_url({})
        self.assertEqual(url, 'http://127.0.0.1:13001/v1/chat/completions')
        self.assertTrue(url.startswith('http://127.0.0.1:'), url)
        self.assertNotIn('cloud.us.kg', url)

    def test_env_override_wins_and_blank_falls_back(self):
        self.assertEqual(gatekeeper.labeler.resolve_llm_url({'LLM_URL': FAKE_URL}), FAKE_URL)
        for blank in ('', '   ', None):
            self.assertEqual(gatekeeper.labeler.resolve_llm_url({'LLM_URL': blank}),
                             gatekeeper.labeler.LLM_URL)


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
        endpoints = []

        class _Stop(Exception):
            pass

        def fake_run(cmd, **kw):
            launched.append(cmd)
            raise _Stop                                  # 首次启动即跳出无限循环

        def fake_probe(api_key, models, llm_url):
            probed.append(list(models))                  # F3：记录 main 实际探测的链
            endpoints.append(llm_url)
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
        # .env 没写 LLM_URL 时退回内置默认（本机中转），且必须真的传到了 probe。
        self.assertEqual(set(endpoints), {gatekeeper.labeler.LLM_URL})

    def test_env_llm_url_reaches_probe(self):
        """端点版的 F3/M7：main 必须把 .env 的 LLM_URL 透传给 probe。

        变异「probe(key, models, labeler.LLM_URL)」（即无视 env 覆盖）会在此变红——
        那种写法测试全绿、日志也好看，但探测的端点与 labeler 实际请求的端点会漂移。"""
        endpoints = []

        class _Stop(Exception):
            pass

        def fake_run(cmd, **kw):
            raise _Stop

        def fake_probe(api_key, models, llm_url):
            endpoints.append(llm_url)
            return True

        with mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value=_env(LLM_MODELS='m-1', LLM_URL=FAKE_URL)), \
             mock.patch.object(gatekeeper, 'probe', side_effect=fake_probe), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=fake_run), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda *_: None):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                with self.assertRaises(_Stop):
                    gatekeeper.main()
        self.assertTrue(endpoints, 'main 从未调用 probe')
        self.assertEqual(set(endpoints), {FAKE_URL})
        self.assertNotIn(gatekeeper.labeler.LLM_URL, endpoints)
        self.assertIn(FAKE_URL, out.getvalue())          # 端点进日志，出事能直接对质

    def test_recovery_probe_uses_the_same_endpoint(self):
        """X3：main 里**第二处** probe 调用（恢复分支）也必须用同一个解析出的端点。

        main 探两次端点：等窗口阶段，以及「labeler 异常退出后判断渠道还活着吗」的恢复阶段。
        上一条用例在首次 subprocess.run 就抛异常，从没进过恢复分支，于是变异「只把恢复分支
        改传 labeler.LLM_URL」三组全绿（实测存活，捕获到 [覆盖地址, 覆盖地址, 默认地址]）。
        后果不是小事：LLM 异常之后恰恰最需要门卫按**真实运行端点**判断是否恢复，
        探默认端点就会错误放行（渠道其实还坏）或永久阻断（渠道已好但探的不是它）。"""
        endpoints = []
        launched = []

        class _Stop(Exception):
            pass

        def fake_run(cmd, **kw):
            launched.append(cmd)
            return SimpleNamespace(returncode=1)         # 异常退出 → 进恢复分支

        def fake_probe(api_key, models, llm_url):
            endpoints.append(llm_url)
            if launched:                                 # 已启动过 labeler ⇒ 这是恢复分支的探测
                raise _Stop                              # 有界退出，不让 main 回到无限循环
            return True

        with mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value=_env(LLM_MODELS='m-1', LLM_URL=FAKE_URL)), \
             mock.patch.object(gatekeeper, 'probe', side_effect=fake_probe), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=fake_run), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda *_: None):
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(_Stop):
                    gatekeeper.main()
        self.assertEqual(launched, [gatekeeper.LABELER_CMD])
        # 分阶段断言（不只是「集合里只有覆盖地址」）：等待阶段 PASS_N 次 + 恢复阶段至少 1 次，
        # 每一次都必须是 .env 解析出的那个。
        self.assertEqual(endpoints[:gatekeeper.PASS_N], [FAKE_URL] * gatekeeper.PASS_N)
        self.assertEqual(endpoints[gatekeeper.PASS_N:], [FAKE_URL])


class ProbeContractTest(unittest.TestCase):
    """M5：llm_url 在 probe / probe_one 上是**必填**参数这件事本身要有测试。

    两个函数的 docstring 都写了「必填；给默认值就会静默漂移」，但注释不是防线：变异
    「改成 llm_url: str | None = None，函数体里 llm_url or labeler.LLM_URL」三组全绿
    （实测存活）——既有用例个个都显式传了端点，看不出差别，而从此漏传会静默退回常量。"""

    def test_llm_url_is_required_on_probe_one(self):
        with self.assertRaises(TypeError):
            gatekeeper.probe_one(FAKE_KEY, 'm-1')

    def test_llm_url_is_required_on_probe(self):
        with self.assertRaises(TypeError):
            gatekeeper.probe(FAKE_KEY, ['m-1'])

    def test_llm_url_has_no_default_in_signature(self):
        """上一条钉「漏传就炸」，这条钉「签名里没有默认值可悄悄兜住」。

        两者不等价：给 llm_url 任何默认值都会让 TypeError 消失，但只有默认值恰好是
        labeler.LLM_URL 时行为才「看起来对」——那正是最难发现的那种漂移。"""
        for fn in (gatekeeper.probe_one, gatekeeper.probe):
            with self.subTest(fn=fn.__name__):
                param = inspect.signature(fn).parameters['llm_url']
                self.assertIs(param.default, inspect.Parameter.empty)


class VersionMismatchTest(unittest.TestCase):
    """两文件配套部署：新 gatekeeper.py 落在旧 labeler.py 上要说人话，且照样 fail-closed。

    gatekeeper 复用 labeler.resolve_llm_url 之后，只更新 gatekeeper.py 会在启动时炸
    AttributeError；systemd 是 Restart=on-failure / RestartSec=60，表现为一分钟一次的
    traceback 崩循环、打标全停，而日志里看不出是「两文件版本不配对」。"""

    @contextlib.contextmanager
    def old_labeler(self):
        """模拟「部署机上的 labeler.py 还是端点改造之前那一版」（没有 resolve_llm_url）。
        真的把属性删掉而不是塞 None —— 要复现的是 AttributeError 形态，不是取值为假。"""
        saved = gatekeeper.labeler.resolve_llm_url
        del gatekeeper.labeler.resolve_llm_url
        try:
            yield
        finally:
            gatekeeper.labeler.resolve_llm_url = saved

    def test_resolver_raises_a_readable_error_not_attribute_error(self):
        with self.old_labeler():
            with self.assertRaises(gatekeeper.LabelerTooOld) as ctx:
                gatekeeper.resolve_probe_endpoint(_env())
        message = str(ctx.exception)
        self.assertIn('labeler.py', message)          # 指出是哪个文件的问题
        self.assertIn('同批部署', message)             # 指出怎么修

    def test_resolver_reuses_the_labeler_function_when_present(self):
        """正常路径仍是「复用 labeler 的解析」，不是门卫自己抄一份端点逻辑。"""
        sentinel = 'http://127.0.0.1:13998/v1/chat/completions'
        with mock.patch.object(gatekeeper.labeler, 'resolve_llm_url',
                               return_value=sentinel) as m:
            self.assertEqual(gatekeeper.resolve_probe_endpoint(_env()), sentinel)
        self.assertTrue(m.called)

    def test_main_fails_closed_with_its_own_exit_code(self):
        def must_not_launch(*a, **kw):
            raise AssertionError('版本不配对时不应启动 labeler')

        with self.old_labeler(), \
             mock.patch.object(gatekeeper.labeler, 'load_env',
                               return_value=_env(LLM_MODELS='m-1')), \
             mock.patch.object(gatekeeper.subprocess, 'run', side_effect=must_not_launch), \
             mock.patch.object(gatekeeper.time, 'sleep', lambda *_: None), \
             mock.patch.object(gatekeeper, 'probe_one', return_value=True):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                rc = gatekeeper.main()
        self.assertEqual(rc, gatekeeper.EXIT_VERSION_MISMATCH)
        # 两种 fail-closed 必须能分辨：都是「没启动 labeler」，但一个是 .env 缺配置、
        # 一个是部署配错版本，修法完全不同。
        self.assertNotEqual(rc, gatekeeper.EXIT_NO_MODELS)
        text = err.getvalue()
        self.assertIn('同批部署', text)
        self.assertIn('fail-closed', text)


if __name__ == '__main__':
    unittest.main()
