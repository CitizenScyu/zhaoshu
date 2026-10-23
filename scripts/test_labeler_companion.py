#!/usr/bin/env python3
"""labeler.py 的同目录配套文件自检（check_companion_api）单测。

为什么要有这道自检：部署机上这几个 .py 是**分别 scp** 的，而 labeler.py 直接引用它们的三十多个
名字。2026-10-23 差点真踩一次——部署机 /var/lib/zhaoshu-worker 的 douban_list.py 停在 eab792a
（只有 load_done_titles），仓内 labeler.py 已到 30f0581（改调 load_done_index 并把它传给
build_*_queue）。只换 labeler.py 上去，下一轮就在选书阶段炸 AttributeError；而 gatekeeper 的恢复
分支是「探测→重启 labeler→再炸」的无限循环，每圈还白烧最多 FAIL_M 次 25 万字段探测。
仓内既有测试兜不住这个形态：它们永远只看到同一提交里的几个文件。

覆盖：
- 名单来源：两份 REQUIRED_*_API 必须**恰好等于**从 labeler.py 源码反查出的全部
  `douban_list.<名字>` / `labeler_source_policy.<名字>` 引用（多一个=陈旧/错字，少一个=新增引用
  没进名单，两个方向都变红）；名单里的每个名字在仓内对应模块真的存在；无重复且保持字典序；
  COMPANION_MODULES 覆盖的就是这两个真模块（新增配套文件却没进清单会变红）。
- 自检行为：真模块通过；缺名字抛 CompanionTooOld，且**一次报全**所有模块的所有缺失、带上出问题
  那个文件的绝对路径（部署机上要能一眼看出是哪个文件）与「同批部署」的修法；生产默认检查的就是
  import 进来的那几个真模块（钉住默认参数，防被换成假模块后自检永远绿）。
- 事故复现：把真 douban_list 的 load_done_index 删掉（= eab792a 形态），自检必须报出它。
- main 收口：配套不齐时返回 EXIT_COMPANION_TOO_OLD，且**在读 .env 之前**就返回（不选书、不打标）；
  该退出码与 labeler 的 0/1/2、gatekeeper 的 3/4 都不冲突，且两侧字面值相等
  （两边刻意各写一份字面值，故必须有测试钉住它们没漂移）。

全离线：不联网、不连库、不读 .env、不调真模型（main 的用例把 load_env 换成抛异常的替身）。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -t scripts -p 'test_labeler_companion.py'
"""
import contextlib
import io
import os
import re
import sys
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import douban_list  # noqa: E402
import gatekeeper  # noqa: E402
import labeler  # noqa: E402
import labeler_source_policy  # noqa: E402

with open(os.path.join(HERE, 'labeler.py'), encoding='utf-8') as _fh:
    LABELER_SOURCE = _fh.read()

# 唯一的排除项：文件名 douban_list.py 会被反查正则匹到属性名 'py'。它不是接口，故排除；
# 排除表刻意只有一个名字——labeler.py 里再出现别的「<模块名>.<非接口词>」字面就该改措辞，
# 而不是往这张表里加（加一个就少一分「新增引用必须进名单」的约束力）。
NON_API_REFS = frozenset({'py'})

DEPLOYED_DOUBAN_LIST = '/var/lib/zhaoshu-worker/douban_list.py'
DEPLOYED_SOURCE_POLICY = '/var/lib/zhaoshu-worker/labeler_source_policy.py'

# (模块名, 真模块, 名单常量名, 部署机路径)：本文件里所有逐模块断言都按这张表跑，
# 加一个配套文件就在这里加一行（COMPANION_MODULES 的覆盖面由下面一条用例钉住）。
COMPANIONS = (
    ('douban_list', douban_list, 'REQUIRED_DOUBAN_LIST_API', DEPLOYED_DOUBAN_LIST),
    ('labeler_source_policy', labeler_source_policy, 'REQUIRED_SOURCE_POLICY_API', DEPLOYED_SOURCE_POLICY),
)


def _referenced(module_name: str) -> set:
    """从 labeler.py 源码反查对某个配套模块的全部属性引用（含注释与文档串里的写法）。"""
    return set(re.findall(module_name + r'\.([A-Za-z_][A-Za-z0-9_]*)', LABELER_SOURCE))


