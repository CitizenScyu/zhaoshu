"""T5 wiring contract: offline, synthetic data, exact cooked TS SQL parity."""
import re
import unittest
from pathlib import Path
from unittest import mock
import import_one
from test_import_one import TempDirCase, record, validated


def ts_sql(start):
    text = (Path(__file__).resolve().parents[1] / 'src/lib/importer-enqueue.ts').read_text(encoding='utf-8')
    template = text.split(start, 1)[1].split('`);', 1)[0]
    values = []
    def bind(match):
        values.append(match.group(0))
        return '$' + str(len(values))
    return re.sub(r'\$\{[^}]+\}', bind, template).replace('\\\\', '\\')


class Wiring(TempDirCase):
    def test_exact_sql_and_policy_bindings(self):
        with mock.patch.dict(import_one.os.environ, {'LABELER_DOWNLOAD_POLICY_VERSION': ' synthetic-v2 '}):
            query, params = import_one.build_upsert(validated(record()))
            self.assertEqual(query, ts_sql('result = firstRow(await sql`'))
            self.assertEqual(params[11:], ['builtin', None, '', 'synthetic-v2', 'synthetic-v2', '', True])
            query, params = import_one.build_ensure_system_task(42)
            self.assertEqual(query, ts_sql('const result = firstRow(await sql`'))
            self.assertEqual(params, [42, 'builtin', None, '', 'synthetic-v2', 'synthetic-v2', ''])
        self.assertEqual(import_one.FIND_LABELED_BOOK_SQL,
                         '\n    SELECT id FROM labeled_books\n    WHERE' + ts_sql('const rows = rowsOf(await sql`\n    SELECT id FROM labeled_books\n    WHERE'))

    def test_atomic_failure_leaves_no_marker_and_retry_succeeds(self):
        calls = []
        def execute(q, p):
            calls.append(q)
            if 'WITH upserted' in q and len(calls) == 2:
                raise RuntimeError('synthetic task constraint failure')
            return {'rows': []}
        importer = self.importer(execute)
        self.assertEqual(importer.import_record(record()), 'failed')
        self.assertFalse(importer.marker_path.exists())
        self.assertEqual(importer.import_record(record()), 'imported')
        self.assertEqual(sum('WITH upserted' in q for q in calls), 2)

    def test_duplicate_repairs_without_labels_and_failure_is_retryable(self):
        calls = []
        fail = [True]
        def execute(q, p):
            calls.append(q)
            if 'WITH target' in q and fail[0]:
                fail[0] = False
                raise RuntimeError('synthetic ledger failure')
            return {'rows': [{'id': 42}]}
        importer = self.importer(execute)
        importer._imported.add(record()['url'])
        self.assertEqual(importer.import_record(record()), 'failed')
        self.assertEqual(importer.import_record(record()), 'duplicate')
        self.assertFalse(any('INSERT INTO labeled_books' in q for q in calls))
        self.assertFalse(importer.marker_path.exists())

    def test_duplicate_missing_identity_and_review_do_not_enqueue(self):
        calls = []
        def execute(q, p):
            calls.append(q)
            return {'rows': []}
        importer = self.importer(execute)
        importer._imported.add(record()['url'])
        self.assertEqual(importer.import_record(record()), 'failed')
        self.assertEqual(len(calls), 1)
        rec = record(author='')
        self.assertEqual(importer.import_record(rec), 'review')
        self.assertEqual(len(calls), 1)

if __name__ == '__main__':
    unittest.main()
