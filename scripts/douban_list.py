#!/usr/bin/env python3
"""豆瓣名单选书：豆瓣网文 tag 页 → book15 搜索 → 打标队列。

背景（2026-09-18 实测）：book15.net 榜单池 232 本已抽干，打标停滞。
豆瓣 8 月热门图书榜（严肃出版书）在 book15 命中率 0/14——book15 是网文站；
对口的豆瓣入口是网文向 tag 页（book.douban.com/tag/网络小说 等），
这些页列出的是知名度高的网文（凡人修仙传、斗破苍穹、绍宋、秦吏…），命中率高。

选书流程：
  豆瓣 tag 页（title + author）→ book15 站内搜索 /books/search.html?kw=
  → 第一条结果做标题语义校验（防 LIKE 模糊匹配返回同人/衍生书）→ 打标队列。

误匹配实测样本（必须校验的依据）：
  《间客》→《天上有间客栈》、《斗破苍穹》→《一切从斗破苍穹开始》、
  《遮天》→《穿越从遮天开始》。校验 = 去卷号/序号后同名，或互为包含。

本模块只做「选书」，抓正文/清洗/打标/断点续传统一走 labeler.py 既有管线。
"""
import re
import sys
import time
import urllib.parse

# ---- 豆瓣侧配置 ----
# 网文向 tag（2026-09-18 实测全部可抓；严肃 tag 如「文学」命中率为 0 故不收）。
# 每页 ~20 本，去重后约 200 本候选，按命中过滤后即打标队列。
DOUBAN_TAGS = (
    '网络小说', '网文', '玄幻小说', '仙侠', '武侠小说', '奇幻小说',
    '科幻小说', '盗墓', '穿越小说', '历史小说', '悬疑小说', '恐怖小说', '言情',
)
DOUBAN_BASE = 'https://book.douban.com'
# 豆瓣对非浏览器 UA 偶尔弹验证码；用与浏览器一致的 UA（phoenix 实测可直连）。
DOUBAN_UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'}

# ---- book15 侧配置 ----
SEARCH_DELAY = 1.5        # 两次站内搜索间隔（对目标站友好，低于 CHAPTER_DELAY 的抓正文压力）
SEARCH_RETRY = 3          # 单次搜索重试（book15 单请求失败率 ~18%）
SEARCH_RETRY_DELAY = 3    # 重试基础间隔（线性退避 3s/6s/9s）

# 标题校验时剥掉的多余成分：卷号/册数/套装后缀。实测豆瓣与 book15 对同一本书
# 的命名常差一个后缀（《盗墓笔记》vs《盗墓笔记7》、《凡人修仙传》vs《凡人修仙传（1-10）》）。
_STRIP_RE = re.compile(
    r'[（(【\[]?\s*(?:第?[0-9一二三四五六七八九十百千]+(?:部|册|卷|季|部)?'
    r'|上|中|下|全本|完结|大结局|套装[0-9一-十]*册?|全\s*[0-9一-十]*\s*册)'
    r'\s*[）)\]】]?\s*$'
)


def _norm_title(title: str) -> str:
    """标题归一化：去空白/书名号/卷号后缀，供语义比对。"""
    t = re.sub(r'[《》\s·、:：\-—_]+', '', (title or '').strip())
    t = _STRIP_RE.sub('', t)
    return t


def title_compatible(douban_title: str, site_title: str) -> bool:
    """豆瓣书名与 book15 搜索结果标题是否指向同一本书。

    判据：归一化后相等，或**一方是另一方的前缀**（短的一方 ≥ 2 字）。
    前缀方向覆盖两类真命中形态：
      豆瓣名是站点名前缀——《盗墓笔记》vs《盗墓笔记7》《盗墓笔记·十年》、
        《斗罗大陆》vs《斗罗大陆IV终极斗罗》（系列卷号挂在真书名后面）；
      站点名是豆瓣名前缀——《盗墓笔记·十年》vs《盗墓笔记》。
    误匹配实测样本（LIKE 模糊搜索，必须拦下）全部是**中部**命中而非前缀：
      《间客》→《天上有间客栈》、《斗破苍穹》→《一切从斗破苍穹开始》、
      《遮天》→《穿越从遮天开始》。
    前缀仍漏「真书名+同人续写」（如《诡秘之主之XX》）——那靠打标时的
    LLM 验证段（site_title_match）作第二层防线，本层不追求全拦。
    """
    d, s = _norm_title(douban_title), _norm_title(site_title)
    if not d or not s:
        return False
    if d == s:
        return True
    # 前缀要求短的一方至少 2 个归一化字符（1 字书名如《雨》做前缀会误中大量标题）
    if len(d) >= 2 and (s.startswith(d) or d.startswith(s)):
        return True
    return False