def _required(module_name: str) -> tuple:
    return dict((name, getattr(labeler, const)) for name, _, const, _ in COMPANIONS)[module_name]


def _fake_module(path: str, names=()) -> types.ModuleType:
    """造一个只有 names 这些属性的假配套模块（其余一律缺失）。"""
    module = types.ModuleType(os.path.basename(path)[:-3])
    module.__file__ = path
    for name in names:
        setattr(module, name, object())
    return module


def _pairs(*fakes):
    """把 (假模块, 名单) 组装成 check_companion_api 收的形态；名单默认取该模块的真名单。"""
    return tuple((module, _required(os.path.basename(module.__file__)[:-3])) for module in fakes)


class RequiredListTest(unittest.TestCase):
    def test_lists_equal_every_reference_in_labeler_source(self):
        """名单必须与源码反查结果**逐名字相等**（两个方向都钉），逐个配套模块各钉一次。

        只钉「引用 ⊆ 名单」的话，名单会单向膨胀成一堆陈旧条目，最后没人敢删也没人信；
        只钉「名单 ⊆ 引用」的话，新增一处 `douban_list.foo` 而忘了进名单就静默漏防——
        而那正是本自检唯一要防的形态。"""
        for module_name, _, const, _ in COMPANIONS:
            with self.subTest(module=module_name):
                referenced = _referenced(module_name) - NON_API_REFS
                required = set(getattr(labeler, const))
                self.assertEqual(referenced - required, set(),
                                 f'这些 {module_name} 引用没进 {const}，配套自检会漏防')
                self.assertEqual(required - referenced, set(),
                                 f'{const} 里这些名字在 labeler.py 已无引用，是陈旧条目（或写错了）')

    def test_non_api_exclusion_is_exactly_the_filename_suffix(self):
        """排除表只有 'py' 且它确实被匹到过：写成别的样子（如 douban_list.<名字>）就该是空集，
        空集说明这张表已经无用、应删；出现第二个元素说明源码里多了非接口字面，要改措辞。"""
        self.assertEqual(_referenced('douban_list') - set(labeler.REQUIRED_DOUBAN_LIST_API),
                         set(NON_API_REFS))

    def test_every_required_name_exists_in_the_repo_module(self):
        """名单对仓内模块逐个 hasattr：错字、被改名、被删掉的条目都在这里变红。"""
        for module_name, module, const, _ in COMPANIONS:
            with self.subTest(module=module_name):
                missing = [n for n in getattr(labeler, const) if not hasattr(module, n)]
                self.assertEqual(missing, [])

    def test_lists_are_deduped_and_sorted(self):
        for module_name, _, const, _ in COMPANIONS:
            with self.subTest(module=module_name):
                names = list(getattr(labeler, const))
                self.assertEqual(len(names), len(set(names)), '名单有重复条目')
                self.assertEqual(names, sorted(names), '名单请按字典序排（比对与 review 都靠这个顺序）')

    def test_companion_modules_covers_exactly_the_real_modules(self):
        """清单覆盖面：新增一个配套模块（labeler.py 开始 import 第四个文件）却没进 COMPANION_MODULES，
        自检就会对它零防护——而测试全绿。这里把「清单里的模块 == 本文件反查过的模块」钉住。"""
        self.assertEqual([module for module, _ in labeler.COMPANION_MODULES],
                         [module for _, module, _, _ in COMPANIONS])
        self.assertEqual([tuple(names) for _, names in labeler.COMPANION_MODULES],
                         [getattr(labeler, const) for _, _, const, _ in COMPANIONS])
        self.assertGreaterEqual(len(labeler.REQUIRED_DOUBAN_LIST_API), 30,
                                '名单短到这个程度说明反查失效了')


