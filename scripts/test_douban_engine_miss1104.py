"""engmiss1104：引擎干净 miss 跨轮记忆（合成数据，不起真实 CLI/HTTP）。"""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import douban_list as dl
import labeler
import labeler_source_policy as sp


class Cli:
    """returncode/stdout 可配的合成引擎 CLI；默认返回作者不符的候选（= 干净 miss）。"""
    def __init__(self, returncode=0, author='乙作者', stdout=None):
        self.returncode = returncode
        self.author = author
        self.stdout = stdout
        self.calls = []

    def run(self, command, *args):
        self.calls.append((command, args))
        if command != 'search':
            raise AssertionError('unexpected synthetic CLI command')
        title = args[args.index('--title') + 1]
        out = self.stdout if self.stdout is not None else json.dumps([
            {'title': title, 'author': self.author, 'source': 'synthetic.example',
             'bookUrl': 'https://synthetic.example/books/1'}])
        return SimpleNamespace(returncode=self.returncode, stderr='', stdout=out)


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class EngineMissMemoTest(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.dir = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.path = self.dir / dl.ENGINE_MISS_FILENAME
        stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        stack.enter_context(mock.patch('urllib.request.urlopen', side_effect=AssertionError('real HTTP forbidden')))
        stack.enter_context(mock.patch('subprocess.run', side_effect=AssertionError('real subprocess forbidden')))
        self.sleeps = []
        stack.enter_context(mock.patch.object(dl.time, 'sleep', self.sleeps.append))
        self.out = io.StringIO()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.http = mock.Mock(side_effect=AssertionError('retired HTTP must not be called'))
        self.policy = sp.SourcePolicy(builtin_disabled=sp.RETIRED_HOSTS)
        self.clock = Clock()

    def memo(self, ttl=3600):
        return dl.EngineMissMemo.load(self.path, ttl, clock=self.clock)

    def resolve(self, cli, memo, books=None):
        books = books or [{'title': '合成书', 'author': '甲作者'}]
        return dl._resolve_candidates([dict(b) for b in books], self.http, engine_cli=cli,
                                      source_policy=self.policy, engine_miss=memo)

    def test_clean_miss_is_skipped_next_round_until_ttl(self):
        for cli_kwargs in ({'returncode': 1}, {'returncode': 0, 'author': '乙作者'}):
            with self.subTest(**cli_kwargs):
                self.path.unlink(missing_ok=True)
                memo = self.memo()
                first = Cli(**cli_kwargs)
                self.assertEqual(self.resolve(first, memo), [])
                self.assertEqual(len(first.calls), 1)
                memo.save()
                # 下一轮（新进程）读回：TTL 内不再调 CLI，照常计入 miss，摘要带计数
                self.out.truncate(0)
                second = Cli(**cli_kwargs)
                self.assertEqual(self.resolve(second, self.memo()), [])
                self.assertEqual(second.calls, [])
                self.assertIn('1 本近期已搜无果，本轮未重搜', self.out.getvalue())
                self.assertIn('未命中 1 本', self.out.getvalue())
                # 过期后重搜
                self.clock.now += 3601
                third = Cli(**cli_kwargs)
                self.resolve(third, self.memo())
                self.assertEqual(len(third.calls), 1)
                self.clock.now -= 3601

    def test_key_includes_list_author(self):
        memo = self.memo()
        self.resolve(Cli(), memo)
        cli = Cli(author='丙作者')
        queue = self.resolve(cli, memo, [{'title': '合成书', 'author': '丙作者'}])
        self.assertEqual(len(cli.calls), 1)
        self.assertEqual(len(queue), 1)

    def test_hits_errors_and_bad_output_are_not_recorded(self):
        memo = self.memo()
        self.assertEqual(len(self.resolve(Cli(author='甲作者'), memo)), 1)
        self.resolve(Cli(returncode=2), memo)
        self.resolve(Cli(stdout='not json'), memo)
        self.resolve(Cli(stdout='{}'), memo)
        self.assertEqual(memo.misses, {})
        self.assertFalse(memo.dirty)
        memo.save()
        self.assertFalse(self.path.exists())

    def test_engine_disabled_mid_round_does_not_record_rest(self):
        memo = self.memo()
        books = [{'title': '合成书', 'author': '甲作者'}, {'title': '另一本', 'author': '甲作者'}]
        cli = Cli(returncode=2)
        self.resolve(cli, memo, books)
        self.assertEqual(len(cli.calls), 1)
        self.assertEqual(memo.misses, {})

    def test_ttl_zero_disables_everything(self):
        self.assertEqual(dl.resolve_engine_miss_ttl({dl.ENGINE_MISS_TTL_ENV: '0'}), 0)
        memo = self.memo(ttl=0)
        for _ in range(2):
            cli = Cli()
            self.resolve(cli, memo)
            self.assertEqual(len(cli.calls), 1)
        memo.save()
        self.assertFalse(self.path.exists())

    def test_load_drops_expired_and_tolerates_corrupt_file(self):
        key = dl.EngineMissMemo.key('合成书', '甲作者')
        old = dl.EngineMissMemo.key('旧书', '')
        self.path.write_text(json.dumps({'version': 1, 'misses': {
            key: self.clock.now - 10, old: self.clock.now - 7200, 'bad': 'x'}}), encoding='utf-8')
        memo = self.memo()
        self.assertEqual(set(memo.misses), {key})
        self.assertTrue(memo.recent('《合成书》', '甲作者'))
        for raw in (b'\xff', b'[]', b'{"misses": []}', b'broken'):
            self.path.write_bytes(raw)
            self.assertEqual(self.memo().misses, {})
        # 原子写落盘后可读回，且不留临时文件
        memo.record('新书', '')
        memo.save()
        self.assertIn(dl.EngineMissMemo.key('新书', ''), self.memo().misses)
        self.assertEqual([p.name for p in self.dir.iterdir()], [dl.ENGINE_MISS_FILENAME])

    def test_resolve_ttl(self):
        self.assertEqual(dl.resolve_engine_miss_ttl({}), dl.ENGINE_MISS_TTL_SEC)
        self.assertEqual(dl.resolve_engine_miss_ttl({dl.ENGINE_MISS_TTL_ENV: ' 120 '}), 120)
        self.assertEqual(dl.resolve_engine_miss_ttl({dl.ENGINE_MISS_TTL_ENV: 'abc'}), dl.ENGINE_MISS_TTL_SEC)
        self.assertEqual(dl.resolve_engine_miss_ttl(None), dl.ENGINE_MISS_TTL_SEC)

    def test_no_memo_keeps_old_behaviour(self):
        for _ in range(2):
            cli = Cli()
            self.resolve(cli, None)
            self.assertEqual(len(cli.calls), 1)

    def test_policy_blocked_book15_does_not_sleep(self):
        books = [{'title': f'合成书{i}', 'author': '甲作者'} for i in range(3)]
        self.resolve(Cli(), self.memo(), books)
        self.assertEqual(self.sleeps, [])

    def test_main_wires_memo_into_both_adapters_and_saves(self):
        tree = ast.parse(Path(__file__).with_name('labeler.py').read_text(encoding='utf-8'))
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        calls = [node for node in ast.walk(main) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute)
                 and node.func.attr in ('build_douban_queue', 'build_webnovel_queue')]
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertTrue(any(k.arg == 'engine_miss' for k in call.keywords))
        saves = [node for node in ast.walk(main) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == 'save'
                 and isinstance(node.func.value, ast.Name) and node.func.value.id == 'engine_miss']
        # 选书后一次 + resolvedmemo1112 split_queue 后记终态一次
        self.assertEqual(len(saves), 2)


