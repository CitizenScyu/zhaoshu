#!/usr/bin/env python3
"""douban_list.py 的离线单测（豆瓣线打标供给）。

全离线：不联网、不调 LLM、不读 .env。
复跑：python scripts/test_douban_list.py
      python -m unittest discover -s scripts -p 'test_douban_list.py'

样本来源：2026-09-18 实测。
- 豆瓣 tag 页结构：book.douban.com/tag/网络小说 等页面的 li.subject-item 块
  （li > div.info > h2 > a[title] + div.pub「作者 / 出版社」）。
- book15 搜索结果结构：class="list-item-panel" 区块内的 h3/details 链接；
  误匹配样本（间客→天上有间客栈、斗破苍穹→一切从斗破苍穹开始、
  遮天→穿越从遮天开始）是 phoenix 上真跑出来的。
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import douban_list  # noqa: E402


class FakeEngineCli:
    """引擎 CLI 桩：记录调用、返回预置的 CompletedProcess-like 结果（不真调子进程）。

    results 可为 {subcommand: SimpleNamespace(returncode, stdout, stderr)} 字典，
    或 callable(subcommand, args) -> SimpleNamespace（用于按调用序变结果）。"""

    def __init__(self, results):
        self.results = results
        self.calls = []

    def run(self, subcommand, *args):
        self.calls.append((subcommand, list(args)))
        if callable(self.results):
            return self.results(subcommand, list(args))
        return self.results[subcommand]


def _proc(returncode=0, stdout='', stderr=''):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _engine_search_stdout(candidates):
    """engine-fetch.mjs `search --json` 的 stdout：单行 JSON 数组。"""
    return json.dumps(candidates, ensure_ascii=False)


def no_wait(case):
    """把两个站间间隔都置 0（测试不等真 sleep；对目标站的礼貌延迟只在生产生效）。"""
    patcher = mock.patch.multiple(douban_list, SEARCH_DELAY=0, DOUBAN_PAGE_DELAY=0)
    patcher.start()
    case.addCleanup(patcher.stop)


# 豆瓣 tag 页实测结构（按 2026-09-18 抓到的 subject-item 块缩写，
# 保留真实嵌套：h2 内 a 带 title 属性，div.pub 内是「作者 / 出版社」）。
DOUBAN_TAG_HTML = """<ul class="subject-list">
<li class="subject-item">
  <div class="pic"><a class="nbg" href="https://book.douban.com/subject/37444272/"><img src="x.jpg" width="90"></a></div>
  <div class="info">
    <h2><a href="https://book.douban.com/subject/37444272/" title="我在废土世界扫垃圾">我在废土世界扫垃圾</a></h2>
    <div class="pub">有花在野 / 广东旅游出版社</div>
    <div class="star clearfix"><span class="rating_nums">9.3</span></div>
  </div>
</li>
<li class="subject-item">
  <div class="pic"><a class="nbg" href="https://book.douban.com/subject/25676982/"><img src="y.jpg" width="90"></a></div>
  <div class="info">
    <h2><a href="https://book.douban.com/subject/25676982/" title="盗墓笔记">盗墓笔记</a></h2>
    <div class="pub">南派三叔 / 中国友谊出版公司</div>
  </div>
</li>
<li class="subject-item">
  <div class="info">
    <h2><a href="https://book.douban.com/subject/1/" title="缺 pub 的条目">缺 pub 的条目</a></h2>
  </div>
</li>
<li class="subject-item">
  <div class="info"><h2>没有链接标题的坏条目</h2></div>
</li>
</ul>"""


def book15_search_html(title: str, url: str) -> str:
    """一条搜索结果的搜索页（list-item-panel 区块，按实测结构缩写）。"""
    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8"><title>搜索</title></head><body>
<div class="wrap"><div class="list-item-panel fh"><ul>
<li><a href="{url}" target="_blank" title="{title}"><img src="c.jpg"/></a></li>
<ul class="fh-f1"><h3><a href="{url}" target="_blank" title="{title}">{title}</a></h3></ul>
</ul></div>
<ul><li class="fh"><p class="fh-f1"><a class="nowrap-1" href="/books/details999.html" title="热门榜书">热门榜书</a></p></li></ul>
</div></body></html>"""


NO_RESULT_HTML = """<html><head><title>网阅完本搜索小说</title></head><body>
<ul><li class="fh"><p class="fh-f1"><a href="/books/details999.html" title="热门榜书">热门榜书</a></p></li></ul>
</body></html>"""


class TestParseDoubanTagPage(unittest.TestCase):
    def test_extracts_title_author_url(self):
        books = douban_list.parse_douban_tag_page(DOUBAN_TAG_HTML)
        self.assertEqual(len(books), 3)
        self.assertEqual(books[0], {
            'title': '我在废土世界扫垃圾', 'author': '有花在野',
            'douban_url': 'https://book.douban.com/subject/37444272/'})
        self.assertEqual(books[1]['author'], '南派三叔')

    def test_missing_pub_yields_empty_author(self):
        books = douban_list.parse_douban_tag_page(DOUBAN_TAG_HTML)
        self.assertEqual(books[2]['author'], '')
        self.assertEqual(books[2]['title'], '缺 pub 的条目')

    def test_publisher_first_segment_is_not_author(self):
        # authfix41（authmis41 C2，phoenix 22 行）：该版本没列作者时 pub 首段就是出版社，
        # 不能拿出版社当人名去拒引擎真作者 → 作者未知（''）
        def page(pub):
            return ('<li class="subject-item"><div class="info"><h2><a href="https://book.douban.com'
                    f'/subject/9/" title="书">书</a></h2><div class="pub">{pub}</div></div></li>')
        for pub in ('青岛出版社 / 2020-4 / 59.8', '浙江文艺出版社 / 2020-4 / 40.00元',
                    '中华书局 / 2010', '某某出版公司 / 2019', '早川書房 / 2025-6-18',
                    'Penguin Press / 2020', 'Tor Publishing Group / 2021'):
            with self.subTest(pub=pub):
                self.assertEqual(douban_list.parse_douban_tag_page(page(pub))[0]['author'], '')
        # 反例（2026-09-25 tag 页实测形态）：首段是作者的照旧取作者，含「作者 / 日期」无出版社形态
        for pub, author in (('烽火戏诸侯 / 浙江文艺出版社 / 2020-4', '烽火戏诸侯'),
                            ('柯山梦 / 2012-8', '柯山梦'), ('饭卡 / 2024', '饭卡'),
                            ('七月新番', '七月新番'), ('Steven Pressfield / Bantam', 'Steven Pressfield')):
            with self.subTest(pub=pub):
                self.assertEqual(douban_list.parse_douban_tag_page(page(pub))[0]['author'], author)

    def test_broken_item_is_skipped(self):
        # h2 里没有带 title 的 a：跳过，不拖垮整页
        titles = [b['title'] for b in douban_list.parse_douban_tag_page(DOUBAN_TAG_HTML)]
        self.assertNotIn('没有链接标题的坏条目', titles)

    def test_empty_page(self):
        self.assertEqual(douban_list.parse_douban_tag_page('<html></html>'), [])


class TestParseBook15Search(unittest.TestCase):
    def test_extracts_results_in_order(self):
        html = book15_search_html('诡秘之主', '/books/details3168.html')
        self.assertEqual(douban_list.parse_book15_search(html),
                         [('/books/details3168.html', '诡秘之主')])

    def test_hot_rank_block_is_not_a_result(self):
        # 无结果时页面只剩 .fh 热门榜（不是 list-item-panel），不得混进搜索结果
        self.assertEqual(douban_list.parse_book15_search(NO_RESULT_HTML), [])


class TestTitleCompatible(unittest.TestCase):
    """语义校验：LIKE 模糊搜索的误匹配防线。样本全部来自 2026-09-18 实测。"""

    # 真命中：必须放行
    TRUE_HITS = (
        ('诡秘之主', '诡秘之主'),                    # 完全同名
        ('盗墓笔记', '盗墓笔记7'),                   # 剥序号后同名
        ('盗墓笔记', '盗墓笔记·十年'),               # 副标题形态
        ('凡人修仙传', '凡人修仙传（1-10）'),         # 剥套装册数后缀
        ('斗罗大陆', '斗罗大陆IV终极斗罗'),           # 站内名带系列卷号
    )

    # 误匹配：必须拦下（实测 LIKE 搜索真返回过这些）
    FALSE_MATCHES = (
        ('间客', '天上有间客栈'),                     # 「间客」出现在标题中部
        ('斗破苍穹', '一切从斗破苍穹开始'),            # 同人书，书名不在开头
        ('遮天', '穿越从遮天开始'),                   # 同上
    )

    def test_true_hits_pass(self):
        for douban_title, site_title in self.TRUE_HITS:
            with self.subTest(pair=(douban_title, site_title)):
                self.assertTrue(douban_list.title_compatible(douban_title, site_title))

    def test_false_matches_are_blocked(self):
        for douban_title, site_title in self.FALSE_MATCHES:
            with self.subTest(pair=(douban_title, site_title)):
                self.assertFalse(douban_list.title_compatible(douban_title, site_title))

    def test_one_char_title_never_matches_by_containment(self):
        # 单字书名靠包含规则会命中大量标题，必须拦
        self.assertFalse(douban_list.title_compatible('雨', '风吹草动雨未歇'))

    def test_empty_titles_never_match(self):
        self.assertFalse(douban_list.title_compatible('', '随便什么'))
        self.assertFalse(douban_list.title_compatible('随便什么', ''))


class TestSearchBook15(unittest.TestCase):
    """search_book15 接线：重试、语义校验、无结果。全部 mock http_get。"""

    def _http_get(self, url):
        return self.pages[url]

    def test_exact_hit_returns_first_compatible(self):
        self.pages = {'/books/search.html?kw=%E8%AF%A1%E7%A7%98%E4%B9%8B%E4%B8%BB':
                      book15_search_html('诡秘之主', '/books/details3168.html')}
        hit = douban_list.search_book15(self._http_get, '诡秘之主')
        self.assertEqual(hit, {'url': '/books/details3168.html', 'title': '诡秘之主'})

    def test_mismatched_result_returns_none(self):
        # 搜索有结果但标题对不上（同人/衍生）→ None，不返回错书
        self.pages = {'/books/search.html?kw=%E9%97%B4%E5%AE%A2':
                      book15_search_html('天上有间客栈', '/books/details133.html')}
        self.assertIsNone(douban_list.search_book15(self._http_get, '间客'))

    def test_no_result_page_returns_none(self):
        self.pages = {'/books/search.html?kw=%E9%9B%B6%E8%AF%BA': NO_RESULT_HTML}
        self.assertIsNone(douban_list.search_book15(self._http_get, '零诺'))

    def test_retries_then_succeeds(self):
        # 前两次网络失败，第三次成功 → 仍能拿到结果
        self.calls = []

        def flaky(url):
            self.calls.append(url)
            if len(self.calls) < 3:
                raise ConnectionError('ssl handshake timeout')
            return book15_search_html('绍宋', '/books/details5780.html')

        douban_list.SEARCH_RETRY_DELAY = 0  # 测试不等真退避
        try:
            hit = douban_list.search_book15(flaky, '绍宋')
        finally:
            douban_list.SEARCH_RETRY_DELAY = 3
        self.assertEqual(hit, {'url': '/books/details5780.html', 'title': '绍宋'})
        self.assertEqual(len(self.calls), 3)

    def test_all_retries_exhausted_returns_none(self):
        def always_fail(url):
            raise ConnectionError('down')
        douban_list.SEARCH_RETRY_DELAY = 0
        try:
            self.assertIsNone(douban_list.search_book15(always_fail, '任何书'))
        finally:
            douban_list.SEARCH_RETRY_DELAY = 3


class TestBuildDoubanQueue(unittest.TestCase):
    def _http_get(self, url):
        if url.startswith('https://book.douban.com/tag/'):
            return DOUBAN_TAG_HTML
        return self.search_pages.get(url, NO_RESULT_HTML)

    def test_queue_shape_matches_rank_books(self):
        # 产出与 fetch_rank_books() 同构：url 站内相对路径 + title/author/category
        self.search_pages = {
            '/books/search.html?kw=%E6%88%91%E5%9C%A8%E5%BA%9F%E5%9C%9F%E4%B8%96%E7%95%8C%E6%89%AB%E5%9E%83%E5%9C%BE':
                NO_RESULT_HTML,
            '/books/search.html?kw=%E7%9B%97%E5%A2%93%E7%AC%94%E8%AE%B0':
                book15_search_html('盗墓笔记7', '/books/details42.html'),
            '/books/search.html?kw=%E7%BC%BA%20pub%20%E7%9A%84%E6%9D%A1%E7%9B%AE':
                NO_RESULT_HTML,
        }
        no_wait(self)
        queue = douban_list.build_douban_queue(self._http_get)
        self.assertEqual(len(queue), 1)
        b = queue[0]
        self.assertEqual(b['url'], '/books/details42.html')
        self.assertEqual(b['title'], '盗墓笔记7')
        self.assertEqual(b['author'], '南派三叔')
        self.assertEqual(b['category'], '豆瓣tag')

    def test_douban_tag_fetch_failure_is_skipped(self):
        # 某个 tag 拉取失败：告警跳过，其余 tag 照常
        def failing_douban(url):
            if url.startswith('https://book.douban.com/tag/'):
                raise ConnectionError('douban down')
            return NO_RESULT_HTML

        no_wait(self)
        queue = douban_list.build_douban_queue(failing_douban)
        self.assertEqual(queue, [])

    def test_dedup_across_tags(self):
        # 同一本书出现在两个 tag 页（正常现象）：豆瓣名单侧先去重
        books = douban_list.parse_douban_tag_page(DOUBAN_TAG_HTML) \
            + douban_list.parse_douban_tag_page(DOUBAN_TAG_HTML)
        keys = [douban_list._norm_title(b['title']) for b in books]
        self.assertNotEqual(len(keys), len(set(keys)))  # 原始列表确实有重复
        # fetch_douban_books 的去重逻辑（与 build_douban_queue 内一致）
        seen, deduped = set(), []
        for b in books:
            k = douban_list._norm_title(b['title'])
            if k not in seen:
                seen.add(k)
                deduped.append(b)
        self.assertEqual(len(deduped), 3)


# ---- 豆瓣 tag 翻页（2026-09-19 实测 ?start=N 生效，每 tag 3 页）----
def douban_page_html(titles, start):
    """一页 subject-item 列表（title 依次编号，便于断言页码）。"""
    items = ''.join(
        f'<li class="subject-item"><div class="info">'
        f'<h2><a href="https://book.douban.com/subject/{1000 + start + i}/" '
        f'title="{t}">{t}</a></h2><div class="pub">{t}作者 / 某社</div></div></li>'
        for i, t in enumerate(titles))
    return f'<ul class="subject-list">{items}</ul>'


