"""Synthetic done-author gate regressions; no worker main or real services."""
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
import labeler_source_policy as sp


class FakeCli:
    def __init__(self, author='乙作者'):
        self.author = author
        self.calls = []

    def run(self, command, *args):
        self.calls.append((command, args))
        if command != 'search':
            raise AssertionError('unexpected synthetic CLI command')
        title = args[args.index('--title') + 1]
        return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps([
            {'title': title, 'author': self.author, 'source': 'synthetic.example',
             'bookUrl': 'https://synthetic.example/books/1'},
        ]))


class SiteTitleCli(FakeCli):
    """引擎候选书名固定为站点书名（与名单书名不同，模拟《剑来1：少年起微末》→《剑来》）。"""
    def __init__(self, site_title, author='甲作者'):
        super().__init__(author)
        self.site_title = site_title

    def run(self, command, *args):
        self.calls.append((command, args))
        return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps([
            {'title': self.site_title, 'author': self.author, 'source': 'synthetic.example',
             'bookUrl': 'https://synthetic.example/books/1'},
        ]))


class DoneAuthorGate(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.records = self.directory / 'synthetic-done.jsonl'
        stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        # Only supply the genre table dependency, not any matching decision.
        stack.enter_context(mock.patch.dict(sys.modules, {
            'import_one': SimpleNamespace(PRIMARY_GENRES={'悬疑灵异', '轻小说'}),
        }))
        stack.enter_context(mock.patch('urllib.request.urlopen', side_effect=AssertionError('real HTTP forbidden')))
        stack.enter_context(mock.patch('subprocess.run', side_effect=AssertionError('real subprocess forbidden')))
        stack.enter_context(mock.patch('subprocess.Popen', side_effect=AssertionError('real subprocess forbidden')))
        stack.enter_context(mock.patch.object(dl.time, 'sleep', lambda _seconds: None))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.http = mock.Mock(side_effect=AssertionError('retired HTTP must not be called'))
        self.policy = sp.SourcePolicy(builtin_disabled=sp.RETIRED_HOSTS)

    def index(self, rows):
        self.records.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in rows), encoding='utf-8')
        return dl.load_done_index(self.records)

    def resolve(self, candidate, done_index, cli=None, **kwargs):
        result = dl._resolve_candidates([candidate], self.http, done_index=done_index,
                                        engine_cli=cli, source_policy=self.policy, **kwargs)
        self.http.assert_not_called()
        return result

    def test_same_author_alias_and_legacy_rows_skip_before_search(self):
        done = self.index([{'title': '《合成书》', 'site_title': '合成别名', 'author': '[清] 張三 著'}])
        self.assertEqual(set(done), {'合成书', '合成别名'})
        self.assertEqual(dl.load_done_titles(self.records), {'合成书', '合成别名'})
        for title in ('合成书', '合成别名'):
            with self.subTest(title=title):
                cli = FakeCli('张三')
                self.assertEqual(self.resolve({'title': title, 'author': '张三'}, done, cli), [])
                self.assertEqual(cli.calls, [])

    def test_different_author_reaches_real_search_but_not_automatic_acceptance(self):
        done = self.index([{'title': '合成书', 'author': '甲作者'}])
        candidate = {'title': '合成书', 'author': '乙作者', 'origin': '合成名单', 'douban_url': 'synthetic-subject'}
        cli = FakeCli('乙作者')
        queue = self.resolve(candidate, done, cli)
        self.assertEqual(len(cli.calls), 1)
        self.assertEqual(cli.calls[0][1][cli.calls[0][1].index('--author') + 1], '乙作者')
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]['author'], '乙作者')
        self.assertEqual(queue[0]['list_title'], '合成书')
        self.assertEqual(queue[0]['category'], '合成名单')
        self.assertEqual(queue[0]['douban_url'], 'synthetic-subject')
        self.assertTrue(queue[0]['engine'])
        wrong = FakeCli('甲作者')
        self.assertEqual(self.resolve(candidate, done, wrong), [])
        self.assertEqual(len(wrong.calls), 1)

    def test_unknown_or_polluted_author_on_either_side_stays_conservative(self):
        unknowns = [None, '', '未知作者', '（佚名）', '---', '[日]', '合成出版社', '轻小说', 99]
        for unknown in unknowns:
            for old_author, new_author in ((unknown, '乙作者'), ('甲作者', unknown)):
                with self.subTest(old=old_author, new=new_author):
                    done = self.index([{'title': '合成书', 'author': old_author}])
                    cli = FakeCli()
                    self.assertEqual(self.resolve({'title': '合成书', 'author': new_author}, done, cli), [])
                    self.assertEqual(cli.calls, [])

    def test_mixed_records_keep_unknown_and_each_known_author(self):
        rows = [{'title': '合成书', 'author': '甲作者'}, {'title': '合成书', 'author': '乙作者'}]
        known = self.index(rows)
        cli = FakeCli()
        self.assertEqual(self.resolve({'title': '合成书', 'author': '乙作者'}, known, cli), [])
        self.assertEqual(cli.calls, [])
        other = FakeCli('丙作者')
        self.assertEqual(len(self.resolve({'title': '合成书', 'author': '丙作者'}, known, other)), 1)
        for mixed in (rows + [{'title': '合成书'}], [{'title': '合成书'}] + rows):
            done = self.index(mixed)
            self.assertIn('', done['合成书'])
            cli = FakeCli('丙作者')
            self.assertEqual(self.resolve({'title': '合成书', 'author': '丙作者'}, done, cli), [])
            self.assertEqual(cli.calls, [])
        self.assertTrue(dl.is_done_candidate('合成书', '乙作者', {'合成书': set()}))

    def test_bad_records_missing_file_and_bad_encoding(self):
        self.assertEqual(dl.load_done_index(self.records), {})
        self.records.write_text('broken\n[]\nnull\n'
                                + json.dumps({'title': [], 'site_title': '合成别名', 'author': {}}), encoding='utf-8')
        self.assertEqual(dl.load_done_index(self.records), {'合成别名': {''}})
        self.records.write_bytes(b'\xff')
        self.assertEqual(dl.load_done_index(self.records), {})

    def test_legacy_set_is_still_author_independent_even_with_new_index(self):
        done = self.index([{'title': '合成书', 'author': '甲作者'}])
        cli = FakeCli()
        self.assertEqual(self.resolve({'title': '合成书', 'author': '乙作者'}, done, cli,
                                      skip_titles={'合成书'}), [])
        self.assertEqual(cli.calls, [])

    # resolvedone1104：名单书名 ≠ 站点书名时，命中后按站点书名再判已打标 + 本轮去重
    def test_engine_hit_already_labeled_under_site_title_is_skipped(self):
        done = self.index([{'title': '合成书', 'site_title': '合成书', 'author': '甲作者'}])
        cli = SiteTitleCli('合成书', '甲作者')
        self.assertEqual(self.resolve({'title': '合成书1：卷一', 'author': '甲作者'}, done, cli), [])
        self.assertEqual(len(cli.calls), 1)        # 名单书名不在索引里，搜索照常发生
        # 站点书名同名但作者可确认不同 ⇒ 不是同一本，照常入队
        other = SiteTitleCli('合成书', '乙作者')
        queue = self.resolve({'title': '合成书1：卷一', 'author': '乙作者'}, done, other)
        self.assertEqual([e['title'] for e in queue], ['合成书'])

    def test_volumes_resolving_to_one_book_are_queued_once_per_round(self):
        cli = SiteTitleCli('合成书', '甲作者')
        candidates = [{'title': f'合成书{i}：卷{i}', 'author': '甲作者'} for i in (1, 2, 5)]
        queue = dl._resolve_candidates(candidates, self.http, done_index={}, engine_cli=cli,
                                       source_policy=self.policy)
        self.assertEqual([(e['title'], e['list_title']) for e in queue], [('合成书', '合成书1：卷1')])
        self.assertEqual(len(cli.calls), 3)
        # 不传 done_index（旧调用口径）本轮内去重同样生效
        queue = dl._resolve_candidates(candidates, self.http, engine_cli=SiteTitleCli('合成书', '甲作者'),
                                       source_policy=self.policy)
        self.assertEqual(len(queue), 1)

    def test_list_title_in_records_skips_before_search(self):
        done = self.index([{'title': '合成书', 'site_title': '合成书', 'list_title': '合成书1：卷一',
                            'author': '甲作者'}])
        self.assertIn(dl._norm_title('合成书1：卷一'), done)
        cli = SiteTitleCli('合成书', '甲作者')
        self.assertEqual(self.resolve({'title': '合成书1：卷一', 'author': '甲作者'}, done, cli), [])
        self.assertEqual(cli.calls, [])

    def test_labeler_persists_list_title_on_success_record(self):
        source = Path(__file__).with_name('labeler.py').read_text(encoding='utf-8')
        self.assertIn("b_out['list_title'] = list_title", source)

    def test_both_queue_adapters_forward_the_same_index_decision(self):
        done = self.index([{'title': '合成书', 'author': '甲作者'}])
        for adapter in ('douban', 'webnovel'):
            for author, count in (('甲作者', 0), ('乙作者', 1)):
                with self.subTest(adapter=adapter, author=author), contextlib.ExitStack() as stack:
                    candidate = {'title': '合成书', 'author': author, 'douban_url': 'synthetic-subject'}
                    stack.enter_context(mock.patch.object(dl, 'fetch_douban_books', return_value=[candidate]))
                    stack.enter_context(mock.patch.object(dl, 'fetch_qidian_finish_books', return_value=[candidate]))
                    for name in ('fetch_zongheng_complete_books', 'fetch_17k_quanben_books', 'fetch_qidian_rank_books',
                                 'fetch_qimao_rank_books', 'fetch_17k_top_books',
                                 'fetch_jjwxc_finish_books', '_fetch_page', 'fetch_fanqie_finish_books'):
                        stack.enter_context(mock.patch.object(dl, name, return_value=[]))
                    cli = FakeCli(author)
                    if adapter == 'douban':
                        queue = dl.build_douban_queue(self.http, done_index=done, engine_cli=cli, source_policy=self.policy)
                    else:
                        queue = dl.build_webnovel_queue(self.http, include_douban=False, done_index=done,
                                                       engine_cli=cli, source_policy=self.policy)
                    self.assertEqual(len(queue), count)
                    self.assertEqual(len(cli.calls), count)
                    self.http.assert_not_called()

    def test_main_uses_author_index_for_both_adapters_without_running_main(self):
        tree = ast.parse(Path(__file__).with_name('labeler.py').read_text(encoding='utf-8'))
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        loads = [node for node in ast.walk(main) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == 'load_done_index']
        self.assertEqual(len(loads), 1)
        calls = [node for node in ast.walk(main) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute)
                 and node.func.attr in ('build_douban_queue', 'build_webnovel_queue')]
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertFalse(any(keyword.arg == 'skip_titles' for keyword in call.keywords))
            self.assertTrue(any(keyword.arg == 'done_index' and isinstance(keyword.value, ast.Name)
                                and keyword.value.id == 'done_index' for keyword in call.keywords))


if __name__ == '__main__':
    unittest.main()
