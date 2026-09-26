#!/usr/bin/env python3
"""daily_metrics.py 的离线单测（每日北极星指标）。

全离线：不联网、不连库、不读 .env、不调 LLM。
复跑：python scripts/test_daily_metrics.py

样本来源：2026-09-26 在 phoenix 实机勘察到的真实格式
（gate.log 行、nginx combined 行、labels.jsonl / labels-imported.jsonl 结构）。
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import daily_metrics as dm  # noqa: E402


def _noop_validate(rec):
    """validate_record 桩：author 为空 → review，否则 ready。"""
    if not (rec.get('author') or '').strip():
        return {'status': 'review', 'reason': '作者为空，自动导入无法判定身份'}
    return {'status': 'ready'}


class ReadOnlySqlGuard(unittest.TestCase):
    """只读守卫（两道）：登记白名单精确放行 + 关键字/函数黑名单兜底。

    结构性优先：query() 只发本模块登记的常量 SQL，未登记一律拒。
    """

    def test_all_registered_statements_pass(self):
        """原 14 条实际发出的语句必须全部放行。"""
        self.assertEqual(len(dm._RAW_STATEMENTS), 14)
        for raw in dm._RAW_STATEMENTS:
            normalized = dm.ReadOnlySql._guard(raw)
            self.assertIn(normalized, dm._ALLOWED_SQL)

    def test_registered_statements_tolerate_whitespace_and_comments(self):
        """登记 SQL 的空白/换行/注释差异不造成假阴性（同一把归一尺子）。"""
        raw = dm._RAW_STATEMENTS[0]
        for variant in (f'  {raw}  ', f'{raw};', raw.replace(' ', '\n'),
                        f'-- c\n{raw}', f'/* c */ {raw}'):
            self.assertEqual(dm.ReadOnlySql._guard(variant),
                             dm._normalize_sql(raw))

    def test_unregistered_select_is_rejected(self):
        """未登记的（哪怕纯读）也必须拒——白名单是结构性约束，不是语法判断。"""
        for sql in ('SELECT 1', 'SELECT * FROM users',
                    'WITH x AS (SELECT 1) SELECT * FROM x'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_writes(self):
        for sql in ('UPDATE t SET a=1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)',
                    'DROP TABLE t', 'TRUNCATE t', 'ALTER TABLE t ADD c int',
                    'UPDATE labeled_books SET author = \'\' WHERE id = 1'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_data_modifying_cte(self):
        """审查表 1.2：数据修改型 CTE 曾被放行，现必须拒。"""
        for sql in (
            'WITH x AS (DELETE FROM labeled_books RETURNING *) SELECT count(*) FROM x',
            'WITH x AS (SELECT 1) DELETE FROM t',
            'WITH x AS (UPDATE labeled_books SET title = \'x\' RETURNING *) SELECT * FROM x',
            'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x',
            'WITH x AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE '
            'RETURNING *) SELECT * FROM x',
        ):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_row_locks(self):
        """审查表 1.2：SELECT … FOR UPDATE/SHARE 曾被放行，现必须拒。"""
        for sql in ('SELECT * FROM t FOR UPDATE',
                    'SELECT * FROM t FOR UPDATE OF t SKIP LOCKED',
                    'SELECT * FROM t FOR SHARE',
                    'SELECT * FROM t FOR NO KEY UPDATE',
                    'SELECT * FROM t FOR KEY SHARE'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_side_effect_functions(self):
        """审查表 1.2：副作用函数曾被放行，现必须拒。"""
        for sql in (
            'SELECT pg_terminate_backend(1)',
            'SELECT pg_cancel_backend(1)',
            'SELECT nextval(\'s\')', "SELECT setval('s', 1)",
            "SELECT lo_import('/etc/passwd')", 'SELECT lo_export(1, \'/tmp/x\')',
            "SELECT lo_unlink(1)", "SELECT pg_read_file('/etc/passwd')",
            "SELECT pg_read_binary_file('/etc/passwd')", "SELECT pg_ls_dir('/')",
            "SELECT set_config('a', 'b', false)",
            'SELECT pg_advisory_lock(1)', 'SELECT pg_advisory_xact_lock(1)',
            "SELECT dblink_exec('c', 'DELETE FROM t')",
        ):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_leading_comment_wrapped_writes(self):
        """审查表 1.2：注释包裹/前导空白/大小写混写的写语句必须拒。"""
        for sql in ('/*x*/ DELETE FROM t', '--hi\nDROP TABLE t',
                    '   INSERT INTO t VALUES (1)', 'DeLeTe FROM t',
                    '/* a /* b */ DELETE FROM t'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_multi_statement(self):
        for sql in ('SELECT 1; DELETE FROM t', 'SELECT 1; --c\nDELETE FROM t'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_other_dangerous_forms(self):
        for sql in ('COPY t TO STDOUT', 'DO $$ BEGIN END $$', '', '   ',
                    '-- only a comment', 'VACUUM t', 'GRANT ALL ON t TO x',
                    'REVOKE ALL ON t FROM x', 'CALL p()', 'LOCK TABLE t',
                    'CREATE TABLE t (id int)', 'REINDEX TABLE t',
                    'ANALYZE t', 'REFRESH MATERIALIZED VIEW v'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_semicolon_inside_string_still_rejected(self):
        """字符串内分号被误杀（假阳性）——安全侧有意保留。"""
        for sql in ("SELECT ';'", 'SELECT $$ a; b $$'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_select_into_rejected(self):
        with self.assertRaises(ValueError):
            dm.ReadOnlySql._guard('SELECT 1 INTO x')

    def test_commented_registered_statement_passes(self):
        """注释里的分号不算多语句（登记语句本身带注释也必须能过）。"""
        raw = dm._RAW_STATEMENTS[0]
        self.assertEqual(dm.ReadOnlySql._guard(f'{raw} -- ; not a statement'),
                         dm._normalize_sql(raw))


class RedactError(unittest.TestCase):
    """O4：错误原文脱敏——去连接串/host、截断到 200 字。"""

    def test_strips_connection_string(self):
        text = dm.redact_error(
            'failed: postgresql://u:secret@db.144-24-10-250.sslip.io:5432/zhaoshu')
        self.assertNotIn('secret', text)
        self.assertNotIn('postgresql://', text)
        self.assertIn('<conn>', text)

    def test_strips_host_and_ip(self):
        self.assertNotIn('db.internal', dm.redact_error('connect to db.internal:5432 failed'))
        self.assertNotIn('10.0.0.5', dm.redact_error('timeout 10.0.0.5:5432'))

    def test_truncates(self):
        self.assertLessEqual(len(dm.redact_error('x' * 500)), 200)

    def test_count_returns_redacted_error(self):
        class BoomSql:
            def scalar(self, query, params=None):
                raise RuntimeError('postgresql://u:pw@h/db unreachable')
        got = dm._count(BoomSql(), 'SELECT count(*)')
        self.assertIn('error', got)
        self.assertNotIn('pw', got['error'])
        self.assertNotIn('postgresql://', got['error'])


class EnvWhitelist(unittest.TestCase):
    """env 按键名白名单逐行读：只取 DATABASE_URL，其余键（含密钥）不进结果。"""

    def test_only_whitelisted_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '.env'
            path.write_text(
                'LLM_API_KEY=sk-secret\n'
                'DATABASE_URL=postgresql://u:p@h/db\n'
                '# comment\n'
                'LABELER_ENGINE_FALLBACK=1\n', encoding='utf-8')
            env = dm.read_env_whitelist(path)
            self.assertEqual(env, {'DATABASE_URL': 'postgresql://u:p@h/db'})
            self.assertNotIn('LLM_API_KEY', env)

    def test_strips_quotes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '.env'
            path.write_text('DATABASE_URL="postgresql://u:p@h/db"\n', encoding='utf-8')
            self.assertEqual(dm.read_env_whitelist(path)['DATABASE_URL'],
                             'postgresql://u:p@h/db')


class ParseGateLog(unittest.TestCase):
    """gate.log 解析：时间戳继承、成功/字数/调用/跳过归因。"""

    NOW = datetime(2026, 9, 27, 0, 40, tzinfo=timezone.utc)

    def _log(self, *lines):
        return '\n'.join(lines)

    def test_success_and_chars_recent(self):
        text = self._log(
            '  [2026-09-27 00:31:34] [pid=1] [书目=X 分段=1/1] 模型 m 尝试 1/2 成功',
            '  80993 字 | 现代言情/青春校园/暗恋成长 | conf 0.99 | 1 次调用',
            '  → 已写入书库',
            '  80498 字 | 古代言情、宅斗、权谋 | conf 0.96 | 1 次调用',
            '  → 已写入书库')
        got = dm.parse_gate_log(text, now=self.NOW)
        self.assertEqual(got['writes'], 2)
        self.assertEqual(got['chars'], [80993, 80498])
        self.assertEqual(got['calls'], [1, 1])

    def test_old_lines_excluded(self):
        text = self._log(
            '  [2026-09-20 00:00:00] [pid=1] [书目=X] 模型 m 成功',
            '  500000 字 | 玄幻 | conf 0.9 | 2 次调用',
            '  → 已写入书库')
        got = dm.parse_gate_log(text, now=self.NOW)
        self.assertEqual(got['writes'], 0)
        self.assertEqual(got['chars'], [])

    def test_skip_buckets(self):
        text = self._log(
            '  [2026-09-27 00:30:00] [pid=1] [书目=X] 开始',
            '  跳过: 候选《九鼎记》（名单《九鼎》上汤豆苗 vs 引擎 我吃西红柿）',
            '  跳过: 候选《猴爪游戏》（名单《猴爪》威廉.雅各布斯 vs 引擎 岂可说）',
            '  跳过（历史被拒 5 次） 狩魔手记 | /books/details1.html',
            '  跳过本轮已失效源: m.cuoceng.com',
            '  文本质量异常(含广告注入),跳过',
            '  书名不符,疑似错书,记入 rejected(…)')
        got = dm.parse_gate_log(text, now=self.NOW)
        skips = dict(got['skips'])
        self.assertEqual(skips['作者不符/错书'], 2)
        self.assertEqual(skips['历史被拒终态'], 1)
        self.assertEqual(skips['源失效'], 1)
        self.assertEqual(skips['文本质量异常'], 1)
        self.assertEqual(skips['书名核验不符'], 1)

    def test_no_timestamp_lines_ignored(self):
        got = dm.parse_gate_log('  500000 字 | 玄幻 | conf 0.9 | 2 次调用',
                                now=self.NOW)
        self.assertEqual(got['chars'], [])


class ParseNginx(unittest.TestCase):
    """nginx combined 解析：只统计窗口内、可限定路径、支持 .gz。"""

    NOW = datetime(2026, 9, 27, 0, 40, tzinfo=timezone.utc)

    def _write(self, tmp, name, rows):
        path = Path(tmp) / name
        path.write_text('\n'.join(rows) + '\n', encoding='utf-8')
        return path

    def test_bytes_and_path_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [
                # 窗口内 /sql，600 字节
                '127.0.0.1 - - [26/Sep/2026:23:00:00 +0800] "POST /sql HTTP/1.1" 200 600 "-" "node"',
                # 窗口内但路径不同，应排除
                '127.0.0.1 - - [26/Sep/2026:23:00:01 +0800] "GET /healthz HTTP/1.1" 200 30 "-" "x"',
                # 窗口外
                '127.0.0.1 - - [20/Sep/2026:10:00:00 +0800] "POST /sql HTTP/1.1" 200 999 "-" "node"',
                # 扫描噪声，不成行
                '64.23.218.208 - - [26/Sep/2026:23:01:00 +0800] "GET /telescope/requests HTTP/1.1" 404 134 "-" "l9scan"',
            ]
            path = self._write(tmp, 'access.log', rows)
            got = dm.parse_nginx_logs((str(path),), now=self.NOW, only_path='/sql')
            self.assertEqual(got['requests'], 1)
            self.assertEqual(got['bytes'], 600)

    def test_all_paths_when_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [
                '127.0.0.1 - - [26/Sep/2026:23:00:00 +0800] "POST /sql HTTP/1.1" 200 600 "-" "node"',
                '127.0.0.1 - - [26/Sep/2026:23:00:01 +0800] "GET /healthz HTTP/1.1" 200 30 "-" "x"',
            ]
            path = self._write(tmp, 'access.log', rows)
            got = dm.parse_nginx_logs((str(path),), now=self.NOW)
            self.assertEqual(got['requests'], 2)
            self.assertEqual(got['bytes'], 630)

    def test_all_files_missing_returns_unavailable_not_zero(self):
        """M2：日志一个都打不开 → null+原因，不是 0（否则把「没量到」伪装成「今日零流量」）。"""
        got = dm.parse_nginx_logs(('/nonexistent/a.log',), now=self.NOW)
        self.assertEqual(got['bytes'], None)
        self.assertEqual(got['requests'], None)
        self.assertFalse(got['available'])
        self.assertEqual(got['opened'], 0)

    def test_partial_missing_still_counts_available_ones(self):
        """部分文件缺失：仍按实到的部分统计，available=True。"""
        with tempfile.TemporaryDirectory() as tmp:
            rows = [
                '127.0.0.1 - - [26/Sep/2026:23:00:00 +0800] "POST /sql HTTP/1.1" 200 600 "-" "node"',
            ]
            path = self._write(tmp, 'access.log', rows)
            got = dm.parse_nginx_logs(('/nonexistent/a.log', str(path)),
                                      now=self.NOW, only_path='/sql')
            self.assertEqual(got['requests'], 1)
            self.assertEqual(got['bytes'], 600)
            self.assertTrue(got['available'])
            self.assertEqual(got['opened'], 1)

    def test_timestamp_is_local_cst_not_utc(self):
        """回归：日志时间戳是 phoenix 本地 CST(+0800)，必须按 +08:00 解析。

        按 UTC 误读会让窗口整体偏移 8h —— 2026-09-26 实测把传输量从 684 MB
        算成 1.9 GB。这里 now=UTC 12:00，本地 12:00 的日志应正好落在窗口内
        （若误按 UTC 解析，它会变成 UTC 12:00 也仍在窗内……故取边界值 8 小时差）。
        """
        # 本地 2026-09-27 08:00（CST）= UTC 2026-09-27 00:00。
        # now 取 UTC 2026-09-27 00:10 ⇒ 该行恰在窗口内（10 分钟前）；
        # 若误按 UTC 解析成未来 8 小时前…… 直接用差 8h 的另一侧验证。
        now = datetime(2026, 9, 27, 0, 10, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            rows = [
                # 本地 2026-09-27 07:00 = UTC 2026-09-26 23:00 ⇒ 距 now 1h10m，在窗口内
                '127.0.0.1 - - [27/Sep/2026:07:00:00 +0800] "POST /sql HTTP/1.1" 200 100 "-" "n"',
                # 本地 2026-09-26 06:00 = UTC 2026-09-25 22:00 ⇒ 距 now 26h，在窗口外
                '127.0.0.1 - - [26/Sep/2026:06:00:00 +0800] "POST /sql HTTP/1.1" 200 200 "-" "n"',
            ]
            path = self._write(tmp, 'access.log', rows)
            got = dm.parse_nginx_logs((str(path),), now=now, only_path='/sql')
            self.assertEqual(got['requests'], 1)
            self.assertEqual(got['bytes'], 100)


class ReviewBacklog(unittest.TestCase):
    """review 积压分类：复用官方判据桩，跳过已导入，按原因计数。"""

    def test_classify(self):
        lines = [
            json.dumps({'url': 'u1', 'title': 'A', 'author': ''}),
            json.dumps({'url': 'u2', 'title': 'B', 'author': '有作者'}),
            json.dumps({'url': 'u3', 'title': 'C', 'author': ''}),
            json.dumps({'url': 'u4', 'title': '已导入', 'author': ''}),   # 在 imported 集合里
            '  ',                                                          # 空行
            '{bad json',                                                   # 损坏
        ]
        imported = {'u4'}
        got = dm.classify_review_backlog(lines, imported, _noop_validate)
        self.assertEqual(got['unimported'], 3)     # u1,u2,u3（损坏行另计）
        self.assertEqual(got['review'], 2)         # u1,u3
        self.assertEqual(got['review_reasons'][0][1], 2)
        self.assertEqual(got['other'].get('json损坏'), 1)
        self.assertEqual(got['other'].get('ready'), 1)

    def test_validate_exception_counted(self):
        def boom(_rec):
            raise RuntimeError('校验器 bug')
        got = dm.classify_review_backlog([json.dumps({'url': 'u', 'author': 'x'})],
                                         set(), boom)
        self.assertEqual(got['other'].get('校验异常'), 1)


class ReadImported(unittest.TestCase):
    def test_reads_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'labels-imported.jsonl'
            path.write_text(
                '{"url": "u1", "title": "A", "at": "2026-09-19 05:51:25"}\n'
                '{"url": "u2"}\n'
                '{bad\n', encoding='utf-8')
            self.assertEqual(dm.read_imported_urls(path), {'u1', 'u2'})


class RenderMarkdown(unittest.TestCase):
    """渲染：中文一页、null 标注、对比箭头。"""

    def _metrics(self, total=506, labeled24=192, size=24508083):
        return {
            'date': '2026-09-27', 'window_hours': 24,
            'generated_at': '2026-09-27T00:40:00+00:00',
            'library': {'labeled_books_total': total, 'labeled_24h': labeled24,
                        'review_backlog': 108,
                        'review_backlog_by_reason': [('作者为空', 68)]},
            'labeling': {'writes_24h_log': 191, 'avg_chars_per_book_24h': 250723,
                         'avg_llm_calls_per_book_24h': 1.0,
                         'avg_llm_tokens_per_book_24h': None,
                         'avg_llm_tokens_note': '待打标侧记 token',
                         'skip_reasons_top5': [('作者不符/错书', 33)]},
            'sources': {'readable_pool_size': 46, 'pool_max_host_share': 0.109,
                        'hit_max_host_share': None,
                        'hit_max_host_share_note': '无按源命中日志',
                        'coverage_baseline': None,
                        'coverage_baseline_note': '待 F3.1'},
            'database': {'size_bytes': size, 'transfer_24h_bytes': 717859283,
                         'transfer_24h_requests': 26416,
                         'transfer_method': 'nginx'},
            'recommendation': {'created_24h': 1, 'shelf_active': 1, 'feedback_24h': 0,
                               'note': '临时库缺推荐数据'},
            'download': {'done_24h': 3, 'failed_24h': 0, 'pending': 501},
        }

    def test_contains_sections_and_null_marks(self):
        md = dm.render_markdown(self._metrics())
        for section in ('# 书径北极星', '## 1. 书库', '## 2. 打标效率',
                        '## 3. 换源', '## 4. 数据库', '## 5. 推荐', '## 附加：下载'):
            self.assertIn(section, md)
        self.assertIn('—（null）', md)          # token / 命中占比 / 覆盖率
        self.assertIn('23.4 MB', md)            # 库大小（字节 → 人类可读）
        self.assertIn('26,416', md)             # 请求数千分位
        self.assertNotIn('postgresql://', md)   # 连接串不进产物
        self.assertNotIn('sk-', md)

    def test_comparison_arrow(self):
        cur = self._metrics(total=506)
        prev = self._metrics(total=500)
        md = dm.render_markdown(cur, prev)
        self.assertIn('↑6', md)                 # 506 - 500

    def test_lower_is_better_arrow(self):
        cur = self._metrics()
        cur['download']['failed_24h'] = 5
        prev = self._metrics()
        prev['download']['failed_24h'] = 0
        md = dm.render_markdown(cur, prev)
        self.assertIn('↑5 差', md)               # failed 上升 = 差

    def test_no_previous_no_arrow(self):
        md = dm.render_markdown(self._metrics())
        self.assertNotIn('↑', md)
        self.assertNotIn('↓', md)

    def test_error_dict_renders_failed_not_raw(self):
        """O4：DB 报错原文不进 markdown——含 error 键的 dict 显示「—（查询失败）」。"""
        metrics = self._metrics()
        metrics['library']['labeled_books_total'] = {
            'error': 'boom: connection to db.internal:5432 failed'}
        md = dm.render_markdown(metrics)
        self.assertIn(dm._FAILED_MARK, md)
        self.assertNotIn('boom', md)
        self.assertNotIn('db.internal', md)
        self.assertNotIn("'error'", md)

    def test_error_dict_via_bytes_fmt(self):
        metrics = self._metrics()
        metrics['database']['size_bytes'] = {'error': 'x'}
        md = dm.render_markdown(metrics)
        self.assertNotIn("'error'", md)

    def test_transfer_unavailable_renders_no_data_mark(self):
        """M2：日志不可读时渲染「无数据」而非 0.0 B。"""
        metrics = self._metrics()
        metrics['database']['transfer_available'] = False
        metrics['database']['transfer_24h_bytes'] = None
        metrics['database']['transfer_24h_requests'] = None
        metrics['database']['transfer_note'] = '日志文件一个都打不开'
        md = dm.render_markdown(metrics)
        self.assertIn(dm._NO_DATA_MARK, md)
        self.assertNotIn('0.0 B', md)


class LoadPrevious(unittest.TestCase):
    def test_picks_latest_earlier(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / '2026-09-25.json').write_text('{"library": {}}', encoding='utf-8')
            (Path(tmp) / '2026-09-26.json').write_text('{"library": {}}', encoding='utf-8')
            got = dm.load_previous(tmp, '2026-09-27')
            self.assertEqual(got, {'library': {}})
            self.assertIsNone(dm.load_previous(tmp, '2026-09-25'))   # 无更早文件

    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(dm.load_previous(tmp, '2026-09-27'))


class NullSql(unittest.TestCase):
    """无连接串：文件侧指标仍算，库侧记 null，不抛。"""

    def test_collect_with_null_sql(self):
        with tempfile.TemporaryDirectory() as tmp:
            labeler = Path(tmp)
            (labeler / 'labels.jsonl').write_text(
                json.dumps({'url': 'u1', 'title': 'A', 'author': ''}) + '\n', encoding='utf-8')
            (labeler / 'labels-imported.jsonl').write_text('', encoding='utf-8')
            (labeler / 'gate.log').write_text(
                '  [2026-09-27 00:31:34] [pid=1] [书目=X] 成功\n'
                '  80993 字 | 言情 | conf 0.99 | 1 次调用\n'
                '  → 已写入书库\n', encoding='utf-8')
            # 用真 import_one（若同目录可见）或回落到 error；两种都不抛
            metrics = dm.collect_metrics(dm._NullSql(), labeler,
                                         ('/nonexistent.log',))
            self.assertIsInstance(metrics, dict)
            self.assertIn('library', metrics)
            self.assertIn('labeling', metrics)
            # 库侧因 NullSql 报 error/None，但结构完整
            self.assertIn('labeled_books_total', metrics['library'])
            # gate.log 文件侧仍算出 1 次写入
            self.assertEqual(metrics['labeling']['writes_24h_log'], 1)


if __name__ == '__main__':
    unittest.main()