class TestDoubanPagination(unittest.TestCase):
    def setUp(self):
        no_wait(self)

    def _recording_get(self, pages):
        self.urls = []

        def http_get(url):
            self.urls.append(url)
            return pages.get(url, '<html></html>')

        return http_get

    def test_first_page_has_no_start_param_and_later_pages_do(self):
        # 标题必须两两不同：数字会被 _norm_title 当卷号剥掉，单字重复也会被去重
        alphabet = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌'
        counter = 0
        pages = {}
        for p in range(3):
            for tag in douban_list.DOUBAN_TAGS:
                titles = []
                for _ in range(3):
                    titles.append(alphabet[counter // len(alphabet)] +
                                  alphabet[counter % len(alphabet)] + '书')
                    counter += 1
                pages[douban_list._douban_tag_url(tag, p)] = douban_page_html(titles, p * 20)
        http_get = self._recording_get(pages)
        books = douban_list.fetch_douban_books(http_get, pages=3)
        self.assertEqual(len(books), len(douban_list.DOUBAN_TAGS) * 3 * 3)
        first_tag_quoted = urllib.parse.quote(douban_list.DOUBAN_TAGS[0])
        tag_urls = [u for u in self.urls if first_tag_quoted in u]
        self.assertTrue(tag_urls[0].endswith('/tag/' + first_tag_quoted))  # 第一页不带参数
        self.assertTrue(tag_urls[1].endswith('?start=20'))
        self.assertTrue(tag_urls[2].endswith('?start=40'))

    def test_pages_are_deduplicated_within_a_tag(self):
        same = douban_page_html(['重复书', '独有书'], 0)
        pages = {douban_list._douban_tag_url('网络小说', p): same for p in range(3)}
        books = douban_list.fetch_douban_books(self._recording_get(pages), pages=3)
        self.assertEqual([b['title'] for b in books], ['重复书', '独有书'])

    def test_single_page_failure_does_not_drop_the_others(self):
        def http_get(url):
            if url.endswith('?start=20'):
                raise ConnectionError('豆瓣第二页超时')
            return douban_page_html(['甲书', '乙书'], 0)

        books = douban_list.fetch_douban_books(http_get, pages=3)
        self.assertEqual(len(books), 2)          # 失败页被跳过，其余页照常

    def test_default_is_one_page_and_pages_are_configurable(self):
        self.assertEqual(douban_list.DOUBAN_PAGES, 1)   # 审查 D.3：默认 1 页
        with mock.patch.object(douban_list, 'DOUBAN_PAGES', 2):
            urls = []
            douban_list.fetch_douban_books(
                lambda url: urls.append(url) or douban_page_html([], 0))
            self.assertEqual(len(urls), len(douban_list.DOUBAN_TAGS) * 2)
            self.assertTrue(any('?start=20' in u for u in urls))


class TestDoubanPagesSwitch(unittest.TestCase):
    """3 页是显式开关（审查 D.3）：默认 1 页，LABELER_DOUBAN_PAGES 才开。"""

    def setUp(self):
        no_wait(self)

    def test_default_is_one_page(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(douban_list.DOUBAN_PAGES_ENV, None)
            self.assertEqual(douban_list.resolve_douban_pages(), 1)
            self.assertEqual(douban_list.resolve_douban_pages({}), 1)

    def test_env_dict_opens_more_pages(self):
        # labeler 的 .env 读成字典、不 export 到 os.environ → 必须支持传字典
        self.assertEqual(
            douban_list.resolve_douban_pages({douban_list.DOUBAN_PAGES_ENV: '3'}), 3)

    def test_process_env_is_used_when_dict_is_silent(self):
        with mock.patch.dict(os.environ, {douban_list.DOUBAN_PAGES_ENV: '2'}):
            self.assertEqual(douban_list.resolve_douban_pages({}), 2)

    def test_invalid_or_non_positive_values_fall_back(self):
        for value in ('abc', '0', '-1', ''):
            with self.subTest(value=value):
                self.assertEqual(
                    douban_list.resolve_douban_pages(
                        {douban_list.DOUBAN_PAGES_ENV: value}), 1)

    def test_explicit_pages_argument_wins(self):
        urls = []
        douban_list.fetch_douban_books(
            lambda url: urls.append(url) or douban_page_html([], 0), pages=3)
        self.assertEqual(len(urls), len(douban_list.DOUBAN_TAGS) * 3)


class TestSkipDoneTitles(unittest.TestCase):
    """搜索前跳过已打标书名（审查 D.3）：这是「跳过已完成」的正确性，不是缓存优化。"""

    def setUp(self):
        no_wait(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_load_done_titles_reads_title_and_site_title(self):
        path = Path(self.tmp.name) / 'labels.jsonl'
        path.write_text('\n'.join([
            json.dumps({'title': '剑来', 'site_title': '剑来'}, ensure_ascii=False),
            json.dumps({'title': '《雪中悍刀行》', 'site_title': ''}, ensure_ascii=False),
            '坏行',
            json.dumps({'title': '', 'site_title': ''}, ensure_ascii=False),
        ]), encoding='utf-8')
        self.assertEqual(douban_list.load_done_titles(path),
                         {'剑来', '雪中悍刀行'})          # 归一化（去书名号）
        self.assertEqual(douban_list.load_done_titles(Path(self.tmp.name) / 'nope.jsonl'),
                         set())

    def test_skipped_candidate_is_not_searched(self):
        seen = []

        def http_get(url):
            seen.append(url)
            if url == douban_list.ZHENG_MOBILE + '/complete':
                return ZHENG_COMPLETE_HTML
            if url.startswith(douban_list.QIDIAN_MOBILE):
                return '<html></html>'
            return NO_RESULT_HTML

        queue = douban_list.build_webnovel_queue(
            http_get, include_douban=False, skip_titles={'剑来'})
        self.assertEqual(queue, [])
        # 「剑来」在候选池里，但已在 labels.jsonl → 连搜索都不发
        self.assertNotIn('/books/search.html?kw=%E5%89%91%E6%9D%A5', seen)
        # 未打标的同源候选照常搜索（雪中悍刀行）
        self.assertIn('/books/search.html?kw=%E9%9B%AA%E4%B8%AD%E6%82%8D%E5%88%80%E8%A1%8C', seen)

    def test_no_skip_set_searches_everything(self):
        seen = []

        def http_get(url):
            seen.append(url)
            if url == douban_list.ZHENG_MOBILE + '/complete':
                return ZHENG_COMPLETE_HTML
            if url.startswith(douban_list.QIDIAN_MOBILE):
                return '<html></html>'
            return NO_RESULT_HTML

        douban_list.build_webnovel_queue(http_get, include_douban=False)
        self.assertIn('/books/search.html?kw=%E5%89%91%E6%9D%A5', seen)


# ---- 起点移动版页面（2026-09-18 实测结构缩写）----
# finish 页：区块名后跟 (书名, 作者) 对（影视同期区），或 书名/简介/作者/分类/完本/字数
QIDIAN_FINISH_HTML = """<html><body>
<div>返回</div><div>完本</div><div>男生</div><div>女生</div>
<div>大家都在搜</div>
<div>影视同期</div><div>火热影视原作</div>
<div>庆余年</div><div>猫腻</div>
<div>将夜</div><div>猫腻</div>
<div>斗破苍穹</div><div>天蚕土豆</div>
<div>经典必读</div><div>更多</div>
<div>诡秘之主</div><div>爱潜水的乌贼</div>
<div>玄幻</div><div>完结</div><div>446.77万字</div>
<div>灵境行者</div><div>卖报小郎君</div>
<div>科幻</div><div>完结</div><div>417.95万字</div>
<div>畅销完本</div><div>更多</div>
<div>捞尸人</div><div>人知鬼恐怖，鬼晓人心毒。这是一本传统灵异小说。</div><div>纯洁滴小龙</div>
<div>都市</div><div>完本</div><div>651.82万字</div>
<div>首页</div><div>完本小说</div><div>登录后获得更多特色功能</div><div>立即登录</div>
<div>QQ阅读</div><div>腾讯动漫</div><div>触屏版</div><div>下载</div>
</body></html>"""

# 榜单页：序号 → 书名 → 简介 → 作者 → 分类 → 字数（月票榜是 书名→N月票→简介→作者→分类→字数）
QIDIAN_RANK_HTML = """<html><body>
<div>大家都在搜</div><div>全站</div><div>玄幻</div>
<div>1</div><div>夜无疆</div><div>4.47万月票</div><div>那一天太阳落下再也没有升起…………………</div><div>辰东</div><div>玄幻</div><div>402.69万字</div>
<div>2</div><div>玄鉴仙族</div><div>3.66万月票</div><div>陆江仙熬夜猝死，残魂却附在了一面满是裂痕的青灰色铜镜上……</div><div>季越人</div><div>仙侠</div><div>628.86万字</div>
<div>3</div><div>武道！</div><div>4.11万月票</div><div>田隶</div><div>玄幻</div><div>85.21万字</div>
</body></html>"""


class TestParseQidianFinish(unittest.TestCase):
    def test_extracts_pairs_per_section(self):
        books = douban_list.parse_qidian_finish(QIDIAN_FINISH_HTML)
        titles = {b['title'] for b in books}
        # 影视同期 3 本 + 经典必读 2 本 + 畅销完本 1 本
        self.assertTrue({'庆余年', '将夜', '斗破苍穹', '诡秘之主',
                         '灵境行者', '捞尸人'} <= titles)

    def test_categories_and_wordcounts_are_not_titles(self):
        books = douban_list.parse_qidian_finish(QIDIAN_FINISH_HTML)
        titles = {b['title'] for b in books}
        for noise in ('玄幻', '科幻', '都市', '完结', '更多', '返回'):
            self.assertNotIn(noise, titles)

    def test_author_extraction_with_long_intro(self):
        # 畅销完本区：书名 → 长简介 → 作者。简介行被长度闸挡在作者位外
        books = douban_list.parse_qidian_finish(QIDIAN_FINISH_HTML)
        target = [b for b in books if b['title'] == '捞尸人']
        self.assertEqual(len(target), 1)
        self.assertEqual(target[0]['author'], '纯洁滴小龙')

    def test_dedup_across_sections(self):
        # 同书跨区块出现（真实页面：诡秘之主/斗破苍穹在多区块）→ 去重
        html = QIDIAN_FINISH_HTML.replace(
            '<div>畅销完本</div><div>更多</div>',
            '<div>畅销完本</div><div>更多</div><div>诡秘之主</div><div>爱潜水的乌贼</div>')
        books = douban_list.parse_qidian_finish(html)
        self.assertEqual(len([b for b in books if b['title'] == '诡秘之主']), 1)

    def test_footer_nav_words_are_not_titles(self):
        # 2026-09-18 phoenix 实跑 bug：最后一个区块后直接接页脚（没有下一个区块名切片），
        # 页脚词（首页/登录后…/QQ阅读/触屏版…）被当书名收进名单
        books = douban_list.parse_qidian_finish(QIDIAN_FINISH_HTML)
        titles = {b['title'] for b in books}
        for footer in ('首页', '完本小说', '登录后获得更多特色功能', '立即登录',
                       'QQ阅读', '腾讯动漫', '触屏版', '帮助与客服', '下载'):
            self.assertNotIn(footer, titles)

    def test_empty_page(self):
        self.assertEqual(douban_list.parse_qidian_finish('<html></html>'), [])


class TestParseQidianRank(unittest.TestCase):
    def test_extracts_numbered_entries(self):
        books = douban_list.parse_qidian_rank(QIDIAN_RANK_HTML)
        self.assertEqual(len(books), 3)
        self.assertEqual(books[0]['title'], '夜无疆')
        self.assertEqual(books[0]['author'], '辰东')
        self.assertEqual(books[1]['title'], '玄鉴仙族')
        self.assertEqual(books[1]['author'], '季越人')

    def test_no_desc_when_author_adjacent(self):
        # 第 3 条：书名 → 月票 → 作者 → 分类（无简介），作者照样取到
        books = douban_list.parse_qidian_rank(QIDIAN_RANK_HTML)
        self.assertEqual(books[2]['title'], '武道！')
        self.assertEqual(books[2]['author'], '田隶')

    def test_category_words_not_titles(self):
        books = douban_list.parse_qidian_rank(QIDIAN_RANK_HTML)
        titles = {b['title'] for b in books}
        self.assertNotIn('玄幻', titles)
        self.assertNotIn('仙侠', titles)

    def test_new_genre_words_are_not_authors(self):
        # authfix41（authmis41 C1，phoenix 133 行）：起点新分类词不在噪声表时被当成作者，
        # 真作者被顶掉（《神秘复苏》名单作者成了「悬疑灵异」）。条目按 2026-09-25 本地抓的
        # m.qidian.com/rank/{hotsales,newbook,sign} 原样文本节点缩写。
        html = """<html><body>
<div>全站</div><div>现实</div><div>体育</div><div>悬疑灵异</div><div>诸天无限</div><div>轻小说</div>
<div>15</div><div>还不起学贷的我只好兼职猎魔</div><div>小夕岁</div><div>轻小说</div><div>80万字</div>
<div>17</div><div>神秘复苏</div><div>佛前献花</div><div>悬疑灵异</div><div>531.57万字</div>
<div>6</div><div>浪起1931</div><div>草花书生</div><div>诸天无限</div><div>2.47万字</div>
<div>9</div><div>行商坐医</div><div>山樵守护者</div><div>现实</div><div>12万字</div>
<div>16</div><div>某体育书</div><div>四仰化三铁</div><div>体育</div><div>15.69万字</div>
</body></html>"""
        got = {b['title']: b['author'] for b in douban_list.parse_qidian_rank(html)}
        self.assertEqual(got, {'还不起学贷的我只好兼职猎魔': '小夕岁', '神秘复苏': '佛前献花',
                               '浪起1931': '草花书生', '行商坐医': '山樵守护者',
                               '某体育书': '四仰化三铁'})

    def test_no_genre_word_can_land_in_author_slot(self):
        # 分类全集逐个钉：任一分类词出现在作者位之后都不得被取作作者
        for genre in sorted(douban_list.QIDIAN_GENRES):
            with self.subTest(genre=genre):
                html = (f'<div>1</div><div>书名甲</div><div>真作者</div><div>{genre}</div>'
                        '<div>10万字</div>')
                books = douban_list.parse_qidian_rank(html)
                self.assertEqual([b['author'] for b in books], ['真作者'])


# ---- 纵横移动版完本专区（2026-09-19 调研接入；两种 book-author 形态并存）----
ZHENG_COMPLETE_HTML = """<!doctype html><html><body>
<div class="book-layout" data-sa-d={&#34;book_id&#34;:&#34;1235249&#34;}>
  <a href="//m.zongheng.com/book/1235249" class="book-title">剑来</a>
  <a href="//m.zongheng.com/book/1235249" class="book-author">烽火戏诸侯</a></div>
<div class="book-layout" data-sa-d={&#34;book_id&#34;:&#34;1207373&#34;}>
  <a href="//m.zongheng.com/book/1207373" class="book-title">雪中悍刀行</a>
  <a href="//m.zongheng.com/book/1207373" class="book-author">烽火戏诸侯</a></div>
<div class="book-cell"><a class="book-title">超品神瞳</a>
  <div class="book-meta"><span class="book-author"><aria>作者：</aria>李闲鱼 · 856.8万</span></div></div>
<div class="book-cell"><a class="book-title">剑来</a>
  <div class="book-meta"><span class="book-author"><aria>作者：</aria>烽火戏诸侯 · 680.1万</span></div></div>
</body></html>"""


class TestParseZonghengComplete(unittest.TestCase):
    """纵横完本页：两种 book-author 形态 + 邻条不串作者 + 跨条去重。"""

    def test_extracts_title_and_author_in_both_shapes(self):
        books = douban_list.parse_zongheng_complete(ZHENG_COMPLETE_HTML)
        self.assertEqual([b['title'] for b in books], ['剑来', '雪中悍刀行', '超品神瞳'])
        self.assertEqual(books[0]['author'], '烽火戏诸侯')       # <a class="book-author">
        self.assertEqual(books[1]['author'], '烽火戏诸侯')
        self.assertEqual(books[2]['author'], '李闲鱼')           # <aria>作者：</aria>作者 · 字数

    def test_author_is_not_borrowed_from_the_neighbour_entry(self):
        html = ('<a class="book-title">甲书</a><a class="book-author">甲作者</a>'
                '<a class="book-title">乙书</a><a class="book-author">乙作者</a>')
        books = douban_list.parse_zongheng_complete(html)
        self.assertEqual([(b['title'], b['author']) for b in books],
                         [('甲书', '甲作者'), ('乙书', '乙作者')])

    def test_dedup_across_sections(self):
        books = douban_list.parse_zongheng_complete(ZHENG_COMPLETE_HTML)
        self.assertEqual(len([b for b in books if b['title'] == '剑来']), 1)

    def test_origin_marker_is_zongheng(self):
        books = douban_list.parse_zongheng_complete(ZHENG_COMPLETE_HTML)
        self.assertEqual({b['origin'] for b in books}, {'纵横完本'})

    def test_empty_page(self):
        self.assertEqual(douban_list.parse_zongheng_complete('<html></html>'), [])

    def test_fetch_failure_returns_empty_isolation(self):
        def failing(url):
            raise ConnectionError('zongheng down')
        self.assertEqual(douban_list.fetch_zongheng_complete_books(failing), [])

    def test_fetch_uses_mobile_complete_url(self):
        seen = []
        douban_list.fetch_zongheng_complete_books(
            lambda url: seen.append(url) or ZHENG_COMPLETE_HTML)
        self.assertEqual(seen, [douban_list.ZHENG_MOBILE + '/complete'])


# ---- 17K 完本页（2026-09-19 调研接入）----
Y17K_QUANBEN_HTML = """<html><body>
<a href="//www.17k.com/book/101834.html" target="_blank">乱世王妃</a>
<a href="//www.17k.com/book/101834.html" target="_blank">她是大曜王朝唯一的女王爷，却被迫下嫁给敌国的质子。</a>
<a href="//www.17k.com/book/3671230.html" target="_blank">绝世战体逆天斩仙：吞天记</a>
<a href="//www.17k.com/book/285.html" target="_blank">骁骑校大作：匹夫的逆袭！</a>
<a href="//www.17k.com/book/999.html" target="_blank">被截断的长书名其实还有后半段...</a>
<a href="//www.17k.com/book/7.html" target="_blank">完本小说</a>
<a href="//www.17k.com/author/8.html" target="_blank">某作者</a>
</body></html>"""


class TestParse17kQuanben(unittest.TestCase):
    def test_extracts_only_book_links(self):
        books = douban_list.parse_17k_quanben(Y17K_QUANBEN_HTML)
        self.assertEqual([b['title'] for b in books],
                         ['乱世王妃', '绝世战体逆天斩仙：吞天记', '匹夫的逆袭！'])

    def test_same_book_id_keeps_the_title_anchor_not_the_intro_sentence(self):
        # 实测形态：同一 book id 先出现书名锚点，后出现整句简介锚点；
        # 简介不得进名单（否则会拿一整句话去 book15 搜索）
        titles = [b['title'] for b in douban_list.parse_17k_quanben(Y17K_QUANBEN_HTML)]
        self.assertNotIn('她是大曜王朝唯一的女王爷，却被迫下嫁给敌国的质子。', titles)
        self.assertEqual(titles.count('乱世王妃'), 1)

    def test_intro_like_text_is_rejected_even_as_first_anchor(self):
        html = ('<a href="//www.17k.com/book/1.html">他是落魄书生，却一步步走上巅峰，'
                '终成一代霸主。</a>')
        self.assertEqual(douban_list.parse_17k_quanben(html), [])

    def test_promotional_prefix_is_stripped(self):
        titles = [b['title'] for b in douban_list.parse_17k_quanben(Y17K_QUANBEN_HTML)]
        self.assertIn('匹夫的逆袭！', titles)
        self.assertNotIn('骁骑校大作：匹夫的逆袭！', titles)
        # 系列力作前缀同族（实测「失落叶月恒系列力作：天行」→《天行》）
        html = '<a href="//www.17k.com/book/2.html">失落叶月恒系列力作：天行</a>'
        self.assertEqual([b['title'] for b in douban_list.parse_17k_quanben(html)], ['天行'])

    def test_truncated_titles_are_dropped(self):
        titles = [b['title'] for b in douban_list.parse_17k_quanben(Y17K_QUANBEN_HTML)]
        self.assertNotIn('被截断的长书名其实还有后半段...', titles)

    def test_navigation_words_are_dropped(self):
        titles = [b['title'] for b in douban_list.parse_17k_quanben(Y17K_QUANBEN_HTML)]
        self.assertNotIn('完本小说', titles)

    def test_title_attribute_form_is_parsed(self):
        html = '<a href="//www.17k.com/book/3381946.html" title="风起龙城" target="_blank">风起龙城</a>'
        self.assertEqual([b['title'] for b in douban_list.parse_17k_quanben(html)], ['风起龙城'])

    def test_span_wrapped_title_is_parsed(self):
        # 审查 C.1/F.2：现场有 8 个 id 的书名在 <span> 里（href><img><span>书名</span>），
        # 旧正则 `>([^<]*)</a>` 吃不到 → 漏收真书。剥标签后取文本即可。
        html = ('<a href="//www.17k.com/book/2402178.html" target="_blank">'
                '<img src="cover.jpg" width="90"><span>挣大钱斗极品：重生好媳妇</span></a>')
        self.assertEqual([b['title'] for b in douban_list.parse_17k_quanben(html)],
                         ['挣大钱斗极品：重生好媳妇'])

    def test_image_only_anchor_yields_no_title(self):
        # 剥标签后为空 → 不当作书名（封面锚点不得进候选池）
        html = '<a href="//www.17k.com/book/9.html"><img src="cover.jpg"></a>'
        self.assertEqual(douban_list.parse_17k_quanben(html), [])

    def test_plain_anchor_wins_over_promo_span_for_same_book(self):
        # 实测：推广锚点（img+span「XX：书名」）在前、权威纯文本锚点在后。
        # 必须优先纯文本（旧行为），否则会拿整串推广名去搜索而 miss。
        html = ('<a href="//www.17k.com/book/2065918.html"><img src="x.jpg">'
                '<span>参天悟道问鼎大乾坤：参天</span></a>'
                '<a href="//www.17k.com/book/2065918.html">参天</a>')
        self.assertEqual([b['title'] for b in douban_list.parse_17k_quanben(html)], ['参天'])

    def test_empty_page(self):
        self.assertEqual(douban_list.parse_17k_quanben('<html></html>'), [])

    def test_fetch_failure_returns_empty_isolation(self):
        def failing(url):
            raise ConnectionError('17k down')
        self.assertEqual(douban_list.fetch_17k_quanben_books(failing), [])

    def test_fetch_uses_quanben_url(self):
        seen = []
        douban_list.fetch_17k_quanben_books(lambda url: seen.append(url) or Y17K_QUANBEN_HTML)
        self.assertEqual(seen, [douban_list.Y17K_BASE + '/quanben/'])


# 头部「精品专区」书卡带作者（author17k41 实测：href 内有制表符、外层 <p class="author">
# 或 <span>，作者链接专用 //user.17k.com/see/…；同页另有「看过」等 user 锚点不带「作者：」标签）。
Y17K_AUTHOR_HTML = """<html><body>
<div class="wrap"><a href="//www.17k.com/book/\t3038645.html" target="_blank"><img src="\tx.jpg\t"/></a>
<h3><a href="//www.17k.com/book/\t3038645.html" target="_blank">\t第九特区\t</a></h3>
<p class="author">作者：<a href="//user.17k.com/see/www/?userId=\t26716073" target="_blank">\t伪戒 \t</a></p>
<span class="icon"></span><a target="_blank" href="//user.17k.com/see/www/?userId=\t26716073">看过</a></div>
<div class="cell"><a href="//www.17k.com/book/1198584.html" target="_blank">万古仙穹</a>
<span class="book-author">作者：<a href="//user.17k.com/see/www/?userId=9">观棋</a></span></div>
<a href="//www.17k.com/book/101834.html" target="_blank">乱世王妃</a>
</body></html>"""


class TestParse17kAuthors(unittest.TestCase):
    """17K 完本页就地补作者（author17k41）：头部书卡有「作者：」的补上，其余保持空串。

    调研结论：详情页/搜索接口均被阿里云 WAF（acw_sc__v2）拦或需 appKey，无免拦的
    按 id/书名作者接口，故只解析页面已有作者、补不到不硬造（保持空串，不改护栏语义）。"""

    def test_author_backfilled_from_book_card(self):
        by_title = {b['title']: b['author']
                    for b in douban_list.parse_17k_quanben(Y17K_AUTHOR_HTML)}
        # href 内含制表符仍能定位到书卡作者（成功补全）
        self.assertEqual(by_title['第九特区'], '伪戒')

    def test_author_not_borrowed_across_cards(self):
        # 「看过」等非「作者：」的 user 锚点不得被当成作者；作者只归本卡书
        authors = douban_list._extract_17k_authors(Y17K_AUTHOR_HTML)
        self.assertEqual(authors.get('3038645'), '伪戒')
        self.assertNotIn('看过', authors.values())

    def test_missing_author_degrades_to_empty_string(self):
        # 页面无「作者：」标签的书（乱世王妃）→ author 空串，护栏语义不变
        by_title = {b['title']: b['author']
                    for b in douban_list.parse_17k_quanben(Y17K_AUTHOR_HTML)}
        self.assertEqual(by_title['乱世王妃'], '')

    def test_span_wrapped_author_label_form(self):
        # <span class="book-author">作者：<a>…</a></span> 形态也能取到
        by_title = {b['title']: b['author']
                    for b in douban_list.parse_17k_quanben(Y17K_AUTHOR_HTML)}
        self.assertEqual(by_title['万古仙穹'], '观棋')

    def test_no_author_anchors_yields_empty_map(self):
        self.assertEqual(douban_list._extract_17k_authors(Y17K_QUANBEN_HTML), {})


class TestBuildWebnovelQueue(unittest.TestCase):
    """多源合并：完本经典优先（起点/纵横/17K）、起点榜单次之、豆瓣补充。"""

    def setUp(self):
        no_wait(self)

    def _http_get(self, url):
        if url == douban_list.QIDIAN_MOBILE + '/finish/':
            return QIDIAN_FINISH_HTML
        if url.startswith(douban_list.QIDIAN_MOBILE + '/rank/'):
            return QIDIAN_RANK_HTML
        if url == douban_list.ZHENG_MOBILE + '/complete':
            return ZHENG_COMPLETE_HTML
        if url == douban_list.Y17K_BASE + '/quanben/':
            return Y17K_QUANBEN_HTML
        if url.startswith('https://book.douban.com/tag/'):
            return DOUBAN_TAG_HTML
        return self.search_pages.get(url, NO_RESULT_HTML)

    def test_multi_source_merge_and_dedup(self):
        # 起点 finish 的盗墓笔记？没有——DOUBAN_TAG_HTML 提供盗墓笔记（豆瓣源）。
        # 混合源：起点诡秘之主（miss）+ 豆瓣盗墓笔记（hit）
        self.search_pages = {
            '/books/search.html?kw=%E7%9B%97%E5%A2%93%E7%AC%94%E8%AE%B0':
                book15_search_html('盗墓笔记7', '/books/details42.html'),
        }
        queue = douban_list.build_webnovel_queue(self._http_get)
        self.assertEqual(len(queue), 1)
        b = queue[0]
        self.assertEqual(b['title'], '盗墓笔记7')
        self.assertEqual(b['category'], '豆瓣网文tag')

    def test_douban_excluded_when_disabled(self):
        self.search_pages = {}
        queue = douban_list.build_webnovel_queue(self._http_get, include_douban=False)
        # 网文站源全 miss（未配 search_pages）→ 空队列
        self.assertEqual(queue, [])

    def test_new_sources_enter_the_candidate_pool(self):
        # 纵横/17K 的书进候选池（命中与否另说），且各自带 origin
        self.search_pages = {
            '/books/search.html?kw=%E5%89%91%E6%9D%A5':
                book15_search_html('剑来', '/books/details100.html'),
            '/books/search.html?kw=%E4%B9%B1%E4%B8%96%E7%8E%8B%E5%A6%83':
                book15_search_html('乱世王妃', '/books/details200.html'),
        }
        queue = douban_list.build_webnovel_queue(self._http_get, include_douban=False)
        by_title = {b['title']: b for b in queue}
        self.assertEqual(by_title['剑来']['category'], '纵横完本')
        self.assertEqual(by_title['乱世王妃']['category'], '17K完本')

    def test_qidian_rank_slugs_are_expanded(self):
        self.assertEqual(douban_list.QIDIAN_RANKS,
                         ('yuepiao', 'hotsales', 'rec', 'update', 'sign', 'newbook'))

    def test_all_six_qidian_ranks_are_fetched(self):
        seen = []

        def http_get(url):
            seen.append(url)
            return self._http_get(url)

        self.search_pages = {}
        douban_list.build_webnovel_queue(http_get, include_douban=False)
        for rank in douban_list.QIDIAN_RANKS:
            with self.subTest(rank=rank):
                self.assertIn(f'{douban_list.QIDIAN_MOBILE}/rank/{rank}/', seen)

    def test_qidian_fetch_failure_falls_through_to_douban(self):
        # 起点全线挂掉：其余源照常供给
        self.search_pages = {
            '/books/search.html?kw=%E7%9B%97%E5%A2%93%E7%AC%94%E8%AE%B0':
                book15_search_html('盗墓笔记7', '/books/details42.html'),
        }

        def failing_qidian(url):
            if 'qidian' in url:
                raise ConnectionError('qidian down')
            return self._http_get(url)

        queue = douban_list.build_webnovel_queue(failing_qidian)
        self.assertEqual([b['title'] for b in queue], ['盗墓笔记7'])

    def test_every_source_down_yields_empty_queue(self):
        def all_down(url):
            if url.startswith('https://book15.net') or url.startswith('/books/'):
                raise ConnectionError('book15 down')
            raise ConnectionError('source down')

        self.assertEqual(douban_list.build_webnovel_queue(all_down), [])


# ---- 引擎兜底搜索（T5：book15 miss 才回落引擎源池）----
class TestEngineFallbackSwitch(unittest.TestCase):
    """LABELER_ENGINE_FALLBACK 开关：默认关（红线：关闭时行为逐字不变）。"""

    def test_default_disabled(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(douban_list.ENGINE_FALLBACK_ENV, None)
            self.assertFalse(douban_list.engine_fallback_enabled({}))
            self.assertFalse(douban_list.engine_fallback_enabled(None))

    def test_env_dict_enables(self):
        self.assertTrue(
            douban_list.engine_fallback_enabled({douban_list.ENGINE_FALLBACK_ENV: '1'}))

    def test_only_one_enables(self):
        for value in ('0', 'true', 'yes', '', 'no'):
            with self.subTest(value=value):
                self.assertFalse(
                    douban_list.engine_fallback_enabled(
                        {douban_list.ENGINE_FALLBACK_ENV: value}))


class TestSearchEngine(unittest.TestCase):
    """search_engine：解析 CLI JSON、同款 title_compatible 校验、退出码语义。"""

    def test_hit_returns_compatible_engine_candidate(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.yingsx.com', 'title': '斗破苍穹',
             'author': '天蚕土豆', 'bookUrl': 'https://www.yingsx.com/book/1'},
        ]))})
        hit = douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆')
        self.assertEqual(hit, {'url': 'https://www.yingsx.com/book/1',
                               'title': '斗破苍穹', 'source': 'www.yingsx.com'})
        # author 非空时随 --author 传入；恒带 --no-builtin（espfix41：book15 已由 search_book15 负责）
        self.assertEqual(cli.calls[0],
                         ('search', ['--title', '斗破苍穹', '--author', '天蚕土豆', '--no-builtin']))

    def test_author_omitted_when_empty(self):
        cli = FakeEngineCli({'search': _proc(1)})
        douban_list.search_engine(cli, '斗破苍穹')
        self.assertEqual(cli.calls[0], ('search', ['--title', '斗破苍穹', '--no-builtin']))

    def test_book15_source_candidate_is_skipped(self):
        # book15 路径已搜过（这是兜底），候选里的 book15.net 条目跳过
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'book15.net', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://book15.net/books/details1.html'},
        ]))})
        self.assertIsNone(douban_list.search_engine(cli, '斗破苍穹'))

    def test_incompatible_title_is_rejected(self):
        # 同款 title_compatible：中部命中的同人书拦下
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.yingsx.com', 'title': '一切从斗破苍穹开始',
             'author': '', 'bookUrl': 'https://www.yingsx.com/book/9'},
        ]))})
        self.assertIsNone(douban_list.search_engine(cli, '斗破苍穹'))

    def test_first_compatible_non_book15_wins(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'book15.net', 'title': '剑来', 'author': '',
             'bookUrl': 'https://book15.net/books/details2.html'},
            {'source': 'www.jhsssd.com', 'title': '剑来', 'author': '烽火戏诸侯',
             'bookUrl': 'https://www.jhsssd.com/book/7'},
        ]))})
        hit = douban_list.search_engine(cli, '剑来')
        self.assertEqual(hit['source'], 'www.jhsssd.com')
        self.assertEqual(hit['url'], 'https://www.jhsssd.com/book/7')

    def test_exit_code_1_is_normal_miss(self):
        cli = FakeEngineCli({'search': _proc(1, '', '无候选：某书')})
        self.assertIsNone(douban_list.search_engine(cli, '某书'))

    def test_exit_code_2_raises_unavailable(self):
        cli = FakeEngineCli({'search': _proc(2, '', '引擎源池不可用：[redacted-url]')})
        with self.assertRaises(douban_list.EngineUnavailable):
            douban_list.search_engine(cli, '某书')

    def test_unknown_nonzero_raises_unavailable(self):
        cli = FakeEngineCli({'search': _proc(7, '', 'boom')})
        with self.assertRaises(douban_list.EngineUnavailable):
            douban_list.search_engine(cli, '某书')

    def test_bad_json_is_treated_as_miss(self):
        cli = FakeEngineCli({'search': _proc(0, 'not json')})
        self.assertIsNone(douban_list.search_engine(cli, '某书'))

    def test_subprocess_error_raises_unavailable(self):
        class Boom:
            def run(self, *a):
                raise OSError('node not found')
        with self.assertRaises(douban_list.EngineUnavailable):
            douban_list.search_engine(Boom(), '某书')