class CheckCompanionApiTest(unittest.TestCase):
    def test_passes_on_the_real_modules(self):
        self.assertIsNone(labeler.check_companion_api())
        self.assertIsNone(labeler.check_companion_api(labeler.COMPANION_MODULES))

    def test_default_argument_is_the_real_module_table(self):
        """生产调用是 `check_companion_api()`（不带参数），所以默认值必须就是真模块表。

        默认值若被改成别的（例如某个测试替身或空表），自检会永远绿——这是本护栏唯一
        「静默失效」的路径，故单独钉住。空表尤其阴：遍历零次即通过，看着像「都齐了」。"""
        self.assertEqual(labeler.check_companion_api.__defaults__, (labeler.COMPANION_MODULES,))
        self.assertNotEqual(labeler.COMPANION_MODULES, ())

    def test_missing_names_raise_and_are_all_reported_at_once(self):
        dropped = labeler.REQUIRED_DOUBAN_LIST_API[-2:]
        module = _fake_module(DEPLOYED_DOUBAN_LIST, labeler.REQUIRED_DOUBAN_LIST_API[:-2])
        with self.assertRaises(labeler.CompanionTooOld) as ctx:
            labeler.check_companion_api(_pairs(module))
        message = str(ctx.exception)
        for name in dropped:
            self.assertIn(name, message)          # 一次报全，不是一个一个试
        self.assertIn(f'需要的 {len(dropped)} 个接口', message)
        self.assertIn(DEPLOYED_DOUBAN_LIST, message)   # 指出是哪个文件（部署机上的绝对路径）
        self.assertIn('同批部署', message)              # 指出怎么修

    def test_gaps_in_several_modules_are_reported_together(self):
        """两个配套文件同时停在旧版本时，一次报全（部署机上这才是常态：修一个重启一次太慢）。"""
        stale = (_fake_module(DEPLOYED_DOUBAN_LIST, labeler.REQUIRED_DOUBAN_LIST_API[:-1]),
                 _fake_module(DEPLOYED_SOURCE_POLICY, labeler.REQUIRED_SOURCE_POLICY_API[:-1]))
        with self.assertRaises(labeler.CompanionTooOld) as ctx:
            labeler.check_companion_api(_pairs(*stale))
        message = str(ctx.exception)
        for path in (DEPLOYED_DOUBAN_LIST, DEPLOYED_SOURCE_POLICY):
            self.assertIn(path, message)
        for name in (labeler.REQUIRED_DOUBAN_LIST_API[-1], labeler.REQUIRED_SOURCE_POLICY_API[-1]):
            self.assertIn(name, message)

    def test_source_policy_gap_is_caught_too(self):
        """第二个配套模块单独缺名字也要报（不是只有 douban_list 那一半接上了自检）。"""
        module = _fake_module(DEPLOYED_SOURCE_POLICY, labeler.REQUIRED_SOURCE_POLICY_API[:-1])
        with self.assertRaises(labeler.CompanionTooOld) as ctx:
            labeler.check_companion_api(_pairs(module))
        message = str(ctx.exception)
        self.assertIn(labeler.REQUIRED_SOURCE_POLICY_API[-1], message)
        self.assertIn(DEPLOYED_SOURCE_POLICY, message)

    def test_empty_module_reports_the_whole_list(self):
        module = _fake_module(DEPLOYED_DOUBAN_LIST)
        with self.assertRaises(labeler.CompanionTooOld) as ctx:
            labeler.check_companion_api(_pairs(module))
        message = str(ctx.exception)
        self.assertIn(f'需要的 {len(labeler.REQUIRED_DOUBAN_LIST_API)} 个接口', message)
        for name in labeler.REQUIRED_DOUBAN_LIST_API:
            self.assertIn(name, message)

    def test_module_without_file_attribute_still_reports_something_readable(self):
        """__file__ 缺失（某些打包/替身形态）时不能炸在自检里——自检本身报错比它要报的错更难查。"""
        module = _fake_module(DEPLOYED_DOUBAN_LIST)
        pairs = _pairs(module)          # 先组装（_pairs 要读 __file__），再把它删掉
        del module.__file__
        with self.assertRaises(labeler.CompanionTooOld) as ctx:
            labeler.check_companion_api(pairs)
        self.assertIn('douban_list.py', str(ctx.exception))   # 回落到模块名 + .py

    def test_the_actual_incident_is_caught(self):
        """事故复现：部署机那份 douban_list.py（eab792a）没有 load_done_index。

        真的把属性删掉再恢复（而不是塞 None）——要复现的是 AttributeError 形态。"""
        saved = douban_list.load_done_index
        del douban_list.load_done_index
        try:
            with self.assertRaises(labeler.CompanionTooOld) as ctx:
                labeler.check_companion_api()
            self.assertIn('load_done_index', str(ctx.exception))
        finally:
            douban_list.load_done_index = saved
        self.assertIsNone(labeler.check_companion_api())     # 恢复后照旧放行

    def test_companion_too_old_is_a_runtime_error(self):
        """gatekeeper 用 getattr 动态取这个类来 catch（旧 labeler 可能没有它），
        基类是 RuntimeError 保证任何按 RuntimeError 兜底的调用方也不会漏掉它。"""
        self.assertTrue(issubclass(labeler.CompanionTooOld, RuntimeError))


