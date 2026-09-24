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
               ('[英] 詹姆斯·马修·巴利', '（英）巴利著；靳锦译'),
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
        ('三毛', '三毛流浪记'),
        ('马丁', '马丁新'),
        ('金庸', '金庸新 著'), ('金庸', '金庸新；某某'),   # 分段后仍是整段相等
        ('美', '[美] 某某'),                    # 切出来的「美」不得撞单字笔名
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
                            ('彼得·潘', '[英] 詹姆斯·马修·巴利', '（英）巴利著；靳锦译')):
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