class TestEngineCliInvocation(unittest.TestCase):
    """EngineCli.run 组装命令 + 凭据红线（DATABASE_URL 只经子进程 env，不进命令行）。"""

    def test_command_assembly_and_credential_isolation(self):
        cli = douban_list.EngineCli(
            node='/usr/bin/node',
            script_path='/repo/scripts/engine-fetch.mjs',
            database_url='postgresql://user:pw@host/db')
        captured = {}

        def fake_run(cmd, **kwargs):
            captured['cmd'] = cmd
            captured['env'] = kwargs.get('env')
            return _proc(1)

        with mock.patch.object(douban_list.subprocess, 'run', fake_run):
            cli.run('search', '--title', '斗破苍穹')

        cmd = captured['cmd']
        self.assertEqual(cmd[0], '/usr/bin/node')
        self.assertEqual(cmd[1], '--import')
        self.assertTrue(cmd[2].startswith('file://'))          # hook 转 file:// URI
        self.assertTrue(cmd[2].endswith('ts-esm-loader.mjs'))
        self.assertEqual(cmd[3], '/repo/scripts/engine-fetch.mjs')
        self.assertEqual(cmd[4], 'search')
        self.assertIn('--json', cmd)                            # 自动补 --json
        # 凭据红线：连接串绝不出现在命令行参数里
        self.assertFalse(any('pw@host' in str(part) for part in cmd))
        self.assertFalse(any('postgres' in str(part) for part in cmd))
        # 只经子进程 env 注入
        self.assertEqual(captured['env']['DATABASE_URL'],
                         'postgresql://user:pw@host/db')

    def test_hook_defaults_to_sibling_of_script(self):
        cli = douban_list.EngineCli(node='node',
                                    script_path='/repo/scripts/engine-fetch.mjs',
                                    database_url='x')
        self.assertTrue(cli.hook_path.replace('\\', '/').endswith(
            '/repo/scripts/ts-esm-loader.mjs'))

    def test_validate_uses_doctor_subcommand(self):
        cli = douban_list.EngineCli(node='node',
                                    script_path='/repo/scripts/engine-fetch.mjs',
                                    database_url='x')
        with mock.patch.object(cli, 'run', return_value=_proc(0, '{"ok":true}\n')) as run:
            proc = cli.validate()
        self.assertEqual(proc.returncode, 0)
        run.assert_called_once_with('doctor')


class TestValidateEngine(unittest.TestCase):
    def test_success(self):
        cli = mock.Mock()
        cli.validate.return_value = _proc(0, '{"ok":true}\n')
        douban_list.validate_engine(cli)

    def test_nonzero_raises_unavailable(self):
        cli = mock.Mock()
        cli.validate.return_value = _proc(1, '', 'Unknown file extension ".ts"')
        with self.assertRaisesRegex(douban_list.EngineUnavailable, '启动探针失败'):
            douban_list.validate_engine(cli)

    def test_invalid_payload_raises_unavailable(self):
        cli = mock.Mock()
        cli.validate.return_value = _proc(0, 'not-json')
        with self.assertRaisesRegex(douban_list.EngineUnavailable, '无效 JSON'):
            douban_list.validate_engine(cli)


class TestResolveCandidatesEngineFallback(unittest.TestCase):
    """_resolve_candidates 接入引擎兜底：book15 miss 才回落；开关关闭行为不变。"""

    def setUp(self):
        no_wait(self)

    def test_engine_fallback_off_is_unchanged(self):
        # engine_cli=None（开关关闭）：book15 miss 直接进 miss，队列条目无 engine 标记
        cands = [{'title': '斗破苍穹', 'author': '天蚕土豆'}]
        queue = douban_list._resolve_candidates(
            cands, lambda url: NO_RESULT_HTML, origin='测试')
        self.assertEqual(queue, [])

    def test_book15_miss_falls_back_to_engine(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.yingsx.com', 'title': '斗破苍穹',
             'author': '天蚕土豆', 'bookUrl': 'https://www.yingsx.com/book/1'},
        ]))})
        cands = [{'title': '斗破苍穹', 'author': '天蚕土豆', 'douban_url': 'd'}]
        queue = douban_list._resolve_candidates(
            cands, lambda url: NO_RESULT_HTML, origin='测试', engine_cli=cli)
        self.assertEqual(len(queue), 1)
        b = queue[0]
        self.assertEqual(b['url'], 'https://www.yingsx.com/book/1')
        self.assertTrue(b['engine'])
        self.assertEqual(b['source_host'], 'www.yingsx.com')
        self.assertEqual(b['title'], '斗破苍穹')
        self.assertEqual(b['category'], '测试')

    def test_book15_hit_wins_engine_not_called(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([]))})
        pages = {'/books/search.html?kw=' + urllib.parse.quote('盗墓笔记'):
                 book15_search_html('盗墓笔记7', '/books/details42.html')}
        queue = douban_list._resolve_candidates(
            [{'title': '盗墓笔记'}], lambda url: pages.get(url, NO_RESULT_HTML),
            engine_cli=cli)
        self.assertEqual(queue[0]['url'], '/books/details42.html')
        self.assertNotIn('engine', queue[0])   # book15 命中不带引擎标记
        self.assertEqual(cli.calls, [])          # 引擎未被调用

    def test_exit_code_2_disables_engine_for_the_rest_of_the_round(self):
        # 第一本触发退出码 2 → 本轮禁用引擎，后续 book15-miss 不再重试引擎
        cli = FakeEngineCli({'search': _proc(2, '', '引擎源池不可用')})
        cands = [{'title': '甲书'}, {'title': '乙书'}]
        queue = douban_list._resolve_candidates(
            cands, lambda url: NO_RESULT_HTML, engine_cli=cli)
        self.assertEqual(queue, [])
        self.assertEqual(len(cli.calls), 1)      # 只调了一次就禁用，不连坐重试

    def test_skip_titles_gate_applies_before_engine(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.yingsx.com', 'title': '剑来', 'author': '',
             'bookUrl': 'https://www.yingsx.com/book/1'},
        ]))})
        queue = douban_list._resolve_candidates(
            [{'title': '剑来'}], lambda url: NO_RESULT_HTML,
            skip_titles={'剑来'}, engine_cli=cli)
        self.assertEqual(queue, [])
        self.assertEqual(cli.calls, [])          # 已打标：连 book15 带引擎都不搜


JUNK_HOST = '4702.zejfxszmh.cc'


def _junk_candidates():
    """垃圾源对任何书名都回的同一批无关条目（按 lbldeploy41 §5 观察的形态合成，非真实内容）。"""
    return [{'source': JUNK_HOST, 'title': f'无关条目{i}', 'author': '某某',
             'bookUrl': f'https://{JUNK_HOST}/book/{i}'} for i in range(3)]


def _pool_cli(real_hits: dict):
    """按书名返回：垃圾源恒回同一批 + 正常源只在 real_hits 里有该书时回命中。记录每次调用参数。"""
    def results(sub, args):
        title = args[args.index('--title') + 1]
        skip = {args[i + 1] for i, a in enumerate(args) if a == '--skip-host'}
        out = [] if JUNK_HOST in skip else _junk_candidates()
        if title in real_hits:
            out.append({'source': 'www.yingsx.com', 'title': title, 'author': '',
                        'bookUrl': real_hits[title]})
        return _proc(0, _engine_search_stdout(out)) if out else _proc(1)
    return FakeEngineCli(results)


class TestEngineJunkSource(unittest.TestCase):
    """espfix41：查询不敏感的垃圾源——本轮识别后经 --skip-host 跳过，不再每本白请求。"""

    def setUp(self):
        no_wait(self)

    def test_junk_host_skipped_after_streak_and_real_hits_unaffected(self):
        titles = ['甲书', '乙书', '丙书', '丁书', '戊书']
        cli = _pool_cli({'丁书': 'https://www.yingsx.com/book/4'})
        with contextlib.redirect_stdout(io.StringIO()) as out:
            queue = douban_list._resolve_candidates(
                [{'title': t} for t in titles], lambda url: NO_RESULT_HTML, engine_cli=cli)
        skip_flags = [JUNK_HOST in c[1] for c in cli.calls]
        # 前 3 本（JUNK_STREAK）仍搜它，第 3 本后判垃圾，第 4、5 本带 --skip-host
        self.assertEqual(skip_flags, [False, False, False, True, True])
        self.assertIn('垃圾源剔除', out.getvalue())
        # 正常源命中不受影响
        self.assertEqual([b['url'] for b in queue], ['https://www.yingsx.com/book/4'])

    def test_counterexample_before_fix_junk_requested_every_book(self):
        # 反例（改前行为）：不带识别器时每本都搜垃圾源（CLI 调用参数里从不出现 --skip-host）
        cli = _pool_cli({})
        for t in ['甲书', '乙书', '丙书', '丁书', '戊书']:
            douban_list.search_engine(cli, t)
        self.assertFalse(any('--skip-host' in c[1] for c in cli.calls))

    def test_source_with_relevant_result_is_never_flagged(self):
        # 正常源：结果集随书名变化，或其中有书名兼容条目 → 不判垃圾
        junk = douban_list.EngineJunkTracker()
        for t in ['甲书', '乙书', '丙书', '丁书']:
            junk.observe(t, [{'source': 'good.example', 'title': t,
                              'bookUrl': 'https://good.example/hot'}])
        self.assertEqual(junk.hosts, set())

    def test_changing_result_sets_reset_streak(self):
        junk = douban_list.EngineJunkTracker()
        junk.observe('甲书', _junk_candidates())
        junk.observe('乙书', _junk_candidates())
        junk.observe('丙书', [{'source': JUNK_HOST, 'title': '别的', 'bookUrl': 'https://x/9'}])
        self.assertEqual(junk.hosts, set())           # 集合变了：连击重置
        junk.observe('丁书', [{'source': JUNK_HOST, 'title': '别的', 'bookUrl': 'https://x/9'}])
        junk.observe('戊书', [{'source': JUNK_HOST, 'title': '别的', 'bookUrl': 'https://x/9'}])
        self.assertEqual(junk.hosts, {JUNK_HOST})

    def test_same_title_repeated_does_not_count(self):
        junk = douban_list.EngineJunkTracker()
        for _ in range(5):
            junk.observe('甲书', _junk_candidates())
        self.assertEqual(junk.hosts, set())            # 必须是不同书名

    def test_book15_candidates_are_ignored(self):
        junk = douban_list.EngineJunkTracker()
        for t in ['甲书', '乙书', '丙书']:
            junk.observe(t, [{'source': 'book15.net', 'title': 'x', 'bookUrl': 'https://book15.net/1'}])
        self.assertEqual(junk.hosts, set())


class TestBreakerOpenSkipsSearchDelay(unittest.TestCase):
    """espfix41：book15 熔断后本本不请求 book15，不再睡 SEARCH_DELAY；未熔断时照睡。"""

    def _sleeps(self, breaker):
        cli = FakeEngineCli({'search': _proc(1)})
        with mock.patch.object(douban_list, 'SEARCH_DELAY', 1.5),                 mock.patch.object(douban_list.time, 'sleep') as sleep:
            douban_list._resolve_candidates(
                [{'title': '甲书'}, {'title': '乙书'}], lambda url: NO_RESULT_HTML,
                engine_cli=cli, book15_breaker=breaker)
        return [c.args[0] for c in sleep.call_args_list]

    def test_open_breaker_no_search_delay(self):
        breaker = douban_list.Book15Breaker(threshold=1)
        breaker.open = True
        self.assertEqual(self._sleeps(breaker), [])

    def test_closed_breaker_still_sleeps(self):
        self.assertEqual(self._sleeps(douban_list.Book15Breaker(threshold=5)), [1.5, 1.5])


class TestEngineHttpOnlySkip(unittest.TestCase):
    """labelerdiag41：兜底候选 URL 引擎取不了（http-only 源等）→ 候选阶段跳过并计数，不白调 toc。"""

    def setUp(self):
        no_wait(self)

    def test_url_support_predicate(self):
        for url in ('https://www.a.com/b/1', 'HTTPS://www.a.com/b/1',
                    'https://www.a.com:443/b/1'):
            with self.subTest(url=url):
                self.assertTrue(douban_list.engine_url_supported(url))
        for url in ('http://www.a.com/b/1', 'https://www.a.com:8443/b/1',
                    'https://u:p@www.a.com/b/1', 'https://@www.a.com/b',
                    '/b/1', 'www.a.com/b/1', 'https://', 'https://www.a.com:abc/b',
                    'ftp://www.a.com/b'):
            with self.subTest(url=url):
                self.assertFalse(douban_list.engine_url_supported(url))

    def test_http_candidate_skipped_https_candidate_wins(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.old.com', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'http://www.old.com/book/1'},
            {'source': 'www.new.com', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://www.new.com/book/1'},
        ]))})
        stats = {}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            hit = douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆', stats=stats)
        self.assertEqual(hit['url'], 'https://www.new.com/book/1')
        self.assertEqual(stats, {'http_only': 1})
        self.assertIn('非 HTTPS 源跳过', out.getvalue())

    def test_only_http_candidates_is_a_miss(self):
        # 名单无作者（第一遍直接收）时同样不能收 http 候选
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.old.com', 'title': '剑来', 'author': '',
             'bookUrl': 'http://www.old.com/book/9'}]))})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(douban_list.search_engine(cli, '剑来'))

    def test_title_incompatible_http_candidate_not_counted(self):
        # 计数口径 = 本来会被选中去调 toc 的候选；标题不兼容的本就不收，不计
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.old.com', 'title': '一切从剑来开始', 'author': '',
             'bookUrl': 'http://www.old.com/book/9'}]))})
        stats = {}
        with contextlib.redirect_stdout(io.StringIO()):
            douban_list.search_engine(cli, '剑来', stats=stats)
        self.assertEqual(stats, {})

    def test_resolve_candidates_summary_counts_http_skips(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'www.old.com', 'title': '剑来', 'author': '',
             'bookUrl': 'http://www.old.com/book/9'}]))})
        with contextlib.redirect_stdout(io.StringIO()) as out:
            queue = douban_list._resolve_candidates(
                [{'title': '剑来'}, {'title': '剑来'}], lambda url: NO_RESULT_HTML,
                engine_cli=cli)
        self.assertEqual(queue, [])
        self.assertIn('跳过非 HTTPS 源候选 2 条', out.getvalue())