class MainFailClosedTest(unittest.TestCase):
    def test_main_returns_exit_5_before_reading_env(self):
        """端到端：真模块上删掉一个名字（= 部署机那份旧文件），main 必须在读 .env 之前退出 5。

        刻意不用「patch COMPANION_MODULES」来造缺失：check_companion_api 的默认参数在 def 时
        就绑定了原清单，patch 模块属性对它无效（实测那样写会一路走到 load_env）。删真属性才是
        生产形态，也顺带证明默认参数确实指向真模块。"""
        def must_not_read_env(*a, **kw):
            raise AssertionError('配套不齐时不应读 .env（更不该选书/打标）')

        saved = douban_list.load_done_index
        del douban_list.load_done_index
        try:
            with mock.patch.object(labeler, 'load_env', side_effect=must_not_read_env), \
                 mock.patch.object(sys, 'argv', ['labeler.py']):
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    rc = labeler.main()
        finally:
            douban_list.load_done_index = saved
        self.assertEqual(rc, labeler.EXIT_COMPANION_TOO_OLD)
        text = err.getvalue()
        self.assertIn('错误:', text)
        # 人话里要带缺什么、缺在哪个文件，否则还得去翻代码或翻部署机上的文件。
        self.assertIn('load_done_index', text)
        self.assertIn(os.path.basename(douban_list.__file__), text)

    def test_main_guard_runs_the_real_check_by_default(self):
        """接线钉：main 里必须是**不带参数**地调 check_companion_api()，且排在读 .env 之前、
        抛错就 return（不是 swallow 后继续跑）。

        上面那条用例把清单换成了假模块，所以「改成 check_companion_api(某个替身)」「整段删掉」
        「except 里只打印不返回」三种改法它都照绿，而线上护栏已经没了——本仓已有同型的洞
        （见 scripts/check-worker-contract.test.ts 的接线钉）。"""
        main_src = LABELER_SOURCE[LABELER_SOURCE.index('def main()'):]
        head = main_src[:main_src.index('env = load_env()')]
        self.assertIn('check_companion_api()', head)
        self.assertRegex(head, r'except CompanionTooOld[\s\S]{0,600}?return EXIT_COMPANION_TOO_OLD')


class ExitCodeProtocolTest(unittest.TestCase):
    def test_both_sides_agree_on_the_same_literal(self):
        """两侧刻意各写一份字面值 5（跨模块取常量会要求「新 gatekeeper 配新 labeler」，
        而那正是这个码要报的故障本身）。既然不共享常量，就必须有测试钉住它们没漂移：
        任一侧改成 6，gatekeeper 就认不出这个码，会把它当「异常退出」进恢复循环无限重启。"""
        self.assertEqual(labeler.EXIT_COMPANION_TOO_OLD, 5)
        self.assertEqual(gatekeeper.EXIT_COMPANION_TOO_OLD, labeler.EXIT_COMPANION_TOO_OLD)

    def test_code_does_not_collide_with_any_other_exit_code(self):
        others = {0, 1, 2,                                   # labeler：全成功/部分失败/整轮零成功
                  gatekeeper.EXIT_NO_MODELS,                 # 3：.env 没给模型链
                  gatekeeper.EXIT_VERSION_MISMATCH}          # 4：labeler.py 比 gatekeeper.py 旧
        self.assertNotIn(labeler.EXIT_COMPANION_TOO_OLD, others)
        self.assertEqual(len(others), 5, '退出码集合变了，请连同本用例一起核对语义')


if __name__ == '__main__':
    unittest.main(verbosity=2)