# ---- 豆瓣 tag 页解析（纯函数，可离线单测）----
def parse_douban_tag_page(html: str) -> list[dict]:
    """豆瓣 tag 页 HTML → [{title, author, douban_url}]。

    结构（2026-09-18 实测）：li.subject-item > div.info >
    h2 > a[title]（书名）+ div.pub（「作者 / 出版社」第一段是作者）。
    坏行（缺 title / 缺 pub）跳过不拖垮整页。
    """
    books: list[dict] = []
    for m in re.finditer(r'<li class="subject-item">([\s\S]*?)</li>', html):
        block = m.group(1)
        t = re.search(r'<h2>\s*<a href="(https://book\.douban\.com/subject/\d+/)"\s+'
                      r'title="([^"]+)"', block)
        if not t:
            continue
        p = re.search(r'<div class="pub">\s*([^<]+?)\s*</div>', block)
        author = ''
        if p:
            # pub 形如「有花在野 / 广东旅游出版社」，取第一段；译者/丛书形态同样取第一段
            author = p.group(1).split('/')[0].strip()
        books.append({'title': t.group(2).strip(),
                      'author': author,
                      'douban_url': t.group(1)})
    return books


# ---- book15 搜索结果解析（纯函数，可离线单测）----
def parse_book15_search(html: str) -> list[tuple[str, str]]:
    """book15 搜索页 HTML → [(details_url, site_title)]（按页面顺序）。

    结果区块 class="list-item-panel"；无结果时区块消失（页面只剩页尾热门榜，
    那些是 .fh 榜单 li，不在本区块内，天然不会混进来）。
    """
    results: list[tuple[str, str]] = []
    for block in re.split(r'class="list-item-panel', html)[1:]:
        m = re.search(r'href="(/books/details\d+\.html)"[^>]*title="([^"]*)"', block)
        if m:
            results.append((m.group(1), m.group(2).strip()))
    return results


# ---- 在线抓取（labeler 侧接线用，单测全部 mock http_get）----
def fetch_douban_books(http_get) -> list[dict]:
    """抓全部 DOUBAN_TAGS 页 → 去重的 [{title, author, douban_url}]。

    单个 tag 拉取失败只告警不中断（下次轮次再试）；按 title 去重。"""
    books, seen = [], set()
    for tag in DOUBAN_TAGS:
        url = f'{DOUBAN_BASE}/tag/{urllib.parse.quote(tag)}'
        try:
            html = http_get(url)
        except Exception as e:
            print(f'  豆瓣tag[{tag}] 拉取失败: {e}', file=sys.stderr)
            continue
        for b in parse_douban_tag_page(html):
            key = _norm_title(b['title'])
            if key and key not in seen:
                seen.add(key)
                books.append(b)
    return books


def _search_book15_once(http_get, title: str) -> list[tuple[str, str]]:
    kw = urllib.parse.quote(title)
    html = http_get(f'/books/search.html?kw={kw}')
    return parse_book15_search(html)


def search_book15(http_get, title: str) -> dict | None:
    """书名 → book15 详情页（带语义校验）。miss / 误匹配 / 全重试失败均返回 None。

    http_get 需接受 book15 站内相对路径（与 labeler 抓正文同一约定，
    便于测试注入与将来换 BASE）。"""
    last_err = None
    for attempt in range(SEARCH_RETRY):
        try:
            results = _search_book15_once(http_get, title)
            for url, site_title in results:
                if title_compatible(title, site_title):
                    return {'url': url, 'title': site_title}
            return None
        except Exception as e:
            last_err = e
            time.sleep(SEARCH_RETRY_DELAY * (attempt + 1))
    print(f'  book15搜索[{title}] {SEARCH_RETRY} 次全失败: {last_err}', file=sys.stderr)
    return None


def build_douban_queue(http_get) -> list[dict]:
    """豆瓣名单 → book15 打标队列 [{url, title, author, category, status, douban_url}]。

    与 labeler.fetch_rank_books() 的产出同构（url 为站内相对路径），
    打标循环零改动直接消费。搜不到 / 误匹配的书记日志跳过，不阻塞队列。
    """
    douban_books = fetch_douban_books(http_get)
    print(f'豆瓣名单共 {len(douban_books)} 本（去重后）')
    queue: list[dict] = []
    miss: list[str] = []
    for b in douban_books:
        hit = search_book15(http_get, b['title'])
        if hit:
            queue.append({'url': hit['url'], 'title': hit['title'],
                          'author': b.get('author', ''),
                          'category': '豆瓣tag', 'status': '',
                          'douban_url': b.get('douban_url', '')})
        else:
            miss.append(b['title'])
        time.sleep(SEARCH_DELAY)
    print(f'book15 命中 {len(queue)} 本，未命中 {len(miss)} 本'
          f'{"（" + "、".join(miss[:10]) + ("…" if len(miss) > 10 else "") + "）" if miss else ""}')
    return queue