class TestBook15Breaker(unittest.TestCase):
    """labelerdiag41：book15 整站挂时连续 N 本搜索全失败 → 本轮剩余跳过 book15、直接走引擎兜底。"""

    def setUp(self):
        no_wait(self)
        patcher = mock.patch.object(douban_list, 'SEARCH_RETRY_DELAY', 0)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.book15_calls = []

    def _down(self, url):
        self.book15_calls.append(url)
        raise ConnectionError('HTTP Error 522')

    @staticmethod
    def _engine_hits():
        def results(sub, args):
            title = args[args.index('--title') + 1]
            return _proc(0, _engine_search_stdout([
                {'source': 'www.yingsx.com', 'title': title, 'author': '',
                 'bookUrl': f'https://www.yingsx.com/{urllib.parse.quote(title)}'}]))
        return FakeEngineCli(results)

    def _run(self, cands, http_get, breaker, engine_cli=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            queue = douban_list._resolve_candidates(
                cands, http_get, engine_cli=engine_cli, book15_breaker=breaker)
        return queue, out.getvalue()

    def test_trips_after_threshold_and_skips_book15_for_the_rest(self):
        cands = [{'title': f'书{i}号'} for i in range(8)]
        cli = self._engine_hits()
        breaker = douban_list.Book15Breaker(3)
        queue, out = self._run(cands, self._down, breaker, engine_cli=cli)
        # 前 3 本各 SEARCH_RETRY 次请求后熔断，后 5 本一个 book15 请求都不发
        self.assertEqual(len(self.book15_calls), 3 * douban_list.SEARCH_RETRY)
        self.assertTrue(breaker.open)
        self.assertEqual(breaker.skipped, 5)
        # 8 本全部走到了引擎兜底（熔断不影响兜底）
        self.assertEqual(len(cli.calls), 8)
        self.assertEqual(len(queue), 8)
        self.assertTrue(all(b['engine'] for b in queue))
        # 熔断事件只打一行；汇总行带熔断跳过数
        self.assertEqual(out.count('book15 熔断：'), 1)
        self.assertIn('book15 熔断跳过搜索 5 本', out)

    def test_page_fetched_resets_consecutive_failures(self):
        # 失败 2 本 → 1 本拿到页面（正常 miss）→ 失败 2 本：从未连续达 3，不熔断。
        # 失败的书连续 SEARCH_RETRY 次请求都失败；拿到页面的书首次请求即成功。
        plan = []
        for ok in (False, False, True, False, False):
            plan += [True] if ok else [False] * douban_list.SEARCH_RETRY
        responses = iter(plan)
        cands = [{'title': f'书{i}号'} for i in range(5)]

        def flaky(url):
            self.book15_calls.append(url)
            if not next(responses):
                raise ConnectionError('timeout')
            return NO_RESULT_HTML

        breaker = douban_list.Book15Breaker(3)
        self._run(cands, flaky, breaker)
        self.assertFalse(breaker.open)
        self.assertEqual(breaker.skipped, 0)

    def test_normal_miss_is_not_a_failure(self):
        # 站点在线但搜不到（正常 miss）不计失败：连续 10 本 miss 也不熔断
        cands = [{'title': f'书{i}号'} for i in range(10)]
        breaker = douban_list.Book15Breaker(3)
        _, out = self._run(cands, lambda url: NO_RESULT_HTML, breaker)
        self.assertFalse(breaker.open)
        self.assertNotIn('熔断', out)

    def test_threshold_zero_disables(self):
        cands = [{'title': f'书{i}号'} for i in range(6)]
        breaker = douban_list.Book15Breaker(0)
        self._run(cands, self._down, breaker)
        self.assertFalse(breaker.open)
        self.assertEqual(len(self.book15_calls), 6 * douban_list.SEARCH_RETRY)

    def test_no_breaker_keeps_summary_line_unchanged(self):
        # book15_breaker=None（旧调用形态）：汇总行不出现熔断字样
        _, out = self._run([{'title': '甲书'}], self._down, None)
        self.assertNotIn('熔断', out)

    def test_resolve_threshold_from_env(self):
        env_name = douban_list.BOOK15_BREAKER_ENV
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(env_name, None)
            self.assertEqual(douban_list.resolve_book15_breaker(None), 5)
            self.assertEqual(douban_list.resolve_book15_breaker({env_name: '3'}), 3)
            self.assertEqual(douban_list.resolve_book15_breaker({env_name: '0'}), 0)
            self.assertEqual(douban_list.resolve_book15_breaker({env_name: 'abc'}), 5)
            self.assertEqual(douban_list.resolve_book15_breaker({env_name: ' '}), 5)
            os.environ[env_name] = '7'
            self.assertEqual(douban_list.resolve_book15_breaker({}), 7)
            self.assertEqual(douban_list.resolve_book15_breaker({env_name: '2'}), 2)


# ---- N02：引擎兜底作者身份过滤（同名异作者正文不得绑定名单身份）----
class TestNormAuthor(unittest.TestCase):
    """_norm_author：身份比对前的作者归一化。

    真实形态对齐 labels-from-phoenix-20260918.jsonl 抽样（261 非空作者里
    出现过分隔符写法差/HTML 实体/「著」尾缀/国籍前缀）；比对语义 = 归一化后
    **严格相等**（不做包含），方向「宁拒不错绑」。"""

    TRUE_PAIRS = (
        ('天蚕土豆', '天蚕土豆著'),                       # 尾缀「著」
        ('priest', 'Priest'),                             # 大小写
        ('（美）乔治·R·R·马丁', '乔治·R·R·马丁'),          # 前导国籍括号段
        ('烽火戏诸侯', ' 烽火戏诸侯 '),                    # 空白
        ('烽火戏诸侯', '烽火戏诸侯 编著'),                 # 分隔 + 组合尾缀
        ('乔治·奥威尔', '乔治&middot;奥威尔'),              # book15 元数据实体形态
        ('贝尔纳·布尔蒂克斯', '贝尔纳.布尔蒂克斯'),         # 半角点分隔
        ('甲', '甲 等著'),                                # 等著组合尾缀
    )

    def test_true_pairs_are_equal(self):
        for a, b in self.TRUE_PAIRS:
            with self.subTest(pair=(a, b)):
                self.assertEqual(douban_list._norm_author(a),
                                 douban_list._norm_author(b))

    def test_containment_is_not_equality(self):
        # 严格相等，不做包含：唐家三少 vs 唐家三少之子 必须不等
        self.assertNotEqual(douban_list._norm_author('唐家三少'),
                            douban_list._norm_author('唐家三少之子'))

    def test_empty_and_punct_only_normalize_to_empty(self):
        for s in ('', '   ', '·', '（）'):
            with self.subTest(s=s):
                self.assertEqual(douban_list._norm_author(s), '')

    def test_bracket_only_author_is_not_stripped_to_nothing(self):
        # 剥前导括号段要求剥后剩余非空：整串就是括号段时先不剥，再走标点剥离
        self.assertEqual(douban_list._norm_author('（佚名）'), '佚名')

    # labelerdiag41：引擎源作者带「作者：」标签（名单 唐家三少 vs 引擎 作者：唐家三少 被判作者不符）
    LABEL_PAIRS = (
        ('唐家三少', '作者：唐家三少'),            # 全角冒号（phoenix 日志原样）
        ('风凌天下', '作者:风凌天下'),              # 半角冒号
        ('风凌天下', '作者 : 风凌天下'),            # 冒号两侧空格
        ('风凌天下', '  作者：  风凌天下 '),        # 首尾空白
        ('风凌天下', '作　者：风凌天下'),           # 「作　者」全角排版空格
        ('风凌天下', '作者　风凌天下'),         # 无冒号、全角空格分隔
        ('风凌天下', '作者风凌天下'),               # 无分隔（textContent 拼接形态）
        ('乔治·奥威尔', '作者：（英）乔治&middot;奥威尔'),  # 与实体/国籍段叠加
        ('天蚕土豆', '作者：天蚕土豆 著'),          # 与尾缀叠加
    )

    def test_author_label_prefix_is_stripped(self):
        for a, b in self.LABEL_PAIRS:
            with self.subTest(pair=(a, b)):
                self.assertEqual(douban_list._norm_author(a),
                                 douban_list._norm_author(b))

    def test_author_label_negative_controls(self):
        # 标签后是另一个人：剥标签不得让异作者变相等
        self.assertNotEqual(douban_list._norm_author('唐家三少'),
                            douban_list._norm_author('作者：天蚕土豆'))
        # 「作者」只在名首才算标签：名中/名尾出现不剥
        self.assertEqual(douban_list._norm_author('某作者'), '某作者')
        self.assertNotEqual(douban_list._norm_author('唐家三少'),
                            douban_list._norm_author('唐家三少作者'))
        # 整串只有「作者」：不是标签，原样保留（不会变空而被当作者未知降级收）
        self.assertEqual(douban_list._norm_author('作者'), '作者')
        # 只有标签没有名字：作者未知 ⇒ ''（走「候选作者空」降级分支，而非判作者不符）
        for s in ('作者：', '作者:', '作者 ： '):
            with self.subTest(s=s):
                self.assertEqual(douban_list._norm_author(s), '')

    def test_author_label_symmetric_for_real_pen_name(self):
        # 以「作者」起头的真实笔名：两端同写法仍相等（归一化对称，不会误拒）
        self.assertEqual(douban_list._norm_author('作者君'),
                         douban_list._norm_author('作者：作者君'))

    def test_engine_toc_double_label_still_matches(self):
        # author17k41 / lblrate-41 §4：引擎 toc N02 校验的误杀形态「作者：X vs 作者：作者：X」
        # （两端都带「作者：」、一端叠加两层）。author_matches 须循环剥标签后判同一人，
        # 否则每条要白抓一次目录再拒（曾误杀 43 条）。含与尾缀「著」叠加。
        for a, b in (
            ('作者：唐家三少', '作者：作者：唐家三少'),
            ('作者：风凌天下', '作者：风凌天下 著'),
            ('唐家三少', '作者：作者：唐家三少'),
        ):
            with self.subTest(pair=(a, b)):
                self.assertTrue(douban_list.author_matches(a, b))
                self.assertTrue(douban_list.author_matches(b, a))


class TestSearchEngineAuthorLabel(unittest.TestCase):
    """labelerdiag41：候选阶段不得因「作者：」标签丢掉引擎兜底真命中。"""

    def test_label_prefixed_candidate_is_verified_match(self):
        cli = FakeEngineCli({'search': _proc(0, json.dumps([
            {'source': 'www.a.com', 'title': '斗罗大陆', 'author': '作者：唐家三少',
             'bookUrl': 'https://www.a.com/b/1'}]))})
        with contextlib.redirect_stdout(io.StringIO()) as out:
            hit = douban_list.search_engine(cli, '斗罗大陆', '唐家三少')
        self.assertEqual(hit, {'url': 'https://www.a.com/b/1', 'title': '斗罗大陆',
                               'source': 'www.a.com'})
        self.assertNotIn('作者不符', out.getvalue())


class TestSearchEngineAuthorFilter(unittest.TestCase):
    """N02 第一层：search_engine 候选过滤 + 两遍选择。"""

    def test_n02_repro_different_author_is_rejected(self):
        # 对齐 gpt-review-recheck-evidence/labeler_repro.py（codex 复核反例）：
        # 名单 Same Title / Author A，引擎返回 Author B 的书 → 队列为空，
        # B 的正文不得绑 A 的身份进队列；拒收要有 stdout 审计行。
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'audit.example', 'title': 'Same Title', 'author': 'Author B',
             'bookUrl': 'https://audit.example/book-b'}]))})
        no_wait(self)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            queue = douban_list._resolve_candidates(
                [{'title': 'Same Title', 'author': 'Author A'}],
                lambda url: NO_RESULT_HTML, engine_cli=cli)
        self.assertEqual(queue, [])
        out = buf.getvalue()
        self.assertIn('作者不符跳过', out)
        self.assertIn('Author A', out)
        self.assertIn('Author B', out)

    def test_verified_match_wins_over_earlier_empty_author(self):
        # 两遍选择第一遍：author 已验证匹配的候选优先于更早的空 author 候选
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://s1.example/b1'},
            {'source': 's2.example', 'title': '斗破苍穹', 'author': '天蚕土豆著',
             'bookUrl': 'https://s2.example/b2'},
        ]))})
        hit = douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆')
        self.assertEqual(hit['url'], 'https://s2.example/b2')

    def test_empty_author_candidate_is_accepted_as_fallback(self):
        # 两遍选择第二遍：没有已验证匹配时退「候选 author 空」（降级可收）
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://s1.example/b1'},
        ]))})
        hit = douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆')
        self.assertEqual(hit['url'], 'https://s1.example/b1')

    def test_verified_mismatch_is_never_chosen_in_either_pass(self):
        # 已验证错配的候选两遍都不收：只剩错配 → miss（None）
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '别人',
             'bookUrl': 'https://s1.example/b1'},
        ]))})
        self.assertIsNone(douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆'))

    def test_author_form_differences_bridge_the_filter(self):
        # 归一化桥接写法差：名单 Priest / 引擎 priest 也能对上
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's.example', 'title': '镇魂', 'author': 'priest',
             'bookUrl': 'https://s.example/b1'},
        ]))})
        hit = douban_list.search_engine(cli, '镇魂', 'Priest')
        self.assertEqual(hit['url'], 'https://s.example/b1')

    def test_list_author_empty_keeps_legacy_behavior(self):
        # 名单 author 为空：行为同现状（title 兼容即收，不看候选 author）
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's.example', 'title': '斗破苍穹', 'author': '随便谁',
             'bookUrl': 'https://s.example/b1'},
        ]))})
        hit = douban_list.search_engine(cli, '斗破苍穹')
        self.assertEqual(hit['url'], 'https://s.example/b1')

    def test_engine_off_stdout_is_byte_identical(self):
        # 红线：开关关闭（engine_cli=None）时 stdout 逐字节不变——
        # 新增的「作者不符跳过」等打印全部只在引擎分支内出现。
        no_wait(self)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            queue = douban_list._resolve_candidates(
                [{'title': '斗破苍穹', 'author': '天蚕土豆'}],
                lambda url: NO_RESULT_HTML)
        self.assertEqual(queue, [])
        self.assertEqual(
            buf.getvalue(),
            'book15 命中 0 本，未命中 1 本，跳过已打标 0 本（斗破苍穹）\n')


class TestSearchEngineAlternates(unittest.TestCase):
    """giveup41：主候选之外的合格候选作为换源备选（同一套判据、静默、有上限）。"""

    def test_alternates_follow_same_filters_and_order(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 'book15.net', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://book15.net/books/details1.html'},             # book15 跳过
            {'source': 's0.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://s0.example/b'},                                # 主候选
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://s1.example/b'},                                # 作者未知：排后
            {'source': 's2.example', 'title': '斗破苍穹', 'author': '别人',
             'bookUrl': 'https://s2.example/b'},                                # 作者错配：不收
            {'source': 's3.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'http://s3.example/b'},                                 # 非 HTTPS：不收
            {'source': 's4.example', 'title': '一切从斗破苍穹开始', 'author': '天蚕土豆',
             'bookUrl': 'https://s4.example/b'},                                # 标题不兼容：不收
            {'source': 's5.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://s5.example/b'},                                # 已验证：排前
            {'source': 's0.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://s0.example/b'},                                # 与主候选重复
        ]))})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆')
        self.assertEqual(hit['url'], 'https://s0.example/b')
        self.assertEqual([a['url'] for a in hit['alternates']],
                         ['https://s5.example/b', 'https://s1.example/b'])
        self.assertEqual(hit['alternates'][0],
                         {'url': 'https://s5.example/b', 'title': '斗破苍穹', 'source': 's5.example'})
        # 静默：备选收集不新增打印（主候选命中即返回，后面的错配/非 HTTPS 行不打印，同改前）
        self.assertEqual(buf.getvalue(), '')

    def test_fallback_primary_also_gets_alternates(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://s1.example/b'},
            {'source': 's2.example', 'title': '斗破苍穹', 'author': '',
             'bookUrl': 'https://s2.example/b'},
        ]))})
        with contextlib.redirect_stdout(io.StringIO()):
            hit = douban_list.search_engine(cli, '斗破苍穹', '天蚕土豆')
        self.assertEqual(hit['url'], 'https://s1.example/b')
        self.assertEqual([a['url'] for a in hit['alternates']], ['https://s2.example/b'])

    def test_alternates_are_capped(self):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': f's{i}.example', 'title': '剑来', 'author': '',
             'bookUrl': f'https://s{i}.example/b'} for i in range(10)]))})
        hit = douban_list.search_engine(cli, '剑来')
        self.assertEqual(len(hit['alternates']), douban_list.ENGINE_MAX_ALTERNATES)

    def test_queue_entry_carries_alternates(self):
        no_wait(self)
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://s1.example/b'},
            {'source': 's2.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://s2.example/b'},
        ]))})
        with contextlib.redirect_stdout(io.StringIO()):
            queue = douban_list._resolve_candidates(
                [{'title': '斗破苍穹', 'author': '天蚕土豆'}],
                lambda url: NO_RESULT_HTML, engine_cli=cli)
        self.assertEqual(queue[0]['source_host'], 's1.example')
        self.assertEqual(queue[0]['engine_alternates'],
                         [{'url': 'https://s2.example/b', 'title': '斗破苍穹', 'source': 's2.example'}])

    def test_single_candidate_has_no_alternates_key(self):
        no_wait(self)
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's1.example', 'title': '斗破苍穹', 'author': '天蚕土豆',
             'bookUrl': 'https://s1.example/b'}]))})
        with contextlib.redirect_stdout(io.StringIO()):
            queue = douban_list._resolve_candidates(
                [{'title': '斗破苍穹', 'author': '天蚕土豆'}],
                lambda url: NO_RESULT_HTML, engine_cli=cli)
        self.assertNotIn('engine_alternates', queue[0])

    # ---- 追平 master（authfix41）后：备选的作者口径与主候选一致 ----
    def test_alternates_use_author_matches(self):
        # 主候选放过的结构差（R2 分段/R4 外文末节）备选侧同样放过；真不同人仍排除
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's0.example', 'title': '冰与火之歌', 'author': '[美]乔治·R.R.马丁',
             'bookUrl': 'https://s0.example/b'},
            {'source': 's1.example', 'title': '冰与火之歌', 'author': '马丁',
             'bookUrl': 'https://s1.example/b'},
            {'source': 's2.example', 'title': '冰与火之歌', 'author': '马丁新',
             'bookUrl': 'https://s2.example/b'},
        ]))})
        with contextlib.redirect_stdout(io.StringIO()):
            hit = douban_list.search_engine(cli, '冰与火之歌', '[美]乔治·R.R.马丁')
        self.assertEqual(hit['url'], 'https://s0.example/b')
        self.assertEqual([a['url'] for a in hit['alternates']], ['https://s1.example/b'])

    def test_no_list_author_ambiguous_yields_no_hit_and_no_alternates(self):
        # 名单无作者 + 兼容候选作者两两不相容 → _pick_author_unknown 判歧义：主候选与备选都没有
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's0.example', 'title': '偷偷藏不住', 'author': '竹已',
             'bookUrl': 'https://s0.example/b'},
            {'source': 's1.example', 'title': '偷偷藏不住', 'author': '旺仔',
             'bookUrl': 'https://s1.example/b'},
        ]))})
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertIsNone(douban_list.search_engine(cli, '偷偷藏不住'))
        self.assertIn('作者歧义跳过', out.getvalue())

    def test_no_list_author_consistent_candidates_become_alternates(self):
        # 名单无作者、作者相容：主候选取作者已知的；其余（作者已知在前、作者空在后）作备选
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's0.example', 'title': '偷偷藏不住', 'author': '',
             'bookUrl': 'https://s0.example/b'},
            {'source': 's1.example', 'title': '偷偷藏不住', 'author': '竹已',
             'bookUrl': 'https://s1.example/b'},
            {'source': 's2.example', 'title': '偷偷藏不住', 'author': '竹已著',
             'bookUrl': 'https://s2.example/b'},
        ]))})
        hit = douban_list.search_engine(cli, '偷偷藏不住')
        self.assertEqual(hit['url'], 'https://s1.example/b')
        self.assertEqual([a['url'] for a in hit['alternates']],
                         ['https://s2.example/b', 'https://s0.example/b'])


