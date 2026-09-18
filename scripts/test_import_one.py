#!/usr/bin/env python3
"""import_one.py 的离线单测（打标产物即时导入）。

全离线：不联网、不连库、不读 .env、不调 LLM。数据库用 FakeDb（内存行表）模拟：
- SELECT id, author FROM labeled_books WHERE lower(title)=lower($1) → 返回同书名行
- INSERT ... ON CONFLICT (title_key, author_key) → 以 (lower(title), lower(author))
  为键 upsert 进内存表（与 0002_identity_key.sql 的生成列语义一致）

复跑：python scripts/test_import_one.py
      python -m unittest discover -s scripts -p 'test_import_one.py'
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_one  # noqa: E402


# ---- 基线记录（labeler.py 写进 labels.jsonl 的形态）----
BASE = {
    'title': '测试书', 'site_title': '测试书', 'author': '作者甲',
    'category': '玄幻奇幻', 'status': '完结', 'source': 'book15.net',
    'selected_by': 'webnovel', 'url': 'https://book15.net/books/details1.html',
    'chars': 400000,
    'labels': {
        'title_guess': '测试书', 'text_quality': '正常',
        'genre': '东方玄幻、重生', 'site_title_match': True,
        'site_title_note': '主角与设定吻合',
        'quality': {'overall': 8.5, 'prose': 8, 'worldbuilding': 9, 'pacing': 8,
                    'enjoyment': 8},
    },
}


def record(**overrides):
    rec = json.loads(json.dumps(BASE))          # 深拷贝
    rec.update(overrides)
    return rec


def labels_record(**label_overrides):
    rec = record()
    rec['labels'].update(label_overrides)
    return rec


def validated(rec):
    result = import_one.validate_record(rec)
    assert result['status'] == 'ready', result.get('reason')
    return result['record']


class FakeDb:
    """Neon HTTP SQL 的内存替身；键 = (lower(title), lower(author))。"""

    def __init__(self):
        self.rows = {}          # key -> {'id','title','author','labels','chars_labeled'}
        self.calls = []
        self.fail_on_insert = 0
        self._next_id = 1

    def seed(self, title, author, **extra):
        row = {'id': self._next_id, 'title': title, 'author': author}
        row.update(extra)
        self._next_id += 1
        self.rows[(title.lower(), author.lower())] = row
        return row

    def __call__(self, query, params):
        self.calls.append((query, params))
        if query.startswith('SELECT'):
            title = params[0].lower()
            return {'rows': [dict(row) for row in self.rows.values()
                             if row['title'].lower() == title]}
        if self.fail_on_insert:
            self.fail_on_insert -= 1
            raise RuntimeError('fixture database failure')
        key = (params[0].lower(), params[1].lower())
        row = self.rows.get(key, {'id': self._next_id})
        if key not in self.rows:
            self._next_id += 1
        row.update({'title': params[0], 'author': params[1], 'labels': params[7],
                    'chars_labeled': params[6]})
        self.rows[key] = row
        return {}


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def importer(self, db, url='postgresql://u:p@db.example/neondb', **kwargs):
        return import_one.AutoImporter(url, directory=self.dir, sql_exec=db,
                                       log=lambda *_: None, **kwargs)


# ---- 纯函数：清洗 / 数值 / URL / 书名 ----
class TestCleanAndNumbers(unittest.TestCase):
    def test_clean_string_drops_nul_and_replaces_lone_surrogates(self):
        self.assertEqual(import_one.clean_string('a\0b\ud800c\udc00😀'), 'ab�c�😀')
        self.assertEqual(import_one.clean_string('正常'), '正常')

    def test_clean_json_cleans_keys_and_nested_values(self):
        cleaned = import_one.clean_json({'a\0': ['x\0', {'b\ud800': 1}]})
        self.assertEqual(cleaned, {'a': ['x', {'b�': 1}]})

    def test_parse_quality_rejects_non_explicit_values(self):
        for value in (None, '', '  ', False, True, [], {}, '八分', '0x08', '1e0',
                      -0.1, 10.1, float('nan'), float('inf'), 'Infinity'):
            with self.subTest(value=value):
                self.assertIsNone(import_one.parse_quality(value))

    def test_parse_quality_keeps_valid_values(self):
        for value, expect in ((0, 0), ('0', 0), (' 8.5 ', 8.5), (10, 10), (8.5, 8.5)):
            with self.subTest(value=value):
                self.assertEqual(import_one.parse_quality(value), expect)

    def test_source_url_only_accepts_plain_http_urls(self):
        for value in (None, '', '  ', False, {}, '/book/1', 'javascript:alert(1)',
                      'https://u:p@book15.net/x', 'https://book15.net/空 格'):
            with self.subTest(value=value):
                self.assertIsNone(import_one.source_url(value))
        self.assertEqual(import_one.source_url(' https://book15.net/a '),
                         'https://book15.net/a')

    def test_title_matches_normalizes_forms_only(self):
        self.assertTrue(import_one.title_matches(' 《ＡＢＣ》 ', 'abc'))
        self.assertTrue(import_one.title_matches('测试书', '测试书'))
        self.assertFalse(import_one.title_matches('测试书', '测试书续篇'))
        self.assertFalse(import_one.title_matches('测试', '测试书'))   # 包含不算同一本
        self.assertFalse(import_one.title_matches('', ''))


class TestNormalizeGenre(unittest.TestCase):
    def test_same_cases_as_genre_map_self_test(self):
        cases = (
            ('玄幻奇幻', '东方玄幻、重生、魔道流', '玄幻'),
            ('恐怖灵异', '都市灵异/惊悚悬疑', '悬疑灵异'),
            ('武侠修真', '', '仙侠'),
            ('', '克苏鲁式神秘奇幻、蒸汽朋克、异世界穿越', '奇幻'),
            ('', '仙侠/穿越', '仙侠'),
            ('', '无限流团队作战', '无限流'),
            ('玄幻奇幻', '', '玄幻'),
            ('', '', '其他'),
            ('', '末世废土生存', '科幻'),
            ('', '轻小说风格日常', '轻小说'),
            ('未知站点类', '武侠江湖恩怨', '武侠'),
            ('', '言情女频古风', '言情'),
        )
        for site, llm, expect in cases:
            with self.subTest(case=(site, llm)):
                self.assertEqual(import_one.normalize_genre(site, llm)[0], expect)

    def test_sub_tags_are_bounded_and_deduplicated(self):
        primary, sub = import_one.normalize_genre('', '重生、重生、系统流、轻松、爽文、单女主、群像')
        self.assertEqual(primary, '其他')
        self.assertEqual(len(sub), 5)
        self.assertEqual(sub[0], '重生')
        self.assertEqual(len(set(sub)), len(sub))


class TestNormalizeAuthor(unittest.TestCase):
    def test_plain_author_is_trimmed(self):
        self.assertEqual(import_one.normalize_author('  作者甲 ')[:2], ('ready', '作者甲'))

    def test_entity_author_is_held_for_the_full_importer(self):
        status, value, reason = import_one.normalize_author('埃里克&middot;霍弗')
        self.assertEqual(status, 'review')
        self.assertIn('HTML 实体', reason)
        self.assertEqual(value, '埃里克&middot;霍弗')

    def test_text_v1_skips_entity_interpolation(self):
        self.assertEqual(
            import_one.normalize_author('&middot;', encoding='text-v1')[:2],
            ('ready', '&middot;'))

    def test_unknown_encoding_and_illegal_characters_go_to_review(self):
        self.assertEqual(import_one.normalize_author('作者', encoding='v2')[0], 'review')
        self.assertEqual(import_one.normalize_author('作\0者')[0], 'review')
        self.assertEqual(import_one.normalize_author('作\ud800者')[0], 'review')

    def test_overlong_author_fails(self):
        self.assertEqual(import_one.normalize_author('字' * 201)[0], 'failed')
        self.assertEqual(import_one.normalize_author('😀' * 200)[0], 'ready')

    def test_non_string_author_fails(self):
        self.assertEqual(import_one.normalize_author(None)[0], 'failed')

    def test_empty_author_is_review_not_ready(self):
        # 幂等红线：空作者 → author_key=''，与存量同 title 的非空作者行不冲突。
        for value in ('', '   ', '　'):
            with self.subTest(value=repr(value)):
                status, _, reason = import_one.normalize_author(value)
                self.assertEqual(status, 'review')
                self.assertIn('作者为空', reason)


# ---- validate_record：与 import_labels.mjs 的门对齐 ----
class TestValidateRecord(unittest.TestCase):
    def test_ready_record_carries_aligned_fields(self):
        out = validated(record())
        self.assertEqual(out['title'], '测试书')
        self.assertEqual(out['author'], '作者甲')
        self.assertEqual(out['source_site'], 'book15.net')
        self.assertEqual(out['source_url'], 'https://book15.net/books/details1.html')
        self.assertEqual(out['chars_labeled'], 400000)
        self.assertEqual(out['quality'], 8.5)
        self.assertEqual(out['primary_genre'], '玄幻')
        self.assertEqual(out['sub_tags'], ['东方玄幻', '重生'])

    def test_known_bad_text_quality_is_skipped(self):
        for quality in ('疑似乱码', '大面积重复', '含广告注入'):
            with self.subTest(quality=quality):
                self.assertEqual(
                    import_one.validate_record(labels_record(text_quality=quality))['status'],
                    'skipped')

    def test_unknown_or_non_string_text_quality(self):
        self.assertEqual(
            import_one.validate_record(labels_record(text_quality='不确定'))['status'],
            'review')
        self.assertEqual(
            import_one.validate_record(labels_record(text_quality=False))['status'],
            'failed')
        self.assertEqual(
            import_one.validate_record(labels_record(text_quality=None))['status'],
            'ready')

    def test_site_title_match_must_be_strict_true(self):
        for flag in (False, None, 'true', 1, 0):
            with self.subTest(flag=flag):
                self.assertEqual(
                    import_one.validate_record(labels_record(site_title_match=flag))['status'],
                    'review')

    def test_legacy_guess_path_when_flag_absent(self):
        rec = labels_record()
        rec['labels'].pop('site_title_match')
        self.assertEqual(import_one.validate_record(rec)['status'], 'ready')
        rec['labels']['title_guess'] = '另一本书'
        self.assertEqual(import_one.validate_record(rec)['status'], 'review')

    def test_conflicting_site_and_listed_title_is_review(self):
        self.assertEqual(
            import_one.validate_record(record(title='另一本', site_title='测试书'))['status'],
            'review')

    def test_missing_title_fails(self):
        self.assertEqual(import_one.validate_record(record(title='', site_title=''))['status'],
                         'failed')

    def test_chars_bounds(self):
        for chars in (False, -1, 1.5, 'x', 2147483648):
            with self.subTest(chars=chars):
                self.assertEqual(import_one.validate_record(record(chars=chars))['status'],
                                 'failed')
        for chars in (None, '', '0', 0):
            with self.subTest(chars=chars):
                self.assertEqual(validated(record(chars=chars))['chars_labeled'], 0)

    def test_broken_roots_fail_without_raising(self):
        for value in (None, [], 'x', {}, {'labels': []}, {'labels': {}},
                      record(author=1), record(labels=[])):
            with self.subTest(value=value):
                self.assertIn(import_one.validate_record(value)['status'],
                              ('failed', 'review'))

    def test_invalid_url_is_a_warning_not_a_rejection(self):
        result = import_one.validate_record(record(url='/books/details1.html'))
        self.assertEqual(result['status'], 'ready')
        self.assertTrue(result['warnings'])
        self.assertEqual(result['record']['source_url'], '')

    def test_bad_quality_overall_warns_and_stays_null(self):
        result = import_one.validate_record(labels_record(quality={'overall': False}))
        self.assertEqual(result['status'], 'ready')
        self.assertIsNone(result['record']['quality'])
        self.assertTrue(result['warnings'])


class TestBuildUpsert(unittest.TestCase):
    def test_conflict_target_and_params(self):
        out = validated(record())
        query, params = import_one.build_upsert(out)
        self.assertIn('ON CONFLICT (title_key, author_key) DO UPDATE', query)
        self.assertEqual(len(params), 11)
        self.assertEqual(params[0], '测试书')
        self.assertEqual(params[1], '作者甲')
        self.assertEqual(params[5], 'https://book15.net/books/details1.html')
        self.assertEqual(params[6], 400000)
        self.assertEqual(json.loads(params[7])['title_guess'], '测试书')
        self.assertEqual(params[8], '玄幻')
        self.assertEqual(json.loads(params[9]), ['东方玄幻', '重生'])
        self.assertEqual(params[10], 8.5)
        self.assertNotIn(None, params[:1])

    def test_missing_url_binds_empty_string_and_null_quality(self):
        out = validated(record(url=None, labels={'title_guess': '测试书'}))
        query, params = import_one.build_upsert(out)
        self.assertEqual(params[5], '')
        self.assertIsNone(params[10])
        self.assertIn("COALESCE(NULLIF(EXCLUDED.source_url, ''), labeled_books.source_url)",
                      query)
        self.assertIn('COALESCE(EXCLUDED.quality, labeled_books.quality)', query)
        self.assertNotIn('DROP', query)

    def test_labeled_at_is_only_bumped_when_content_changes(self):
        # 重复导入是真正的 no-op：内容没变就不动 labeled_at（否则书库「最近打标」
        # 排序会被补录整体推到现在）。
        query, _ = import_one.build_upsert(validated(record()))
        self.assertIn('labeled_at = CASE', query)
        self.assertIn('IS DISTINCT FROM EXCLUDED.labels', query)
        self.assertIn('ELSE labeled_books.labeled_at END', query)

    def test_labels_json_has_no_nul_or_lone_surrogates(self):
        out = validated(labels_record(note='a\0b\ud800😀'))
        _, params = import_one.build_upsert(out)
        self.assertEqual(json.loads(params[7])['note'], 'ab�😀')
        params[7].encode('utf-8')        # 可编码 = 不会炸在 HTTP body 上


class TestFindTwin(unittest.TestCase):
    def test_entity_encoded_stored_author_is_a_twin(self):
        row = {'id': 7, 'author': '埃里克&middot;霍弗'}
        self.assertEqual(import_one.find_twin([row], '埃里克·霍弗'), row)

    def test_same_author_is_not_a_twin(self):
        row = {'id': 7, 'author': '埃里克·霍弗'}
        self.assertIsNone(import_one.find_twin([row], '埃里克·霍弗'))

    def test_different_author_is_not_a_twin(self):
        self.assertIsNone(import_one.find_twin([{'id': 7, 'author': '别人'}], '埃里克·霍弗'))

    def test_empty_rows(self):
        self.assertIsNone(import_one.find_twin([], '作者'))
        self.assertIsNone(import_one.find_twin(None, '作者'))


# ---- AutoImporter：幂等 / 失败不阻断 / 标记 ----
class TestAutoImporter(TempDirCase):
    def test_disabled_without_database_url(self):
        db = FakeDb()
        importer = import_one.AutoImporter('', directory=self.dir, sql_exec=db,
                                           log=lambda *_: None)
        self.assertFalse(importer.enabled)
        self.assertEqual(importer.import_record(record()), 'disabled')
        self.assertEqual(db.calls, [])

    def test_env_switch_can_disable_auto_import(self):
        env = {'DATABASE_URL': 'postgresql://u:p@db.example/neondb',
               import_one.AUTO_IMPORT_ENV: '0'}
        importer = import_one.AutoImporter.from_env(env, directory=self.dir,
                                                    log=lambda *_: None)
        self.assertFalse(importer.enabled)

    def test_env_switch_defaults_on(self):
        env = {'DATABASE_URL': 'postgresql://u:p@db.example/neondb'}
        importer = import_one.AutoImporter.from_env(env, directory=self.dir,
                                                    log=lambda *_: None)
        self.assertTrue(importer.enabled)

    def test_second_import_of_same_url_is_a_noop(self):
        db = FakeDb()
        importer = self.importer(db)
        self.assertEqual(importer.import_record(record()), 'imported')
        writes_after_first = len(db.calls)
        self.assertEqual(importer.import_record(record()), 'duplicate')
        self.assertEqual(len(db.calls), writes_after_first)   # 没有新 SQL
        self.assertEqual(len(db.rows), 1)

    def test_upsert_keeps_one_row_for_same_identity(self):
        # 标记层被绕过（例如另一台机器也导过同一本）：身份键冲突 → 更新同一行
        db = FakeDb()
        importer = self.importer(db)
        self.assertEqual(importer.import_record(record()), 'imported')
        importer._imported.clear()
        self.assertEqual(importer.import_record(labels_record(site_title_note='第二次')), 'imported')
        self.assertEqual(len(db.rows), 1)

    def test_marker_file_records_successful_urls_only(self):
        db = FakeDb()
        importer = self.importer(db)
        importer.import_record(record())
        failed = record(url='https://book15.net/books/details2.html')
        db.fail_on_insert = 1
        self.assertEqual(importer.import_record(failed), 'failed')
        markers = [json.loads(line) for line
                   in (self.dir / import_one.MARKER_NAME).read_text(encoding='utf-8').splitlines()]
        self.assertEqual([m['url'] for m in markers], [BASE['url']])

    def test_failure_writes_log_and_does_not_raise(self):
        db = FakeDb()
        db.fail_on_insert = 1
        importer = self.importer(db)
        self.assertEqual(importer.import_record(record()), 'failed')
        log_text = (self.dir / import_one.FAIL_LOG_NAME).read_text(encoding='utf-8')
        self.assertIn(BASE['url'], log_text)
        self.assertIn('fixture database failure', log_text)
        # 失败不阻断：下一条照常导入
        self.assertEqual(importer.import_record(record(url=BASE['url'] + '?x')), 'imported')

    def test_failure_log_never_leaks_the_connection_string(self):
        db = FakeDb()

        def exploding(query, params):
            raise RuntimeError('boom postgresql://u:p@db.example/neondb')

        importer = import_one.AutoImporter('postgresql://u:p@db.example/neondb',
                                           directory=self.dir, sql_exec=db,
                                           log=lambda *_: None)
        importer._sql_exec = exploding
        importer.import_record(record())
        text = (self.dir / import_one.FAIL_LOG_NAME).read_text(encoding='utf-8')
        self.assertNotIn('db.example', text)
        self.assertNotIn(':p@', text)
        self.assertIn('***', text)

    def test_twin_row_skips_write_without_creating_a_second_row(self):
        db = FakeDb()
        # 存量非不动点行：作者是数字实体写法，解码后与本条作者同身份
        db.seed('测试书', '作&#32773;甲')
        importer = self.importer(db)
        self.assertEqual(importer.import_record(record(author='作者甲')), 'twin-skipped')
        inserts = [c for c in db.calls if c[0].startswith('INSERT')]
        self.assertEqual(inserts, [])
        self.assertEqual(len(db.rows), 1)

    def test_empty_author_cannot_insert_a_second_row(self):
        """审查 A.3 红线：库里已有 (测试书, 作者甲)，本轮 17K 给出同书名空作者。

        旧行为：normalize_author('') → ready，author_key='' 与 '作者甲' 不冲突 →
        ON CONFLICT 不触发 → 凭空插入第二行。现在必须 review 且零 SQL。"""
        db = FakeDb()
        db.seed('测试书', '作者甲')
        importer = self.importer(db)
        status = importer.import_record(record(author=''))
        self.assertEqual(status, 'review')
        self.assertEqual(db.calls, [])                 # 校验阶段拦下，连 SELECT 都不发
        self.assertEqual(len(db.rows), 1)
        self.assertEqual(db.rows[('测试书', '作者甲')]['author'], '作者甲')
        self.assertFalse((self.dir / import_one.MARKER_NAME).exists())

    def test_non_empty_author_with_same_title_still_upserts(self):
        """反例对照：作者非空时同 title 仍走 UPSERT（同身份 → 更新同一行，不新增）。"""
        db = FakeDb()
        db.seed('测试书', '作者甲')
        importer = self.importer(db)
        self.assertEqual(importer.import_record(record(author='作者甲')), 'imported')
        self.assertTrue(any(c[0].startswith('INSERT') for c in db.calls))
        self.assertEqual(len(db.rows), 1)

    def test_review_records_are_not_imported(self):
        db = FakeDb()
        importer = self.importer(db)
        status = importer.import_record(labels_record(site_title_match=False))
        self.assertEqual(status, 'review')
        self.assertEqual(db.calls, [])
        self.assertFalse((self.dir / import_one.MARKER_NAME).exists())

    def test_validation_crash_cannot_break_the_loop(self):
        db = FakeDb()
        importer = self.importer(db)

        class Exploding(dict):
            def get(self, key, default=None):
                raise RuntimeError('校验器 bug')

        self.assertEqual(importer.import_record(Exploding()), 'failed')
        self.assertEqual(importer.import_record(record()), 'imported')

    def test_retry_backlog_is_newest_first_and_bounded(self):
        records = []
        for i in range(5):
            rec = record(url=f'https://book15.net/books/details{i}.html',
                         title=f'测试书{i}', site_title=f'测试书{i}')
            rec['labels']['title_guess'] = f'测试书{i}'
            rec['labels']['site_title_note'] = f'第{i}条'
            records.append(rec)
        jsonl = self.dir / 'labels.jsonl'
        jsonl.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in records),
                         encoding='utf-8')
        original = jsonl.read_text(encoding='utf-8')
        db = FakeDb()
        importer = self.importer(db)
        self.assertEqual(importer.retry_backlog(jsonl, limit=2), 2)
        self.assertEqual(sorted(row['title'] for row in db.rows.values()),
                         ['测试书3', '测试书4'])     # 新→旧
        self.assertEqual(jsonl.read_text(encoding='utf-8'), original)   # 不改写断点文件
        # 已导入的不重复补录，且已标记的记录不占配额 → 继续往旧的补
        self.assertEqual(importer.retry_backlog(jsonl, limit=2), 2)
        self.assertEqual(len(db.rows), 4)
        self.assertEqual(importer.retry_backlog(jsonl, limit=2), 1)     # 只剩最后一条
        self.assertEqual(len(db.rows), 5)

    def test_backlog_budget_counts_attempts_not_only_successes(self):
        # 一条一直失败（review）的记录会吃掉一次尝试配额，不能无限扫描整个文件
        records = []
        for i in range(5):
            rec = record(title=f'正常{i}', site_title=f'正常{i}',
                         url=f'https://book15.net/books/details{i}.html')
            rec['labels']['title_guess'] = f'正常{i}'
            records.append(rec)
        stuck = record(title='不可核验', site_title='不可核验',
                       url='https://book15.net/books/details9.html')
        stuck['labels']['site_title_match'] = False                    # → review
        records.append(stuck)                                          # 最新一条：永远 review
        jsonl = self.dir / 'labels.jsonl'
        jsonl.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in records),
                         encoding='utf-8')
        db = FakeDb()
        importer = self.importer(db)
        # attempted=1 撞上 review；attempted=2 补录正常4 → 配额用满即停
        self.assertEqual(importer.retry_backlog(jsonl, limit=2), 1)
        self.assertEqual([row['title'] for row in db.rows.values()], ['正常4'])

    def test_retry_backlog_disabled_or_missing_file(self):
        db = FakeDb()
        importer = self.importer(db)
        self.assertEqual(importer.retry_backlog(self.dir / 'nope.jsonl', limit=5), 0)
        self.assertEqual(importer.retry_backlog(self.dir / 'nope.jsonl', limit=0), 0)

    def test_marker_blocks_reimport_but_force_clears_it(self):
        db = FakeDb()
        importer = self.importer(db)
        self.assertEqual(importer.import_record(record()), 'imported')
        self.assertEqual(importer.import_record(record()), 'duplicate')
        importer.forget_markers()                     # CLI --force 的等价动作
        self.assertEqual(importer.import_record(record()), 'imported')
        self.assertEqual(len(db.rows), 1)             # 仍然只有一行（UPSERT 兜底）

    def test_backlog_default_is_small(self):
        self.assertEqual(import_one.IMPORT_BACKLOG_DEFAULT, 20)


class TestCli(unittest.TestCase):
    def _fixture(self, tmp):
        path = Path(tmp) / 'labels.jsonl'
        path.write_text('\n'.join([
            json.dumps(record(), ensure_ascii=False),
            json.dumps(labels_record(text_quality='疑似乱码'), ensure_ascii=False),
            json.dumps(labels_record(site_title_match=False), ensure_ascii=False),
            '{bad json',
        ]), encoding='utf-8')
        return path

    def test_dry_run_counts_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(import_one.main(['--dry-run', '--file', str(self._fixture(tmp))]), 0)

    def test_dry_run_limit_takes_the_newest_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._fixture(tmp)
            # 最后两条：1 条 review + 1 条坏行（坏行在读取阶段就被跳过，不计入）
            self.assertEqual(import_one.main(
                ['--dry-run', '--file', str(path), '--limit', '2']), 0)

    def test_url_filter_selects_one_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'labels.jsonl'
            path.write_text('\n'.join([
                json.dumps(record(url='https://book15.net/books/details1.html'),
                           ensure_ascii=False),
                json.dumps(record(url='https://book15.net/books/details2.html'),
                           ensure_ascii=False),
            ]), encoding='utf-8')
            self.assertEqual(import_one.main(
                ['--dry-run', '--file', str(path), '--limit', '1']), 0)

    def test_missing_database_url_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._fixture(tmp)
            saved = os.environ.pop('DATABASE_URL', None)
            try:
                with self.assertRaises(SystemExit):
                    import_one.main(['--file', str(path)])
            finally:
                if saved is not None:
                    os.environ['DATABASE_URL'] = saved

    def test_database_failure_does_not_raise_and_logs(self):
        # 真实 CLI 路径 + 数据库不可达：必须 exit 0（打标侧靠这个不被打断），
        # 且失败落在 labels-import-fail.log（不联网：urlopen 被替换）。
        with tempfile.TemporaryDirectory() as tmp:
            path = self._fixture(tmp)
            os.environ['DATABASE_URL'] = 'postgresql://u:p@db.example/neondb'
            try:
                with mock.patch.object(import_one.urllib.request, 'urlopen',
                                       side_effect=OSError('connection refused')):
                    self.assertEqual(import_one.main(
                        ['--file', str(path), '--url', BASE['url']]), 0)
            finally:
                os.environ.pop('DATABASE_URL', None)
            log_text = (Path(tmp) / import_one.FAIL_LOG_NAME).read_text(encoding='utf-8')
            self.assertIn('connection refused', log_text)
            self.assertNotIn('db.example', log_text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
