#!/usr/bin/env python3
"""labeler.py 打标线遗留非阻断项（lblfu41）回归单测。

来源（均为复审报告里的「非阻断」条目）：
- L1 lbladrev-41 非阻断1：101–200 字、以省略号收尾的正常短章被当试读丢弃；
- L2 lbladrev-41 非阻断2：merge_text_quality 让「正常段」盖掉无证据的未知取值；
- L3 lbladrev-41 §1 A3：`第100章 2012.12.21` 的日期章名被当更新时间剥成 `第100章`；
- Q2 lblqualrev2 非阻断B + §1② B4：求票规则的口吻词表 / 行尾锚过宽，误删无引号叙述；
- Q3 lblqualrev2 非阻断C：「求票啦！」「各位，求票！」漏删。
全离线：不联网、不真调 CLI、不调 LLM。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_followups.py'
"""
import json
import os
import sys
import types
import unittest
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


class FakeCli:
    def __init__(self, toc_chapters, bodies):
        self.toc_chapters, self.bodies = toc_chapters, bodies

    def run(self, subcommand, *args):
        if subcommand == 'toc':
            return _proc(0, json.dumps({'chapters': self.toc_chapters}, ensure_ascii=False))
        return _proc(0, json.dumps({'text': self.bodies[args[1]]}, ensure_ascii=False))


# 一章 101–200 字、以省略号收尾的正常短章（楔子/过场章常见写法）
SHORT_ELLIPSIS = ('夜色沉沉，青云山下的小村里只剩几盏油灯还亮着。' * 4
                  + '他回头望了一眼，终究什么也没说，转身走进了风雪里……')
# yunqi 同形截断预览：约 100 字 + ASCII 省略号
PREVIEW = '晨曦洒落，风过竹林，满山青翠如波涛缓缓起伏，又是新的一天。' * 4 + '...'


# ---------------- L1 孤立的省略号短章不当试读 ----------------
class TestIsolatedShortEllipsisChapter(unittest.TestCase):
    def test_sample_shape(self):
        self.assertTrue(100 < len(SHORT_ELLIPSIS) <= labeler.PREVIEW_CHAPTER_MAX)
        self.assertTrue(100 < len(PREVIEW) <= labeler.PREVIEW_CHAPTER_MAX)

    def test_fetch_keeps_single_short_ellipsis_chapter(self):
        full = '正文' * 300
        chapters = [{'url': f'https://k/c{i}', 'title': f'第{i}章 起'} for i in range(6)]
        bodies = {c['url']: full for c in chapters}
        bodies['https://k/c3'] = SHORT_ELLIPSIS
        stats = {}
        with mock.patch.object(labeler.time, 'sleep'):
            text, chars = labeler.fetch_book_text_engine(
                FakeCli(chapters, bodies), 'https://k/b', stats=stats)
        self.assertIn(SHORT_ELLIPSIS, text)
        self.assertEqual(stats['preview_chapters'], 0)
        self.assertEqual(chars, 5 * len(full) + len(SHORT_ELLIPSIS))

    def test_prepare_keeps_single_short_ellipsis_chapter(self):
        text = '\n\n'.join(
            [f'【第{i}章 起】\n{_chapter_body(f"章{i}", 80)}' for i in range(5)]
            + [f'【第5章 夜】\n{SHORT_ELLIPSIS}'])
        out, _, reason, stats = labeler.prepare_book_text(text, clean=True)
        self.assertIsNone(reason)
        self.assertIn(SHORT_ELLIPSIS, out)
        self.assertEqual(stats['preview_chapters'], 0)

    def test_fetch_still_drops_preview_source(self):
        # 反例：成批的截断预览（试读源）照旧丢弃
        full = '正文' * 300
        chapters = [{'url': f'https://yq/c{i}', 'title': f'第{i}章 夜'} for i in range(12)]
        bodies = {c['url']: (full if i < 4 else f'{PREVIEW}') for i, c in enumerate(chapters)}
        stats = {}
        with mock.patch.object(labeler.time, 'sleep'):
            text, chars = labeler.fetch_book_text_engine(
                FakeCli(chapters, bodies), 'https://yq/b', stats=stats)
        self.assertEqual(stats['preview_chapters'], 8)
        self.assertNotIn(PREVIEW, text)
        self.assertEqual(chars, 4 * len(full))

    def test_title_previews_count_towards_preview_source(self):
        # 目录里已有 APP免费 试读章被跳过 → 该源是试读源，零星的正文预览章同样丢
        full = '正文' * 300
        chapters = ([{'url': f'https://yq/f{i}', 'title': f'第{i}章 免费'} for i in range(3)]
                    + [{'url': f'https://yq/a{i}', 'title': f'第{i}章 罚跪APP免费'}
                       for i in range(3, 8)]
                    + [{'url': 'https://yq/p', 'title': '第8章 夜'}])
        bodies = {c['url']: full for c in chapters}
        bodies['https://yq/p'] = PREVIEW
        stats = {}
        with mock.patch.object(labeler.time, 'sleep'):
            text, _ = labeler.fetch_book_text_engine(
                FakeCli(chapters, bodies), 'https://yq/b', stats=stats)
        self.assertEqual(stats['preview_chapters'], 6)
        self.assertNotIn(PREVIEW, text)

    def test_prepare_still_drops_preview_source(self):
        free = '\n\n'.join(f'【第{i}章 免费】\n{_chapter_body(f"章{i}", 40)}' for i in range(10))
        previews = '\n\n'.join(f'【第{i}章 夜】\n{PREVIEW}' for i in range(10, 20))
        out, _, reason, stats = labeler.prepare_book_text(free + '\n\n' + previews, clean=True)
        self.assertIsNone(reason)
        self.assertEqual(stats['preview_chapters'], 10)
        self.assertNotIn(PREVIEW, out)