# ---- authfix41：作者比对补结构差规则（样例全部取自 phoenix gate.log round 1 原样，authmis41）----
class TestAuthorMatches(unittest.TestCase):
    """author_matches(名单作者, 引擎作者)：归一化严格相等 + R2 分段/角色 + R3 剥括号 + R4 外文末节。"""

    # B 组 8 行形态（名单 → 引擎），修复后必须能对上
    B_PAIRS = {
        'R2': (('马伯庸', '马伯庸著 刘巴布编绘'),                        # 风起陇西
               ('苏末那', '软星科技原著 执笔：苏末那'),                   # 仙剑奇侠传四（全集）
               ('软星科技', '软星科技原著 执笔：苏末那'),                 # 尾部「原著」角色
               ('刘巴布', '马伯庸著；刘巴布编绘'),                        # 分号分隔
               ('刘巴布', '马伯庸、刘巴布'),                              # 顿号
               ('刘巴布', '马伯庸，刘巴布')),                             # 逗号
        'R3': (('[美] 斯蒂芬·金', '[美]斯蒂芬·金（Stephen King）'),       # 它：全2册
               ('[俄] 阿卡迪·斯特鲁伽茨基、[俄] 鲍里斯·斯特鲁伽茨基',
                '(俄)阿卡迪·斯特鲁伽茨基 鲍里斯·斯特鲁伽茨基'),         # 离世界末日还有十亿年！
               ('斯蒂芬·金', '斯蒂芬·金【Stephen King】')),
        'R4': (('[美]乔治·R.R.马丁', '马丁'),                             # 冰与火之歌
               ('[英] 詹姆斯·马修·巴利', '（英）巴利'),                   # 彼得·潘
               ('[英] 詹姆斯·马修·巴利', '(英)巴利'),
               ('乔治·R·R·马丁', '马丁'),
               ('马丁', '乔治&middot;R.R.马丁')),                          # 方向对称 + 实体
    }

    # A 组「同名真不同人」（引擎给的是同名书，但作者确实不是名单那位）：必须仍拒
    A_PAIRS = (
        ('[日] 东野圭吾', '里拜亚鲸'),          # 幻夜
        ('紫金陈', '蒋小韫'), ('紫金陈', '蜗牛'),  # 设局
        ('[美] 斯蒂芬·金', '作家cyQTqh'),        # 它
        ('松本清张、稲木皓人', '(英)A.L·萨德勒'),  # 德川家康
        ('松本清张、稲木皓人', '李猛'),
        ('金庸', 'ywind'),
    )

    # 护栏反例：子串/后缀包含一律不算（authmis41 实测裸子串规则会误配这些）
    GUARD_PAIRS = (
        ('金庸', '金庸新'), ('金庸新', '金庸'), ('古龙', '古龙新'),
        ('唐家三少', '唐家三少之子'), ('刘慈欣', '慈欣'), ('慈欣', '刘慈欣著'),
        ('巴利', '巴利·艾柯'),                  # 长侧含 · 但短侧不是末节
        ('[美] 斯蒂芬·金', '金'),               # 末节只 1 字不认
        ('J.R.R.托尔金', '托尔金'),              # 长侧无「·/•」不视为外文名（点号只切分不作标志）
        ('[英] 詹姆斯·马修·巴利', '修巴利'),     # 末节是整段相等，不是归一化串的后缀
        ('三毛', '三毛流浪记'),
        ('马丁', '马丁新'),
        ('金庸', '金庸新 著'), ('金庸', '金庸新；某某'),   # 分段后仍是整段相等
        ('美', '[美] 某某'),                    # 切出来的「美」不得撞单字笔名
        # authrev41 非阻断 1：多署名串切出的一段不做外文末节匹配——否则同一引擎串
        # 同时匹配「马丁」和「某某」两个不同名单作者。代价：phoenix 实测的「（英）巴利著；靳锦译」
        # 这一行不再命中（彼得·潘另有「（英）巴利」「(英)巴利」两行照收，书级不受影响）。
        ('马丁', '乔治·马丁著 某某编绘'),
        ('[英] 詹姆斯·马修·巴利', '（英）巴利著；靳锦译'),
        ('乔治·马丁著 某某编绘', '马丁'),
        # 拉丁名内的空格不是多署名分隔：切开会让共有名字段的两人相等
        ('Stephen King', 'Stephen Fry'), ('Author A', 'Author B'),
        ('[英] J.R.R.托尔金', 'J.R.R.Tolkien'),   # R5 中外文异体：不做
        ('威廉.雅各布斯', '(英)W.W.雅各布斯'),
    )

    def test_b_group_pairs_match(self):
        for rule, pairs in self.B_PAIRS.items():
            for a, b in pairs:
                with self.subTest(rule=rule, pair=(a, b)):
                    self.assertTrue(douban_list.author_matches(a, b))

    def test_b_group_pairs_were_rejected_by_plain_normalization(self):
        # 回归前提：这些对在「_norm_author 严格相等」下确实不等（否则测试证明不了新规则）
        for rule, pairs in self.B_PAIRS.items():
            for a, b in pairs:
                with self.subTest(rule=rule, pair=(a, b)):
                    self.assertNotEqual(douban_list._norm_author(a), douban_list._norm_author(b))

    def test_a_group_same_title_different_person_still_rejected(self):
        for a, b in self.A_PAIRS:
            with self.subTest(pair=(a, b)):
                self.assertFalse(douban_list.author_matches(a, b))
                self.assertFalse(douban_list.author_matches(b, a))

    def test_containment_guards(self):
        for a, b in self.GUARD_PAIRS:
            with self.subTest(pair=(a, b)):
                self.assertFalse(douban_list.author_matches(a, b))

    def test_plain_normalized_equality_still_matches(self):
        for a, b in TestNormAuthor.TRUE_PAIRS + TestNormAuthor.LABEL_PAIRS:
            with self.subTest(pair=(a, b)):
                self.assertTrue(douban_list.author_matches(a, b))

    def test_bracket_strip_keeps_nonempty_guard(self):
        # 剥括号后为空的一侧不参与 R3：「（佚名）」不得因两端剥空而相等
        self.assertFalse(douban_list.author_matches('（佚名）', '（无名氏）'))
        self.assertFalse(douban_list.author_matches('张三', '（张三）李四'))

    def test_role_label_needs_colon(self):
        # 前导角色须带冒号才剥：「原著」「执笔」开头的真名不被当标签
        self.assertFalse(douban_list.author_matches('苏末那', '执笔苏末那X'))
        self.assertTrue(douban_list.author_matches('苏末那', '执笔 : 苏末那'))

    def test_role_suffix_does_not_overstrip_real_names(self):
        # 「原著」不进通用尾缀：名以「原」结尾的作者照旧对得上（高原著 → 高原）
        self.assertTrue(douban_list.author_matches('高原', '高原著'))
        self.assertFalse(douban_list.author_matches('高', '高原著'))


class TestSearchEngineAuthorRules(unittest.TestCase):
    """authfix41：search_engine 走 author_matches，B 组候选收、A 组照拒。"""

    @staticmethod
    def _search(title, list_author, cand_author):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout([
            {'source': 's.example', 'title': title, 'author': cand_author,
             'bookUrl': 'https://s.example/b1'}]))})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, title, list_author)
        return hit, buf.getvalue()

    def test_b_group_candidates_are_accepted(self):
        for title, a, b in (('风起陇西', '马伯庸', '马伯庸著 刘巴布编绘'),
                            ('仙剑奇侠传四（全集）', '苏末那', '软星科技原著 执笔：苏末那'),
                            ('它：全2册', '[美] 斯蒂芬·金', '[美]斯蒂芬·金（Stephen King）'),
                            ('冰与火之歌', '[美]乔治·R.R.马丁', '马丁'),
                            ('彼得·潘', '[英] 詹姆斯·马修·巴利', '（英）巴利著')):
            with self.subTest(title=title):
                hit, out = self._search(title, a, b)
                self.assertEqual(hit, {'url': 'https://s.example/b1', 'title': title,
                                       'source': 's.example'})
                self.assertNotIn('作者不符', out)

    def test_a_group_candidates_still_rejected_with_list_title_in_log(self):
        for title, a, b in (('幻夜', '[日] 东野圭吾', '里拜亚鲸'), ('设局', '紫金陈', '蒋小韫'),
                            ('它', '[美] 斯蒂芬·金', '作家cyQTqh'), ('天龙八部', '金庸', '金庸新')):
            with self.subTest(title=title):
                hit, out = self._search(title, a, b)
                self.assertIsNone(hit)
                # 日志同时给出候选书名与名单书名（authmis41：旧日志只打候选书名，被误读成名单书）
                self.assertIn(f'作者不符跳过: 候选《{title}》（名单《{title}》{a} vs 引擎 {b}）', out)

    def test_publisher_list_entry_takes_author_unknown_path(self):
        # R1 连带：豆瓣出版社条目解析成 '' 后走既有「名单无作者 → title 兼容即收」
        html = ('<li class="subject-item"><div class="info"><h2><a href="https://book.douban.com'
                '/subject/9/" title="剑来1：少年起微末">剑来1：少年起微末</a></h2>'
                '<div class="pub">浙江文艺出版社 / 2020-4 / 40.00元</div></div></li>')
        book = douban_list.parse_douban_tag_page(html)[0]
        hit, out = self._search(book['title'], book['author'], '烽火戏诸侯')
        self.assertEqual(hit['url'], 'https://s.example/b1')
        self.assertNotIn('作者不符', out)



# ---- authfix41 续做（主会话裁定：错绑比漏收更糟）----
# 豆瓣 subject 页结构按 2026-09-25 实抓缩写（保留真实嵌套与空白形态）。
# 偷偷藏不住 subject/35003286：#info 里**没有作者行**（tag 页 pub 首段因此是出版社），作者只在作者卡片里。
SUBJECT_CARD_ONLY_HTML = """<div id="info">
    <span class="pl">出版社:</span>
      <a href="https://book.douban.com/press/2818">青岛出版社</a>
    <br>
    <span class="pl">出版年:</span> 2020-4<br/>
    <span class="pl">原作名:</span> 偷偷藏不住<br/>
</div>
<div id="authors">
  <ul class="authors-list from-subject __oneline">
          <li class="author">
              <a href="https://book.douban.com/author/4616235/" title="竹已">
                  <img src="x.png" alt="竹已" class="avatar">
              </a>
              <div class="info">
                  <a href="https://book.douban.com/author/4616235/" title="竹已" class="name">竹已</a>
                  <span class="role">作者</span>
              </div>
          </li>
      <li class="author fake fake5"></li>
  </ul>
</div>"""
# 斗破苍穹 subject/22933018：常规版本，#info 有作者行
SUBJECT_INFO_HTML = """<div id="info">
    <span>
      <span class="pl"> 作者</span>:
            <a href="/search/%E5%A4%A9%E8%9A%95%E5%9C%9F%E8%B1%86">天蚕土豆</a>
    </span><br/>
    <span class="pl">出版社:</span>
      <a href="https://book.douban.com/press/2636">湖北少年儿童出版社</a>
    <br>
</div>"""
TAG_PUBLISHER_ONLY_HTML = """<ul class="subject-list">
<li class="subject-item"><div class="info">
  <h2><a href="https://book.douban.com/subject/35003286/" title="偷偷藏不住">偷偷藏不住</a></h2>
  <div class="pub">青岛出版社 / 2020-4 / 59.8</div></div></li>
<li class="subject-item"><div class="info">
  <h2><a href="https://book.douban.com/subject/22933018/" title="斗破苍穹">斗破苍穹</a></h2>
  <div class="pub">天蚕土豆 / 湖北少年儿童出版社 / 2010-7</div></div></li>
</ul>"""
SUBJECT_TTCBZ = 'https://book.douban.com/subject/35003286/'

# 偷偷藏不住的引擎候选（phoenix gate.log 335 起那次搜索：旺仔排第一）
TTCBZ_CANDIDATES = [
    {'source': 'a.example', 'title': '偷偷藏不住', 'author': '旺仔', 'bookUrl': 'https://a.example/wz'},
    {'source': 'b.example', 'title': '偷偷藏不住', 'author': '竹已', 'bookUrl': 'https://b.example/zy'},
    {'source': 'c.example', 'title': '偷偷藏不住', 'author': '桑稚段嘉许', 'bookUrl': 'https://c.example/sz'},
]


class TestParseDoubanSubjectAuthor(unittest.TestCase):
    def test_author_card_when_info_has_no_author(self):
        self.assertEqual(douban_list.parse_douban_subject_author(SUBJECT_CARD_ONLY_HTML), '竹已')

    def test_info_author_line(self):
        self.assertEqual(douban_list.parse_douban_subject_author(SUBJECT_INFO_HTML), '天蚕土豆')

    def test_no_author_anywhere(self):
        self.assertEqual(douban_list.parse_douban_subject_author('<div id="info"></div>'), '')

    def test_translator_card_is_not_author(self):
        html = SUBJECT_CARD_ONLY_HTML.replace('<span class="role">作者</span>',
                                              '<span class="role">译者</span>')
        self.assertEqual(douban_list.parse_douban_subject_author(html), '')


class TestDoubanSubjectBackfill(unittest.TestCase):
    """只对「pub 首段是出版社」的条目去 subject 页补作者；单次尝试、失败落回名单无作者。"""

    def setUp(self):
        no_wait(self)
        self.urls = []

    def _get(self, subject):
        def http_get(url):
            self.urls.append(url)
            if url == douban_list._douban_tag_url('网络小说', 0):
                return TAG_PUBLISHER_ONLY_HTML
            if url == SUBJECT_TTCBZ:
                if isinstance(subject, Exception):
                    raise subject
                return subject
            if url.startswith('https://book.douban.com/subject/'):
                raise AssertionError(f'不该请求 subject 页: {url}')
            return '<html></html>'
        return http_get

    def test_publisher_only_entry_is_backfilled_from_subject(self):
        with contextlib.redirect_stdout(io.StringIO()):
            books = douban_list.fetch_douban_books(self._get(SUBJECT_CARD_ONLY_HTML), pages=1)
        got = {b['title']: b for b in books}
        self.assertEqual(got['偷偷藏不住']['author'], '竹已')
        self.assertEqual(got['斗破苍穹']['author'], '天蚕土豆')      # 有作者的条目不请求 subject
        self.assertEqual(self.urls.count(SUBJECT_TTCBZ), 1)
        self.assertTrue(all('publisher_only' not in b for b in books))   # 标记不外带进队列

    def test_subject_failure_is_single_attempt_and_leaves_author_empty(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            books = douban_list.fetch_douban_books(
                self._get(ConnectionError('豆瓣 subject 超时')), pages=1)
        got = {b['title']: b for b in books}
        self.assertEqual(got['偷偷藏不住']['author'], '')
        self.assertEqual(self.urls.count(SUBJECT_TTCBZ), 1)          # 不重试
        self.assertIn('补作者失败', err.getvalue())

    def test_subject_without_author_leaves_author_empty(self):
        with contextlib.redirect_stdout(io.StringIO()):
            books = douban_list.fetch_douban_books(self._get('<div id="info"></div>'), pages=1)
        self.assertEqual({b['title']: b for b in books}['偷偷藏不住']['author'], '')

    def test_subject_request_is_throttled_like_tag_pages(self):
        with mock.patch.object(douban_list.time, 'sleep') as sleep, \
                contextlib.redirect_stdout(io.StringIO()):
            douban_list.fetch_douban_books(self._get(SUBJECT_CARD_ONLY_HTML), pages=1)
        # tag 页之间 len(TAGS)-1 次 + subject 1 次，间隔都是 DOUBAN_PAGE_DELAY
        self.assertEqual(sleep.call_count, len(douban_list.DOUBAN_TAGS))
        self.assertTrue(all(c.args == (douban_list.DOUBAN_PAGE_DELAY,)
                            for c in sleep.call_args_list))


class TestAuthorUnknownAmbiguityGuard(unittest.TestCase):
    """名单无作者：兼容候选作者 ≥2 人 ⇒ 作者歧义跳过；一人（或全无作者）才收。"""

    @staticmethod
    def _search(title, candidates, author=''):
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout(candidates))})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, title, author)
        return hit, buf.getvalue()

    def test_ttcbz_three_authors_is_skipped_not_bound_to_first(self):
        # 改前：第一个兼容候选即收 ⇒ 绑到旺仔（a.example/wz）；改后：作者歧义跳过
        hit, out = self._search('偷偷藏不住', TTCBZ_CANDIDATES)
        self.assertIsNone(hit)
        self.assertIn('作者歧义跳过: 《偷偷藏不住》名单无作者，兼容候选作者 3 人（旺仔、桑稚段嘉许、竹已）',
                      out)

    def test_prefix_title_candidate_excluded_m4(self):
        # M4：名单无作者路径要求书名完全相等——同名**前缀**候选（偷偷藏不住的喜欢/司格子）
        # 被排除，不再算作第二位作者；只剩唯一精确同名候选（竹已）→ 直接收，不判歧义
        hit, out = self._search('偷偷藏不住', [
            TTCBZ_CANDIDATES[1],
            {'source': 'd.example', 'title': '偷偷藏不住的喜欢', 'author': '司格子',
             'bookUrl': 'https://d.example/sgz'}])
        self.assertEqual(hit['url'], 'https://b.example/zy')
        self.assertNotIn('作者歧义', out)
        self.assertNotIn('司格子', out)

    def test_prefix_only_candidate_is_dropped_not_released(self):
        # M4 反例 D 精神：唯一候选是前缀同人续写 → 被排除 → 无候选 → miss（不放行错书）
        hit, out = self._search('神秘复苏', [
            {'source': 'e.example', 'title': '神秘复苏之从回魂夜开始', 'author': '某同人作者',
             'bookUrl': 'https://e.example/tr'}])
        self.assertIsNone(hit)

    def test_single_author_is_accepted_preferring_known_author(self):
        hit, out = self._search('剑来', [
            {'source': 'e.example', 'title': '剑来', 'author': '', 'bookUrl': 'https://e.example/0'},
            {'source': 'a.example', 'title': '剑来', 'author': '烽火戏诸侯',
             'bookUrl': 'https://a.example/1'},
            {'source': 'b.example', 'title': '剑来1：少年起微末', 'author': '作者：烽火戏诸侯',
             'bookUrl': 'https://b.example/2'}])
        self.assertEqual(hit['url'], 'https://a.example/1')
        self.assertNotIn('作者歧义', out)

    def test_same_person_written_differently_is_one_author(self):
        # 聚簇用 author_matches：多署名写法不算第二人
        hit, _ = self._search('风起陇西', [
            {'source': 'a.example', 'title': '风起陇西', 'author': '马伯庸',
             'bookUrl': 'https://a.example/1'},
            {'source': 'b.example', 'title': '风起陇西', 'author': '马伯庸著 刘巴布编绘',
             'bookUrl': 'https://b.example/2'}])
        self.assertEqual(hit['url'], 'https://a.example/1')

    def test_all_candidates_without_author_takes_first(self):
        hit, _ = self._search('某书', [
            {'source': 'a.example', 'title': '某书', 'author': '', 'bookUrl': 'https://a.example/1'},
            {'source': 'b.example', 'title': '某书', 'author': '', 'bookUrl': 'https://b.example/2'}])
        self.assertEqual(hit['url'], 'https://a.example/1')

    def test_known_list_author_path_unchanged(self):
        # 名单有作者时不走歧义护栏：三人里挑出竹已
        hit, out = self._search('偷偷藏不住', TTCBZ_CANDIDATES, author='竹已')
        self.assertEqual(hit['url'], 'https://b.example/zy')
        self.assertNotIn('作者歧义', out)

    # ---- M4-r（复审第二轮，非阻断）：无作者路径相等前先剥站点装饰尾缀 ----
    def test_m4r_norm_title_bare_strips_site_decoration(self):
        nb = douban_list._norm_title_bare
        self.assertEqual(nb('神秘复苏 全文阅读'), nb('神秘复苏'))
        self.assertEqual(nb('神秘复苏最新章节'), nb('神秘复苏'))
        self.assertEqual(nb('神秘复苏笔趣阁'), nb('神秘复苏'))
        self.assertEqual(nb('神秘复苏全文阅读最新章节'), nb('神秘复苏'))   # 多个装饰尾缀成组剥
        # 同人续写尾缀不在装饰表 → 仍不相等（C6 前缀续写照拦，幂等红线不变）
        self.assertNotEqual(nb('神秘复苏之从回魂夜开始'), nb('神秘复苏'))

    def test_m4r_decorated_title_no_author_now_accepted(self):
        # 真同书、站点标题加装饰尾缀、名单无作者 → 不再因尾缀误拒（唯一无作者候选被收）
        cands = [{'source': 'a.example', 'title': '剑来 全文阅读', 'author': '',
                  'bookUrl': 'https://a.example/1'}]
        hit, _ = self._search('剑来', cands)
        self.assertIsNotNone(hit)
        self.assertEqual(hit['url'], 'https://a.example/1')
        # 变异：清空装饰词表 → 尾缀不剥 → 书名不等 → 回到误拒（证明尾缀规则承重）
        with mock.patch.object(douban_list, '_SITE_DECOR_RE', __import__('re').compile(r'(?!x)x')):
            hit2, _ = self._search('剑来', cands)
            self.assertIsNone(hit2)


class TestPublisherOnlyEndToEnd(unittest.TestCase):
    """豆瓣出版社条目 → subject 补作者 → 引擎候选（旺仔排第一）→ 绑到竹已；补不到则歧义跳过。"""

    def setUp(self):
        no_wait(self)

    def _run(self, subject):
        def http_get(url):
            if url == douban_list._douban_tag_url('网络小说', 0):
                return TAG_PUBLISHER_ONLY_HTML
            if url == SUBJECT_TTCBZ:
                if isinstance(subject, Exception):
                    raise subject
                return subject
            return NO_RESULT_HTML if url.startswith('/books/search') else '<html></html>'

        def engine(sub, args):
            title = args[args.index('--title') + 1]
            if title == '偷偷藏不住':
                return _proc(0, _engine_search_stdout(TTCBZ_CANDIDATES))
            return _proc(1)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            queue = douban_list.build_douban_queue(http_get, pages=1,
                                                   engine_cli=FakeEngineCli(engine))
        return {q['title']: q for q in queue}, buf.getvalue()

    def test_backfilled_author_binds_true_author(self):
        got, _ = self._run(SUBJECT_CARD_ONLY_HTML)
        self.assertEqual(got['偷偷藏不住']['url'], 'https://b.example/zy')
        self.assertEqual(got['偷偷藏不住']['author'], '竹已')

    def test_backfill_failure_falls_back_to_ambiguity_guard(self):
        got, out = self._run(ConnectionError('豆瓣 subject 超时'))
        self.assertNotIn('偷偷藏不住', got)
        self.assertIn('作者歧义跳过', out)


