#!/usr/bin/env python3
"""labeler.py ↔ import_one.py 接线的离线单测（打标完一本即入库）。

全离线：不联网、不连库、不调 LLM、不读真 .env。
  「全离线」由 OfflineGuardMixin 钉死：套件运行期任何真实出网
  （socket.connect / create_connection / getaddrinfo、或 http_get 桩未覆盖的 URL）
  立即抛出 OfflineViolation，消息里点名第一个本仓业务帧
  （`离线违约：labeler.py:228 http_get 试图联网…`）。桩没打全时**当场**失败，
  不会再像修好前那样超时 30s 后才报一个语义无关的 `AssertionError: 2 != 0`。
import_one.AutoImporter 被替换为记录用的假实现，验证三件事：
  1) 每标完一本确实调用一次导入（顺序与候选一致）；
  2) 导入失败/异常**不阻断**打标循环，后面的书照常打标；
  3) 关闸（无 DATABASE_URL / --book / LABELER_AUTO_IMPORT=0）时不碰导入。

复跑：python scripts/test_labeler_import.py
"""
import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import traceback
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_one  # noqa: E402
import labeler  # noqa: E402


# ---- 离线守卫 ----
# 为什么在 TCP 层拦、且为什么继承 BaseException 而不是 Exception：
#   1) 出网入口远不止 labeler.http_get 一个——fetch_label_model_from_db（NEON /sql）、
#      label_book（LLM streaming）、import_one._http_sql、子进程引擎 CLI 都可能对外发包。
#      拦 socket 是唯一能一次覆盖全部入口的位置。
#   2) 更关键：labeler.main() 的打标循环有 `except Exception` 兜底（labeler.py:1386），
#      Exception 类的守卫会被它吞掉、折算成 fail+=1，最后仍是 `2 != 0`——正是本次要修的病。
#      继承 BaseException 才能穿透那层兜底，让违约以原名原栈冒到测试层。
# 代价：违约会中断套件（后续用例不再跑）——这对「离线」这个硬承诺是特性不是缺陷。
class OfflineViolation(BaseException):
    """套件运行期发生真实出网（或桩未覆盖的 URL）时抛出。非 AssertionError 子类，
    以便穿透 labeler.main() / import_one 的 `except Exception` 兜底。"""


# 本仓可能联网的模块文件名（用于「点名谁在出网」，不匹配时退回文件基名）
_PROJECT_MODULES = ('labeler.py', 'import_one.py', 'douban_list.py', 'engine_cli.py')


def _offending_frame() -> str:
    """离出网点最近的第一个本仓业务帧。

    跳过本文件的守卫/夹具帧（_guard / offline_violation / _make_ / _offending_frame /
    _first_project_frame），否则消息会点名守卫自己而不是真正在出网的代码。"""
    skip = {'_guard', 'offline_violation', '_offending_frame', '_first_project_frame',
            'fake_http_get', '_strict_stub'}
    for frame in reversed(traceback.extract_stack()):
        base = os.path.basename(frame.filename)
        if base in _PROJECT_MODULES and frame.name not in skip:
            return f'{base}:{frame.lineno} {frame.name}()'
    for frame in reversed(traceback.extract_stack()):
        base = os.path.basename(frame.filename)
        if base.startswith('test_'):
            return f'{base}:{frame.lineno} {frame.name}()'
    return '（未取到本仓帧）'


def offline_violation(reason: str) -> OfflineViolation:
    return OfflineViolation(f'离线违约：{reason}（调用者 {_offending_frame()}）。'
                            f'本套件承诺全离线——请补桩，别让测试真的发包。')


def _make_socket_guard(entrypoint: str):
    def guard(*args, **kwargs):
        raise offline_violation(f'socket.{entrypoint} 试图真实出网，参数 {args!r}')
    guard.__name__ = f'offline_guard_{entrypoint}'
    return guard


class OfflineGuardMixin:
    """装在 TestCase 的 setUp：拦 TCP/DNS。进程内 patch，无跨用例共享状态。"""

    # connect_ex 在 socket.socket 上，getaddrinfo/create_connection 在 socket 模块上
    _GUARDS = (('connect', socket.socket), ('connect_ex', socket.socket),
               ('create_connection', socket), ('getaddrinfo', socket))

    def install_offline_guard(self):
        for entrypoint, target in self._GUARDS:
            patcher = mock.patch.object(target, entrypoint,
                                        _make_socket_guard(entrypoint))
            patcher.start()
            self.addCleanup(patcher.stop)


