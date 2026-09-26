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
    """只读守卫：SQL 层必须拒写、拒多语句。"""

    def test_accepts_select_and_with(self):
        self.assertTrue(dm.ReadOnlySql._guard('SELECT 1'))
        self.assertTrue(dm.ReadOnlySql._guard('  with x as (select 1) select * from x  '))
        self.assertTrue(dm.ReadOnlySql._guard('SELECT 1;'))  # 单个尾分号允许

    def test_rejects_writes(self):
        for sql in ('UPDATE t SET a=1', 'DELETE FROM t', 'INSERT INTO t VALUES (1)',
                    'DROP TABLE t', 'TRUNCATE t', 'ALTER TABLE t ADD c int'):
            with self.assertRaises(ValueError):
                dm.ReadOnlySql._guard(sql)

    def test_rejects_multi_statement(self):
        with self.assertRaises(ValueError):
            dm.ReadOnlySql._guard('SELECT 1; DELETE FROM t')
        # 注释里的分号不算多语句
        self.assertEqual(dm.ReadOnlySql._guard('SELECT 1 -- ; not a statement'),
                         'SELECT 1')


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

    def test_missing_file_is_skipped(self):
        got = dm.parse_nginx_logs(('/nonexistent/a.log',), now=self.NOW)
        self.assertEqual(got, {'requests': 0, 'bytes': 0})


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
