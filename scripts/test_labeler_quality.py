#!/usr/bin/env python3
"""labeler.py 调模型前的文本质量处理（lblqual41）单测。

覆盖：
- _drop_rule 新增的作者求票行 / 章末标记 / 纯分隔线规则（实证样本 + 不误删正文的反例）；
- prepare_book_text：跨章去重（cuoceng 串章同形）、试读截断源判定（yunqi 同形）、去重后字数不足；
- EngineStopUrls：toc 后给目录内章节的 content 带 --stop-urls-file，旧 CLI 不认时降级；
- 主循环：本地预检不合格 → 不调模型、写 labels-rejected.jsonl；去重后的正文才送模型。
全离线：不联网、不真调 CLI、不调 LLM。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_quality.py'
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


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _line(tag: str, i: int) -> str:
    """一行 ≥ DEDUPE_MIN_LINE 字、彼此不同的叙述正文。"""
    return f'{tag}第{i}段：他沿着山路一直往前走，雪越下越大，远处传来几声狼嚎。'


def _chapter_body(tag: str, n: int = 60) -> str:
    return '\n'.join(_line(tag, i) for i in range(n))


class TestPleaAndMarkerRule(unittest.TestCase):
    # 实证样本（bqquge《斗罗大陆III》前 12 章，本机重取）
    EVIDENCE_PLEA = (
        '求收藏、求推荐票！',
        '求收藏、求推荐票',
        '四更啦！求推荐票、求收藏。唐门万岁，书友们万岁！',
        '今天的第二章送上，再次拜求推荐票、拜求收藏支持。今天保底四更哦。冲榜、冲榜，唐门的兄弟姐妹们，陪我一起创造辉煌！',
        '新书刚刚开始上传，需要大家的呵护，求收藏、求推荐票！唐门万岁。',
        '求收藏、求推荐票，第三更送上！继续冲榜！',
    )
    EVIDENCE_MARKER = (
        '(本章完)',
        '（本章完）',
        '－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－－',
        '---------',
    )
    # 反例（复审阻断②）：无引号的第三人称叙述，含「求打赏/求订阅」但不是对读者说话，必须保留
    NARRATION_KEEP = (
        '他跪在雪地里向过往的行人求打赏，嗓子已经哑了。',
        '粉丝们求打赏主播的礼物堆了一整桌。',
        '他求订阅那本杂志已经三年了，书架上摆得满满当当。',
    )
    # 反例：正文 / 对白，必须保留
    KEEP = (
        '“求收藏！求推荐票！”他在直播间里扯着嗓子喊。',
        '「求月票」四个字挂在他的直播间标题上。',
        '他求推荐信的事被导师拒绝了。',
        '她想求收藏家帮忙鉴定这幅画。',
        '他把这个月的月票都投给了自己最喜欢的作者。',
        '他求一个结果，哪怕是坏的。',
        '——他终于明白了。',
        '……',
        '本章完结之后，他离开了青云山。',
        '——————',   # 五个以上才算分隔线；这是 6 个破折号，同属分隔线 → 见下方单独断言
    )

    def test_evidence_plea_lines_are_dropped(self):
        for line in self.EVIDENCE_PLEA:
            self.assertEqual(labeler._drop_rule(line), 'plea', line)

    def test_evidence_marker_lines_are_dropped(self):
        for line in self.EVIDENCE_MARKER:
            self.assertEqual(labeler._drop_rule(line), 'marker', line)

    def test_unquoted_narration_is_kept(self):
        # 复审阻断②：只凭「整行无引号」会把这三行当求票行整行删掉
        for line in self.NARRATION_KEEP:
            self.assertIsNone(labeler._drop_rule(line), line)

    def test_prose_and_dialogue_are_kept(self):
        for line in self.KEEP[:-1]:
            self.assertIsNone(labeler._drop_rule(line), line)
        # 纯破折号分隔线（场景切换）按分隔线处理：对打标没有信息量，删掉不损正文
        self.assertEqual(labeler._drop_rule(self.KEEP[-1]), 'marker')

    def test_overlong_plea_line_is_kept(self):
        # 长度护栏：超过 PLEA_LINE_MAX_LEN 的行不进规则（宁漏勿误删）
        line = '求收藏' + '他走了很远很远的路，' * 20
        self.assertGreater(len(line), labeler.PLEA_LINE_MAX_LEN)
        self.assertIsNone(labeler._drop_rule(line))

    def test_book15_clean_chapter_text_also_drops_plea(self):
        html = ('<div class="chapter-content-panel">'
                + ''.join(f'<p>{_line("甲", i)}</p>' for i in range(5))
                + '<p>求收藏、求推荐票！</p><p>(本章完)</p></div>')
        text, stats = labeler.clean_chapter_text(html)
        self.assertNotIn('求收藏', text)
        self.assertNotIn('本章完', text)
        self.assertEqual(stats['lines_dropped'], 2)


class TestPrepareBookText(unittest.TestCase):
    def test_clean_text_passes_through_unchanged(self):
        text = f'【第1章 起】\n{_chapter_body("甲", 200)}\n\n【第2章 承】\n{_chapter_body("乙", 200)}'
        out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertEqual(out, text)
        self.assertIsNone(reason)
        self.assertEqual(stats['dup_lines'], 0)
        self.assertEqual(stats['clean_lines'], 0)
        self.assertEqual(chars, len(_chapter_body("甲", 200)) + len(_chapter_body("乙", 200)))

    def test_cuoceng_overlap_is_deduplicated(self):
        # cuoceng 同形：第 k 次 content 返回「第 k 章 + 后面几章」，相邻两次大面积重叠
        bodies = [_chapter_body(f'章{k}') for k in range(6)]
        windows = ['\n'.join(bodies[k:k + 3]) for k in range(4)]
        text = '\n\n'.join(f'【第{k}章】\n{w}' for k, w in enumerate(windows))
        out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertGreater(stats['dup_lines'], 0)
        for body in bodies:
            for line in body.split('\n'):
                self.assertEqual(out.count(line), 1, line)   # 每段只剩一份
        self.assertEqual(chars, sum(len(b) for b in bodies) + 2)   # 6 章内容 + 首窗 3 章之间的 2 个换行

    def test_short_repeated_dialogue_is_kept(self):
        body = '\n'.join(['“嗯。”', _line('甲', 0), '“嗯。”', _line('甲', 1), '“嗯。”'] * 1)
        text = f'【第1章】\n{body}\n\n【第2章】\n“嗯。”\n{_chapter_body("乙")}'
        out, _, _, stats = labeler.prepare_book_text(text, clean=True)
        self.assertEqual(out.count('“嗯。”'), 4)
        self.assertEqual(stats['dup_lines'], 0)

    def test_whole_duplicate_chapter_is_dropped_but_not_treated_as_preview(self):
        a, b = _chapter_body("甲", 200), _chapter_body("乙", 200)
        text = '\n\n'.join(f'【第{i}章】\n{x}' for i, x in enumerate([a, a, b, b, a, b]))
        out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertEqual(stats['chapters_after'], 2)
        self.assertEqual(chars, len(a) + len(b))
        self.assertEqual(stats['median_chapter'], len(a) - a.count('\n'))   # 章长按字数计、不含换行

    def test_yunqi_preview_source_is_rejected(self):
        # yunqi 同形：184 章，每章只有约 100 字的试读片段（复审非阻断③补了总字数条件后，
        # 试读门要「中位数低且全书不足 PREVIEW_MIN_TOTAL」才拒，所以这里章数取到全书不过万字）
        preview = '晨曦洒落，风过竹林，满山青翠如波涛缓缓起伏，又是新的一天。' * 4 + '...'
        self.assertGreater(len(preview), 100)
        text = '\n\n'.join(f'【第{i}章 标题APP免费】\n{preview}{i}' for i in range(60))
        _, _, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIsNotNone(reason)
        self.assertIn('试读', reason)
        self.assertLess(stats['median_chapter'], labeler.PREVIEW_MEDIAN_MAX)

    def test_bracket_system_lines_are_not_chapter_heads(self):
        # 复审阻断①：60 章×约 900 字的系统流小说，每章中部一条「【叮！获得xx点经验值】」独占一段。
        # 旧切章把它当章节标题 → 切成 120 章、中位 375 → 整本按「疑似试读」拒收。
        # 章正文用 30 段各不相同的叙述（每段约 30 字），保证去重不吞字。
        system_line = '【叮！获得xx点经验值】'
        chapters = []
        for i in range(60):
            body = '\n'.join(_line(f'章{i}', k) for k in range(30))
            chapters.append(f'【第{i}章 标题】\n{body}\n\n{system_line}\n{body}')
        text = '\n\n'.join(chapters)
        out, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertEqual(stats['chapters_before'], 60)          # 不再被切成 120
        self.assertGreaterEqual(stats['median_chapter'], labeler.PREVIEW_MEDIAN_MAX)
        self.assertIn(system_line, out)                          # 系统提示是正文，保留
        self.assertGreater(chars, labeler.PRECHECK_MIN_CHARS)

    def test_short_but_long_enough_book_is_not_preview(self):
        # 复审非阻断③：30 章×约 450 字、全书过万字是正常短章，不是试读
        line = _line('甲', 0)
        n = 14                                             # 每章字数落在试读阈值以下
        para = '\n'.join(line for _ in range(n))
        self.assertLess(len(para) - para.count('\n'), labeler.PREVIEW_MEDIAN_MAX)
        text = '\n\n'.join(
            '【第{i}章】\n'.format(i=i) + '\n'.join(_line(f'章{i}', k) for k in range(n))
            for i in range(30))
        _, chars, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertGreater(chars, labeler.PREVIEW_MIN_TOTAL)
        self.assertLess(stats['median_chapter'], labeler.PREVIEW_MEDIAN_MAX)
        self.assertIsNone(reason)

    def test_few_short_chapters_are_not_judged_preview(self):
        text = '\n\n'.join(f'【第{i}章】\n{_line("甲", i) * 5}' for i in range(3))
        _, _, reason, _ = labeler.prepare_book_text(text, clean=True)
        self.assertNotIn('试读', reason or '')

    def test_too_few_chars_after_dedupe_is_rejected(self):
        body = _chapter_body('甲', 30)
        text = '\n\n'.join(f'【第{i}章】\n{body}' for i in range(40))   # 40 章全是同一章
        self.assertGreater(len(text), labeler.PRECHECK_MIN_CHARS)
        _, chars, reason, _ = labeler.prepare_book_text(text, clean=True)
        self.assertLess(chars, labeler.PRECHECK_MIN_CHARS)
        self.assertIn('清洗去重后仅', reason)

    def test_clean_flag_gates_line_rules(self):
        text = f'【第1章】\n{_chapter_body("甲")}\n求收藏、求推荐票！'
        out_engine, _, _, s1 = labeler.prepare_book_text(text, clean=True)
        out_book15, _, _, s2 = labeler.prepare_book_text(text, clean=False)
        self.assertNotIn('求收藏', out_engine)
        self.assertEqual(s1['clean_lines'], 1)
        self.assertIn('求收藏', out_book15)
        self.assertEqual(s2['clean_lines'], 0)

    def test_text_without_chapter_heads(self):
        text = _chapter_body('甲') + '\n' + _line('甲', 0)
        out, _, _, stats = labeler.prepare_book_text(text, clean=False)
        self.assertEqual(out, _chapter_body('甲'))
        self.assertEqual(stats['dup_lines'], 1)


class RecordingCli:
    """引擎 CLI 桩：记录完整参数；handler(sub, args) -> CompletedProcess-like。"""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []
        self.node = '/usr/bin/node'

    def run(self, subcommand, *args):
        self.calls.append((subcommand, args))
        return self.handler(subcommand, args)


def _toc_json(urls):
    return json.dumps({'source': 'm.cuoceng.com', 'title': '鬼吹灯', 'author': '天下霸唱',
                       'chapters': [{'index': i, 'title': f'第{i}章', 'url': u}
                                    for i, u in enumerate(urls)]}, ensure_ascii=False)


class TestEngineStopUrls(unittest.TestCase):
    URLS = ['https://m.cuoceng.com/b/0.html', 'https://m.cuoceng.com/b/3.html',
            'https://m.cuoceng.com/b/1.html']

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _wrap(self, handler):
        inner = RecordingCli(handler)
        return inner, labeler.EngineStopUrls(inner, directory=self.tmp.name)

    def test_content_after_toc_carries_stop_file_with_whole_toc(self):
        def handler(sub, args):
            return _proc(0, _toc_json(self.URLS)) if sub == 'toc' else _proc(0, '{"text": "x"}')

        inner, cli = self._wrap(handler)
        cli.run('toc', '--url', 'https://m.cuoceng.com/b.html')
        cli.run('content', '--url', self.URLS[1])
        self.assertEqual(inner.calls[1], ('content', ('--url', self.URLS[1],
                                                      '--stop-urls-file', cli.path)))
        self.assertEqual(Path(cli.path).read_text(encoding='utf-8').split(), self.URLS)
        self.assertEqual(cli.node, '/usr/bin/node')      # 其余属性原样转发

    def test_content_outside_toc_or_other_commands_unchanged(self):
        inner, cli = self._wrap(lambda sub, args: _proc(0, _toc_json(self.URLS)))
        cli.run('content', '--url', self.URLS[0])            # 还没取过 toc
        cli.run('toc', '--url', 'https://m.cuoceng.com/b.html')
        cli.run('content', '--url', 'https://other.example/9.html')
        cli.run('search', '--title', '鬼吹灯')
        self.assertEqual([c[1] for c in inner.calls if c[0] != 'toc'],
                         [('--url', self.URLS[0]), ('--url', 'https://other.example/9.html'),
                          ('--title', '鬼吹灯')])

    def test_failed_toc_forgets_previous_book(self):
        state = {'toc_ok': True}

        def handler(sub, args):
            if sub == 'toc':
                return _proc(0, _toc_json(self.URLS)) if state['toc_ok'] else _proc(1, '', '无章节')
            return _proc(0, '{"text": "x"}')

        inner, cli = self._wrap(handler)
        cli.run('toc', '--url', 'https://m.cuoceng.com/a.html')
        state['toc_ok'] = False
        cli.run('toc', '--url', 'https://m.cuoceng.com/b.html')
        cli.run('content', '--url', self.URLS[0])
        self.assertEqual(inner.calls[-1], ('content', ('--url', self.URLS[0])))

    def test_old_cli_rejecting_flag_degrades_once_and_retries(self):
        def handler(sub, args):
            if sub == 'toc':
                return _proc(0, _toc_json(self.URLS))
            if '--stop-urls-file' in args:
                return _proc(2, '', '未知参数：--stop-urls-file')
            return _proc(0, '{"text": "正文"}')

        inner, cli = self._wrap(handler)
        cli.run('toc', '--url', 'https://m.cuoceng.com/b.html')
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            first = cli.run('content', '--url', self.URLS[0])
            second = cli.run('content', '--url', self.URLS[1])
        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 0)
        self.assertFalse(cli.supported)
        self.assertIn('不支持 --stop-urls-file', err.getvalue())
        contents = [c[1] for c in inner.calls if c[0] == 'content']
        self.assertEqual(contents, [('--url', self.URLS[0], '--stop-urls-file', cli.path),
                                    ('--url', self.URLS[0]), ('--url', self.URLS[1])])

    def test_unreadable_stop_file_is_not_treated_as_old_cli(self):
        # 复审非阻断①：新 CLI 自己报「--stop-urls-file 无法读取」（rc=2 且 stderr 含参数名）
        # 不能被当成旧 CLI，否则整轮停止点被静默关掉
        def handler(sub, args):
            if sub == 'toc':
                return _proc(0, _toc_json(self.URLS))
            if '--stop-urls-file' in args:
                return _proc(2, '', '--stop-urls-file 无法读取：文件不存在')
            return _proc(0, '{"text": "正文"}')

        inner, cli = self._wrap(handler)
        cli.run('toc', '--url', 'https://m.cuoceng.com/b.html')
        first = cli.run('content', '--url', self.URLS[0])
        second = cli.run('content', '--url', self.URLS[1])
        self.assertEqual(first.returncode, 2)
        self.assertTrue(cli.supported)                       # 没降级
        contents = [c[1] for c in inner.calls if c[0] == 'content']
        self.assertEqual(contents, [('--url', self.URLS[0], '--stop-urls-file', cli.path),
                                    ('--url', self.URLS[1], '--stop-urls-file', cli.path)])
        self.assertEqual(second.returncode, 2)

    def test_other_content_errors_are_not_retried(self):
        def handler(sub, args):
            if sub == 'toc':
                return _proc(0, _toc_json(self.URLS))
            return _proc(1, '', '空正文')

        inner, cli = self._wrap(handler)
        cli.run('toc', '--url', 'https://m.cuoceng.com/b.html')
        self.assertEqual(cli.run('content', '--url', self.URLS[0]).returncode, 1)
        self.assertEqual(len([c for c in inner.calls if c[0] == 'content']), 1)
        self.assertTrue(cli.supported)

    def test_fetch_book_text_engine_passes_stop_file_for_every_chapter(self):
        body = '正文' * 100

        def handler(sub, args):
            if sub == 'toc':
                return _proc(0, _toc_json(self.URLS))
            return _proc(0, json.dumps({'text': body}, ensure_ascii=False))

        inner, cli = self._wrap(handler)
        with mock.patch.object(labeler.time, 'sleep'):
            _, chars = labeler.fetch_book_text_engine(cli, 'https://m.cuoceng.com/b.html')
        self.assertEqual(chars, 3 * len(body))
        contents = [c[1] for c in inner.calls if c[0] == 'content']
        self.assertEqual(len(contents), 3)
        for args in contents:
            self.assertEqual(args[2:], ('--stop-urls-file', cli.path))


class TestMainPrecheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / '.env').write_text('LLM_API_KEY=test-key-not-real\n', encoding='utf-8')

    def _run_main(self, text):
        book = {'url': 'https://yunqi.qq.com/detail/750056', 'title': '诛仙',
                'author': '萧鼎', 'engine': True, 'source_host': 'yunqi.qq.com'}
        sent = []

        def fake_build(http_get, skip_titles=None, include_douban=True, pages=None,
                       engine_cli=None, book15_breaker=None):
            return [book]

        def fake_label(text, *a, **k):
            sent.append(text)
            return ({'title_guess': '诛仙', 'site_title_match': True, 'text_quality': '正常',
                     'genre': '仙侠', 'confidence': 0.9}, 1)

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'LABELER_DATA_DIR': str(self.dir)}), \
                mock.patch.object(labeler.douban_list, 'build_webnovel_queue',
                                  side_effect=fake_build), \
                mock.patch.object(labeler, 'fetch_book_text_engine',
                                  return_value=(text, len(text))), \
                mock.patch.object(labeler, 'label_book', side_effect=fake_label), \
                mock.patch.object(labeler.time, 'sleep'), \
                mock.patch.object(sys, 'argv',
                                  ['labeler.py', '--source', 'webnovel', '--no-db-model']), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = labeler.main()
        return code, sent, out.getvalue()

    def test_preview_source_is_rejected_without_llm_call(self):
        # 每章约 100 字、60 章：全书字数要先过 MIN_BOOK_CHARS 才进得到本地预检，
        # 所以用「短章 × 足够多章」让抓取字数过线、预检再按试读拒
        preview = '晨曦洒落，风过竹林，满山青翠如波涛缓缓起伏，又是新的一天。' * 4 + '...'
        text = '\n\n'.join(f'【第{i}章 标题APP免费】\n{preview}{i}' for i in range(82))
        code, sent, out = self._run_main(text)
        self.assertEqual(code, 2)
        self.assertEqual(sent, [])                       # 没调模型
        rec = json.loads((self.dir / 'labels-rejected.jsonl').read_text(encoding='utf-8'))
        self.assertTrue(rec['reason'].startswith('本地预检: 章节正文过短'))
        self.assertEqual(rec['url'], 'https://yunqi.qq.com/detail/750056')
        self.assertIn('本地预检不合格', out)
        self.assertIn('失败分类: 本地预检拒收 1', out)
        self.assertFalse((self.dir / 'labels.jsonl').exists())

    def test_precheck_rejections_do_not_pin(self):
        # 复审非阻断②：本地预检拒收写 rejected，但不应计入钉子户次数（≥5 次即永久跳过）
        preview = '晨曦洒落，风过竹林，满山青翠如波涛缓缓起伏，又是新的一天。' * 4 + '...'
        text = '\n\n'.join(f'【第{i}章】\n{preview}{i}' for i in range(82))
        for _ in range(REJECT_TERMINAL_RUNS := 6):
            code, sent, _ = self._run_main(text)
            self.assertEqual(code, 2)
            self.assertEqual(sent, [])
        rows = (self.dir / 'labels-rejected.jsonl').read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(rows), REJECT_TERMINAL_RUNS)
        counts = labeler.count_rejections(self.dir / 'labels-rejected.jsonl')
        self.assertEqual(counts, {})
        self.assertEqual(labeler.terminal_urls(counts), set())

    def test_model_rejections_still_pin(self):
        # 对照：非本地预检的拒收照旧计数，达到阈值仍成钉子户
        rej = self.dir / 'labels-rejected.jsonl'
        url = 'https://yunqi.qq.com/detail/750056'
        rej.write_text(
            ''.join(json.dumps({'url': url, 'reason': '模型判定: 含广告注入'},
                               ensure_ascii=False) + '\n' for _ in range(5)),
            encoding='utf-8')
        counts = labeler.count_rejections(rej)
        self.assertEqual(counts.get(url), 5)
        self.assertIn(url, labeler.terminal_urls(counts))

    def test_overlapping_text_is_deduplicated_before_llm(self):
        bodies = [_chapter_body(f'章{k}', 80) for k in range(6)]
        text = '\n\n'.join(f'【第{k}章】\n' + '\n'.join(bodies[k:k + 3]) for k in range(4))
        code, sent, out = self._run_main(text)
        self.assertEqual(code, 0)
        self.assertEqual(len(sent), 1)
        for body in bodies:
            self.assertEqual(sent[0].count(body.split('\n')[0]), 1)
        self.assertIn('本地预检: 去重', out)
        rec = json.loads((self.dir / 'labels.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(rec['chars'], len(sent[0]) - sum(len(f'【第{k}章】\n') for k in range(4))
                         - 2 * 3)


if __name__ == '__main__':
    unittest.main()