class RecordingImporter:
    """记录调用的假导入器；behavior 控制每条记录的结果（可为异常）。"""

    def __init__(self, enabled=True):
        self.enabled = enabled
        self.disabled_reason = '' if enabled else '无 DATABASE_URL'
        self.records = []
        self.backlog_calls = []
        self.behavior = {}

    def status_line(self):
        return '自动导入: 假实现'

    def import_record(self, rec):
        self.records.append(rec)
        outcome = self.behavior.get(rec.get('url'), 'imported')
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def retry_backlog(self, path, limit=import_one.IMPORT_BACKLOG_DEFAULT):
        self.backlog_calls.append((Path(path).name, limit))
        return 0


class FakeAutoImporter:
    last = None
    behavior_template = {}

    @classmethod
    def from_env(cls, env, directory=None, log=print):
        instance = RecordingImporter(enabled=bool(env.get('DATABASE_URL')))
        instance.behavior = dict(cls.behavior_template)
        cls.last = instance
        return instance


def labels_for(title):
    return {'title_guess': title, 'text_quality': '正常', 'genre': '玄幻',
            'site_title_match': True, 'site_title_note': '正文吻合',
            'quality': {'overall': 8}}


# ---- rank 线惰性元数据路径的详情页桩（labeler.py:1236 的 http_get）----
# 48fe774 给 rank 路径新加了「现抓一次详情页」（og:novel 元数据 + 章节列表 + 正文
# 共用同一份 html），本文件没跟着补桩，于是 8 个用例真的在联网。html 桩须同时满足：
#   - parse_book_meta 的三个 og:novel 正则有命中（author/category/status）；
#   - BOOK15.chapters_from_html 解析出 ≥ STUB_MIN_CHAPTERS(10) 章；
# 章节正文由 labeler.fetch_book_text 单独打桩（见 run_main），与本次修复无关。
def _detail_page(chapters: int = 12) -> str:
    body = ''.join(
        f'<dd><a href="/chapter/index100-{i}.html">第{i}章 测试章节</a></dd>'
        for i in range(1, chapters + 1))
    return ('<html><head>'
            '<meta property="og:novel:author" content="测试作者"/>'
            '<meta property="og:novel:category" content="玄幻奇幻"/>'
            '<meta property="og:novel:status" content="连载中"/>'
            f'</head><body><div id="list">{body}</div></body></html>')


class MainHarness(OfflineGuardMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.install_offline_guard()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.books = [
            {'url': '/books/detailsA.html', 'title': '书甲'},
            {'url': '/books/detailsB.html', 'title': '书乙'},
        ]
        FakeAutoImporter.last = None
        FakeAutoImporter.behavior_template = {}

    def write_env(self, **extra):
        lines = ['LLM_API_KEY=test-key-not-real']
        lines += [f'{key}={value}' for key, value in extra.items()]
        (self.dir / '.env').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def stub_http(self, pages=None):
        """打桩 labeler.http_get；只允许 pages 里显式列出的 URL。

        **严格桩**：未列出的 URL 一律判离线违约并点名该 URL。语义 = 「测试没预期的
        出网路径就是违约」——labeler 以后再加一个 http_get 调用，这里当场红，不用等超时。
        """
        allowed = dict(pages or {})
        served = []

        def fake_http_get(url, timeout=30):
            served.append(url)
            if url not in allowed:
                raise offline_violation(
                    f'labeler.http_get 收到未打桩的 URL {url}——'
                    f'测试没预期这条出网路径，请补桩而不是放它联网')
            return allowed[url]
        patcher = mock.patch.object(labeler, 'http_get', fake_http_get)
        patcher.start()
        self.addCleanup(patcher.stop)
        return served

    def run_main(self, argv, detail_pages=None, **env_extra):
        """跑 labeler.main()。第 4 个返回值 served = 实际打桩服务过的 URL 列表。"""
        self.write_env(**env_extra)
        out, err = io.StringIO(), io.StringIO()
        pages = detail_pages
        if pages is None:
            # 默认给「每个候选的详情页」各发一份合成 html（rank 线惰性元数据那一次 GET）
            pages = {labeler.BOOK15.absolute(b['url']): _detail_page() for b in self.books}
        served = self.stub_http(pages)
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler, 'fetch_rank_books', return_value=list(self.books)), \
                mock.patch.object(labeler, 'fetch_book_text',
                                  # 60000 字：rank 线会按 is_stub_candidate 复核，
                                  # 必须 ≥ STUB_MIN_CHARS(50000) 才不被当残本候选跳过。
                                  return_value=('正文' * 30000, 60000)), \
                mock.patch.object(labeler, 'label_book',
                                  side_effect=lambda text, key, models, site_title='', **kw:
                                  (labels_for(site_title), 1)), \
                mock.patch.object(labeler, 'time', mock.Mock()), \
                mock.patch.object(import_one, 'AutoImporter', FakeAutoImporter), \
                mock.patch.object(sys, 'argv', ['labeler.py'] + argv), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        return code, out.getvalue(), err.getvalue(), served

    def clear_labels(self):
        (self.dir / 'labels.jsonl').unlink(missing_ok=True)

    def labels_jsonl(self):
        path = self.dir / 'labels.jsonl'
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line]


