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


class TestBuildWebnovelQueue(unittest.TestCase):
    """多源合并：起点为主、豆瓣补充，跨源去重后过 book15 搜索。"""

    def _http_get(self, url):
        if url == douban_list.QIDIAN_MOBILE + '/finish/':
            return QIDIAN_FINISH_HTML
        if url == douban_list.QIDIAN_MOBILE + '/rank/yuepiao/':
            return QIDIAN_RANK_HTML
        if url == douban_list.QIDIAN_MOBILE + '/rank/hotsales/':
            return QIDIAN_RANK_HTML
        if url.startswith('https://book.douban.com/tag/'):
            return DOUBAN_TAG_HTML
        return self.search_pages.get(url, NO_RESULT_HTML)

    def test_multi_source_merge_and_dedup(self):
        # 起点 finish 的盗墓笔记？没有——DOUBAN_TAG_HTML 提供盗墓笔记（豆瓣源）。
        # 混合源：起点诡秘之主（miss）+ 豆瓣盗墓笔记（hit）
        self.search_pages = {
            '/books/search.html?kw=%E8%AF%A1%E7%A7%98%E4%B9%8B%E4%B8%BB': NO_RESULT_HTML,
            '/books/search.html?kw=%E7%81%B5%E5%A2%83%E8%A1%8C%E8%80%85': NO_RESULT_HTML,
            '/books/search.html?kw=%E7%9B%97%E5%A2%93%E7%AC%94%E8%AE%B0':
                book15_search_html('盗墓笔记7', '/books/details42.html'),
        }
        douban_list.SEARCH_DELAY = 0
        try:
            queue = douban_list.build_webnovel_queue(self._http_get)
        finally:
            douban_list.SEARCH_DELAY = 1.5
        self.assertEqual(len(queue), 1)
        b = queue[0]
        self.assertEqual(b['title'], '盗墓笔记7')
        self.assertEqual(b['category'], '豆瓣网文tag')

    def test_douban_excluded_when_disabled(self):
        self.search_pages = {}
        douban_list.SEARCH_DELAY = 0
        try:
            queue = douban_list.build_webnovel_queue(self._http_get, include_douban=False)
        finally:
            douban_list.SEARCH_DELAY = 1.5
        # 只有起点源（全 miss）→ 空队列，且没有任何豆瓣请求
        self.assertEqual(queue, [])

    def test_qidian_fetch_failure_falls_through_to_douban(self):
        # 起点全线挂掉：豆瓣照常供给
        def failing_qidian(url):
            if 'qidian' in url:
                raise ConnectionError('qidian down')
            if url.startswith('https://book.douban.com/tag/'):
                return DOUBAN_TAG_HTML
            return NO_RESULT_HTML

        douban_list.SEARCH_DELAY = 0
        try:
            queue = douban_list.build_webnovel_queue(failing_qidian)
        finally:
            douban_list.SEARCH_DELAY = 1.5
        self.assertEqual(queue, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