# ---- authfix41 整改（authrev41）----
class TestAuthorMatchesRevision(unittest.TestCase):
    def test_multi_signature_engine_string_does_not_match_two_list_authors_via_r4(self):
        # 非阻断 1：R4 只作用于单人署名；「某某」照旧靠分段匹配
        self.assertFalse(douban_list.author_matches('马丁', '乔治·马丁著 某某编绘'))
        self.assertTrue(douban_list.author_matches('某某', '乔治·马丁著 某某编绘'))
        self.assertTrue(douban_list.author_matches('马丁', '乔治·马丁著'))   # 单人署名照旧
        # 外文名在多署名串末尾时，按「·」切出的末节也是「马丁」——须靠单人署名护栏拦下
        for engine in ('某某、乔治·马丁', '某某编绘 乔治·马丁', '某某；（美）乔治·马丁'):
            with self.subTest(engine=engine):
                self.assertFalse(douban_list.author_matches('马丁', engine))
                self.assertFalse(douban_list.author_matches(engine, '马丁'))

    def test_nbsp_is_a_signature_separator(self):
        # 非阻断 2：&nbsp; 换空白参与切分，两位作者都能对上（改前马伯庸对不上）
        for a in ('马伯庸', '刘巴布'):
            with self.subTest(a=a):
                self.assertTrue(douban_list.author_matches(a, '马伯庸&nbsp;刘巴布'))
        self.assertFalse(douban_list.author_matches('马伯', '马伯庸&nbsp;刘巴布'))

    def test_list_side_multi_signature_is_split(self):
        # 非阻断 3：名单侧也切分，任一名单段与引擎任一段相等即真
        self.assertTrue(douban_list.author_matches('松本清张、稲木皓人', '松本清张'))
        self.assertTrue(douban_list.author_matches('松本清张、稲木皓人', '稲木皓人 著'))
        self.assertTrue(douban_list.author_matches('[美] 甲乙, [美] 丙丁', '丙丁'))
        # A 组原样仍拒
        self.assertFalse(douban_list.author_matches('松本清张、稲木皓人', '(英)A.L·萨德勒'))
        self.assertFalse(douban_list.author_matches('松本清张、稲木皓人', '李猛'))
        # 国籍段不算一段：「[英国] 甲、[英国] 乙」不得因共有「英国」撞上别人
        self.assertFalse(douban_list.author_matches('[英国] 甲乙、[英国] 丙丁', '[英国] 戊己'))

    def test_list_author_normalizing_to_empty_never_matches(self):
        # 非阻断 4：名单归一化为空 ⇒ 永不匹配（含引擎侧同样剥成空）
        for want in ('', '---', '。。。', '作者：', '（）'):
            for got in ('', '---', '。。。', '天蚕土豆', '作者：天蚕土豆'):
                with self.subTest(want=want, got=got):
                    self.assertFalse(douban_list.author_matches(want, got))


class TestAmbiguityGuardOrderIndependent(unittest.TestCase):
    """阻断 1：作者歧义判定与候选顺序无关（author_matches 不传递，不能贪心聚簇）。"""

    @staticmethod
    def _pick(authors):
        hits = [({'url': f'https://s{i}.example/b', 'author': a}, a) for i, a in enumerate(authors)]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            hit = douban_list._pick_author_unknown('同名书', hits)
        return hit, out.getvalue()

    def _all_orders(self, authors):
        import itertools
        return {p: self._pick(list(p)) for p in itertools.permutations(authors)}

    def test_non_transitive_chain_is_skipped_in_every_order(self):
        # 马伯庸 ~ 马伯庸著 刘巴布编绘 ~ 刘巴布，但 马伯庸 ≁ 刘巴布 ⇒ 3! 排列全部跳过
        results = self._all_orders(['马伯庸', '马伯庸著 刘巴布编绘', '刘巴布'])
        self.assertEqual(len(results), 6)
        for order, (hit, out) in results.items():
            with self.subTest(order=order):
                self.assertIsNone(hit)
                self.assertIn('兼容候选作者 3 人（刘巴布、马伯庸、马伯庸著 刘巴布编绘）', out)

    def test_two_different_martins_are_skipped_in_every_order(self):
        results = self._all_orders(['马丁', '乔治·马丁', '罗伯特·马丁'])
        self.assertEqual(len(results), 6)
        for order, (hit, out) in results.items():
            with self.subTest(order=order):
                self.assertIsNone(hit)
                self.assertIn('作者歧义跳过', out)

    def test_same_person_set_is_accepted_in_every_order(self):
        # 两两同一人 ⇒ 每种顺序都收（收作者已知的第一个）
        for authors in (['马丁', '乔治·马丁'], ['马伯庸', '马伯庸著 刘巴布编绘', '马伯庸 著']):
            results = self._all_orders(authors)
            for order, (hit, out) in results.items():
                with self.subTest(order=order):
                    self.assertIsNotNone(hit)
                    self.assertEqual(hit['author'], order[0])
                    self.assertNotIn('作者歧义', out)

    def test_known_author_preferred_over_empty_in_every_order(self):
        for order, (hit, _) in self._all_orders(['', '竹已', '竹已 著']).items():
            with self.subTest(order=order):
                self.assertTrue(hit['author'])

# ---- authfix41 整改（authrev41 增量）----
class TestAuthorSpaceSplitRevision(unittest.TestCase):
    # A：名内空格不是多署名分隔——切开后共有姓氏段就被判同一人
    DIFFERENT = (('上條 一輝', '上條 二輝'), ('司马 迁', '司马 光'), ('欧阳 修', '欧阳 询'),
                 ('夏目 漱石', '夏目 房之介'), ('太宰 治', '太宰 幸'), ('J.R.R. 托尔金', 'J.R.R. 马丁'))

    def test_cjk_name_internal_space_is_not_a_separator(self):
        for a, b in self.DIFFERENT:
            with self.subTest(pair=(a, b)):
                self.assertFalse(douban_list.author_matches(a, b))
                self.assertFalse(douban_list.author_matches(b, a))
        self.assertTrue(douban_list.author_matches('上條 一輝', '上條一輝'))   # 同一人写法差照旧
        # 只有一侧带「·」的空白不切：「斯蒂芬·金（Stephen King）」切开会让「King」单独成段
        self.assertEqual(douban_list._author_segments('[美]斯蒂芬·金（Stephen King）')[1:], [])
        self.assertFalse(douban_list.author_matches('King', '[美]斯蒂芬·金（Stephen King）'))

    def test_real_cjk_multi_signature_strings_still_split(self):
        for engine, parts in (
                ('马伯庸著 刘巴布编绘', ['马伯庸著', '刘巴布编绘']),          # 角色后缀后的空白
                ('软星科技原著 执笔：苏末那', ['软星科技原著', '执笔：苏末那']),  # 角色标签前的空白
                ('刘巴布 执笔：苏末那', ['刘巴布', '执笔：苏末那']),          # 左边不以角色结尾，靠右边标签
                ('(俄)阿卡迪·斯特鲁伽茨基 鲍里斯·斯特鲁伽茨基',              # 两个外文全名
                 ['(俄)阿卡迪·斯特鲁伽茨基', '鲍里斯·斯特鲁伽茨基']),
                ('马伯庸、刘巴布', ['马伯庸', '刘巴布']), ('马伯庸/刘巴布', ['马伯庸', '刘巴布']),
                ('马伯庸&nbsp;刘巴布', ['马伯庸', '刘巴布'])):
            with self.subTest(engine=engine):
                self.assertEqual(douban_list._author_segments(engine)[1:], parts)
                for p in ('马伯庸', '刘巴布') if '马伯庸' in engine else ():
                    self.assertTrue(douban_list.author_matches(p, engine))
        self.assertTrue(douban_list.author_matches('苏末那', '软星科技原著 执笔：苏末那'))
        self.assertTrue(douban_list.author_matches('鲍里斯·斯特鲁伽茨基',
                                                   '(俄)阿卡迪·斯特鲁伽茨基 鲍里斯·斯特鲁伽茨基'))

    # B：「名 + 空格 + 著」是单人署名，R4 照常生效
    def test_trailing_role_after_space_is_single_author(self):
        for a, b in (('[澳]杰西卡·汤森 著', '汤森'), ('[美]乔治·R.R.马丁 著', '马丁'),
                     ('[英] 詹姆斯·马修·巴利 著', '巴利'), ('[英] 詹姆斯·马修·巴利', '（英）巴利 著'),
                     ('[澳]杰西卡·汤森 著 绘', '汤森')):   # 连续角色词：「著」后的空白按规则会切出「绘」
            with self.subTest(pair=(a, b)):
                self.assertTrue(douban_list.author_matches(a, b))
                self.assertTrue(douban_list.author_matches(b, a))

    def test_trailing_role_strip_does_not_admit_multi_signature(self):
        for engine in ('乔治·马丁著 某某编绘', '某某、乔治·马丁 著', '某某编绘 乔治·马丁 著',
                       '（英）巴利著；靳锦译', '某某 著 乔治·马丁'):
            with self.subTest(engine=engine):
                self.assertFalse(douban_list._is_single_author(engine))
                self.assertFalse(douban_list.author_matches('马丁', engine))

# ---- authcv41：内容比对（目录 + 开头正文判定同书）----
# 正例：同一本书跨两站，章节标题去编号后集合相同、开头正文一致（作者串因繁简虚增，
#   如《凌霄之上》观棋 vs 觀棋）→ 应聚为唯一主簇、放行。
# 反例：同名不同书，章节标题集合不相交 → 多簇、维持歧义跳过。
CM_TITLES_X = ['第一章 天才陨落', '第二章 蝼蚁之路', '第三章 血脉觉醒',
               '第四章 初显锋芒', '第五章 风波再起']
CM_TITLES_X_ALT = ['第1章 天才陨落', '第2章 蝼蚁之路', '第3章 血脉觉醒',
                   '第4章 初显锋芒', '第5章 风波再起']          # 同书、编号写法不同
CM_TITLES_Y = ['第一章 星空之下', '第二章 荒原孤影', '第三章 古城疑云',
               '第四章 迷雾深处', '第五章 短兵相接']            # 同名不同书
CM_BODY_X = '叶凌霄睁开双眼，发现自己重回三年前那个风雨交加的夜晚，命运的齿轮再度转动。' * 120
CM_BODY_Y = '林牧站在荒原尽头，望着远方燃烧的城池，握紧了手中早已卷刃的旧刀，杀意渐浓。' * 120


def _cm_book(titles, body, base):
    """一本书的引擎响应片段：toc（章节标题+URL）+ 各章正文。"""
    chapters = [{'title': t, 'url': f'{base}/c{i}'} for i, t in enumerate(titles)]
    contents = {f'{base}/c{i}': body for i in range(len(titles))}
    return {'toc': {'title': '书', 'chapters': chapters}, 'contents': contents}


def _cm_cli(books, candidates=None):
    """按 --url 分发 toc/content 的 FakeEngineCli（callable 形态）；search 返回 candidates。"""
    def _url_of(args):
        return args[args.index('--url') + 1] if '--url' in args else ''

    def dispatch(subcommand, args):
        if subcommand == 'search':
            return _proc(0, _engine_search_stdout(candidates or []))
        url = _url_of(args)
        if subcommand == 'toc':
            book = books.get(url)
            if not book:
                return _proc(1, '')
            return _proc(0, json.dumps(book['toc'], ensure_ascii=False))
        if subcommand == 'content':
            for b in books.values():
                if url in b['contents']:
                    return _proc(0, json.dumps({'text': b['contents'][url]}, ensure_ascii=False))
            return _proc(1, '')
        return _proc(1, '')
    return FakeEngineCli(dispatch)


def _cm_book_bodies(titles, bodies, base):
    """每章各自不同正文的书（M2 正文兜底测试用）：chapters[i].url → bodies[i]。"""
    chapters = [{'title': t, 'url': f'{base}/c{i}'} for i, t in enumerate(titles)]
    contents = {f'{base}/c{i}': bodies[i] for i in range(min(len(titles), len(bodies)))}
    return {'toc': {'title': '书', 'chapters': chapters}, 'contents': contents}


# 每章约 1600 字、彼此不同的长正文（去模板后 > CONTENT_MIN_BODY_CHARS）
CM_MULTI_X = ['第一章里叶凌霄踏入试炼秘境遭遇强敌围攻。' * 90,
              '第二章他于绝境中顿悟剑意反手击溃追兵。' * 90,
              '第三章沉睡血脉骤然觉醒天地为之变色。' * 90]
CM_MULTI_Y = ['第一章林牧穿越焦土荒原寻找失落古城。' * 90,
              '第二章他在幽深密林遭遇成群变异巨兽。' * 90,
              '第三章残破旧刀终于出鞘斩开重重杀阵。' * 90]
CM_TEMPLATE_LINE = '温馨提示您：本章内容可能存在采集错漏，请留意甄别，本站不承担任何责任。'
# M2-r：**逐章变化**的站点模板（句中嵌章号），两本书用同一模板但正文不同
CM_VARYING_TMPL = ('本站郑重提示书友：您当前正在阅读的是本书第%s章的正文内容更新，若在阅读过程中发现'
                   '章节文字出现错乱、重复、缺失或前后串章等各类异常情况，烦请您立即返回本书目录页面'
                   '重新点击对应章节进入以刷新页面缓存，本站将持续竭诚为广大书友提供稳定优质且完全'
                   '免费的在线阅读服务体验，衷心感谢您长期以来对本站的理解厚爱与鼎力支持。')
CM_VARY_PLOT_X = ['甲主角探远古秘境。' * 160, '甲主角战强敌苦斗。' * 160, '甲主角醒血脉逆天。' * 160]
CM_VARY_PLOT_Y = ['乙主角闯焦土荒原。' * 160, '乙主角入密林遇兽。' * 160, '乙主角挥旧刀破阵。' * 160]
# §12 N2：模板句里嵌**不可归一变量**（手打组甲/乙/丙——汉字，非数字/URL），旧「归一后完全相同」
# 覆盖不到；模糊去重（bigram Jaccard）能识别只差一字的逐章模板。
CM_VAR_TMPL_HAND = ('本站郑重提示各位书友本章内容由本站热心读者手打组%s负责录入校对完成若在阅读过程中'
                    '发现任何文字错漏或章节串行敬请返回本书目录页重新进入以刷新页面缓存衷心感谢诸位'
                    '书友长期以来对本站的理解厚爱与鼎力支持祝各位阅读愉快')


def _fp_dual(titles, base, bodies=None):
    """指纹：给定章名 + 每章各异长正文（默认 CM_MULTI_X，两侧用同一组 → 正文信号「可判且判同」）。
    §12 双信号与门下，隔离目录信号做承重验证时用它把正文侧钉成「同书」。"""
    return douban_list.fetch_content_fingerprint(
        _cm_cli({base: _cm_book_bodies(titles, bodies or CM_MULTI_X, base)}), base)


class TestContentFingerprint(unittest.TestCase):
    def test_norm_toc_title_strips_numbering(self):
        self.assertEqual(douban_list._norm_toc_title('第一章 天才陨落'), '天才陨落')
        self.assertEqual(douban_list._norm_toc_title('第1章 天才陨落'), '天才陨落')
        self.assertEqual(douban_list._norm_toc_title('楔子：开端'), '开端')
        self.assertEqual(douban_list._norm_toc_title('序章'), '')
        self.assertEqual(douban_list._norm_toc_title('番外 后日谈'), '后日谈')

    def test_jaccard_and_ngrams(self):
        self.assertEqual(douban_list._jaccard(set(), {'a'}), 0.0)
        self.assertEqual(douban_list._jaccard({'a', 'b'}, {'a', 'b'}), 1.0)
        self.assertEqual(douban_list._jaccard({'a', 'b'}, {'b', 'c'}), 1 / 3)
        self.assertTrue(douban_list._char_ngrams('天才陨落风波'))
        self.assertEqual(douban_list._char_ngrams('  1234  ！！'), set())   # 只留中日文/拉丁

    def test_fingerprint_from_engine(self):
        base = 'https://a.example/x'
        books = {base: _cm_book_bodies(CM_TITLES_X, CM_MULTI_X + CM_MULTI_X, base)}
        cli = _cm_cli(books)
        fp = douban_list.fetch_content_fingerprint(cli, base)
        self.assertEqual(fp['toc'], ['天才陨落', '蝼蚁之路', '血脉觉醒', '初显锋芒', '风波再起'])
        self.assertTrue(fp['body'])                 # 每章正文各异 → 去模板后非空
        self.assertGreater(fp['body_chars'], 0)

    def test_fingerprint_none_on_engine_failure(self):
        cli = _cm_cli({})                       # 无此书 → toc rc=1 → None（不猜同书）
        self.assertIsNone(douban_list.fetch_content_fingerprint(cli, 'https://a.example/x'))

    def test_fingerprint_cache_reused(self):
        books = {'https://a.example/x': _cm_book(CM_TITLES_X, CM_BODY_X, 'https://a.example/x')}
        cli = _cm_cli(books)
        cache = {}
        douban_list.fetch_content_fingerprint(cli, 'https://a.example/x', cache=cache)
        n1 = len(cli.calls)
        douban_list.fetch_content_fingerprint(cli, 'https://a.example/x', cache=cache)
        self.assertEqual(len(cli.calls), n1)    # 命中缓存：不再发引擎调用

    def test_content_calls_capped_by_attempts_not_hits(self):
        # N1 反例 R1：500 章、每章正文 ≤100 字（都不计入 body）→ content 调用仍 ≤ CONTENT_MAX_CHAPTERS
        base = 'https://a.example/x'
        chapters = [{'title': f'第{i}章', 'url': f'{base}/c{i}'} for i in range(500)]
        contents = {f'{base}/c{i}': '短' for i in range(500)}
        books = {base: {'toc': {'title': '书', 'chapters': chapters}, 'contents': contents}}
        cli = _cm_cli(books)
        douban_list.fetch_content_fingerprint(cli, base)
        content_calls = sum(1 for sub, _ in cli.calls if sub == 'content')
        self.assertLessEqual(content_calls, douban_list.CONTENT_MAX_CHAPTERS)


