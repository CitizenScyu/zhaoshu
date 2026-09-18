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
    return _resolve_candidates(douban_books, http_get, origin='豆瓣tag')


def _resolve_candidates(candidates: list[dict], http_get, origin: str = '') -> list[dict]:
    """候选名单（[{title, author, ...}]）→ 过 book15 搜索+校验的打标队列。

    各名单源共用：命中记队列（category 记来源标记，默认取候选自带 origin，
    调用方可用 origin 参数覆盖），miss 记日志跳过。"""
    queue: list[dict] = []
    miss: list[str] = []
    for b in candidates:
        hit = search_book15(http_get, b['title'])
        if hit:
            queue.append({'url': hit['url'], 'title': hit['title'],
                          'author': b.get('author', ''),
                          'category': origin or b.get('origin', ''),
                          'status': '',
                          'douban_url': b.get('douban_url', '')})
        else:
            miss.append(b['title'])
        time.sleep(SEARCH_DELAY)
    print(f'book15 命中 {len(queue)} 本，未命中 {len(miss)} 本'
          f'{"（" + "、".join(miss[:10]) + ("…" if len(miss) > 10 else "") + "）" if miss else ""}')
    return queue


# ---- 网文站榜单名单源（2026-09-18 用户指令升级：网文站榜单优先，豆瓣 tag 补充）----
# 可抓性实测（phoenix，2026-09-18）：
# - m.qidian.com/rank/{yuepiao,hotsales}/：移动版 SSR 可直抓（桌面 www.qidian.com
#   是 JS 盾，恒 209B）。?ym= / chanId= 参数被忽略（恒返回当月全站榜），每榜 20 本。
# - m.qidian.com/finish/：完本频道页，SSR 渲染 4 个区块（影视同期/经典必读/
#   大神完本/畅销完本），**经典完本对口 book15 库存**：13 本核心书目实测命中 12。
# - www.zongheng.com/rank/details.html：Nuxt SSR，__NUXT__ 闭包内有月票榜 20 本，
#   但当前在更新书为主（剑来/最强狂兵外命中率低），且闭包解析脆，不接。
QIDIAN_UA = {'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
                           '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'}
QIDIAN_MOBILE = 'https://m.qidian.com'

# 完本频道区块名（按出现顺序切片）。区块后紧跟的小标题（如「火热影视原作」）
# 不是区块名，靠 QIDIAN_FINISH_SUBTITLES 排除。
QIDIAN_FINISH_SECTIONS = ('影视同期', '经典必读', '大神完本', '畅销完本')
QIDIAN_FINISH_SUBTITLES = ('火热影视原作',)
# 区块条目里会出现的分类/导航词（既不是书名也不是作者）
_QD_NOISE = {'玄幻', '仙侠', '都市', '历史', '游戏', '科幻', '悬疑', '奇幻', '武侠',
             '完本', '完结', '连载', '更多', '男生', '女生', '返回', '取消'}


def _text_nodes(html: str, max_len: int = 50) -> list[str]:
    """提取文本节点（标签之间的中文/数字文本），列表页解析共用。"""
    return [m.group(1).strip() for m in re.finditer(r'>([^<>]*[一-龥0-9][^<>]*)<', html)
            if m.group(1).strip() and len(m.group(1)) <= max_len]


def _looks_author(s: str) -> bool:
    return (s not in _QD_NOISE and 1 <= len(s) <= 12
            and not s.endswith('万字') and not s.endswith('月票')
            and not re.fullmatch(r'[\d.]+', s))


