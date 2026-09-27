#!/usr/bin/env python3
"""labeler.py「被拒冷却后移」的离线单测（lblreplay42）。

背景：被拒的书不写 labels.jsonl（断点续传认不出），被拒次数又不到钉子户阈值，于是每次
重启都从名单头重新跑同一批作者冲突最密集的书（deploylbl41c-report.md §87–95），约 40 分钟
0 产出。本组用例锁死修复行为：

- 拒收记录统一带 ISO UTC 时间戳 `rejected_at`（write_rejection）；旧行无该字段视为「时间未知」。
- 近 LABELER_REJECT_COOLDOWN_S 秒内被拒过的书不跳过，而是移到待处理队尾（split_queue），
  两组各自保持原相对顺序。
- 冷却外 / 时间未知 → 不后移；冷却 ≤ 0（含 env=0）→ 关闸，队列顺序与改前逐项相同。
- done 与钉子户的判定完全不变。

全离线：不联网、不调 LLM。复跑：
    python scripts/test_labeler_replay.py
    python -m unittest discover -s scripts -p 'test_labeler_replay.py'
"""
import datetime
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402


def write_jsonl(path: Path, rows) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        for row in rows:
            f.write((row if isinstance(row, str)
                     else json.dumps(row, ensure_ascii=False)) + '\n')


class TestResolveRejectCooldown(unittest.TestCase):
    """env 解析：显式解析、非法值回退默认、0/负=关闭（照 resolve_dead_host_ttl 那套）。"""

    def test_missing_env_is_default(self):
        self.assertEqual(labeler.resolve_reject_cooldown({}),
                         labeler.REJECT_COOLDOWN_SEC)

    def test_empty_string_is_default(self):
        self.assertEqual(
            labeler.resolve_reject_cooldown({labeler.REJECT_COOLDOWN_ENV: '   '}),
            labeler.REJECT_COOLDOWN_SEC)

    def test_non_integer_falls_back_to_default(self):
        self.assertEqual(
            labeler.resolve_reject_cooldown({labeler.REJECT_COOLDOWN_ENV: 'abc'}),
            labeler.REJECT_COOLDOWN_SEC)

    def test_zero_is_kept_as_disable(self):
        self.assertEqual(
            labeler.resolve_reject_cooldown({labeler.REJECT_COOLDOWN_ENV: '0'}), 0)

    def test_negative_is_kept(self):
        self.assertEqual(
            labeler.resolve_reject_cooldown({labeler.REJECT_COOLDOWN_ENV: '-5'}), -5)

    def test_explicit_value_wins(self):
        self.assertEqual(
            labeler.resolve_reject_cooldown({labeler.REJECT_COOLDOWN_ENV: '3600'}),
            3600)

    def test_none_env_is_default(self):
        self.assertEqual(labeler.resolve_reject_cooldown(None),
                         labeler.REJECT_COOLDOWN_SEC)


