#!/usr/bin/env python3
"""rank 线重定位的稳定记录身份 + 备选源保留的离线单测（628）。

全离线：不联网、不调 LLM、不读真 .env。离线契约由 OfflineGuardMixin（socket/DNS 层
守卫，同 test_labeler_import.py）钉死；重定位用 FakeEngineCli（不真起子进程）。

钉的两个缺口（主协调亲核，本批必修）：
1. 617 重定位把 b['url'] 换成引擎 hit['url'] 且丢原 URL；split_queue/拒收/残本/
   下轮 done 全按当前 URL 比对 → 旧键失配：已 done/stub 的书重复打标、pinned 终态
   失效、deferred 后移失效；引擎轮间换站 URL 再漂移，同书每轮重打。
2. 重定位条目不带 hit['alternates']（名单线已有 engine_alternates 换源机制）→
   主源坏时丢已有备选。

身份判据：稳定身份 = 原 book15 站内路径的绝对 URL（与书名无关，同名异书不误合并）；
当前取文 URL 独立存放，随时可被引擎换源改写而不影响身份匹配。旧记录只有 url 键的，
回落 url 键匹配（零迁移）。

复跑：python scripts/test_labeler_identity.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402

from test_labeler_import import (  # noqa: E402
    OfflineGuardMixin, offline_violation, labels_for)

BASE = labeler.BASE                      # https://book15.net
DETAIL_A = '/books/detailsA.html'
DETAIL_B = '/books/detailsB.html'
DETAIL_C = '/books/detailsC.html'
DETAIL_D = '/books/detailsD.html'
ENGINE_URL_A1 = 'https://src1.example/b/a'
ENGINE_URL_A2 = 'https://src2.example/b/a'   # 下轮引擎换站后的同书 URL
ALT = {'url': 'https://alt.example/b/a', 'title': '书甲', 'source': 'alt.example'}


def _now_iso():
    """冷却期内的拒收时间戳（now，ISO UTC）——deferred 判定的合成输入。"""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _search_hit_stdout(url, author='', alternates=None):
    cand = {'title': '书甲', 'bookUrl': url, 'source': 'alt.example', 'author': author}
    if alternates is not None:
        cand['alternates'] = alternates
    return json.dumps([cand], ensure_ascii=False)


class HitCli:
    """引擎搜索桩：每本书按 title 返回一个引擎命中（URL 可按轮次换站）。

    hit_extra 允许给返回 hit 注入 alternates 等键（search_engine 的 stdout 是候选数组，
    alternates 由 search_engine 内部组装；这里直接测 _relocate_rank_books_to_engine
    的返回，故在 labeler.douban_list.search_engine 一层打桩返回完整 hit）。"""

    def __init__(self, mapping):
        self.mapping = dict(mapping)      # title -> hit dict | None
        self.calls = []

    def __call__(self, cli, title, *args, **kwargs):
        self.calls.append(title)
        return self.mapping.get(title)


class IdentityHarness(OfflineGuardMixin, unittest.TestCase):
    """rank 线 main() 的离线夹具：book15 retired + 引擎重定位真跑（不短路）。"""

    def setUp(self):
        super().setUp()
        self.install_offline_guard()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n',
                                       encoding='utf-8')
        self._prev_source_policy = labeler.SOURCE_POLICY
        self.addCleanup(self._restore_source_policy)

    def _restore_source_policy(self):
        labeler.SOURCE_POLICY = self._prev_source_policy

    def write_labels(self, recs, name='labels.jsonl'):
        with open(self.dir / name, 'a', encoding='utf-8') as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')

    def run_main(self, books, hits, argv=('--dry-run',), patchers=()):
        """跑 labeler.main()（rank 线，book15 retired 生效、重定位真跑）。

        hits: title -> 引擎 hit dict（或 None=miss）。返回 (code, stdout, stderr)。
        """
        search_stub = HitCli(hits)
        p_search = mock.patch.object(labeler.douban_list, 'search_engine', search_stub)
        p_cli = mock.patch.object(labeler, '_build_engine_cli',
                                  return_value=types.SimpleNamespace())
        p_rank = mock.patch.object(labeler, 'fetch_rank_books',
                                   return_value=[dict(b) for b in books])
        for p in (p_search, p_cli, p_rank) + tuple(patchers):
            p.start()
            self.addCleanup(p.stop)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--no-db-model', *argv]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        return code, out.getvalue(), err.getvalue()


class TestRelocationKeepsStableIdentity(IdentityHarness):
    """缺口 1：重定位改写 URL 后，done/stub/pinned/deferred 仍按稳定身份命中。"""

    BOOK_A = {'url': DETAIL_A, 'title': '书甲'}
    BOOK_B = {'url': DETAIL_B, 'title': '书乙'}

    def test_done_by_old_book15_url_not_relocated_again(self):
        """旧记录只有 url 键（book15 绝对 URL）：重定位后 done 仍命中，不重打标。

        修好前：split_queue 拿新引擎 URL 比对旧 book15 URL → 失配 → 已完成的书进 todo。
        """
        self.write_labels([{'url': BASE + DETAIL_A, 'title': '书甲'}])
        code, out, _ = self.run_main(
            [self.BOOK_A, self.BOOK_B],
            {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'},
             '书乙': {'url': 'https://src1.example/b/b', 'title': '书乙', 'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 1 本', out)
        self.assertIn('书乙', out)

    def test_stub_by_old_book15_url_still_terminal(self):
        """labels-stub.jsonl 记的是旧 book15 URL：重定位后仍算终态（与 done 同口径）。"""
        self.write_labels([{'url': BASE + DETAIL_A, 'title': '书甲', 'reason': '残本'}],
                          name='labels-stub.jsonl')
        code, out, _ = self.run_main(
            [self.BOOK_A], {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲',
                                   'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 0 本', out)

    def test_pinned_by_old_book15_url_still_terminal(self):
        """钉子户终态按旧 book15 URL 记：重定位后仍跳过，日志不 KeyError。"""
        self.write_labels(
            [{'url': BASE + DETAIL_A, 'site_title': '书甲'}] * 5,
            name='labels-rejected.jsonl')
        code, out, _ = self.run_main(
            [self.BOOK_A], {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲',
                                   'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 0 本', out)
        self.assertIn('钉子户终态', out)
        self.assertIn('5 次', out)

    def test_deferred_by_identity_moves_to_tail_not_lost(self):
        """冷却期被拒（deferred）：按身份命中 → 后移到队尾（不跳过、也不回到队头）。"""
        from datetime import datetime, timezone
        self.write_labels(
            [{'url': BASE + DETAIL_A, 'site_title': '书甲',
              'rejected_at': datetime.now(timezone.utc).isoformat()}],
            name='labels-rejected.jsonl')
        code, out, _ = self.run_main(
            [self.BOOK_A, self.BOOK_B],
            {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'},
             '书乙': {'url': 'https://src1.example/b/b', 'title': '书乙',
                     'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('其中 1 本因', out)          # 后移计数用同一身份口径

    def test_deferred_by_identity_only_counted_in_log(self):
        """632：拒收行带 identity 键且取文 URL 已换引擎站 → 队列后移了，日志计数不能是 0。

        合成输入：拒收行 url=旧引擎 URL、identity=book15 站内绝对 URL（重定位后的真实
        写回形态——`_attach_identity` 在 identity≠url 时写 identity）。条目本轮命中另
        一家引擎站（URL 三者互不相等）：`deferred_urls`（URL 键）不命中任何键，
        只有身份并集 `_deferred_keys` 命中 identity。修好前：队尾后移（队列判定用并集）、
        「其中 0 本」计数（旧代码只交 deferred_urls）——日志与队列自相矛盾。
        断言口径：处理 2 本 + 其中 1 本后移（M ≤ N，count 与队列同一身份键集）。
        """
        self.write_labels(
            [{'url': ENGINE_URL_A1, 'identity': BASE + DETAIL_A,
              'site_title': '书甲', 'rejected_at': _now_iso()}],
            name='labels-rejected.jsonl')
        code, out, _ = self.run_main(
            [self.BOOK_B, self.BOOK_A],           # 书乙在前：后移的书甲必须排到队尾
            {'书甲': {'url': ENGINE_URL_A2, 'title': '书甲', 'source': 'src2.example'},
             '书乙': {'url': 'https://src1.example/b/b', 'title': '书乙',
                     'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 2 本', out)
        self.assertIn('其中 1 本因', out)

    def test_deferred_tail_cut_by_limit_counts_zero(self):
        """632：后移书在队尾、被 --limit 截掉时计数为 0（limit 后计数语义不变）。

        队头是未后移的正常书（书丙），两本后移书（书甲/书乙）排到队尾；--limit 1 只留
        队头正常书：队尾两本没进本轮待处理队列，「其中 0 本」正确——计数跟着切片后的
        queue 走，不是跟着 deferred 名单走（M 与 N 同口径，不会 M > N）。
        """
        self.write_labels(
            [{'url': ENGINE_URL_A1, 'identity': BASE + DETAIL_A,
              'site_title': '书甲', 'rejected_at': _now_iso()},
             {'url': ENGINE_URL_A2, 'identity': BASE + DETAIL_B,
              'site_title': '书乙', 'rejected_at': _now_iso()}],
            name='labels-rejected.jsonl')
        code, out, _ = self.run_main(
            [{'url': DETAIL_C, 'title': '书丙'}, self.BOOK_A, self.BOOK_B],
            {'书丙': {'url': 'https://src3.example/b/c', 'title': '书丙',
                     'source': 'src3.example'},
             '书甲': {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'},
             '书乙': {'url': ENGINE_URL_A2, 'title': '书乙', 'source': 'src2.example'}},
            argv=('--dry-run', '--limit', '1'))
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 1 本', out)
        self.assertIn('其中 0 本因', out)

    def test_deferred_same_title_other_book_not_moved(self):
        """632：同名异书不因书名相同被误后移（身份键不含书名）。

        被拒的是 detailsX（书名也叫书甲，但另一本）；本轮候选 detailsA 同名不同身份：
        不得命中 deferred——不后移、计数 0。钉死后移判定就不会退回「裸书名/标题」匹配。
        """
        self.write_labels(
            [{'url': BASE + '/books/detailsX.html', 'site_title': '书甲',
              'rejected_at': _now_iso()}],
            name='labels-rejected.jsonl')
        code, out, _ = self.run_main(
            [self.BOOK_A],
            {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 1 本', out)
        self.assertIn('其中 0 本因', out)

    def test_success_written_this_round_matches_next_round_new_engine_url(self):
        """本轮成功写回 → 下轮引擎换站（URL 不同）也不重复打标。

        这是「重定位丢旧状态」最直接的复现：两轮引擎 URL 不同，身份必须跨轮稳定。
        """
        # 第一轮：真实写一条带 identity 的成功记录
        code, out, _ = self.run_main(
            [self.BOOK_A],
            {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'}},
            argv=(),
            patchers=self._full_label_patchers())
        self.assertEqual(code, 0)
        recs = [json.loads(ln) for ln in
                (self.dir / 'labels.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(recs), 1)
        # 第二轮：引擎换站，同书命中不同 URL
        code2, out2, _ = self.run_main(
            [self.BOOK_A],
            {'书甲': {'url': ENGINE_URL_A2, 'title': '书甲', 'source': 'src2.example'}},
            argv=('--dry-run',))
        self.assertEqual(code2, 0)
        self.assertIn('本轮处理 0 本', out2)

    def _full_label_patchers(self):
        """非 dry-run 一轮成功所需的桩：引擎取文 + LLM（全部假值，不触网）。"""
        fetch = mock.patch.object(
            labeler, 'fetch_engine_book_with_giveup',
            return_value=('正文' * 30000, 60000,
                          {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'}))
        lab = mock.patch.object(
            labeler, 'label_book',
            side_effect=lambda text, key, models, site_title='', **kw:
                (labels_for(site_title), 1))
        clock = mock.patch.object(labeler, 'time', mock.Mock())
        return (fetch, lab, clock)

    def test_same_title_different_source_path_not_merged(self):
        """同名不同书（不同站内路径 = 不同身份）：不能因书名相同合并跳过。"""
        # detailsX 已 done；detailsY 同名（另一本书）必须照常处理
        self.write_labels([{'url': BASE + '/books/detailsX.html', 'title': '书甲'}])
        code, out, _ = self.run_main(
            [{'url': '/books/detailsX.html', 'title': '书甲'},
             {'url': DETAIL_A, 'title': '书甲'}],
            {'书甲': {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'}})
        self.assertEqual(code, 0)
        self.assertIn('本轮处理 1 本', out)


class TestRelocationKeepsAlternates(IdentityHarness):
    """缺口 2：重定位命中要保留 hit['alternates'] → engine_alternates。"""

    def test_hit_with_alternates_is_carried_into_queue_entry(self):
        """search_engine 返回带 alternates 的 hit：重定位条目须带 engine_alternates。

        修好前：_relocate_rank_books_to_engine 只挑 url/title/source，备选被丢。
        """
        hit = {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example',
               'alternates': [ALT]}
        stub = mock.patch.object(labeler.douban_list, 'search_engine',
                                 side_effect=lambda cli, title: hit)
        with stub:
            out, stats = labeler._relocate_rank_books_to_engine(
                [{'url': DETAIL_A, 'title': '书甲'}], object())
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].get('engine_alternates'), [ALT])
        self.assertEqual(out[0].get('identity'), BASE + DETAIL_A)

    def test_main_source_failure_uses_alternate_via_engine_alternates(self):
        """主源失败时按 engine_alternates 换源取文成功（接既有换源机制）。

        修好前：重定位条目没有 engine_alternates，主源一挂整本放弃（备选白丢）。
        """
        hit = {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example',
               'alternates': [ALT]}
        gave_up = labeler.EngineSourceGaveUp('src1.example', 'http_4xx', '主源坏', '', 0)
        used = {'url': ALT['url'], 'title': ALT['title'], 'source': ALT['source']}

        def fake_fetch(cli, book, tracker, **kw):
            alts = book.get('engine_alternates') or []
            if not alts:
                raise gave_up
            return '正文' * 30000, 60000, used

        fetch = mock.patch.object(labeler, 'fetch_engine_book_with_giveup',
                                  side_effect=fake_fetch)
        lab = mock.patch.object(
            labeler, 'label_book',
            side_effect=lambda text, key, models, site_title='', **kw:
                (labels_for(site_title), 1))
        clock = mock.patch.object(labeler, 'time', mock.Mock())
        code, out, _ = self.run_main(
            [{'url': DETAIL_A, 'title': '书甲'}], {'书甲': hit},
            argv=(), patchers=(fetch, lab, clock))
        self.assertEqual(code, 0)
        recs = [json.loads(ln) for ln in
                (self.dir / 'labels.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]['url'], ALT['url'])       # 产物记真实取文来源
        self.assertEqual(recs[0]['source'], 'alt.example')


class TestRetiredUrlNeverFetched(IdentityHarness):
    """红线：身份匹配不得把旧退休 URL 变成网络请求。"""

    def test_no_request_to_book15_after_relocation(self):
        """重定位后的整轮不应对 book15 发任何 http_get（身份键只用于比对）。"""
        served = []

        def fake_http_get(url, timeout=30):
            served.append(url)
            raise offline_violation(
                f'labeler.http_get 收到未打桩的 URL {url}——重定位后不应请求 book15')

        hit = {'url': ENGINE_URL_A1, 'title': '书甲', 'source': 'src1.example'}
        code, out, _ = self.run_main(
            [{'url': DETAIL_A, 'title': '书甲'}], {'书甲': hit},
            patchers=(mock.patch.object(labeler, 'http_get', fake_http_get),))
        self.assertEqual(code, 0)
        self.assertEqual(served, [])


class TestPlainUnrelocatedPathUnchanged(IdentityHarness):
    """原普通未重定位路径兼容：非 retired 场景（重定位被短路）行为不变。"""

    def test_book15_entries_still_split_by_url(self):
        """重定位未发生（引擎未开/短路）时，split_queue 仍按 URL 匹配（旧契约）。"""
        self.write_labels([{'url': BASE + DETAIL_A, 'title': '书甲'}])
        books = [{'url': DETAIL_A, 'title': '书甲'},
                 {'url': DETAIL_B, 'title': '书乙'}]
        done = labeler.load_done_urls(self.dir / 'labels.jsonl')
        todo, skipped_done, _ = labeler.split_queue(books, done, set())
        self.assertEqual(len(todo), 1)
        self.assertEqual(len(skipped_done), 1)
        self.assertEqual(todo[0]['url'], DETAIL_B)


if __name__ == '__main__':
    unittest.main(verbosity=2)