def parse_qidian_finish(html: str) -> list[dict]:
    """起点完本频道页 → [{title, author, origin}]。

    页面结构（SSR，2026-09-18 实测）：文本节点流 = 导航词…「区块名」之后跟
    (书名, 作者) 对（影视同期区），或 书名/简介/作者/分类/完本/字数（其余区）。
    解析策略：按区块名切片；区内取「短行对」——当前行不是分类词/副标题/字数行，
    且下一行像作者（短、非分类、非字数、非纯数字）→ 记为 书名/作者。
    简介行比书名长，由 max_len=50 + _looks_author 的长度闸挡在作者位之外；
    单条误配只影响自身，不拖垮整页。跨区块同名书去重。
    """
    texts = _text_nodes(html)
    books: list[dict] = []
    section = ''
    i = 0
    while i < len(texts):
        t = texts[i]
        if t in QIDIAN_FINISH_SECTIONS:
            section = t
            i += 1
            continue
        if section and t not in _QD_NOISE and t not in QIDIAN_FINISH_SUBTITLES \
                and len(t) >= 2 and not t.endswith('万字') and not t.endswith('月票'):
            nxt = texts[i + 1] if i + 1 < len(texts) else ''
            # 形态 A：书名/作者 纯对（影视同期区；书名短行 ≤15，简介通常更长）
            if _looks_author(nxt) and (len(t) <= 15 or nxt in QIDIAN_FINISH_SECTIONS):
                books.append({'title': t, 'author': nxt,
                              'origin': '起点完本频道', 'douban_url': ''})
                i += 2
                continue
            # 形态 B：书名/简介/作者（畅销完本区）——下一行是长简介、下下行像作者
            if i + 2 < len(texts) and len(nxt) > 15 \
                    and _looks_author(texts[i + 2]) and len(t) <= 15:
                books.append({'title': t, 'author': texts[i + 2],
                              'origin': '起点完本频道', 'douban_url': ''})
                i += 3
                continue
        i += 1
    seen, deduped = set(), []
    for b in books:
        k = _norm_title(b['title'])
        if k and k not in seen:
            seen.add(k)
            deduped.append(b)
    return deduped


def parse_qidian_rank(html: str) -> list[dict]:
    """起点移动版榜单页（月票/畅销）→ [{title, author, origin}]。

    条目结构：纯数字序号 → 书名 → (简介) → 作者 → 分类 → (完结/连载) → 字数。
    作者 = 从书名向后扫、第一个分类词/字数行之前的最后一个短行。
    """
    texts = _text_nodes(html)
    books: list[dict] = []
    i = 0
    while i < len(texts) - 1:
        if re.fullmatch(r'\d{1,3}', texts[i]):
            title = texts[i + 1]
            if not title or title in _QD_NOISE or title.endswith('万字'):
                i += 1
                continue
            j = i + 2
            author = ''
            while j < len(texts) and j < i + 8:
                if texts[j] in _QD_NOISE or texts[j].endswith('万字'):
                    break
                if _looks_author(texts[j]):
                    author = texts[j]
                j += 1
            books.append({'title': title, 'author': author,
                          'origin': '起点榜单', 'douban_url': ''})
            i = max(j, i + 2)
            continue
        i += 1
    return books


def fetch_qidian_finish_books(http_get) -> list[dict]:
    """起点完本频道（经典完本为主，book15 命中率实测最高的一档）。"""
    try:
        return parse_qidian_finish(http_get(f'{QIDIAN_MOBILE}/finish/'))
    except Exception as e:
        print(f'  起点[完本频道] 拉取失败: {e}', file=sys.stderr)
        return []


def fetch_qidian_rank_books(http_get) -> list[dict]:
    """起点月票榜+畅销榜（当前在更新书为主，命中偏低，补充量）。"""
    books: list[dict] = []
    for rank in ('yuepiao', 'hotsales'):
        try:
            books.extend(parse_qidian_rank(http_get(f'{QIDIAN_MOBILE}/rank/{rank}/')))
        except Exception as e:
            print(f'  起点[{rank}榜] 拉取失败: {e}', file=sys.stderr)
    return books


def build_webnovel_queue(http_get, include_douban: bool = True) -> list[dict]:
    """网文站名单（主）+ 豆瓣 tag（补充）→ book15 打标队列。

    用户指令（2026-09-18）：网文站榜单是对口 book15 的一手来源，优先；
    豆瓣 tag 名单补充。跨源按归一化书名去重，产出与 fetch_rank_books() 同构，
    每个候选过 search_book15（LIKE 模糊搜索 + title_compatible 校验）。
    """
    candidates: list[dict] = []
    seen: set = set()

    def add_batch(batch: list[dict], origin: str):
        added = 0
        for b in batch:
            k = _norm_title(b.get('title', ''))
            if k and k not in seen:
                seen.add(k)
                b['origin'] = origin
                candidates.append(b)
                added += 1
        print(f'{origin}: 新增 {added} 本（累计 {len(candidates)}）')

    add_batch(fetch_qidian_finish_books(http_get), '起点完本频道')
    add_batch(fetch_qidian_rank_books(http_get), '起点榜单')
    if include_douban:
        add_batch(fetch_douban_books(http_get), '豆瓣网文tag')
    return _resolve_candidates(candidates, http_get)