DATABASE_URL = 'postgresql://u:p@db.example/neondb'


class TestAutoImportWiring(MainHarness):
    def test_each_labeled_book_is_imported_in_order(self):
        code, out, _, served = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        importer = FakeAutoImporter.last
        self.assertTrue(importer.enabled)
        self.assertEqual([r['url'] for r in importer.records],
                         [labeler.BASE + '/books/detailsA.html',
                          labeler.BASE + '/books/detailsB.html'])
        self.assertEqual(len(self.labels_jsonl()), 2)
        self.assertEqual(out.count('→ 已写入书库'), 2)
        self.assertEqual(importer.backlog_calls, [('labels.jsonl', import_one.IMPORT_BACKLOG_DEFAULT)])
        # rank 线惰性元数据：每本候选恰好抓一次详情页（元数据/章节/正文同一份 html）
        self.assertEqual(served, [labeler.BASE + '/books/detailsA.html',
                                  labeler.BASE + '/books/detailsB.html'])

    def test_backlog_limit_comes_from_env(self):
        self.books = self.books[:1]
        code, _, _, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL,
                                      **{import_one.BACKLOG_ENV: '200'})
        self.assertEqual(code, 0)
        self.assertEqual(FakeAutoImporter.last.backlog_calls, [('labels.jsonl', 200)])

    def test_broken_backlog_limit_falls_back_to_default(self):
        self.books = self.books[:1]
        code, _, _, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL,
                                      **{import_one.BACKLOG_ENV: 'abc'})
        self.assertEqual(code, 0)
        self.assertEqual(FakeAutoImporter.last.backlog_calls,
                         [('labels.jsonl', import_one.IMPORT_BACKLOG_DEFAULT)])

    def test_import_failure_does_not_stop_labeling(self):
        FakeAutoImporter.behavior_template = {
            labeler.BASE + '/books/detailsA.html': RuntimeError('boom')}
        code, out, err, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.labels_jsonl()), 2)      # 后面的书照常打完
        self.assertEqual(len(FakeAutoImporter.last.records), 2)   # 每本都尝试过导入
        self.assertIn('自动导入异常（不阻断打标）', err)
        self.assertEqual(out.count('→ 已写入书库'), 1)     # 乙书不受甲书异常影响

    def test_failed_status_keeps_loop_going(self):
        FakeAutoImporter.behavior_template = {
            labeler.BASE + '/books/detailsA.html': 'failed'}
        code, out, _, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.labels_jsonl()), 2)
        self.assertIn('未自动入库（failed）', out)
        self.assertIn('→ 已写入书库', out)                 # 乙书不受甲书失败影响
        # failed 是异常路径，仍指向 fail log
        self.assertIn('未自动入库（failed），详见 labels-import-fail.log', out)

    def test_review_status_does_not_point_at_the_fail_log(self):
        # 审查 B.4：review/skipped/twin-skipped 根本不写 fail log，指向它会让操作员
        # 以为没发生。应指向 stdout / labels.jsonl。
        FakeAutoImporter.behavior_template = {
            labeler.BASE + '/books/detailsA.html': 'review'}
        code, out, _, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertIn('未自动入库（review），详见 stdout / labels.jsonl', out)
        self.assertNotIn('未自动入库（review），详见 labels-import-fail.log', out)

    def _all_failed(self, count):
        self.books = [{'url': f'/books/detailsF{i}.html', 'title': f'书{i}'}
                      for i in range(count)]
        FakeAutoImporter.behavior_template = {
            labeler.BASE + b['url']: 'failed' for b in self.books}

    def test_consecutive_failures_raise_exactly_one_alert(self):
        # 审查 B.2：连续失败升级——本轮失败达阈值打一行醒目告警（不做 fail-fast）
        self._all_failed(labeler.AUTO_IMPORT_FAILURE_ALERT + 1)
        code, out, _, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(out.count(f'自动导入本轮已失败 {labeler.AUTO_IMPORT_FAILURE_ALERT} 次'), 1)
        self.assertNotIn(f'自动导入本轮已失败 {labeler.AUTO_IMPORT_FAILURE_ALERT + 1} 次', out)

    def test_below_threshold_prints_no_alert(self):
        self._all_failed(labeler.AUTO_IMPORT_FAILURE_ALERT - 1)
        code, out, _, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertNotIn('自动导入本轮已失败', out)