class FetchFailBackoffTest(EngineMissMemoTest):
    """fetchfail1110：引擎命中但取文源失效放弃的书按 base·2^(n-1) 退避（封顶 7 天），成功清除。"""

    def memo(self, ttl=3600, base=100):
        return dl.EngineMissMemo.load(self.path, ttl, clock=self.clock, fetch_fail_base_sec=base)

    def test_backoff_doubles_and_caps(self):
        memo = self.memo(base=dl.FETCH_FAIL_BASE_SEC)
        self.assertEqual([memo.fetch_backoff_sec(n) for n in (1, 2, 3, 4, 5, 9)],
                         [12 * 3600, 24 * 3600, 48 * 3600, 96 * 3600, 7 * 86400, 7 * 86400])

    def test_skip_within_backoff_then_research(self):
        memo = self.memo()
        self.assertEqual(memo.record_fetch_fail('合成书', '甲作者'), 1)
        memo.save()
        cli = Cli(author='甲作者')
        self.out.truncate(0)
        self.assertEqual(self.resolve(cli, self.memo()), [])
        self.assertEqual(cli.calls, [])
        self.assertIn('1 本近期取文源失效，退避中未重搜', self.out.getvalue())
        self.assertNotIn('未命中 1 本', self.out.getvalue())
        self.clock.now += 101
        self.assertEqual(len(self.resolve(cli, self.memo())), 1)
        # 第二次失败退避翻倍：100s 内跳过，200s 后才重搜
        memo = self.memo()
        self.assertEqual(memo.record_fetch_fail('合成书', '甲作者'), 2)
        self.clock.now += 150
        self.assertTrue(memo.fetch_backoff('合成书', '甲作者'))
        self.clock.now += 60
        self.assertFalse(memo.fetch_backoff('合成书', '甲作者'))

    def test_clear_on_success_and_persist(self):
        memo = self.memo()
        memo.record_fetch_fail('合成书', '甲作者')
        memo.record('别的书', '')
        memo.save()
        memo = self.memo()
        self.assertTrue(memo.fetch_backoff('《合成书》', '甲作者'))
        memo.clear_fetch_fail('合成书', '甲作者')
        self.assertTrue(memo.dirty)
        memo.save()
        memo = self.memo()
        self.assertFalse(memo.fetch_backoff('合成书', '甲作者'))
        self.assertTrue(memo.recent('别的书', ''))

    def test_disabled_and_independent_switches(self):
        self.assertEqual(dl.resolve_fetch_fail_base({dl.FETCH_FAIL_BASE_ENV: '0'}), 0)
        self.assertEqual(dl.resolve_fetch_fail_base({}), dl.FETCH_FAIL_BASE_SEC)
        self.assertEqual(dl.resolve_fetch_fail_base({dl.FETCH_FAIL_BASE_ENV: 'x'}), dl.FETCH_FAIL_BASE_SEC)
        off = self.memo(base=0)
        self.assertEqual(off.record_fetch_fail('合成书', '甲作者'), 0)
        self.assertFalse(off.fetch_backoff('合成书', '甲作者'))
        # 引擎 miss 关、取文退避开：照样读写 fetch_fail
        only = self.memo(ttl=0)
        only.record_fetch_fail('合成书', '甲作者')
        only.save()
        self.assertTrue(self.memo(ttl=0).fetch_backoff('合成书', '甲作者'))
        # 取文退避关：读回保留旧记录、不判退避
        self.assertFalse(self.memo(base=0).fetch_backoff('合成书', '甲作者'))

    def test_corrupt_fetch_fail_entries_ignored(self):
        key = dl.EngineMissMemo.key('合成书', '甲作者')
        self.path.write_text(json.dumps({'version': 1, 'misses': {}, 'fetch_fail': {
            key: [self.clock.now - 10, 1], 'a': 'x', 'b': [1, 0], 'c': [1.0, 'n'],
            'old': [self.clock.now - 30 * 86400, 3]}}), encoding='utf-8')
        memo = self.memo()
        self.assertEqual(set(memo.fetch_fail), {key})

    def test_main_notes_fetch_result(self):
        """labeler 主循环：源失效放弃记退避、打标成功清除（经 _note_fetch_result 即时落盘）。"""
        memo = self.memo()
        labeler._note_fetch_result(memo, ('合成书', '甲作者'),
                                   labeler.EngineSourceGaveUp('a.example', 'no_source', 'x'))
        self.assertTrue(self.memo().fetch_backoff('合成书', '甲作者'))
        labeler._note_fetch_result(memo, ('合成书', '甲作者'), None)
        self.assertFalse(self.memo().fetch_backoff('合成书', '甲作者'))
        labeler._note_fetch_result(None, ('合成书', '甲作者'), None)
        labeler._note_fetch_result(memo, None, None)