# ---------------- L2 未知取值不被「正常」段盖掉 ----------------
class TestMergeUnknownQuality(unittest.TestCase):
    def m(self, *segs):
        return labeler.merge_text_quality(list(segs))

    def test_normal_plus_unknown_without_evidence_is_not_normal(self):
        self.assertEqual(self.m({'text_quality': '正常'}, {'text_quality': '未知值'})[0], '未知值')
        self.assertEqual(self.m({'text_quality': '未知值'}, {'text_quality': '正常'})[0], '未知值')

    def test_non_string_quality_is_not_normal(self):
        q, _ = self.m({'text_quality': '正常'}, {'text_quality': 3})
        self.assertEqual(q, 3)

    def test_known_values_without_evidence_still_yield_to_normal(self):
        # 反例：已知取值（含广告注入/疑似乱码/大面积重复）无证据时仍被正常段覆盖（lbladfix41 设计不变）
        for q in ('含广告注入', '疑似乱码', '大面积重复'):
            self.assertEqual(self.m({'text_quality': '正常'}, {'text_quality': q}), ('正常', []), q)

    def test_unknown_still_most_severe_among_known(self):
        self.assertEqual(self.m({'text_quality': '怪值'}, {'text_quality': '疑似乱码'})[0], '怪值')


# ---------------- L3 日期章名 ----------------
class TestDateChapterTitle(unittest.TestCase):
    def test_date_as_whole_chapter_name_is_kept(self):
        for t in ('第100章 2012.12.21', '第3章 2008年8月8日', '2012.12.21'):
            self.assertEqual(labeler.clean_chapter_title(t), t, t)

    def test_update_time_tail_still_stripped(self):
        self.assertEqual(labeler.clean_chapter_title('第10章 风起 更新时间：2019-05-01 12:00'),
                         '第10章 风起')
        self.assertEqual(labeler.clean_chapter_title('第11章 云涌 2019-05-01'), '第11章 云涌')
        # 标题只剩「更新时间」尾巴：尾巴是站点加的，剥掉
        self.assertEqual(labeler.clean_chapter_title('第12章 更新时间：2019-05-01'), '第12章')


# ---------------- Q2/Q3 求票规则 ----------------
class TestPleaRuleFollowups(unittest.TestCase):
    # lblqualrev2 §1② B/B4：无引号叙述，不是作者对读者说话 → 必须保留
    NARRATION_KEEP = (
        '作者求月票，读者求订阅，场面热闹。',
        '他求订阅那本杂志已经三年了，谢谢。',
        '他跪在雪地里向过往的行人求打赏',
        '那些网络主播正在直播里求打赏',
        '老同学打电话来求推荐票',
        '她低声下气地向主编求订阅',
        '全班同学联名向校长求推荐票',
        '他挨家挨户地求收藏',
        # 用户点名：叙述里的「求票」保留
        '他拿着喇叭在广场上求票。',
        '粉丝们为偶像求票，闹得沸沸扬扬。',
        '她向主办方求月票已经很久了。',
        '那一届的歌王靠求票夺冠。',
        '公司派他四处求票…',
        '他去车站求票据报销。',
    )
    # 真求票行：必须删
    PLEA_DROP = (
        '求票啦！',
        '各位，求票！',
        '投我票吧，求票！',
        '今天三更，求月票！',
        '本书已肥，求打赏～',
        '冲榜求推荐票',
        '求打赏。',
        '小三已经上架了，书友们多多支持。在这里小三求下月票，还有月票的书友，请投给小三吧，谢谢。',
        '求支持，求点击，求推荐，求收藏。',
    )

    def test_narration_kept(self):
        for line in self.NARRATION_KEEP:
            self.assertIsNone(labeler._drop_rule(line), line)

    def test_plea_dropped(self):
        for line in self.PLEA_DROP:
            self.assertEqual(labeler._drop_rule(line), 'plea', line)


if __name__ == '__main__':
    unittest.main()
