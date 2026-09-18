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
import urllib.parse
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import douban_list  # noqa: E402


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
        books = douban_list.fetch_douban_books(http_get)
        self.assertEqual(len(books), len(douban_list.DOUBAN_TAGS) * 3 * 3)
        first_tag_quoted = urllib.parse.quote(douban_list.DOUBAN_TAGS[0])
        tag_urls = [u for u in self.urls if first_tag_quoted in u]
        self.assertTrue(tag_urls[0].endswith('/tag/' + first_tag_quoted))  # 第一页不带参数
        self.assertTrue(tag_urls[1].endswith('?start=20'))
        self.assertTrue(tag_urls[2].endswith('?start=40'))

    def test_pages_are_deduplicated_within_a_tag(self):
        same = douban_page_html(['重复书', '独有书'], 0)
        pages = {douban_list._douban_tag_url('网络小说', p): same for p in range(3)}
        books = douban_list.fetch_douban_books(self._recording_get(pages))
        self.assertEqual([b['title'] for b in books], ['重复书', '独有书'])

    def test_single_page_failure_does_not_drop_the_others(self):
        def http_get(url):
            if url.endswith('?start=20'):
                raise ConnectionError('豆瓣第二页超时')
            return douban_page_html(['甲书', '乙书'], 0)

        books = douban_list.fetch_douban_books(http_get)
        self.assertEqual(len(books), 2)          # 失败页被跳过，其余页照常

    def test_pages_per_tag_is_configurable(self):
        self.assertEqual(douban_list.DOUBAN_PAGES, 3)
        with mock.patch.object(douban_list, 'DOUBAN_PAGES', 1):
            urls = []
            douban_list.fetch_douban_books(
                lambda url: urls.append(url) or douban_page_html([], 0))
            self.assertEqual(len(urls), len(douban_list.DOUBAN_TAGS))
            self.assertTrue(all('?start=' not in u for u in urls))


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