class TestAutoImportDisabled(MainHarness):
    def test_no_database_url_disables_and_warns(self):
        code, _, _, _ = self.run_main(['--no-db-model'])
        self.assertEqual(code, 0)
        importer = FakeAutoImporter.last
        self.assertFalse(importer.enabled)
        self.assertEqual(importer.records, [])
        self.assertEqual(importer.backlog_calls, [])

    def test_dry_run_never_imports_or_backfills(self):
        code, _, _, _ = self.run_main(['--no-db-model', '--dry-run'],
                                      DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(FakeAutoImporter.last.records, [])
        self.assertEqual(FakeAutoImporter.last.backlog_calls, [])

    def test_single_book_mode_is_never_auto_imported(self):
        self.write_env(DATABASE_URL=DATABASE_URL)
        # --book 线不走 rank 惰性元数据，不发详情页 GET（http_get 全程不应被调用）
        served = self.stub_http({})
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler, 'fetch_book_text',
                                  return_value=('正文' * 30000, 60000)), \
                mock.patch.object(labeler, 'label_book',
                                  return_value=({'title_guess': '单本', 'text_quality': '正常'}, 1)), \
                mock.patch.object(labeler, 'time', mock.Mock()), \
                mock.patch.object(import_one, 'AutoImporter', FakeAutoImporter), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--book', '/books/details9.html', '--no-db-model']), \
                contextlib.redirect_stdout(out):
            code = labeler.main()
        self.assertEqual(code, 0)
        self.assertIsNone(FakeAutoImporter.last)          # --book 根本不构造导入器
        self.assertEqual(len(self.labels_jsonl()), 1)
        self.assertEqual(served, [])