class ResolvedMemoTest(EngineMissMemoTest):
    """resolvedmemo1112：引擎命中即已打标/钉子户的名单书，有效期内不再发引擎搜索。"""

    def memo(self, ttl=3600, resolved=100):
        return dl.EngineMissMemo.load(self.path, ttl, clock=self.clock, resolved_ttl_sec=resolved)

    def done_index(self):
        # 已打标记录按站点书名「合成书」记；名单书名「合成书·卷一」搜索前判不成已打标
        return {dl._norm_title('合成书'): {'甲作者'}}

    def resolve_done(self, cli, memo):
        return dl._resolve_candidates([{'title': '合成书·卷一', 'author': '甲作者'}], self.http,
                                      engine_cli=cli, source_policy=self.policy, engine_miss=memo,
                                      done_index=self.done_index())

    def site_cli(self):
        return Cli(author='甲作者', stdout=json.dumps([
            {'title': '合成书', 'author': '甲作者', 'source': 'synthetic.example',
             'bookUrl': 'https://synthetic.example/books/1'}]))

    def test_done_hit_recorded_then_skipped_until_ttl(self):
        memo = self.memo()
        first = self.site_cli()
        self.assertEqual(self.resolve_done(first, memo), [])
        self.assertEqual(len(first.calls), 1)
        self.assertIn('引擎命中书已打标或本轮已入队，跳过', self.out.getvalue())
        self.assertTrue(memo.resolved_recent('合成书·卷一', '甲作者'))
        memo.save()
        # 下轮：有效期内不搜、不计 miss，摘要带计数
        self.out.seek(0)
        self.out.truncate(0)
        again = self.site_cli()
        self.assertEqual(self.resolve_done(again, self.memo()), [])
        self.assertEqual(again.calls, [])
        self.assertIn('1 本近期命中即已打标/终态，本轮未重搜', self.out.getvalue())
        self.assertIn('未命中 0 本', self.out.getvalue())
        # 过期后重搜
        self.clock.now += 101
        late = self.site_cli()
        self.resolve_done(late, self.memo())
        self.assertEqual(len(late.calls), 1)

    def test_queued_duplicate_not_recorded(self):
        memo = self.memo()
        books = [{'title': '合成书·卷一', 'author': '甲作者'}, {'title': '合成书·卷二', 'author': '甲作者'}]
        cli = self.site_cli()
        queue = dl._resolve_candidates([dict(b) for b in books], self.http, engine_cli=cli,
                                       source_policy=self.policy, engine_miss=memo)
        self.assertEqual(len(queue), 1)
        self.assertIn('本轮已入队', self.out.getvalue())
        self.assertEqual(memo.resolved, {})

    def test_disabled_and_persist(self):
        self.assertEqual(dl.resolve_resolved_ttl({}), dl.RESOLVED_TTL_SEC)
        self.assertEqual(dl.resolve_resolved_ttl({dl.RESOLVED_TTL_ENV: '0'}), 0)
        off = self.memo(resolved=0)
        off.record_resolved('甲', '乙')
        self.assertFalse(off.resolved_recent('甲', '乙'))
        self.assertFalse(off.dirty)
        # 仅 resolved 开（miss/fetch_fail 关）也读写
        only = dl.EngineMissMemo.load(self.path, 0, clock=self.clock, resolved_ttl_sec=100)
        only.record_resolved('甲', '乙')
        only.save()
        self.assertTrue(dl.EngineMissMemo.load(self.path, 0, clock=self.clock,
                                               resolved_ttl_sec=100).resolved_recent('甲', '乙'))
        # 旧记忆文件（无 resolved 键）与坏条目
        key = dl.EngineMissMemo.key('甲', '乙')
        self.path.write_text(json.dumps({'version': 1, 'misses': {},
                                         'resolved': {key: self.clock.now - 1, 'x': 'bad',
                                                      'old': self.clock.now - 1000}}), encoding='utf-8')
        self.assertEqual(set(self.memo().resolved), {key})
        self.path.write_text(json.dumps({'version': 1, 'misses': {}}), encoding='utf-8')
        self.assertEqual(self.memo().resolved, {})

    def test_main_records_terminal_engine_items_after_split(self):
        src = Path(__file__).with_name('labeler.py').read_text(encoding='utf-8')
        i = src.index('queue = queue[:args.limit]')
        tail = src[i:i + 900]
        self.assertIn('skipped_done + skipped_pinned', tail)
        self.assertIn("b.get('engine')", tail)
        self.assertIn('record_resolved', tail)
        self.assertIn('resolved_ttl_sec=douban_list.resolve_resolved_ttl(env)', src)


if __name__ == '__main__':
    unittest.main()
