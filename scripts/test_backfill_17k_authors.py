"""backfill_17k_authors 单测：全离线（http_get 被替换，不联网、不连库）。

覆盖任务要点：补全成功、补全失败降级（不写空作者，守幂等红线）、护栏语义不变。"""
import io
import json
import sys
import unittest
import contextlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import labeler                          # noqa: E402
import backfill_17k_authors as bf       # noqa: E402


def _row(title, author='', **over):
    rec = {
        'title': title, 'site_title': title, 'author': author,
        'category': '17K完本', 'url': f'https://engine.example.com/{title}',
        'source': 'engine', 'status': '完本', 'chars': 90000,
        'labels': {'title_guess': title, 'site_title_match': True,
                   'text_quality': '正常', 'genre': '游戏'},
    }
    rec.update(over)
    return rec


# 17K 完本页：只「网游之天下无双」带作者「失落叶」
QUANBEN = ('<a href="//www.17k.com/book/\t88532.html">\t网游之天下无双\t</a>'
           '<p class="author">作者：<a href="//user.17k.com/see/www/?userId=1">失落叶</a></p>'
           '<a href="//www.17k.com/book/2.html">无作者的书</a>')


class TestBackfill17kAuthors(unittest.TestCase):
    def setUp(self):
        self._orig = labeler.http_get
        labeler.http_get = lambda url, timeout=30: QUANBEN

    def tearDown(self):
        labeler.http_get = self._orig

    def _run(self, rows, out):
        Path(out).write_text(
            ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows),
            encoding='utf-8')
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            bf.main(['--labels', out, '--out', out + '.filled'])
        written = [json.loads(x) for x in
                   Path(out + '.filled').read_text(encoding='utf-8').splitlines() if x.strip()]
        Path(out).unlink()
        Path(out + '.filled').unlink()
        return written, buf.getvalue()

    def test_fills_empty_author_from_17k_page(self):
        with _tmp() as d:
            written, _ = self._run([_row('网游之天下无双')], str(d / 'l.jsonl'))
        self.assertEqual([(w['title'], w['author']) for w in written],
                         [('网游之天下无双', '失落叶')])

    def test_already_authored_row_is_not_selected(self):
        with _tmp() as d:
            written, _ = self._run([_row('网游之天下无双', author='别人')], str(d / 'l.jsonl'))
        self.assertEqual(written, [])       # 非空作者不在补作者范围

    def test_unresolved_is_dropped_never_written_with_empty_author(self):
        # 补不到作者的行必须丢弃，绝不写空作者（守 labeler-idempotency-redline）
        with _tmp() as d:
            written, out = self._run([_row('查无此书补不到作者')], str(d / 'l.jsonl'))
        self.assertEqual(written, [])
        self.assertIn('仍补不到    : 1', out)

    def test_guard_semantics_unchanged_bad_row_still_dropped(self):
        # 补了作者但另一道护栏不过（text_quality 异常）→ 仍不写出
        bad = _row('网游之天下无双')
        bad['labels']['text_quality'] = '大面积重复'
        with _tmp() as d:
            written, _ = self._run([bad], str(d / 'l.jsonl'))
        self.assertEqual(written, [])

    def test_resolve_engine_author_reuses_clean_engine_author(self):
        # rvauthor CE5：backfill 的引擎作者解析必须与 labeler 回写走同一套清洗，
        # 否则同一 toc 值两路径写出不同 author_key → 同一本书第二行。
        import labeler
        orig = labeler._engine_json
        labeler._engine_json = lambda cli, sub, *a: {'author': '作者：唐家三少 著'}
        try:
            got = bf.resolve_engine_author(object(), 'https://src.example.com/b/1')
        finally:
            labeler._engine_json = orig
        self.assertEqual(got, labeler._clean_engine_author('作者：唐家三少 著'))
        self.assertEqual(got, '唐家三少')

    def test_engine_env_keys_subset_of_labeler_reads(self):
        # rvauthor 41: backfill 白名单里的键必须是 labeler 引擎路径**实际读取**的键，
        # 否则 .env 里的真值被白名单漏掉，labeler._build_engine_cli 装配失败/静默降级。
        # 从 labeler.py 源码 + douban_list.ENGINE_FALLBACK_ENV 提取实际键名,断言子集关系,
        # 让「白名单写错键名」这类遗漏由测试兜住,而不是靠人工比对。
        import re
        import douban_list
        src = Path(labeler.__file__).read_text(encoding='utf-8')
        reads = set(re.findall(r"env(?:\.get\(|\[)\s*['\"](\w+)['\"]", src))
        # engine_fallback_enabled 经常量读开关,不在 labeler.py 里以字面量出现
        reads.add(douban_list.ENGINE_FALLBACK_ENV)
        whitelist = set(bf._ENGINE_ENV_KEYS)
        self.assertTrue(whitelist <= reads,
                        f'白名单含 labeler 不读的键: {sorted(whitelist - reads)}')
        # 反向也守住:引擎装配真正依赖的键不能被白名单漏掉
        self.assertTrue({'LABELER_ENGINE_FALLBACK', 'LABELER_ENGINE_CLI',
                         'LABELER_ENGINE_NODE', 'DATABASE_URL'} <= whitelist)


import tempfile           # noqa: E402


class _tmp:
    def __enter__(self):
        self._d = tempfile.TemporaryDirectory()
        return Path(self._d.name)

    def __exit__(self, *a):
        self._d.cleanup()


if __name__ == '__main__':
    unittest.main()