class TestOfflineGuardIsEffective(OfflineGuardMixin, unittest.TestCase):
    """守卫自身必须真的能拦住出网，否则「全离线」只是句空话。

    三个用例分别钉：裸 socket 被拦且点名调用者；http_get 桩没打时以「离线违约」
    而非超时报 `2 != 0`；桩漏掉某个 URL 时点名该 URL。后两个正是件1 的变异形态。
    """

    def setUp(self):
        super().setUp()
        self.install_offline_guard()

    def test_raw_socket_connect_is_blocked_with_a_named_caller(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1)
            with self.assertRaises(OfflineViolation) as ctx:
                sock.connect(('192.0.2.1', 80))    # TEST-NET-1；守卫应在发包前拦下
        message = str(ctx.exception)
        self.assertIn('离线违约', message)
        self.assertIn('socket.connect', message)
        self.assertIn('test_labeler_import.py', message)

    def test_missing_http_get_stub_fails_loudly_not_by_timeout(self):
        """变异钉（件2 验收）：http_get 不打桩 = 漏了一个出网调用。

        修好前这里会真实发包、超时 30s、最后只剩 `AssertionError: 2 != 0`；
        有守卫后必须当场以「离线违约」失败，且点名 labeler.py:228 http_get。
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        data = Path(tmp.name)
        (data / '.env').write_text(
            'LLM_API_KEY=test-key-not-real\n'
            'DATABASE_URL=postgresql://u:p@db.example/neondb\n', encoding='utf-8')
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(data)}), \
                mock.patch.object(labeler, 'fetch_rank_books',
                                  return_value=[{'url': '/books/detailsA.html', 'title': '书甲'}]), \
                mock.patch.object(labeler, 'fetch_book_text',
                                  return_value=('正文' * 30000, 60000)), \
                mock.patch.object(labeler, 'label_book',
                                  return_value=(labels_for('书甲'), 1)), \
                mock.patch.object(labeler, 'time', mock.Mock()), \
                mock.patch.object(sys, 'argv', ['labeler.py', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(OfflineViolation) as ctx:
                labeler.main()
        message = str(ctx.exception)
        self.assertIn('离线违约', message)
        self.assertIn('labeler.py', message)
        self.assertIn('http_get()', message)
        # urllib.request 走 socket.create_connection（TCP 层），不是等到超时
        self.assertIn('socket.', message)

    def test_unlisted_url_in_stub_is_named_and_blocked(self):
        """桩覆盖不到的新 URL：点名该 URL（不用等发包超时）。"""
        class _Probe(OfflineGuardMixin, unittest.TestCase):
            def runTest(self):
                pass
        probe = _Probe()
        probe.setUp()
        try:
            patcher = mock.patch.object(labeler, 'http_get', self._strict_stub({}))
            patcher.start()
            probe.addCleanup(patcher.stop)
            with self.assertRaises(OfflineViolation) as ctx:
                labeler.http_get('https://book15.net/books/details1.html')
        finally:
            probe.doCleanups()
        self.assertIn('details1.html', str(ctx.exception))

    @staticmethod
    def _strict_stub(allowed):
        def fake_http_get(url, timeout=30):
            if url not in allowed:
                raise offline_violation(f'labeler.http_get 收到未打桩的 URL {url}')
            return allowed[url]
        return fake_http_get


class TestEnvQuoting(MainHarness):
    """load_env 必须与 import_one.py CLI 的 --env 解析同款：剥掉取值两侧的引号。

    现场事故（2026-09-19 部署）：.env 里写 `DATABASE_URL="postgresql://…"`（dotenv 常见写法），
    不剥引号时 urlsplit 得到 scheme `"postgresql` → 自动导入报「不是 postgres 连接串」静默失败。
    """

    def _load_env(self):
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}):
            return labeler.load_env()

    def test_quoted_values_are_unquoted(self):
        self.write_env(DATABASE_URL='"postgresql://u:p@db.example/neondb"')
        env = self._load_env()
        self.assertEqual(env['DATABASE_URL'], 'postgresql://u:p@db.example/neondb')
        # 与 import_one.py 的解析结果一致（同款规范化）。
        self.assertEqual(
            env['DATABASE_URL'],
            import_one.AutoImporter.from_env({'DATABASE_URL': env['DATABASE_URL']}).database_url,
        )

    def test_single_quoted_and_unquoted_values_are_equivalent(self):
        self.write_env(DATABASE_URL="'postgresql://u:p@db.example/neondb'")
        self.assertEqual(self._load_env()['DATABASE_URL'], 'postgresql://u:p@db.example/neondb')
        self.write_env(DATABASE_URL='postgresql://u:p@db.example/neondb')
        self.assertEqual(self._load_env()['DATABASE_URL'], 'postgresql://u:p@db.example/neondb')

    def test_quoted_url_is_accepted_by_the_import_channel(self):
        """剥引号后 _http_sql 的 scheme 校验必须通过（回归：现场就是这个校验报的错）。"""
        self.write_env(DATABASE_URL='"postgresql://u:p@db.example/neondb"')
        importer = import_one.AutoImporter(self._load_env()['DATABASE_URL'])
        parsed = urllib.parse.urlsplit(importer.database_url)
        self.assertIn(parsed.scheme, ('postgres', 'postgresql'))
        self.assertTrue(parsed.hostname)


if __name__ == '__main__':
    unittest.main(verbosity=2)