class TestSameBookAndRescue(unittest.TestCase):
    def _fp(self, titles, body, base='https://x/1'):
        return douban_list.fetch_content_fingerprint(
            _cm_cli({base: _cm_book(titles, body, base)}), base)

    def _fpb(self, titles, base, bodies=None):
        # 每章各异长正文（去模板后 ≥3000 字），两侧用同一组 bodies → 正文信号「可判且判同」，
        # 用于隔离出目录信号做承重验证（§12 双信号与门下 body 须同时成立）
        return douban_list.fetch_content_fingerprint(
            _cm_cli({base: _cm_book_bodies(titles, bodies or CM_MULTI_X, base)}), base)

    def test_same_book_positive_by_toc(self):
        # §12 双信号与门：目录一致(≥5 共享信息性章名) + 每章各异长正文一致 → 两信号都成立 → 放行
        a = self._fpb(CM_TITLES_X, 'https://a/1')
        b = self._fpb(CM_TITLES_X_ALT, 'https://b/1')
        ok, sim = douban_list.same_book(a, b)
        self.assertTrue(ok)
        self.assertEqual(sim['basis'], 'toc+body')
        self.assertTrue(sim['toc_ok'] and sim['body_ok'])
        self.assertGreaterEqual(sim['toc'], douban_list.CONTENT_TOC_JACCARD)

    def test_same_title_different_book_negative(self):
        a = self._fp(CM_TITLES_X, CM_BODY_X, 'https://a/1')
        y = self._fp(CM_TITLES_Y, CM_BODY_Y, 'https://y/1')
        ok, sim = douban_list.same_book(a, y)
        self.assertFalse(ok)                      # 目录不相交 + 正文无关 → 不同书
        self.assertLess(sim['toc'], douban_list.CONTENT_TOC_JACCARD)

    def test_missing_fingerprint_never_matches(self):
        a = self._fp(CM_TITLES_X, CM_BODY_X, 'https://a/1')
        self.assertFalse(douban_list.same_book(a, None)[0])
        self.assertFalse(douban_list.same_book(None, None)[0])

    def test_short_toc_no_longer_rescued_by_body_alone(self):
        # §12 双信号与门（按设计少救）：目录信息不足（纯编号，无信息性章名）→ 目录不可判 →
        # **即便正文一致也不放行**。删除了「目录不可判就只看正文」的单信号路径。
        nums = ['第一章', '第二章', '第三章']
        a = douban_list.fetch_content_fingerprint(
            _cm_cli({'https://a/1': _cm_book_bodies(nums, CM_MULTI_X, 'https://a/1')}), 'https://a/1')
        b = douban_list.fetch_content_fingerprint(
            _cm_cli({'https://b/1': _cm_book_bodies(nums, CM_MULTI_X, 'https://b/1')}), 'https://b/1')
        c = douban_list.fetch_content_fingerprint(
            _cm_cli({'https://c/1': _cm_book_bodies(nums, CM_MULTI_Y, 'https://c/1')}), 'https://c/1')
        ok_ab, sim_ab = douban_list.same_book(a, b)     # 正文相同但目录不可判
        ok_ac, _ = douban_list.same_book(a, c)          # 正文不同
        self.assertFalse(sim_ab['toc_ok'])              # 目录不可判
        self.assertFalse(ok_ab)                         # 单靠正文不再放行（少救）
        self.assertFalse(ok_ac)

    # ---- 阈值变异验证：阈值改坏，判定就该翻转（证明阈值是承重的）----
    def test_toc_threshold_is_load_bearing(self):
        # body 两侧持平（可判+判同），隔离目录信号。正常同书 → 判是；目录任一阈值改到不可达 → 漏判
        pos_a = self._fpb(CM_TITLES_X, 'https://a/1')
        pos_b = self._fpb(CM_TITLES_X_ALT, 'https://b/1')
        self.assertTrue(douban_list.same_book(pos_a, pos_b)[0])       # 正常：同书判是
        with mock.patch.object(douban_list, 'CONTENT_TOC_JACCARD', 1.01):
            self.assertFalse(douban_list.same_book(pos_a, pos_b)[0])  # Jaccard 闸不可达 → 漏判
        with mock.patch.object(douban_list, 'CONTENT_TOC_LCS', 1.01):
            self.assertFalse(douban_list.same_book(pos_a, pos_b)[0])  # LCS 闸不可达 → 漏判
        # 误并方向：交集≥5 但整体 Jaccard<0.60（各含 3 条不同的额外情节章）→ 判否；阈值改 0 → 误并
        extra_a = CM_TITLES_X + ['第6章 东境残阳', '第7章 北溟孤舟', '第8章 万象归墟']
        extra_b = CM_TITLES_X_ALT + ['第6章 西陲落月', '第7章 南冥断剑', '第8章 太虚碎星']
        lowj_a = self._fpb(extra_a, 'https://c/1')
        lowj_b = self._fpb(extra_b, 'https://d/1')
        self.assertEqual(len(set(lowj_a['toc']) & set(lowj_b['toc'])), 5)   # 交集达标
        self.assertLess(douban_list._jaccard(set(lowj_a['toc']), set(lowj_b['toc'])),
                        douban_list.CONTENT_TOC_JACCARD)                     # 但 Jaccard<0.60
        self.assertFalse(douban_list.same_book(lowj_a, lowj_b)[0])          # 正常：判否
        with mock.patch.object(douban_list, 'CONTENT_TOC_JACCARD', 0.0):
            self.assertTrue(douban_list.same_book(lowj_a, lowj_b)[0])       # Jaccard 闸改坏(0) → 误并 → 变红

    # ---- search_engine 集成：名单无作者、判歧义时的内容比对救回 ----
    def _candidates(self, specs):
        return [{'source': host, 'title': title, 'author': author, 'bookUrl': url}
                for host, title, author, url in specs]

    def test_rescue_false_ambiguity_same_book(self):
        # 《凌霄之上》同一本书两站：作者 观棋 vs 觀棋(繁简→归一后仍不等→判歧义)，但内容同→放行
        # §12：目录一致(共享信息性章名) + 每章各异长正文一致 → 双信号成立
        base_a, base_b = 'https://a.example/1', 'https://b.example/1'
        books = {base_a: _cm_book_bodies(CM_TITLES_X, CM_MULTI_X, base_a),
                 base_b: _cm_book_bodies(CM_TITLES_X_ALT, CM_MULTI_X, base_b)}
        cands = self._candidates([('a.example', '凌霄之上', '观棋', base_a),
                                  ('b.example', '凌霄之上', '觀棋', base_b)])
        cli = _cm_cli(books, cands)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '凌霄之上', '')
        out = buf.getvalue()
        self.assertIsNotNone(hit)
        self.assertIn(hit['url'], (base_a, base_b))
        self.assertIn('内容比对放行', out)
        self.assertIn('content_match', out)
        self.assertNotIn('作者歧义跳过', out)

    def test_no_rescue_same_title_different_books(self):
        # 同名不同书：内容多簇 → 维持作者歧义跳过，绝不放行
        base_a, base_y = 'https://a.example/1', 'https://y.example/1'
        books = {base_a: _cm_book(CM_TITLES_X, CM_BODY_X, base_a),
                 base_y: _cm_book(CM_TITLES_Y, CM_BODY_Y, base_y)}
        cands = self._candidates([('a.example', '长生', '甲作者', base_a),
                                  ('y.example', '长生', '乙作者', base_y)])
        cli = _cm_cli(books, cands)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '长生', '')
        out = buf.getvalue()
        self.assertIsNone(hit)
        self.assertIn('作者歧义跳过', out)
        self.assertNotIn('内容比对放行', out)

    def test_env_switch_off_disables_rescue(self):
        base_a, base_b = 'https://a.example/1', 'https://b.example/1'
        books = {base_a: _cm_book(CM_TITLES_X, CM_BODY_X, base_a),
                 base_b: _cm_book(CM_TITLES_X_ALT, CM_BODY_X, base_b)}
        cands = self._candidates([('a.example', '凌霄之上', '观棋', base_a),
                                  ('b.example', '凌霄之上', '觀棋', base_b)])
        cli = _cm_cli(books, cands)
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {'AUTHCV_CONTENT_MATCH': '0'}), \
                contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '凌霄之上', '')
        out = buf.getvalue()
        self.assertIsNone(hit)                    # 关掉开关 → 回退原歧义跳过
        self.assertIn('作者歧义跳过', out)
        # 关掉后不应发起任何 toc/content 取文（成本回滚干净）
        self.assertFalse(any(c[0] in ('toc', 'content') for c in cli.calls))

    def test_too_many_authors_skips_content_probe(self):
        # distinct 作者 > 上限（同名书泛滥，如《长生》42 人）→ 不取文、维持跳过
        specs = [(f'h{i}.example', '长生', f'作者{i}', f'https://h{i}.example/1') for i in range(6)]
        cli = _cm_cli({}, self._candidates(specs))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '长生', '')
        self.assertIsNone(hit)
        self.assertIn('作者歧义跳过', buf.getvalue())
        self.assertFalse(any(c[0] in ('toc', 'content') for c in cli.calls))


class TestBogusListAuthor(unittest.TestCase):
    def test_genre_and_publisher_are_bogus(self):
        for a in ('悬疑灵异', '轻小说', '玄幻', '仙侠', '言情', '輕小說', '懸疑靈異', '网游',
                  '青岛出版社', '中国友谊出版公司', '浙江文艺出版社', '某某书局',
                  'Penguin Press', 'HarperCollins Publishing'):
            with self.subTest(author=a):
                self.assertTrue(douban_list.is_bogus_list_author(a))

    def test_real_authors_not_downgraded(self):
        # 反例：真人作者（含笔名恰好像普通词的），绝不能误降级
        for a in ('天蚕土豆', '辰东', '出版', '唐家三少', '爱潜水的乌贼', '烽火戏诸侯',
                  '出版社的猫', '玄幻大师', '', '   '):
            with self.subTest(author=a):
                self.assertFalse(douban_list.is_bogus_list_author(a))

    def test_bogus_author_reuses_import_one_genres(self):
        # 复用 import_one.PRIMARY_GENRES：其中每个分类都应判污染
        import import_one
        for g in import_one.PRIMARY_GENRES:
            if g == '其他':          # 「其他」太泛，不宜作污染判据——确认它不在补集里也未被 PRIMARY 命中前先看
                continue
            with self.subTest(genre=g):
                self.assertTrue(douban_list.is_bogus_list_author(g))

    def test_polluted_author_downgraded_and_rescued(self):
        # 名单作者=「悬疑灵异」（分类污染），两站实为同一本书 → 降级为名单无作者 → 内容聚类放行，
        # 采信候选作者（长安天），绝不把「悬疑灵异」写进去
        base_a, base_b = 'https://a.example/1', 'https://b.example/1'
        books = {base_a: _cm_book_bodies(CM_TITLES_X, CM_MULTI_X, base_a),
                 base_b: _cm_book_bodies(CM_TITLES_X_ALT, CM_MULTI_X, base_b)}
        cands = [{'source': 'a.example', 'title': '神秘复苏', 'author': '长安天', 'bookUrl': base_a},
                 {'source': 'b.example', 'title': '神秘复苏', 'author': '長安天', 'bookUrl': base_b}]
        cli = _cm_cli(books, cands)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '神秘复苏', '悬疑灵异')
        out = buf.getvalue()
        self.assertIsNotNone(hit)
        self.assertIn('降级为名单无作者', out)
        self.assertIn('内容比对放行', out)
        # 引擎搜索不应把污染作者当 --author 传下去
        search_args = next(a for sub, a in cli.calls if sub == 'search')
        self.assertNotIn('--author', search_args)

    def test_downgrade_plus_prefix_candidate_not_released_c6(self):
        # rvauthcv 反例 C6：污染作者降级后，唯一候选是前缀同人续写 → M4 要求书名完全相等 → 拦下
        base = 'https://e.example/tr'
        cands = [{'source': 'e.example', 'title': '神秘复苏之从回魂夜开始', 'author': '某同人作者',
                  'bookUrl': base}]
        cli = _cm_cli({base: _cm_book(CM_TITLES_X, CM_BODY_X, base)}, cands)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '神秘复苏', '悬疑灵异')
        out = buf.getvalue()
        self.assertIn('降级为名单无作者', out)      # 确实降级了
        self.assertIsNone(hit)                        # 但前缀续写书不放行

    def test_downgrade_is_load_bearing(self):
        # 变异：把分类识别打空 → 不降级 → 名单有作者、候选全不符 → 被拦（回到坏行为）
        base_a = 'https://a.example/1'
        books = {base_a: _cm_book(CM_TITLES_X, CM_BODY_X, base_a)}
        cands = [{'source': 'a.example', 'title': '神秘复苏', 'author': '长安天', 'bookUrl': base_a}]
        with mock.patch.object(douban_list, '_known_genre_keys', return_value=frozenset()), \
                mock.patch.object(douban_list, '_BOGUS_PUBLISHER_RE',
                                  __import__('re').compile(r'(?!x)x')):
            cli = _cm_cli(books, cands)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                hit = douban_list.search_engine(cli, '神秘复苏', '悬疑灵异')
            self.assertIsNone(hit)                    # 识别失效 → 恢复被拦
            self.assertNotIn('降级为名单无作者', buf.getvalue())


class TestNormAuthorSimplified(unittest.TestCase):
    """authcv41 §8：_norm_author 繁转简，口径与 import_one 入库身份键对齐。
    覆盖范围 = import_one._T2S 那张常用字表（约 130 字，含多数姓氏/常用名字）；
    表未收的字（觀/偽/篤 等）不桥接，见 test_reused_table_coverage_gap。"""

    # 全部用字均在 import_one._T2S 表内
    def test_traditional_simplified_norm_equal(self):
        for trad, simp in (('餘華', '余华'), ('張愛玲', '张爱玲'), ('風雲', '风云'),
                           ('顧曉夢', '顾晓梦'), ('龍傑', '龙杰'), ('陳靜', '陈静')):
            with self.subTest(pair=(trad, simp)):
                self.assertEqual(douban_list._norm_author(trad), douban_list._norm_author(simp))

    def test_author_matches_bridges_traditional(self):
        for trad, simp in (('餘華', '余华'), ('張愛玲', '张爱玲'), ('風雲', '风云'), ('龍傑', '龙杰')):
            with self.subTest(pair=(trad, simp)):
                self.assertTrue(douban_list.author_matches(trad, simp))
                self.assertTrue(douban_list.author_matches(simp, trad))

    def test_aligned_with_import_one_loose_key(self):
        # 与入库身份键同口径：非占位作者，_norm_author(raw) == _loose_author_key(raw)
        import import_one
        for a in ('餘華', '张爱玲', '風雲', '唐家三少', '作者：天蚕土豆', '[美]乔治·R.R.马丁'):
            with self.subTest(author=a):
                self.assertEqual(douban_list._norm_author(a), import_one._loose_author_key(a))

    def test_distinct_authors_still_distinct_after_conversion(self):
        # 反例说明：繁转简只统一「同一姓名的繁/简写法」，不会把不同的人并到一起
        self.assertNotEqual(douban_list._norm_author('風雲'), douban_list._norm_author('風靈'))
        self.assertNotEqual(douban_list._norm_author('張愛玲'), douban_list._norm_author('張愛民'))
        self.assertFalse(douban_list.author_matches('餘華', '张伟'))

    def test_reused_table_coverage_gap(self):
        # 诚实记录：复用的表未收 觀/偽/篤 等字，故 gate.log 里的《凌霄之上》觀棋/观棋、偽戒/伪戒、
        # 中下馬篤/中下马笃 这几例**仍不桥接**（属表覆盖问题，不扩表见 §8）
        import import_one
        for ch in ('觀', '偽', '篤'):
            self.assertNotIn(ch, import_one._T2S)
        self.assertFalse(douban_list.author_matches('觀棋', '观棋'))

    def test_traditional_ambiguity_dissolved_no_rescue_needed(self):
        # 名单无作者、两站作者是同名的繁/简（餘華 vs 余华）→ 归一后同一人 → 不再判歧义、
        # 直接收（无需内容比对、不取文）
        cands = [{'source': 'a.example', 'title': '活着', 'author': '餘華',
                  'bookUrl': 'https://a.example/1'},
                 {'source': 'b.example', 'title': '活着', 'author': '余华',
                  'bookUrl': 'https://b.example/1'}]
        cli = FakeEngineCli({'search': _proc(0, _engine_search_stdout(cands))})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            hit = douban_list.search_engine(cli, '活着', '')
        out = buf.getvalue()
        self.assertIsNotNone(hit)
        self.assertNotIn('作者歧义跳过', out)
        self.assertNotIn('内容比对放行', out)
        self.assertFalse(any(c[0] in ('toc', 'content') for c in cli.calls))

    def test_conversion_is_load_bearing(self):
        # 变异：关掉繁转简表 → 繁/简同名判不相等（回到 authcv 之前的假不符）
        self.assertTrue(douban_list.author_matches('餘華', '余华'))
        with mock.patch.object(douban_list, '_T2S_TRANS', {}):
            self.assertFalse(douban_list.author_matches('餘華', '余华'))
            self.assertNotEqual(douban_list._norm_author('風雲'), douban_list._norm_author('风云'))


class TestTocGuardsM1(unittest.TestCase):
    """M1：通用标题停用表 + 目录信息量下限(5) + 有序 LCS 双闸，防同名异书被通用标题打穿。"""

    def _fp(self, titles, body, base):
        return douban_list.fetch_content_fingerprint(
            _cm_cli({base: _cm_book(titles, body, base)}), base)

    def test_generic_titles_filtered(self):
        seq = douban_list._informative_toc_titles(
            [{'title': t} for t in ['上架感言', '尾声', '后记', '公告', '序章', '楔子', '番外',
                                     '请假条', '新书', '第一章 天才陨落', '第二章 蝼蚁']])
        self.assertEqual(seq, ['天才陨落'])       # 只留信息性标题（'蝼蚁' <4 字被长度闸剔除）、保序

    def test_lcs_ratio(self):
        self.assertEqual(douban_list._lcs_ratio(['a', 'b', 'c'], ['a', 'b', 'c']), 1.0)
        self.assertAlmostEqual(douban_list._lcs_ratio(['a', 'b', 'c', 'd', 'e'],
                                                      ['e', 'd', 'c', 'b', 'a']), 0.2)
        self.assertEqual(douban_list._lcs_ratio([], ['a']), 0.0)

    def test_c1_generic_saturated_not_merged(self):
        # rvauthcv 反例 C1：通用标题饱和 + 1 个不同的情节标题 + 不同正文 → 判否
        a = self._fp(['上架感言', '尾声', '后记', '第一章 天才陨落'], CM_BODY_X, 'https://a/1')
        b = self._fp(['上架感言', '尾声', '后记', '第一章 星空之下'], CM_BODY_Y, 'https://b/1')
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_c2_pure_numbering_plus_generic_not_merged(self):
        # rvauthcv 反例 C2：纯「第X章」+ 通用词 → 信息性标题塌成空 → 不靠目录判相似；正文不同 → 判否
        a = self._fp(['第一章', '第二章', '第三章', '上架感言', '尾声', '后记'], CM_BODY_X, 'https://a/1')
        b = self._fp(['第1章', '第2章', '第3章', '上架感言', '尾声', '后记'], CM_BODY_Y, 'https://b/1')
        self.assertEqual(a['toc'], [])                     # 信息性标题为空
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_shuffled_same_titles_rejected_by_lcs(self):
        # 集合相同但顺序完全打乱（Jaccard=1.0）→ 有序 LCS 低 → 判否（同名异书重排目录防线）
        # 章名取 ≥4 字（过 §12 长度闸），≥6 条（过交集下限）
        titles_a = ['天才陨落', '蝼蚁之路', '血脉觉醒', '初显锋芒', '风波再起', '万象归墟']
        titles_b = list(reversed(titles_a))
        a = self._fp([f'第{i+1}章 {t}' for i, t in enumerate(titles_a)], CM_BODY_X, 'https://a/1')
        b = self._fp([f'第{i+1}章 {t}' for i, t in enumerate(titles_b)], CM_BODY_Y, 'https://b/1')
        ok, sim = douban_list.same_book(a, b)
        self.assertEqual(sim['toc'], 1.0)                  # 集合完全相同
        self.assertLess(sim['lcs'], douban_list.CONTENT_TOC_LCS)
        self.assertFalse(ok)

    def test_min_titles_raised_to_five(self):
        self.assertGreaterEqual(douban_list.CONTENT_TOC_MIN_TITLES, 5)

    # ---- M1-r（复审第二轮）：结构性判据——只有带章节编号的正文章节参与目录比对 ----
    def test_m1r_unnumbered_auxiliary_entries_excluded(self):
        # 不带章节编号的辅助条目（封推感言/三江感言/更新说明/读者必看/新书预告/分卷感言）
        # 整条不参与目录比对；全部落在停用表之外也拦得住（结构性，非枚举）
        aux = ['封推感言', '三江感言', '更新说明', '读者必看', '新书预告', '分卷感言']
        self.assertEqual(douban_list._informative_toc_titles([{'title': t} for t in aux]), [])
        for t in aux:
            self.assertNotIn(douban_list._norm_toc_title(t), douban_list._GENERIC_TOC_NORM)  # 表外
            self.assertFalse(douban_list._split_toc_numbering(t)[0])                          # 不带编号

    def test_m1r_generic_saturated_table_miss_not_merged(self):
        # 复审 M1-r 反例：6 个表外辅助条目 + 各自 1 条不同情节章 → 信息性章名各只剩 1 → 目录不可判
        aux = ['封推感言', '三江感言', '更新说明', '读者必看', '新书预告', '分卷感言']
        a = self._fp(aux + ['第一章 天才陨落'], CM_BODY_X, 'https://a/1')
        b = self._fp(aux + ['第一章 星空之下'], CM_BODY_Y, 'https://b/1')
        self.assertEqual(len(set(a['toc'])), 1)             # 仅 1 条信息性章名（<5）
        self.assertFalse(douban_list.same_book(a, b)[0])    # 转正文，正文不同 → 判否

    def test_m1r_variant_generic_words_not_merged(self):
        # 复审给的变体：另一批表外辅助词，同样不带编号 → 不参与 → 两本不同书不放行
        aux = ['公告栏', '更新说明', '关于更新', '作者寄语', '读者必看', '新书预告']
        a = self._fp(aux + ['第一章 天才陨落'], CM_BODY_X, 'https://a/1')
        b = self._fp(aux + ['第一章 星空之下'], CM_BODY_Y, 'https://b/1')
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_m1r_char_gate_is_load_bearing(self):
        # 变异：把结构判据还原成「枚举式」（去编号后非空且不在停用表就算信息性，不看是否带编号/长度/子串）
        # → 6 个相同辅助词重新参与 → 打穿 Jaccard/LCS → 误判同书 → 变红。正文两侧持平以隔离目录信号。
        aux = ['封推感言', '三江感言', '更新说明', '读者必看', '新书预告', '分卷感言']
        ta, tb = aux + ['第一章 天才陨落'], aux + ['第一章 星空之下']
        self.assertFalse(douban_list.same_book(_fp_dual(ta, 'https://a/1'),
                                               _fp_dual(tb, 'https://b/1'))[0])

        def _enumerative(chapters):
            out = []
            for c in chapters:
                if not isinstance(c, dict):
                    continue
                t = douban_list._norm_toc_title(c.get('title') or '')
                if t and t not in douban_list._GENERIC_TOC_NORM:
                    out.append(t)
            return out
        with mock.patch.object(douban_list, '_informative_toc_titles', _enumerative):
            a2 = _fp_dual(ta, 'https://a/1')
            b2 = _fp_dual(tb, 'https://b/1')
            self.assertTrue(douban_list.same_book(a2, b2)[0])   # 枚举式 → 辅助词打穿目录 + 正文持平 → 误并 → 变红

    def test_toc_min_match_gate_load_bearing(self):
        # §12 交集下限（CONTENT_TOC_MIN_MATCH=5）承重：两本书各 5 条信息性章名、但只共享 4 条
        # （第 5 条各不同）→ 交集 4 <5 → 目录不可判 → 双信号与门不放行。正文两侧持平以隔离目录信号。
        shared = ['天才陨落', '蝼蚁之路', '血脉觉醒', '初显锋芒']
        ta = [f'第{i+1}章 {t}' for i, t in enumerate(shared + ['风波再起'])]
        tb = [f'第{i+1}章 {t}' for i, t in enumerate(shared + ['星空之下'])]
        a = _fp_dual(ta, 'https://a/1')
        b = _fp_dual(tb, 'https://b/1')
        self.assertEqual(len(set(a['toc']) & set(b['toc'])), 4)     # 交集 4 <5
        self.assertFalse(douban_list.same_book(a, b)[0])            # 不可判 → 不放行
        with mock.patch.object(douban_list, 'CONTENT_TOC_MIN_MATCH', 4):
            self.assertTrue(douban_list.same_book(a, b)[0])         # 交集闸改坏(4) → 目录判同+正文持平 → 误并 → 变红

    def test_toc_name_length_gate_filters_short_names(self):
        # §12 名长闸（CONTENT_TOC_MIN_NAME_CHARS=4）：单/双字章名信息量不足 → 不计入信息性章名
        singles = [{'title': f'第{i}章 {c}'} for i, c in enumerate('甲乙丙丁戊', 1)]
        self.assertEqual(douban_list._informative_toc_titles(singles), [])   # 全 <4 字被剔
        self.assertEqual(douban_list._informative_toc_titles([{'title': '第1章 天'}]), [])
        self.assertEqual(douban_list._informative_toc_titles([{'title': '第1章 天才陨落'}]),
                         ['天才陨落'])

    # ---- §12 N1（第三轮复审）：带编号的辅助条目 + 停用表建表 bug ----
    def test_n1_generic_norm_table_includes_stripped_words(self):
        # 修复建表 bug：番外/序/楔子/引子/正文 曾因被 _TOC_NUM_RE 剥空而丢键，现须在表中生效
        for w in ('番外', '序', '楔子', '引子', '正文'):
            with self.subTest(word=w):
                self.assertIn(douban_list._norm_generic_toc_word(w), douban_list._GENERIC_TOC_NORM)
                self.assertTrue(douban_list._is_auxiliary_toc_name(douban_list._norm_generic_toc_word(w)))

    def test_n1_numbered_auxiliary_entries_excluded(self):
        # 带编号的辅助条目（第1章 求月票…）按**子串**归类为辅助，不计入信息性章名
        numbered_aux = ['第1章 求月票', '第2章 求推荐票', '第3章 求收藏', '第4章 更新说明',
                        '第5章 读者必看', '第6章 感谢支持']
        self.assertEqual(douban_list._informative_toc_titles([{'title': t} for t in numbered_aux]), [])

    def test_n1_repro_a_numbered_aux_plus_one_plot_not_merged(self):
        # 第三轮 N1 反例 A：6 个带编号辅助条目全同 + 各 1 条不同情节章 → 交集信息性章名=0 → 判否
        aux = ['第1章 求月票', '第2章 求推荐票', '第3章 求收藏', '第4章 更新说明',
               '第5章 读者必看', '第6章 感谢支持']
        a = self._fp(aux + ['第7章 天才陨落'], CM_BODY_X, 'https://a/1')
        b = self._fp(aux + ['第7章 星空之下'], CM_BODY_Y, 'https://b/1')
        self.assertLess(len(set(a['toc']) & set(b['toc'])), douban_list.CONTENT_TOC_MIN_MATCH)
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_n1_repro_b_structural_prefixes_not_merged(self):
        # 第三轮 N1 反例 B：第一章 楔子/第二章 序/第三章 引子/第四章 正文/第五章 番外 + 1 情节章 → 判否
        struct = ['第一章 楔子', '第二章 序', '第三章 引子', '第四章 正文', '第五章 番外']
        a = self._fp(struct + ['第六章 天才陨落'], CM_BODY_X, 'https://a/1')
        b = self._fp(struct + ['第六章 星空之下'], CM_BODY_Y, 'https://b/1')
        self.assertFalse(douban_list.same_book(a, b)[0])


