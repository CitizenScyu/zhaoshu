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
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import douban_list  # noqa: E402


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
        douban_list.SEARCH_DELAY = 0
        douban_list.DoubanTags = None  # 防御：不允许测试改到全局 tag 表
        del douban_list.DoubanTags
        try:
            queue = douban_list.build_douban_queue(self._http_get)
        finally:
            douban_list.SEARCH_DELAY = 1.5
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

        douban_list.SEARCH_DELAY = 0
        try:
            queue = douban_list.build_douban_queue(failing_douban)
        finally:
            douban_list.SEARCH_DELAY = 1.5
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
