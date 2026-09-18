#!/usr/bin/env python3
"""labeler.py ↔ import_one.py 接线的离线单测（打标完一本即入库）。

全离线：不联网、不连库、不调 LLM、不读真 .env。
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
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_one  # noqa: E402
import labeler  # noqa: E402


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


class MainHarness(unittest.TestCase):
    def setUp(self):
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

    def run_main(self, argv, **env_extra):
        self.write_env(**env_extra)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler, 'fetch_rank_books', return_value=list(self.books)), \
                mock.patch.object(labeler, 'fetch_book_text',
                                  return_value=('正文' * 6000, 20000)), \
                mock.patch.object(labeler, 'label_book',
                                  side_effect=lambda text, key, models, site_title='', **kw:
                                  (labels_for(site_title), 1)), \
                mock.patch.object(labeler, 'time', mock.Mock()), \
                mock.patch.object(import_one, 'AutoImporter', FakeAutoImporter), \
                mock.patch.object(sys, 'argv', ['labeler.py'] + argv), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        return code, out.getvalue(), err.getvalue()

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
        code, out, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        importer = FakeAutoImporter.last
        self.assertTrue(importer.enabled)
        self.assertEqual([r['url'] for r in importer.records],
                         [labeler.BASE + '/books/detailsA.html',
                          labeler.BASE + '/books/detailsB.html'])
        self.assertEqual(len(self.labels_jsonl()), 2)
        self.assertEqual(out.count('→ 已写入书库'), 2)
        self.assertEqual(importer.backlog_calls, [('labels.jsonl', import_one.IMPORT_BACKLOG_DEFAULT)])

    def test_backlog_limit_comes_from_env(self):
        self.books = self.books[:1]
        self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL,
                      **{import_one.BACKLOG_ENV: '200'})
        self.assertEqual(FakeAutoImporter.last.backlog_calls, [('labels.jsonl', 200)])

    def test_import_failure_does_not_stop_labeling(self):
        FakeAutoImporter.behavior_template = {
            labeler.BASE + '/books/detailsA.html': RuntimeError('boom')}
        code, out, err = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.labels_jsonl()), 2)      # 后面的书照常打完
        self.assertEqual(len(FakeAutoImporter.last.records), 2)   # 每本都尝试过导入
        self.assertIn('自动导入异常（不阻断打标）', err)
        self.assertEqual(out.count('→ 已写入书库'), 1)     # 乙书不受甲书异常影响

    def test_failed_status_keeps_loop_going(self):
        FakeAutoImporter.behavior_template = {
            labeler.BASE + '/books/detailsA.html': 'failed'}
        code, out, _ = self.run_main(['--no-db-model'], DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.labels_jsonl()), 2)
        self.assertIn('未自动入库（failed）', out)
        self.assertIn('→ 已写入书库', out)                 # 乙书不受甲书失败影响


class TestAutoImportDisabled(MainHarness):
    def test_no_database_url_disables_and_warns(self):
        code, out, _ = self.run_main(['--no-db-model'])
        self.assertEqual(code, 0)
        importer = FakeAutoImporter.last
        self.assertFalse(importer.enabled)
        self.assertEqual(importer.records, [])
        self.assertEqual(importer.backlog_calls, [])

    def test_dry_run_never_imports_or_backfills(self):
        code, out, _ = self.run_main(['--no-db-model', '--dry-run'],
                                     DATABASE_URL=DATABASE_URL)
        self.assertEqual(code, 0)
        self.assertEqual(FakeAutoImporter.last.records, [])
        self.assertEqual(FakeAutoImporter.last.backlog_calls, [])

    def test_single_book_mode_is_never_auto_imported(self):
        self.write_env(DATABASE_URL=DATABASE_URL)
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler, 'fetch_book_text',
                                  return_value=('正文' * 6000, 20000)), \
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