class TestWriteRejection(unittest.TestCase):
    """拒收记录写入：统一打上 ISO UTC 时间戳；已带值时不覆盖。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'labels-rejected.jsonl'

    def _rows(self):
        return [json.loads(ln) for ln in
                self.path.read_text(encoding='utf-8').splitlines() if ln.strip()]

    def test_stamps_iso_utc_when_missing(self):
        before = datetime.datetime.now(datetime.timezone.utc)
        labeler.write_rejection(self.path, {'url': labeler.BASE + '/books/details1.html',
                                            'reason': '字数不足'})
        after = datetime.datetime.now(datetime.timezone.utc)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        stamp = rows[0].get(labeler.REJECTED_AT_FIELD)
        self.assertIsInstance(stamp, str)
        parsed = labeler._parse_iso_utc(stamp)
        self.assertIsNotNone(parsed)
        # 时间戳落在写入前后这段真实时间内（aware，UTC）。
        self.assertTrue(before <= parsed <= after)
        self.assertIsNotNone(parsed.tzinfo)
        # 原字段保留。
        self.assertEqual(rows[0]['reason'], '字数不足')

    def test_does_not_overwrite_explicit_timestamp(self):
        given = '2020-01-02T03:04:05+00:00'
        labeler.write_rejection(self.path, {'url': labeler.BASE + '/books/details2.html',
                                            labeler.REJECTED_AT_FIELD: given})
        self.assertEqual(self._rows()[0][labeler.REJECTED_AT_FIELD], given)

    def test_appends_not_truncates(self):
        labeler.write_rejection(self.path, {'url': 'a'})
        labeler.write_rejection(self.path, {'url': 'b'})
        self.assertEqual([r['url'] for r in self._rows()], ['a', 'b'])

    def test_does_not_mutate_caller_dict(self):
        rec = {'url': 'x'}
        labeler.write_rejection(self.path, rec)
        self.assertNotIn(labeler.REJECTED_AT_FIELD, rec)


class TestParseIsoUtc(unittest.TestCase):
    """ISO 时间解析：Z 后缀、带偏移、naive 补 UTC、非法/缺失 → None。"""

    def test_trailing_z_becomes_utc(self):
        p = labeler._parse_iso_utc('2026-09-27T12:00:00Z')
        self.assertEqual(p, datetime.datetime(2026, 9, 27, 12, 0, 0,
                                               tzinfo=datetime.timezone.utc))

    def test_offset_preserved(self):
        p = labeler._parse_iso_utc('2026-09-27T20:00:00+08:00')
        self.assertEqual(p.astimezone(datetime.timezone.utc).hour, 12)

    def test_naive_assumed_utc(self):
        p = labeler._parse_iso_utc('2026-09-27T12:00:00')
        self.assertEqual(p.tzinfo, datetime.timezone.utc)

    def test_malformed_is_none(self):
        for bad in ['', '   ', 'not-a-date', None, 123, '2026-13-40']:
            with self.subTest(bad=bad):
                self.assertIsNone(labeler._parse_iso_utc(bad))


class TestRecentRejectionUrls(unittest.TestCase):
    """冷却集：近 cooldown 秒内被拒的 url；旧行/时间未知/未来/边界的处置。"""

    NOW = 1_700_000_000.0   # 固定「现在」，避免用例受真实时钟影响

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'labels-rejected.jsonl'

    def _iso(self, offset_sec: float) -> str:
        return datetime.datetime.fromtimestamp(
            self.NOW + offset_sec, datetime.timezone.utc).isoformat()

    def test_recent_is_included_old_is_not(self):
        write_jsonl(self.path, [
            {'url': 'recent', labeler.REJECTED_AT_FIELD: self._iso(-100)},
            {'url': 'old', labeler.REJECTED_AT_FIELD: self._iso(-200_000)},
        ])
        got = labeler.recent_rejection_urls(self.path, 86400, now=self.NOW)
        self.assertEqual(got, {'recent'})

    def test_missing_timestamp_is_unknown_not_deferred(self):
        """旧格式记录无 rejected_at → 视为很久以前，不后移。"""
        write_jsonl(self.path, [{'url': 'legacy', 'reason': '旧行无时间戳'}])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), set())

    def test_malformed_timestamp_is_unknown(self):
        write_jsonl(self.path, [
            {'url': 'bad', labeler.REJECTED_AT_FIELD: '不是时间'}])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), set())

    def test_future_timestamp_is_ignored(self):
        """时钟偏移导致未来时间戳 → 不可信，忽略（不后移）。"""
        write_jsonl(self.path, [
            {'url': 'future', labeler.REJECTED_AT_FIELD: self._iso(+500)}])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), set())

    def test_boundary_exactly_cooldown_is_excluded(self):
        """恰好等于 cooldown 秒 → 已过冷却（(0, cooldown) 开区间）。"""
        write_jsonl(self.path, [
            {'url': 'edge', labeler.REJECTED_AT_FIELD: self._iso(-86400)}])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), set())

    def test_just_inside_cooldown_is_included(self):
        write_jsonl(self.path, [
            {'url': 'edge', labeler.REJECTED_AT_FIELD: self._iso(-86399)}])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), {'edge'})

    def test_latest_rejection_wins(self):
        """同一 url 多次被拒：取最近一次；有任意一次落在冷却内就后移。"""
        write_jsonl(self.path, [
            {'url': 'u', labeler.REJECTED_AT_FIELD: self._iso(-200_000)},
            {'url': 'u', labeler.REJECTED_AT_FIELD: self._iso(-50)},
        ])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), {'u'})

    def test_all_old_stays_out(self):
        write_jsonl(self.path, [
            {'url': 'u', labeler.REJECTED_AT_FIELD: self._iso(-200_000)},
            {'url': 'u', labeler.REJECTED_AT_FIELD: self._iso(-300_000)},
        ])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 86400, now=self.NOW), set())

    def test_cooldown_zero_disables(self):
        write_jsonl(self.path, [
            {'url': 'recent', labeler.REJECTED_AT_FIELD: self._iso(-1)}])
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, 0, now=self.NOW), set())
        self.assertEqual(
            labeler.recent_rejection_urls(self.path, -1, now=self.NOW), set())

    def test_missing_file_is_empty(self):
        self.assertEqual(
            labeler.recent_rejection_urls(Path(self.tmp.name) / 'nope.jsonl',
                                          86400, now=self.NOW), set())


def absu(rel: str) -> str:
    return labeler.BOOK15.absolute(rel)


class TestSplitQueueDeferred(unittest.TestCase):
    """split_queue 第三种排序：deferred 的书不跳过，移到待处理队尾，两组各保原相对顺序。"""

    def setUp(self):
        self.books = [{'url': f'/books/details{c}.html', 'title': t}
                      for c, t in [('A', '甲'), ('B', '乙'), ('C', '丙'),
                                   ('D', '丁'), ('E', '戊')]]

    def test_deferred_moved_to_tail_preserving_order(self):
        # 后移 乙、丁 → 前段 [甲,丙,戊] 保序，尾段 [乙,丁] 保序
        deferred = {absu('/books/detailsB.html'), absu('/books/detailsD.html')}
        todo, done, pinned = labeler.split_queue(
            self.books, set(), set(), deferred=deferred)
        self.assertEqual([b['title'] for b in todo], ['甲', '丙', '戊', '乙', '丁'])
        self.assertEqual(done, [])
        self.assertEqual(pinned, [])

    def test_empty_deferred_is_identical_to_before(self):
        """关键回归：deferred 空 → 队列与改前逐项相同（不传 / 传空集 / 传 None 三种写法一致）。"""
        expect = ['甲', '乙', '丙', '丁', '戊']
        for kwargs in ({}, {'deferred': set()}, {'deferred': None}):
            with self.subTest(kwargs=kwargs):
                todo, _, _ = labeler.split_queue(self.books, set(), set(), **kwargs)
                self.assertEqual([b['title'] for b in todo], expect)

    def test_done_takes_priority_over_deferred(self):
        """既已完成又在冷却内 → 算已完成跳过，不进队尾。"""
        done = {absu('/books/detailsB.html')}
        deferred = {absu('/books/detailsB.html'), absu('/books/detailsD.html')}
        todo, skipped_done, _ = labeler.split_queue(
            self.books, done, set(), deferred=deferred)
        self.assertEqual([b['title'] for b in todo], ['甲', '丙', '戊', '丁'])
        self.assertEqual([b['title'] for b in skipped_done], ['乙'])

    def test_pinned_takes_priority_over_deferred(self):
        """既是钉子户又在冷却内 → 算钉子户终态跳过，不进队尾。"""
        pinned = {absu('/books/detailsD.html')}
        deferred = {absu('/books/detailsB.html'), absu('/books/detailsD.html')}
        todo, _, skipped_pinned = labeler.split_queue(
            self.books, set(), pinned, deferred=deferred)
        self.assertEqual([b['title'] for b in todo], ['甲', '丙', '戊', '乙'])
        self.assertEqual([b['title'] for b in skipped_pinned], ['丁'])

    def test_all_deferred_still_all_processed_just_reordered(self):
        """全部在冷却内：一本不跳，只是顺序不变地整体成为队尾（等价于原序）。"""
        deferred = {absu(b['url']) for b in self.books}
        todo, _, _ = labeler.split_queue(
            self.books, set(), set(), deferred=deferred)
        self.assertEqual([b['title'] for b in todo], ['甲', '乙', '丙', '丁', '戊'])


class TestMainDeferredLog(unittest.TestCase):
    """main() 接线（离线 dry-run）：启动日志的后移行 + 队尾顺序 + 冷却=0 关闸等价。"""

    def _now_iso(self):
        return datetime.datetime.now(datetime.timezone.utc).isoformat()

    def _setup_dir(self, cooldown_env: str | None):
        d = Path(self.tmp.name)
        env_lines = ['LLM_API_KEY=test-key-not-real']
        if cooldown_env is not None:
            env_lines.append(f'{labeler.REJECT_COOLDOWN_ENV}={cooldown_env}')
        (d / '.env').write_text('\n'.join(env_lines) + '\n', encoding='utf-8')
        # 甲已完成
        write_jsonl(d / 'labels.jsonl', [{'url': labeler.BASE + '/books/detailsA.html'}])
        # 乙、丁近期各被拒 2 次（不到钉子户阈值 5），带新鲜时间戳 → 冷却内应后移
        now = self._now_iso()
        write_jsonl(d / 'labels-rejected.jsonl', [
            {'url': labeler.BASE + '/books/detailsB.html', labeler.REJECTED_AT_FIELD: now},
            {'url': labeler.BASE + '/books/detailsB.html', labeler.REJECTED_AT_FIELD: now},
            {'url': labeler.BASE + '/books/detailsD.html', labeler.REJECTED_AT_FIELD: now},
            {'url': labeler.BASE + '/books/detailsD.html', labeler.REJECTED_AT_FIELD: now},
        ])
        return d

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.books = [{'url': f'/books/details{c}.html', 'title': t}
                      for c, t in [('A', '甲'), ('B', '乙'), ('C', '丙'),
                                   ('D', '丁'), ('E', '戊')]]

    def _run(self, cooldown_env):
        import contextlib
        import io
        d = self._setup_dir(cooldown_env)
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(d)}), \
                mock.patch.object(labeler, 'fetch_rank_books',
                                  return_value=list(self.books)), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--dry-run', '--no-db-model']), \
                contextlib.redirect_stdout(buf):
            rc = labeler.main()
        return rc, buf.getvalue()

    def _dry_run_order(self, out):
        return [ln.split(' | ')[0].replace(' - ', '').strip()
                for ln in out.splitlines() if ln.startswith(' - ')]

    def test_default_cooldown_defers_to_tail_and_logs(self):
        rc, out = self._run(None)   # 默认 86400
        self.assertEqual(rc, 0)
        self.assertIn(f'被拒冷却后移: {labeler.REJECT_COOLDOWN_SEC} 秒内被拒过的书移到队尾', out)
        # 甲已完成剔除；乙、丁在冷却内后移 → 丙、戊、乙、丁
        self.assertEqual(self._dry_run_order(out), ['丙', '戊', '乙', '丁'])
        self.assertIn('本轮待处理 4 本，其中 2 本因 86400 秒内被拒过后移', out)

    def test_cooldown_zero_keeps_original_order(self):
        rc, out = self._run('0')
        self.assertEqual(rc, 0)
        self.assertIn('被拒冷却后移: 关闭', out)
        # 关闸：与改前逐项相同（甲剔除后按名单原序 乙、丙、丁、戊）
        self.assertEqual(self._dry_run_order(out), ['乙', '丙', '丁', '戊'])

    def test_illegal_env_falls_back_to_default_behaviour(self):
        rc, out = self._run('abc')   # 非法 → 回退默认 86400，仍后移
        self.assertEqual(rc, 0)
        self.assertIn(f'被拒冷却后移: {labeler.REJECT_COOLDOWN_SEC} 秒内被拒过的书移到队尾', out)
        self.assertEqual(self._dry_run_order(out), ['丙', '戊', '乙', '丁'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
