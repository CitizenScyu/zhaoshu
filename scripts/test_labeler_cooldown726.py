#!/usr/bin/env python3
"""726：常规选书阶段接入跨轮冷却载体（DeadHostMemory）的离线合成测试。

钉住的契约（任务 726）：
  * worker 式装配（= main() 选书段同一顺序：DeadHostMemory.load → _build_source_policy
    → labeler.SOURCE_POLICY → bridged http_get → fetch_douban_books）不调 main() 本体；
  * 第一轮：选书期名单 host 持续失败达阈值 → 经 sink 真实落盘 labels-dead-hosts.json；
  * 第二轮：独立装配在选书前即识别冷却，相关 HTTP 调用 = 0（传输层炸弹证明未发请求）；
    （listpolicy1110 改口径：名单页走 list_scope ⇒ 只在本轮「名单冷却」、不落侧车，书源判死/
    停用不拦名单页；上两条现只对取文口径的裸 http_get 成立）
  * TTL 到期恢复资格；retired（book15 一族）与运维停用永不复活；
  * 正常合法源仍可尝试；正常 miss（拿到页面但无结果）不记失败、不进侧车；
  * TTL<=0 只关临时冷却，停用门照常；
  * 选书与打标共用同一状态文件（文件名/目录选择一致；打标段消费路径已有
    test_labeler_speed.TestMainRecallsDeadHosts 覆盖，此处只钉状态文件同一性）。

隔离声明（先核再跑）：
  * HTTP：所有用例 patch labeler.urllib.request.urlopen（假传输 / URLError / 炸弹），
    任何真实联网尝试都会被假件接住或触发 AssertionError；
  * CLI/子进程：patch douban_list.subprocess.run 为炸弹，且不构造 EngineCli
    （engine_fallback_enabled({}) 恒 False，见 guard 用例）；
  * DB/模型：不调 resolve_models/load_env/main/label_book；env 一律显式空 dict
    （parse_disabled_hosts 显式 dict = 唯一来源，不回退 os.environ，见 guard 用例）；
  * 不读真实 .env：数据目录是 tempfile；时钟经 now= 参数与 TTL 偏移控制；
    sleep 全部 patch 为 no-op。

复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -t scripts -p 'test_labeler_cooldown726.py'
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import douban_list  # noqa: E402
import labeler  # noqa: E402
import labeler_source_policy as sp  # noqa: E402

# 豆瓣 tag 页实测结构缩写（同 test_douban_list.DOUBAN_TAG_HTML：3 条有效 + 1 坏行）。
DOUBAN_TAG_HTML = """<ul class="subject-list">
<li class="subject-item">
  <div class="pic"><a class="nbg" href="https://book.douban.com/subject/37444272/"><img src="x.jpg" width="90"></a></div>
  <div class="info">
    <h2><a href="https://book.douban.com/subject/37444272/" title="我在废土世界扫垃圾">我在废土世界扫垃圾</a></h2>
    <div class="pub">有花在野 / 广东旅游出版社</div>
    <div class="star clearfix"><span class="rating_nums">9.3</span></div>
  </div>
</li>
<li class="subject-item">
  <div class="pic"><a class="nbg" href="https://book.douban.com/subject/25676982/"><img src="y.jpg" width="90"></a></div>
  <div class="info">
    <h2><a href="https://book.douban.com/subject/25676982/" title="盗墓笔记">盗墓笔记</a></h2>
    <div class="pub">南派三叔 / 中国友谊出版公司</div>
  </div>
</li>
<li class="subject-item">
  <div class="info">
    <h2><a href="https://book.douban.com/subject/1/" title="缺 pub 的条目">缺 pub 的条目</a></h2>
  </div>
</li>
<li class="subject-item">
  <div class="info"><h2>没有链接标题的坏条目</h2></div>
</li>
</ul>"""


def _bomb_urlopen(*args, **kwargs):
    raise AssertionError('真实 HTTP 尝试未被隔离（urlopen 被调用）')


def _bomb_run(*args, **kwargs):
    raise AssertionError('引擎 CLI 子进程未被隔离（subprocess.run 被调用）')


def _fail_urlopen(*args, **kwargs):
    raise urllib.error.URLError('synthetic offline failure')


class Harness(unittest.TestCase):
    """worker 式装配 + 全隔离传输层；保存/恢复全局 SOURCE_POLICY。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.sidecar = self.dir / labeler.DEAD_HOSTS_FILENAME
        self._prev_policy = labeler.SOURCE_POLICY
        self.addCleanup(self._restore_policy)
        sleep_patch = mock.patch.object(labeler.time, 'sleep')
        sleep_patch.start()
        self.addCleanup(sleep_patch.stop)
        run_patch = mock.patch.object(douban_list.subprocess, 'run', _bomb_run)
        run_patch.start()
        self.addCleanup(run_patch.stop)

    def _restore_policy(self):
        labeler.SOURCE_POLICY = self._prev_policy

    def _assemble(self, ttl=3600, env=None):
        """main() 选书段同款装配顺序（不调 main 本体）。"""
        env = {} if env is None else env
        mem = (labeler.DeadHostMemory.load(self.sidecar, ttl_sec=ttl)
               if ttl > 0 else None)
        policy = labeler._build_source_policy(env, mem, ttl, self.dir)
        labeler.SOURCE_POLICY = policy
        return mem, policy

    def _bridged(self, scoped=True):
        # 与 main() 选书段逐字同构：名单源完整 URL 经 BOOK15.absolute 透传给 http_get，
        # listpolicy1110 起包在 SOURCE_POLICY.list_scope() 里。scoped=False = 取文口径的裸 http_get。
        def bridged(path):
            if not scoped or labeler.SOURCE_POLICY is None:
                return labeler.http_get(labeler.BOOK15.absolute(path))
            with labeler.SOURCE_POLICY.list_scope():
                return labeler.http_get(labeler.BOOK15.absolute(path))
        return bridged

    def _fetch_douban(self, urlopen_fake, scoped=True):
        with mock.patch.object(labeler.urllib.request, 'urlopen', urlopen_fake):
            with contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                return douban_list.fetch_douban_books(self._bridged(scoped))