class TestBodyGuardsM2(unittest.TestCase):
    """M2：正文兜底去站点模板行 + 阈值提到 0.60 + 去模板后字数下限 3000，防模板/公版开头打穿。"""

    def _fp(self, titles, bodies, base):
        return douban_list.fetch_content_fingerprint(
            _cm_cli({base: _cm_book_bodies(titles, bodies, base)}), base)

    def test_c3_site_template_stripped_not_merged(self):
        # rvauthcv 反例 C3：目录不足 + 两本不同书正文都是同站模板块 → 去模板后正文空 → 判否
        nums = ['第一章', '第二章', '第三章']
        tmpl = [CM_TEMPLATE_LINE] * 3
        a = self._fp(nums, tmpl, 'https://a/1')
        b = self._fp(nums, tmpl, 'https://b/1')
        self.assertLess(a['body_chars'], douban_list.CONTENT_MIN_BODY_CHARS)  # 模板被剥光
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_template_stripped_real_content_kept(self):
        # 模板行(跨章重复)剥掉、每章真实正文保留；配合目录一致 → 双信号成立 → 放行
        with_tmpl_x = [CM_TEMPLATE_LINE + '\n' + body for body in CM_MULTI_X]
        a = self._fp(CM_TITLES_X, with_tmpl_x, 'https://a/1')
        b = self._fp(CM_TITLES_X_ALT, with_tmpl_x, 'https://b/1')
        ok, sim = douban_list.same_book(a, b)
        self.assertTrue(ok)
        self.assertTrue(sim['toc_ok'] and sim['body_ok'])
        self.assertGreaterEqual(a['body_chars'], douban_list.CONTENT_MIN_BODY_CHARS)

    def test_short_body_not_enough_to_decide(self):
        # 去模板后正文不足 3000 字 → 即便相同也判否（拿不准不放行）
        nums = ['第一章', '第二章']
        short = ['第一章真实但很短的正文内容。', '第二章同样很短的一点正文。']
        a = self._fp(nums, short, 'https://a/1')
        b = self._fp(nums, short, 'https://b/1')
        self.assertLess(a['body_chars'], douban_list.CONTENT_MIN_BODY_CHARS)
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_body_threshold_is_load_bearing(self):
        # 目录两侧持平（可判+判同），隔离正文信号：正文阈值/字数闸改坏 → 判定翻转
        a = self._fp(CM_TITLES_X, CM_MULTI_X, 'https://a/1')
        c = self._fp(CM_TITLES_X_ALT, CM_MULTI_Y, 'https://c/1')      # 目录同、正文不同
        self.assertFalse(douban_list.same_book(a, c)[0])             # 正常：正文不同 → 判否
        with mock.patch.object(douban_list, 'CONTENT_BODY_JACCARD', 0.0), \
                mock.patch.object(douban_list, 'CONTENT_MIN_BODY_CHARS', 0):
            self.assertTrue(douban_list.same_book(a, c)[0])          # 正文阈值+字数闸都改坏 → 误并 → 变红
        b = self._fp(CM_TITLES_X_ALT, CM_MULTI_X, 'https://b/1')     # 目录同、正文同
        self.assertTrue(douban_list.same_book(a, b)[0])              # 正常：同书判是
        with mock.patch.object(douban_list, 'CONTENT_MIN_BODY_CHARS', 10 ** 9):
            self.assertFalse(douban_list.same_book(a, b)[0])         # 字数下限不可达 → 正文不可判 → 漏判 → 变红

    def test_body_jaccard_raised_to_060(self):
        self.assertGreaterEqual(douban_list.CONTENT_BODY_JACCARD, 0.60)

    # ---- M2-r（复审第二轮）：逐章变化的模板（嵌章号）归一后跨章去重 ----
    @staticmethod
    def _vary_chapters(tmpl, plots):
        cn = ['一', '二', '三']
        return [(tmpl % cn[i]) + '\n' + plots[i] for i in range(3)]

    def test_m2r_per_chapter_varying_template_stripped(self):
        # 复审 M2-r 反例：两本不同书，每章都带「第N章」逐章变化的站点模板 + 各自正文。
        # 归一章号后模板跨章一致被识别剔除 → 只留各自正文 → 正文不同 → 判否（不再误并）
        nums = ['第一章', '第二章', '第三章']
        a = self._fp(nums, self._vary_chapters(CM_VARYING_TMPL, CM_VARY_PLOT_X), 'https://a/1')
        b = self._fp(nums, self._vary_chapters(CM_VARYING_TMPL, CM_VARY_PLOT_Y), 'https://b/1')
        self.assertGreaterEqual(a['body_chars'], douban_list.CONTENT_MIN_BODY_CHARS)  # 去模板后正文仍够长
        self.assertLess(douban_list._jaccard(a['body'], b['body']), douban_list.CONTENT_BODY_JACCARD)
        self.assertFalse(douban_list.same_book(a, b)[0])

    def test_m2r_normalization_is_load_bearing(self):
        # §12/§14 跨章模糊去重（bigram Jaccard≥_BODY_SIM_BIGRAM）承重，两个方向都验证：
        # (1) 不同书 + 同款逐章模板：正常模板被剥 → 合并正文各异；阈值改到不可达 → 模板残留 → 合并正文虚高。
        ax = self._vary_chapters(CM_VARYING_TMPL, CM_VARY_PLOT_X)
        bx = self._vary_chapters(CM_VARYING_TMPL, CM_VARY_PLOT_Y)
        self.assertLess(douban_list._jaccard(self._fp(CM_TITLES_X, ax, 'https://a/1')['body'],
                                             self._fp(CM_TITLES_X_ALT, bx, 'https://b/1')['body']),
                        douban_list.CONTENT_BODY_JACCARD)                    # 正常：模板被剥 → 正文各异
        with mock.patch.object(douban_list, '_BODY_SIM_BIGRAM', 1.01):
            self.assertGreaterEqual(
                douban_list._jaccard(self._fp(CM_TITLES_X, ax, 'https://a/1')['body'],
                                     self._fp(CM_TITLES_X_ALT, bx, 'https://b/1')['body']),
                douban_list.CONTENT_BODY_JACCARD)                           # 模板未去 → 合并相似度虚高
        # (2) 真同书 + 同款逐章模板：正常去模板后各章互异 → 逐章配对成立 → 放行；阈值改到不可达 →
        #     模板残留占满各章 n-gram → 章间被「互不相同」判据视为雷同 → 逐章配对失败 → 漏判（变红）。
        same = self._vary_chapters(CM_VARYING_TMPL, CM_VARY_PLOT_X)
        self.assertTrue(douban_list.same_book(self._fp(CM_TITLES_X, same, 'https://a/1'),
                                              self._fp(CM_TITLES_X_ALT, same, 'https://b/1'))[0])
        with mock.patch.object(douban_list, '_BODY_SIM_BIGRAM', 1.01):
            self.assertFalse(douban_list.same_book(self._fp(CM_TITLES_X, same, 'https://a/1'),
                                                   self._fp(CM_TITLES_X_ALT, same, 'https://b/1'))[0])

    def test_m2r_varying_template_kept_for_same_book(self):
        # 正例保护：同一本书两站、同款逐章模板 + 目录一致 → 归一去模板后各章真实正文一致 → 双信号成立 → 放行
        chapters = self._vary_chapters(CM_VARYING_TMPL, CM_VARY_PLOT_X)
        a = self._fp(CM_TITLES_X, chapters, 'https://a/1')
        b = self._fp(CM_TITLES_X_ALT, chapters, 'https://b/1')
        self.assertGreaterEqual(a['body_chars'], douban_list.CONTENT_MIN_BODY_CHARS)
        self.assertTrue(douban_list.same_book(a, b)[0])

    # ---- §12 N2（第三轮复审）：模板嵌不可归一变量（手打组甲/乙/丙）→ 模糊去重 ----
    def test_n2_repro_template_variable_stripped_not_merged(self):
        # 第三轮 N2 反例：两本不同书，逐章模板只差一个汉字（手打组甲/乙/丙）+ 各自不同正文。
        # 模糊去重按 bigram 相似识别并剔模板 → 只留各异正文 → body Jaccard 低 → 判否
        nums = ['第一章', '第二章', '第三章']
        ca = [(CM_VAR_TMPL_HAND % h) + '\n' + CM_VARY_PLOT_X[i] for i, h in enumerate('甲乙丙')]
        cb = [(CM_VAR_TMPL_HAND % h) + '\n' + CM_VARY_PLOT_Y[i] for i, h in enumerate('甲乙丙')]
        a = self._fp(nums, ca, 'https://a/1')
        b = self._fp(nums, cb, 'https://b/1')
        self.assertGreaterEqual(a['body_chars'], douban_list.CONTENT_MIN_BODY_CHARS)     # 正文（去模板后）够长
        self.assertLess(douban_list._jaccard(a['body'], b['body']),
                        douban_list.CONTENT_BODY_JACCARD)                                # 模板被剥 → 正文各异
        self.assertFalse(douban_list.same_book(a, b)[0])                                 # 判否

    def test_n2_fuzzy_dedup_is_load_bearing(self):
        # 承重：模糊阈值改到不可达 → 手打组模板不被识别 → 残留 → 两本不同书 body Jaccard 虚高
        nums = ['第一章', '第二章', '第三章']
        ca = [(CM_VAR_TMPL_HAND % h) + '\n' + CM_VARY_PLOT_X[i] for i, h in enumerate('甲乙丙')]
        cb = [(CM_VAR_TMPL_HAND % h) + '\n' + CM_VARY_PLOT_Y[i] for i, h in enumerate('甲乙丙')]
        with mock.patch.object(douban_list, '_BODY_SIM_BIGRAM', 1.01):
            a = self._fp(nums, ca, 'https://a/1')
            b = self._fp(nums, cb, 'https://b/1')
            self.assertGreaterEqual(douban_list._jaccard(a['body'], b['body']),
                                    douban_list.CONTENT_BODY_JACCARD)                    # 模板残留 → 虚高 → 变红

    def test_line_bigrams_and_similarity(self):
        _sim, _bg = douban_list._lines_similar, douban_list._line_bigrams
        self.assertTrue(_sim(_bg('本章内容由手打组甲负责录入校对完成感谢支持'),
                             _bg('本章内容由手打组乙负责录入校对完成感谢支持')))   # 只差一字 → 相似
        self.assertFalse(_sim(_bg('叶凌霄睁开双眼命运的齿轮再度转动起来'),
                              _bg('林牧握紧手中卷刃旧刀杀意在胸中渐浓')))          # 不同正文 → 不相似
        self.assertFalse(_sim(_bg(''), _bg('任意')))                                # 空集不相似

    def test_all_remaining_lines_kept_no_length_selection(self):
        # §13：删掉「每章取最长前 5 段」——去模板后**保留全部剩余正文行**（不再按行长挑选，
        # 免得长模板行顶成主体、丢掉短情节行）。单章无跨章模板 → 长短行全部保留。
        long_seg = '这一段是真正的正文内容相当长足以进入指纹参与比对不会被当作噪声' * 8
        shorts = [f'第{i}段短情节句子内容各不相同甲乙丙丁' for i in range(20)]
        parts = ['\n'.join([long_seg] + shorts)]
        text, participating = douban_list._clean_body_parts(parts)
        kept = text.split('\n')
        self.assertEqual(participating, 1)
        self.assertGreater(len(kept), 5)                 # 远多于旧的 5 段上限
        self.assertIn(long_seg, kept)
        for s in shorts:                                 # 短行不再被按长度丢弃
            self.assertIn(s, kept)

    def test_mid_chapter_template_stripped_regardless_of_position(self):
        # §13 必修：埋在**章内中段**（非前后各 10 行）的共享模板同样要剔——全行参与，不再只取边缘。
        tmpl = '本站温馨提示您本章内容由热心网友采集整理仅供学习交流请于阅读后自觉删除并支持正版'
        pad = ['无关铺垫文句%d各章互不相同用于把模板挤出边缘窗口甲乙丙丁戊' % k for k in range(15)]
        # 模板埋在第 16 行（远离前后各 10 行的边缘窗口）
        chA = [(pad[k] + 'A%d' % k) for k in range(15)] + [tmpl] + ['甲书独有正文情节' * 20]
        chB = [(pad[k] + 'B%d' % k) for k in range(15)] + [tmpl] + ['乙书独有正文情节' * 20]
        parts = ['\n'.join(chA), '\n'.join(chB)]
        text, _ = douban_list._clean_body_parts(parts)
        self.assertNotIn(tmpl, text.split('\n'))         # 中段共享模板被剔除

    def test_required_repro_mid_template_not_merged(self):
        # 第四轮必修反例：两本不同书、同站模板埋在第 11 行起、长模板行本会被「取最长前 5 段」顶成主体。
        # §13 全行去模板后 → body 指纹只剩各自情节 → 正文不可判/不判同 → 判否（幂等红线）。
        shared = ['第12章 拍卖会风波', '第30章 秘境开启', '第45章 宗门大比',
                  '第58章 万兽围城', '第70章 苍穹试炼']
        seg = ('本站内容均由热心网友从互联网公开渠道收集整理而来仅供个人学习交流与试读使用请于'
               '下载后二十四小时内自觉删除若您喜欢本书请支持正版并购买实体书籍谢谢您的配合与理解')

        def mk(prefix, extra):
            titles = shared + [extra]
            bodies = []
            for ci in range(len(titles)):
                head = ['%s首%d段填充文句风雷霜雪云雾山河%d' % (prefix, ci, k) for k in range(10)]
                tail = ['%s尾%d段填充文句剑刀枪棍拳掌%d' % (prefix, ci, k) for k in range(12)]
                tpl = [seg + seg[30:120]]                # 长模板行埋在第 11 行起
                plot = ['%s书%d章独有情节此段专属本书本章与其他毫不相同的真实正文内容甲乙丙' % (prefix, ci) * 3]
                bodies.append('\n'.join(head + tpl + tail + plot))
            return titles, bodies

        ta, ba = mk('甲本', '第99章 青锋归鞘')
        tb, bb = mk('乙本', '第99章 玉殿封神')
        a = self._fp(ta, ba, 'https://a/1')
        b = self._fp(tb, bb, 'https://b/1')
        self.assertFalse(douban_list.same_book(a, b)[0])          # 模板去掉后 → 判否

    def test_body_min_chapters_gate_load_bearing(self):
        # §13 结构兜底：去模板后剩余 <30% 的章不参与；参与章 <_BODY_MIN_CHAPTERS → 正文不可判。
        # 构造两本书：只有 1 章有真实正文、其余章全是共享模板（去模板后为空 → 不参与）→ 参与章=1 → 不放行。
        tmpl = '本站提示本章内容由网友采集仅供学习交流请支持正版并于阅读后自觉删除谢谢配合理解万分'
        real = '这一章是真正独有的长正文内容与其他书其他章都不一样情节独特' * 20
        # 3 章：前 2 章纯模板（跨章重复→去空→不参与），第 3 章真实正文
        pa = ['\n'.join([tmpl]), '\n'.join([tmpl]), '\n'.join([real + '甲'])]
        pb = ['\n'.join([tmpl]), '\n'.join([tmpl]), '\n'.join([real + '乙'])]
        a = self._fp(['第一章', '第二章', '第三章'], pa, 'https://a/1')
        b = self._fp(['第一章', '第二章', '第三章'], pb, 'https://b/1')
        self.assertLess(a['body_chapters'], douban_list._BODY_MIN_CHAPTERS)   # 参与章不足
        self.assertFalse(douban_list.same_book(a, b)[0])                      # 正文不可判 → 不放行
        with mock.patch.object(douban_list, '_BODY_MIN_CHAPTERS', 1), \
                mock.patch.object(douban_list, '_BODY_KEEP_MIN_RATIO', 0.0):
            a2 = self._fp(['第一章', '第二章', '第三章'], pa, 'https://a/1')
            b2 = self._fp(['第一章', '第二章', '第三章'], pb, 'https://b/1')
            # 闸放开后单章即可判：此时 body_chars 仍须够长才可判，这里 real 足够 → 承重可见
            self.assertGreaterEqual(a2['body_chapters'], 1)


class TestBogusDowngradeEndToEnd(unittest.TestCase):
    """M3 端到端：名单解析(污染作者) → search_engine 降级 → _resolve_candidates 建条目 →
    labeler.engine_author_writeback → import_one 判定；断言分类名/出版社名绝不出现在最终作者。"""

    def setUp(self):
        no_wait(self)

    def _resolve(self, list_author, engine_candidates, books):
        def http_get(url):
            return NO_RESULT_HTML if url.startswith('/books/search') else '<html></html>'
        cli = _cm_cli(books, engine_candidates)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            queue = douban_list._resolve_candidates(
                [{'title': '神秘复苏', 'author': list_author, 'douban_url': 'https://d/1'}],
                http_get, origin='测试', engine_cli=cli)
        return queue, buf.getvalue()

    def test_polluted_author_never_reaches_entry_or_final_author(self):
        import import_one
        import labeler
        base_a, base_b = 'https://a.example/1', 'https://b.example/1'
        books = {base_a: _cm_book_bodies(CM_TITLES_X, CM_MULTI_X, base_a),
                 base_b: _cm_book_bodies(CM_TITLES_X_ALT, CM_MULTI_X, base_b)}
        cands = [{'source': 'a.example', 'title': '神秘复苏', 'author': '长安天', 'bookUrl': base_a},
                 {'source': 'b.example', 'title': '神秘复苏', 'author': '長安天', 'bookUrl': base_b}]
        queue, out = self._resolve('悬疑灵异', cands, books)
        self.assertEqual(len(queue), 1)
        entry = queue[0]
        self.assertEqual(entry['list_author_raw'], '悬疑灵异')     # 原串仅存诊断字段
        self.assertNotEqual(entry['author'], '悬疑灵异')
        self.assertTrue(entry['author'])                          # 采信候选作者（长安天/長安天）
        # labeler toc 二次校验拿 entry author（非污染）比对 → 与候选同一人 → 不会误拒
        self.assertTrue(douban_list.author_matches(entry['author'], '长安天'))
        # 回写 + import 判定：最终作者绝不含污染串
        wb = labeler.engine_author_writeback(entry['author'], '长安天', entry['list_title'], '神秘复苏')
        final = wb or entry['author']
        self.assertNotIn('悬疑灵异', final)
        _, val, _ = import_one.normalize_author(final)
        self.assertNotIn('悬疑灵异', val)

    def test_polluted_single_candidate_toc_no_author_stays_review(self):
        import import_one
        import labeler
        base = 'https://a.example/1'
        books = {base: _cm_book(CM_TITLES_X, CM_BODY_X, base)}
        cands = [{'source': 'a.example', 'title': '神秘复苏', 'author': '', 'bookUrl': base}]
        queue, out = self._resolve('悬疑灵异', cands, books)
        self.assertEqual(len(queue), 1)
        entry = queue[0]
        self.assertEqual(entry['author'], '')                     # 候选无作者 → 条目 author 空（不写污染串）
        self.assertEqual(entry['list_author_raw'], '悬疑灵异')
        # toc 无作者时回写：list_author='' + toc_author='' → '' → 不写污染
        wb = labeler.engine_author_writeback(entry['author'], '', entry['list_title'], '神秘复苏')
        self.assertEqual(wb, '')
        status, _, _ = import_one.normalize_author(entry['author'])
        self.assertEqual(status, 'review')                        # 空作者 → review，绝不入库为污染串


if __name__ == '__main__':
    unittest.main(verbosity=2)