class TestIsolationGuards(Harness):
    """先证明隔离：无引擎旁路、无进程环境泄漏。"""

    def test_engine_fallback_off_with_empty_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('LABELER_ENGINE_FALLBACK', None)
            self.assertFalse(douban_list.engine_fallback_enabled({}))

    def test_explicit_env_dict_is_sole_source_no_os_environ_leak(self):
        with mock.patch.dict(os.environ,
                             {sp.DISABLED_HOSTS_ENV: 'leak.example'}, clear=False):
            self.assertEqual(sp.parse_disabled_hosts({}), ())


class TestSelectionCooldownRoundTrip(Harness):
    """listpolicy1110 起：名单页失败只在本轮「名单冷却」，不落侧车；书源判死不拦名单页。"""

    def test_main_bridged_uses_list_scope(self):
        """main() 的 bridged 与 Harness._bridged 同构（源码级钉住，防回退成裸 lambda）。"""
        src = Path(labeler.__file__).read_text(encoding='utf-8')
        body = src[src.index('            def bridged(path):'):]
        body = body[:body.index('done_index = douban_list.load_done_index')]
        self.assertIn('with SOURCE_POLICY.list_scope():', body)
        self.assertIn('http_get(BOOK15.absolute(path))', body)

    def test_round1_list_failures_cool_within_round_only(self):
        """名单 host 持续失败：第 3 次最终失败起本轮余下名单页零请求，但不落侧车、不进书源冷却。"""
        mem, policy = self._assemble()
        calls = []

        def fail(req, timeout=30):
            calls.append(req.full_url)
            raise urllib.error.URLError('synthetic offline failure')

        books = self._fetch_douban(fail)
        self.assertEqual(books, [])
        self.assertEqual(sp.COOLDOWN_FAIL_THRESHOLD, 3)
        self.assertEqual(len(calls), 3 * (1 + labeler.HTTP_RETRY))   # 13 个 tag 只真打前 3 个
        self.assertFalse(self.sidecar.exists())
        self.assertEqual(policy.blocked('book.douban.com'), (False, ''))
        with policy.list_scope():
            self.assertEqual(policy.blocked('book.douban.com'), (True, '名单冷却'))

    def test_round2_book_source_dead_does_not_block_list_pages(self):
        """侧车里判死的 host（取文口径）照样拉名单页；取文口径仍冷却。"""
        mem = labeler.DeadHostMemory(self.sidecar, ttl_sec=3600)
        mem.add('book.douban.com', now=labeler.time.time())
        mem.save()
        seen = []

        def ok_urlopen(req, timeout=30):
            seen.append(req.full_url)
            return io.BytesIO(DOUBAN_TAG_HTML.encode('utf-8'))

        mem2, policy2 = self._assemble()          # 新“进程”：重新 load 同一文件
        self.assertIn('book.douban.com', mem2.dead_hosts(now=labeler.time.time()))
        self.assertEqual(len(self._fetch_douban(ok_urlopen)), 3)
        self.assertEqual(len(seen), 13)
        self.assertEqual(policy2.blocked('book.douban.com'), (True, '冷却中'))
        self.assertEqual(self._fetch_douban(_bomb_urlopen, scoped=False), [])

    def test_disabled_host_lists_still_fetched_but_book15_never(self):
        """停用清单（env/运维）只管取文：名单页放行；book15 一族在名单口径下也照拦。"""
        _, policy = self._assemble(env={sp.DISABLED_HOSTS_ENV: 'book.douban.com'})
        self.assertTrue(policy.disable('ops.example', 'ops', now=1.0))
        with policy.list_scope():
            self.assertEqual(policy.blocked('book.douban.com'), (False, ''))
            self.assertEqual(policy.blocked('ops.example'), (False, ''))
            for h in sp.BOOK15_HOSTS:
                self.assertEqual(policy.blocked(h), (True, '停用'))
                policy.record_success(h)
                self.assertEqual(policy.blocked(h), (True, '停用'))
        self.assertEqual(policy.blocked('book.douban.com'), (True, '停用'))
        self.assertEqual(policy.blocked('ops.example'), (True, '停用'))

    def test_list_counts_isolated_from_book_source_cooldown(self):
        """名单页成功不替书源清冷却；书源失败计数不被名单页计入。"""
        _, policy = self._assemble()
        for _ in range(sp.COOLDOWN_FAIL_THRESHOLD):
            policy.record_failure('a.example', 'x', now=1.0)
        self.assertEqual(policy.blocked('a.example'), (True, '冷却中'))
        with policy.list_scope():
            policy.record_success('a.example')
            policy.record_failure('b.example')
        self.assertEqual(policy.blocked('a.example'), (True, '冷却中'))
        self.assertEqual(policy.fail_count('b.example'), 0)
        # 名单页一次成功即清名单计数
        with policy.list_scope():
            for _ in range(2):
                policy.record_failure('c.example')
            policy.record_success('c.example')
            policy.record_failure('c.example')
            self.assertEqual(policy.blocked('c.example'), (False, ''))
        hosts = json.loads(self.sidecar.read_text(encoding='utf-8'))['hosts']
        self.assertEqual(set(hosts), {'a.example'})      # 只有取文口径的判死落侧车

    def test_expired_ttl_restores_but_retired_never_revives(self):
        """TTL 过期 → 名单 host 恢复资格（真实尝试）；book15 retired 恸不复活。"""
        mem = labeler.DeadHostMemory(self.sidecar, ttl_sec=3600)
        mem.add('book.douban.com', now=labeler.time.time() - 3600 - 60)
        mem.save()
        seen = []

        def ok_urlopen(req, timeout=30):
            seen.append(req.full_url)
            return io.BytesIO(DOUBAN_TAG_HTML.encode('utf-8'))

        mem3, policy3 = self._assemble()
        self.assertFalse(policy3.blocked('book.douban.com')[0])
        books = self._fetch_douban(ok_urlopen)
        self.assertEqual(len(books), 3)             # 13 个 tag 都真实抓到了
        self.assertEqual(len(seen), 13)
        # retired：到期/成功都不复活
        for h in sp.BOOK15_HOSTS:
            policy3.record_success(h)
            self.assertEqual(policy3.blocked(h), (True, '停用'))
        self.assertFalse(policy3.enable(sp.BOOK15_HOST))

    def test_ops_disabled_host_never_revives_across_rounds(self):
        """运维停用（labels-source-disabled.json）跨轮持久；到期只影响冷却，不动停用。"""
        _, pol1 = self._assemble()
        self.assertTrue(pol1.disable('ops.example', 'ops', now=1.0))
        mem2, pol2 = self._assemble()               # 新一轮
        self.assertEqual(pol2.blocked('ops.example'), (True, '停用'))

    def test_healthy_source_tried_and_normal_miss_not_punished(self):
        """合法源照常尝试；正常 miss（拿到页面但无结果）不记失败、不落侧车。"""
        empty_html = '<html><body>no subject items</body></html>'
        calls = []

        def empty_urlopen(req, timeout=30):
            calls.append(req.full_url)
            return io.BytesIO(empty_html.encode('utf-8'))

        mem, policy = self._assemble()
        books = self._fetch_douban(empty_urlopen)
        self.assertEqual(books, [])
        self.assertEqual(len(calls), 13)             # 全部真实尝试了
        self.assertFalse(self.sidecar.exists())      # 正常 miss 不落侧车
        self.assertFalse(policy.blocked('book.douban.com')[0])
        self.assertEqual(policy.fail_count('book.douban.com'), 0)

    def test_ttl_zero_disables_only_cooldown(self):
        """TTL<=0：冷却整条关（不计数不落盘），停用门照常。"""
        mem, policy = self._assemble(ttl=0)          # mem=None（同 main 关闸形态）
        self.assertIsNone(mem)
        self._fetch_douban(_fail_urlopen)            # 13 个 tag 全失败也不记
        self.assertFalse(self.sidecar.exists())
        self.assertFalse(policy.blocked('book.douban.com')[0])
        self.assertEqual(policy.blocked(sp.BOOK15_HOST), (True, '停用'))

    def test_selection_and_labeling_share_same_state_file(self):
        """选书阶段落的状态即打标阶段读的状态：同文件名、同 mem.dead_hosts 口径。"""
        self.assertEqual(labeler.DEAD_HOSTS_FILENAME, 'labels-dead-hosts.json')
        self._assemble()                             # 装配（sink 才接了侧车）
        self._fetch_douban(_fail_urlopen, scoped=False)   # 取文口径失败才落盘
        self.assertTrue(self.sidecar.exists())
        mem = labeler.DeadHostMemory.load(self.sidecar, ttl_sec=3600)
        remembered = mem.dead_hosts(now=labeler.time.time())
        self.assertIn('book.douban.com', remembered)
        # 打标段 preseed 用法（main：source_giveups.dead.update(remembered)）
        tracker = labeler.SourceGiveupTracker(labeler.DEAD_HOST_GIVEUPS, dead=remembered)
        self.assertEqual(tracker.dead, remembered)


if __name__ == '__main__':
    unittest.main(verbosity=2)
