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
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

# ---- 豆瓣侧配置 ----
# 网文向 tag（2026-09-18 实测全部可抓；严肃 tag 如「文学」命中率为 0 故不收）。
# 每页 ~20 本，去重后约 200 本候选，按命中过滤后即打标队列。
DOUBAN_TAGS = (
    '网络小说', '网文', '玄幻小说', '仙侠', '武侠小说', '奇幻小说',
    '科幻小说', '盗墓', '穿越小说', '历史小说', '悬疑小说', '恐怖小说', '言情',
)
DOUBAN_BASE = 'https://book.douban.com'
# 豆瓣翻页（2026-09-19 实测：?start=N 生效，三页书目不重复）。
# **默认 1 页**（审查 D.3 独立结论）：3 页贡献候选大头与搜索时间大头、命中最差，
# 把每轮搜索墙钟从 ~6 min 拉到 20–25 min，可能咬门卫窗口。3 页作显式开关：
# .env 里 LABELER_DOUBAN_PAGES=3（或进程环境同名字段）才开。首轮「灌满预备」
# 可临时开一次，不应当每轮默认。
DOUBAN_PAGES = 1
DOUBAN_PAGES_ENV = 'LABELER_DOUBAN_PAGES'
DOUBAN_PAGE_SIZE = 20
DOUBAN_PAGE_DELAY = 1.0   # 翻页间隔：39 个请求连发容易触发豆瓣验证码（对站点友好）
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


# ---- 作者归一化（N02：引擎兜底身份过滤的比对口径）----
# 背景：search_engine(title, author) 的 author 传给 CLI 但候选不过滤，同名异作者时
# B 的正文会绑上 A 的名单身份入 labels.jsonl / 书库（共享数据污染）。本函数把两端
# 作者归一到可比形态，比对语义 = 归一化后**严格相等**（不做包含——「唐家三少」不得
# 匹配「唐家三少之子」）。方向「宁拒不错绑」：误拒可从 labels-rejected.jsonl 复核。
# 真实形态对齐 labels-from-phoenix-20260918.jsonl 抽样（261 非空作者：
# 「乔治&middot;奥威尔」HTML 实体、「贝尔纳.布尔蒂克斯」半角点、其余几乎全为纯中文名）。
_AUTHOR_PUNCT_RE = re.compile(
    "["
    r"\s\u3000"                       # 空白 + 全角空格
    "·、，,。:：;；"                # 分隔类：中点/顿号/中英逗号句号冒号分号
    r"\-—_/\'""“”‘’"                # 连字符/破折号/斜杠/下划线/各类引号
    "《》「」『』（）()【】"          # 括号类
    r"!！?？\.&;\[\]"                # 感叹/问号/小数点/&/分号/方括号（[]须转义）
    "]+")
_AUTHOR_SUFFIX_RE = re.compile(r'(?:等著|编著|校译|校注|合著|著|译|绘|校|主编|编)$')
# 前导国籍/语种括号段：（美）/【日】/[英]/(英) 等；剥后剩余非空才剥
_AUTHOR_LEAD_BRACKET_RE = re.compile(r'^[（(【\[][^）)】\]]{0,6}[）)】\]]')


def _norm_author(s: str) -> str:
    """作者身份比对前的归一化：空白（含全角）/分隔标点/尾部著述后缀/前导国籍段/casefold。

    与 import 线（import_one.normalize_author）的分工：那条线管**入库身份键**，
    宁 review 不冒进；本函数只管**打标前的候选过滤与 toc 校验**，把两端写法差
    桥接掉即可。HTML 实体按「&...; 整体替换为 ·」处理（乔治&middot;奥威尔 →
    乔治·奥威尔），与标点剥离天然衔接；未成对的 & / ; 当普通标点剥。"""
    text = (s or '').casefold()
    text = re.sub(r'&[a-zA-Z]+;', '·', text)      # &middot; 等实体 → 分隔符
    # 前导括号段（（美）/【日】）：必须在标点剥离**之前**剥，否则括号字符先被标点层
    # 吃掉、内容残片（美）就留在名首了。剥后剩余非空才剥（「（佚名）」保留括号内容）。
    m = _AUTHOR_LEAD_BRACKET_RE.match(text)
    if m and text[m.end():]:
        text = text[m.end():]
    text = _AUTHOR_PUNCT_RE.sub('', text)
    # 尾部著述后缀循环剥（「等著」先于「著」匹配，防复合尾巴剥不净）
    while True:
        stripped = _AUTHOR_SUFFIX_RE.sub('', text)
        if stripped == text:
            break
        text = stripped
    return text





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
def _douban_tag_url(tag: str, page: int) -> str:
    """tag 页 URL。第一页保持原样（不带参数，线上行为一字不变），后续页用 ?start=N。"""
    base = f'{DOUBAN_BASE}/tag/{urllib.parse.quote(tag)}'
    return base if page == 0 else f'{base}?start={page * DOUBAN_PAGE_SIZE}'


def resolve_douban_pages(env: dict | None = None) -> int:
    """豆瓣翻页数：显式开关优先（env 字典 → 进程环境），默认 1 页。

    开关值非法/小于 1 时回落默认，绝不因为一个环境变量把整轮拉长或拉挂。
    labeler 的 .env 由 load_env() 读成字典，**不 export 到 os.environ**，
    所以必须支持把 env 字典显式传进来。"""
    raw = ''
    if env and env.get(DOUBAN_PAGES_ENV) is not None:
        raw = str(env.get(DOUBAN_PAGES_ENV)).strip()
    if not raw:
        raw = (os.environ.get(DOUBAN_PAGES_ENV) or '').strip()
    if not raw:
        return DOUBAN_PAGES
    try:
        pages = int(raw)
    except ValueError:
        return DOUBAN_PAGES
    return pages if pages >= 1 else DOUBAN_PAGES


def load_done_titles(path) -> set:
    """labels.jsonl → 已打标书名的归一化集合（搜索前跳过用）。

    审查 D.3 认定「已在 labels.jsonl 的书名不要再搜」是收益最大的一刀：缓存是优化，
    「跳过已完成再搜」是正确性/产品问题——否则扩容后稳态每轮全量空搜。
    title / site_title 都收（LLM 猜名与站点名可能只中一个）。文件不存在/坏行只跳过。"""
    titles: set = set()
    source = Path(path)
    if not source.exists():
        return titles
    try:
        lines = source.read_text(encoding='utf-8').splitlines()
    except OSError:
        return titles
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        for field in ('title', 'site_title'):
            key = _norm_title(rec.get(field) or '')
            if key:
                titles.add(key)
    return titles


def fetch_douban_books(http_get, pages: int | None = None) -> list[dict]:
    """抓全部 DOUBAN_TAGS 页（每 tag `pages` 页，默认 DOUBAN_PAGES）→ 去重。

    单个 tag/页拉取失败只告警不中断（下次轮次再试）；按 title 去重。
    翻页用 ?start=N（2026-09-19 实测三页书目不重复），页间留 DOUBAN_PAGE_DELAY。"""
    pages = DOUBAN_PAGES if pages is None else pages
    books, seen = [], set()
    first = True
    for tag in DOUBAN_TAGS:
        for page in range(pages):
            if not first:
                time.sleep(DOUBAN_PAGE_DELAY)
            first = False
            url = _douban_tag_url(tag, page)
            try:
                html = http_get(url)
            except Exception as e:
                print(f'  豆瓣tag[{tag}] 第{page + 1}页拉取失败: {e}', file=sys.stderr)
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


# ---- 引擎源兜底（T5：book15 miss 才回落引擎源池）----
# 背景（2026-09-18 用户高优先项）：打标名单候选 468 本，book15 只命中 39（8.3%）——
# 供给被 book15 收录面锁死。M2 W1 已放量（enginePoolSize=2：yingsx + jhsssd）。
# 本模块解除「每个候选必须过 search_book15」的硬约束：book15 仍首选（命中质量最高），
# miss 才回落引擎源池（调 scripts/engine-fetch.mjs CLI，同款 title_compatible 校验）。
# 开关 LABELER_ENGINE_FALLBACK=1 默认关；关闭时 _resolve_candidates 行为逐字不变（红线）。
ENGINE_FALLBACK_ENV = 'LABELER_ENGINE_FALLBACK'
ENGINE_CLI_TIMEOUT = 60         # 单次 CLI 调用墙钟上限（CLI 内部各子命令另有更紧的界）


class EngineUnavailable(Exception):
    """引擎 CLI 环境错误（退出码 2 / 无法调用 / 未知非零）。

    语义：本轮禁用引擎兜底、降级 book15-only、不重试（不连坐后续候选）。
    异常消息只带脱敏后的 returncode + 截断 stderr 摘要，绝不含连接串。"""


def engine_fallback_enabled(env: dict | None = None) -> bool:
    """引擎兜底是否开启：env 字典 → 进程环境，取值恰为 '1' 才开（默认关，红线）。"""
    raw = ''
    if env and env.get(ENGINE_FALLBACK_ENV) is not None:
        raw = str(env.get(ENGINE_FALLBACK_ENV)).strip()
    if not raw:
        raw = (os.environ.get(ENGINE_FALLBACK_ENV) or '').strip()
    return raw == '1'


def _short_stderr(stderr: str | None, limit: int = 200) -> str:
    """CLI stderr 摘要：单行化 + 截断。CLI 侧已有 safeReason 脱敏，这里再兜一层长度。

    凭据红线：即便如此也不把 stderr 原样长篇透传日志——只留可读的错误类别摘要。"""
    text = ' '.join((stderr or '').split())
    return text[:limit]


class EngineCli:
    """封装 engine-fetch.mjs 子进程调用（labeler 在 phoenix 上 shell out）。

    组装形态（任务书 §C）：
      node --import <file://.../ts-alias-hook.mjs> <.../engine-fetch.mjs> <sub> … --json
    Windows 裸驱动器路径给 --import 会 ERR_UNSUPPORTED_ESM_URL_SCHEME，故 hook 统一转
    file:// URI（Linux/phoenix 亦合法）。

    凭据红线：DATABASE_URL 只经**子进程 env** 注入（db.ts 模块初始化读它），
    绝不进命令行参数、日志或异常消息；stdout/stderr 只在调用方按需截断摘要。"""

    def __init__(self, node: str, script_path: str, database_url: str,
                 hook_path: str | None = None, timeout: int = ENGINE_CLI_TIMEOUT):
        self.node = node or 'node'
        self.script_path = script_path
        # hook 默认取 engine-fetch.mjs 同目录的 ts-alias-hook.mjs
        self.hook_path = hook_path or str(Path(script_path).parent / 'ts-alias-hook.mjs')
        self._database_url = database_url
        self.timeout = timeout

    def _import_target(self) -> str:
        """--import 目标转 file:// URI（跨平台安全）。"""
        return Path(self.hook_path).resolve().as_uri()

    def run(self, subcommand: str, *args: str):
        """调 CLI 子命令（自动补 --json）。返回 CompletedProcess（returncode/stdout/stderr）。

        DATABASE_URL 从当前 env 复制的副本里注入子进程，不落任何参数或日志。"""
        cmd = [self.node, '--import', self._import_target(), self.script_path,
               subcommand, *args, '--json']
        child_env = dict(os.environ)
        if self._database_url:
            child_env['DATABASE_URL'] = self._database_url
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=self.timeout, env=child_env)


def search_engine(cli, title: str, author: str = '') -> dict | None:
    """book15 miss 后的引擎兜底搜索：调 CLI `search --title …`，同款 title_compatible 校验。

    返回命中 {'url': bookUrl（绝对）, 'title': site_title, 'source': host} 或 None（miss）。
    退出码：0=有候选（逐条按 title_compatible 校验，跳过 book15.net 源）；1=正常 miss；
    2/未知非零/无法调用 → 抛 EngineUnavailable（调用方本轮降级 book15-only、不重试）。"""
    args = ['--title', title]
    if author:
        args += ['--author', author]
    try:
        proc = cli.run('search', *args)
    except subprocess.TimeoutExpired:
        raise EngineUnavailable(f'引擎搜索超时（{ENGINE_CLI_TIMEOUT}s）')
    except OSError as e:
        # node/脚本不可执行等：环境错误，禁用兜底
        raise EngineUnavailable(f'引擎 CLI 无法调用: {type(e).__name__}')
    if proc.returncode == 2:
        raise EngineUnavailable(f'引擎源池不可用（rc=2）: {_short_stderr(proc.stderr)}')
    if proc.returncode == 1:
        return None
    if proc.returncode != 0:
        raise EngineUnavailable(f'引擎 CLI 异常退出（rc={proc.returncode}）: '
                                f'{_short_stderr(proc.stderr)}')
    try:
        candidates = json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(candidates, list):
        return None
    for c in candidates:
        if not isinstance(c, dict):
            continue
        if c.get('source') == 'book15.net':
            continue          # book15 路径已搜过（这是兜底），跳过
        site_title = c.get('title') or ''
        book_url = c.get('bookUrl') or ''
        if book_url and title_compatible(title, site_title):
            return {'url': book_url, 'title': site_title,
                    'source': c.get('source', '')}
    return None


def build_douban_queue(http_get, skip_titles: set | None = None,
                       pages: int | None = None, engine_cli=None) -> list[dict]:
    """豆瓣名单 → book15 打标队列 [{url, title, author, category, status, douban_url}]。

    与 labeler.fetch_rank_books() 的产出同构（url 为站内相对路径），
    打标循环零改动直接消费。搜不到 / 误匹配的书记日志跳过，不阻塞队列。
    skip_titles（归一化书名集合）= 已打标书名，搜索前直接跳过（审查 D.3）。"""
    douban_books = fetch_douban_books(http_get, pages=pages)
    print(f'豆瓣名单共 {len(douban_books)} 本（去重后）')
    return _resolve_candidates(douban_books, http_get, origin='豆瓣tag',
                               skip_titles=skip_titles, engine_cli=engine_cli)


def _resolve_candidates(candidates: list[dict], http_get, origin: str = '',
                        skip_titles: set | None = None, engine_cli=None) -> list[dict]:
    """候选名单（[{title, author, ...}]）→ 过 book15 搜索+校验的打标队列。

    各名单源共用：命中记队列（category 记来源标记，默认取候选自带 origin，
    调用方可用 origin 参数覆盖），miss 记日志跳过。
    skip_titles 命中（书名归一化后已在 labels.jsonl）→ **不发搜索**直接跳过：
    缓存是优化，「跳过已完成再搜」是正确性/产品问题（审查 D.3）。

    engine_cli（T5）：非空且 LABELER_ENGINE_FALLBACK 开启时，book15 miss 才回落引擎源池。
    engine_cli=None（开关关闭）时本函数行为**逐字不变**（红线）——不调 CLI、条目无 engine 标记。
    引擎命中的条目带 {'engine': True, 'source_host': host, url=bookUrl（绝对）}；
    退出码 2（环境错误）→ 本轮禁用引擎、降级 book15-only、不重试（不连坐后续候选）。"""
    queue: list[dict] = []
    miss: list[str] = []
    skipped = 0
    book15_hits = 0
    engine_hits = 0
    engine_disabled = False
    for b in candidates:
        key = _norm_title(b.get('title', ''))
        if skip_titles and key and key in skip_titles:
            skipped += 1
            continue
        hit = search_book15(http_get, b['title'])
        if hit:
            queue.append({'url': hit['url'], 'title': hit['title'],
                          'author': b.get('author', ''),
                          'category': origin or b.get('origin', ''),
                          'status': '',
                          'douban_url': b.get('douban_url', '')})
            book15_hits += 1
            time.sleep(SEARCH_DELAY)
            continue
        # book15 miss：开关开启且引擎未被禁用时回落引擎源池
        engine_hit = None
        if engine_cli is not None and not engine_disabled:
            try:
                engine_hit = search_engine(engine_cli, b['title'], b.get('author', ''))
            except EngineUnavailable as e:
                # 环境错误：本轮降级 book15-only，后续候选不再尝试引擎（不连坐重试）
                print(f'  引擎兜底不可用，本轮降级 book15-only（不重试）: {e}',
                      file=sys.stderr)
                engine_disabled = True
        if engine_hit:
            queue.append({'url': engine_hit['url'], 'title': engine_hit['title'],
                          'author': b.get('author', ''),
                          'category': origin or b.get('origin', ''),
                          'status': '',
                          'douban_url': b.get('douban_url', ''),
                          'engine': True,
                          'source_host': engine_hit['source']})
            engine_hits += 1
        else:
            miss.append(b['title'])
        time.sleep(SEARCH_DELAY)
    # 开关关闭时 engine_hits=0 且 book15_hits==len(queue)，本行逐字复现旧文案（红线）。
    engine_note = f'，引擎兜底命中 {engine_hits} 本' if engine_cli is not None else ''
    print(f'book15 命中 {book15_hits} 本，未命中 {len(miss)} 本，'
          f'跳过已打标 {skipped} 本{engine_note}'
          f'{"（" + "、".join(miss[:10]) + ("…" if len(miss) > 10 else "") + "）" if miss else ""}')
    return queue


# ---- 网文站榜单名单源（2026-09-18 用户指令升级：网文站榜单优先，豆瓣 tag 补充）----
# 可抓性实测（phoenix，2026-09-18）：
# - m.qidian.com/rank/{yuepiao,hotsales}/：移动版 SSR 可直抓（桌面 www.qidian.com
#   是 JS 盾，恒 209B）。?ym= / chanId= 参数被忽略（恒返回当月全站榜），每榜 20 本。
# - m.qidian.com/finish/：完本频道页，SSR 渲染 4 个区块（影视同期/经典必读/
#   大神完本/畅销完本），**经典完本对口 book15 库存**：13 本核心书目实测命中 12。
QIDIAN_UA = {'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
                           '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'}
QIDIAN_MOBILE = 'https://m.qidian.com'
# 6 个榜单 slug（2026-09-19 实测：rec/update/sign/newbook 与 yuepiao/hotsales
# 同构 SSR，解析函数零改动，改常量即每轮 +80 本）。
# update/sign/newbook 是在更新书（2026-09-19 口径修正：未完结连载名作同样算目标）。
QIDIAN_RANKS = ('yuepiao', 'hotsales', 'rec', 'update', 'sign', 'newbook')

# 完本频道区块名（按出现顺序切片）。区块后紧跟的小标题（如「火热影视原作」）
# 不是区块名，靠 QIDIAN_FINISH_SUBTITLES 排除。
QIDIAN_FINISH_SECTIONS = ('影视同期', '经典必读', '大神完本', '畅销完本')
QIDIAN_FINISH_SUBTITLES = ('火热影视原作',)
# 页脚导航词：出现即清空 section（真实页面最后一个区块（畅销完本）后直接接页脚，
# 没有下一个区块名来切片，页脚词会被当条目收进名单——2026-09-18 phoenix 实跑抓到）。
QIDIAN_FINISH_STOP = ('首页', '完本小说', '登录后获得更多特色功能', '立即登录',
                      'QQ阅读', '红袖添香', '腾讯动漫', '客户端', '触屏版',
                      '帮助与客服', '安装起点读书客户端', '看更多正版好书', '下载')
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
        if any(t == w or t.startswith(w) for w in QIDIAN_FINISH_STOP):
            section = ''      # 页脚：后面不再有条目
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
    """起点 6 榜（月票/畅销/推荐/更新/签约/新书，各 20 本）。"""
    books: list[dict] = []
    for rank in QIDIAN_RANKS:
        try:
            books.extend(parse_qidian_rank(http_get(f'{QIDIAN_MOBILE}/rank/{rank}/')))
        except Exception as e:
            print(f'  起点[{rank}榜] 拉取失败: {e}', file=sys.stderr)
    return books


# ---- 纵横（m.zongheng.com/complete，2026-09-19 调研接入）----
# 入口翻案说明：此前判「不接」的两条理由（榜单以在更新书为主 + __NUXT__ 闭包脆）
# 都被 m 站完本专区绕开——它是**完本页**（不是榜单），书目直接 SSR 在 HTML 里
# （不碰闭包）。实测 42 条完本（去重 41），含雪中悍刀行/剑来/最强狂兵，
# book15 抽样命中 17/41 ≈ 41%。桌面榜单/移动榜单/API 均不接（空壳/WAF）。
ZHENG_MOBILE = 'https://m.zongheng.com'
_ZH_TITLE_RE = re.compile(r'class="book-title">([^<]+)</a>')
# 两种形态：人气完本/最新完本 = <a class="book-author">作者</a>；
# 更多完本 = <span class="book-author"><aria>作者：</aria>作者 · 856.8万</span>
_ZH_AUTHOR_RE = re.compile(
    r'class="book-author">[\s\S]{0,60}?(?:</aria>)?([^<·\n]+?)\s*(?:</a>|·)')


def parse_zongheng_complete(html: str) -> list[dict]:
    """纵横移动版完本专区 → [{title, author, origin}]。

    逐条以 class="book-title" 锚点定位，作者只在**本条锚点与下一条锚点之间**找
    （找不到再回头找上一条锚点之后的空档），避免把邻条作者串到本条；
    两种页面形态共用一条作者正则。跨条按归一化书名去重。"""
    entries = [(m.start(), m.end(), m.group(1).strip())
               for m in _ZH_TITLE_RE.finditer(html)]
    books, seen = [], set()
    for i, (start, end, title) in enumerate(entries):
        if not title or len(title) > 40:
            continue
        nxt = entries[i + 1][0] if i + 1 < len(entries) else len(html)
        prev = entries[i - 1][1] if i > 0 else 0
        m = _ZH_AUTHOR_RE.search(html[end:nxt]) or _ZH_AUTHOR_RE.search(html[prev:start])
        author = m.group(1).strip() if m else ''
        key = _norm_title(title)
        if key and key not in seen:
            seen.add(key)
            books.append({'title': title, 'author': author,
                          'origin': '纵横完本', 'douban_url': ''})
    return books


def fetch_zongheng_complete_books(http_get) -> list[dict]:
    """纵横移动版完本专区（纯 SSR 完本页，book15 命中率实测 41%）。"""
    try:
        return parse_zongheng_complete(http_get(f'{ZHENG_MOBILE}/complete'))
    except Exception as e:
        print(f'  纵横[完本专区] 拉取失败: {e}', file=sys.stderr)
        return []


# ---- 17K 小说网（www.17k.com/quanben/，2026-09-19 调研接入）----
# 完本页纯 SSR（无 JS 盾），实测 159 本去重（约 111 条标题干净），
# 含巫颂/罪恶之城/超级兵王等经典，book15 抽样命中 8/25 ≈ 32%。
# 各榜 Top100 详情页被 Aliyun WAF 挡，**不接**；/quanben/ 与 /top/ 不受影响。
Y17K_BASE = 'https://www.17k.com'
# 页面有两种锚点形态（2026-09-19 审查 C.1/F.2 实测）：
#   纯文本：href=//www.17k.com/book/N.html ...>书名</a>
#   带图：  href=//www.17k.com/book/N.html ...><img .../><span>书名</span></a>（8 个 id）
# 原正则 `>([^<]*)</a>` 吃不到第二种（`[^>]*>` 后紧跟 `<img`）→ 漏收 8 本真书。
# 改为捕获锚点内部 HTML，再剥标签：两种形态都取到纯书名。
_Y17K_BOOK_RE = re.compile(
    r'href="//www\.17k\.com/book/(\d+)\.html"[^>]*>(.*?)</a>', re.S)
_Y17K_TAG_RE = re.compile(r'<[^>]*>')
# 页面有 48 条被截断的标题（结尾 ...），按前缀搜 book15 命中率低且易误配 → 丢弃
_17K_TRUNCATED_RE = re.compile(r'(?:\.{2,}|…+|。{2,})\s*$')
# 推广前缀：「骁骑校大作：匹夫的逆袭！」「失落叶月恒系列力作：天行」→ 取冒号后的真书名
_17K_PROMO_RE = re.compile(r'^[^：:]{0,12}?(?:大作|力作|作品)[：:]\s*')
_17K_NOISE = {'完本小说', '排行榜', '首页', '更多', '全部', '免费阅读'}


def _clean_17k_title(title: str) -> str:
    """17K 完本页标题清洗：去推广前缀 / 丢弃截断标题与简介句 / 去多余空白。

    实测（y17k_quanben.html）：159 本书名全 ≤20 字，而同页的**简介锚点**是整句
    （「修行即时掠夺，强者方能侠义，他于绝境中得绝世战仙之衣钵，从此逆天崛起。」）。
    `parse_17k_quanben` 已按 book id 取首个锚点把简介挡在外面；这里再用
    「含句中标点或超长即判简介」作第二道防线（宁缺勿滥，宁可少收也不放脏书名进搜索）。"""
    text = re.sub(r'\s+', ' ', (title or '').replace('&nbsp;', ' ')).strip()
    text = _17K_PROMO_RE.sub('', text)
    if _17K_TRUNCATED_RE.search(text):
        return ''
    text = text.strip()
    if not 2 <= len(text) <= 25 or text in _17K_NOISE or '，' in text or '。' in text:
        return ''
    return text


def parse_17k_quanben(html: str) -> list[dict]:
    """17K 完本页 → [{title, author, origin}]（页面无作者，author 空）。

    同一本书在页面上有多个锚点（实测）：
    - **纯文本**锚点：`<a href=…>书名</a>`（权威书名，页面后段）；
    - **推广**锚点：`<a href=…><img …/><span>XX：书名</span></a>`（封面/推荐位）；
    - **简介**锚点：`<a href=…>整句简介</a>`。

    取法：按 book id 分组，**优先纯文本锚点**（旧行为，推广/简介锚点被天然跳过）；
    该 id 没有任何纯文本锚点时，才回退用带标签锚点剥标签后的文本——覆盖审查 C.1 指出的
    「8 个 id 书名只在 `<span>` 里」的漏收（例：`挣大钱斗极品：重生好媳妇`）。
    再按归一化书名跨 id 去重。宁缺勿滥：简介句仍被 _clean_17k_title 的标点/长度闸挡掉。"""
    order: list[str] = []
    plain: dict[str, str] = {}
    wrapped: dict[str, str] = {}
    for m in _Y17K_BOOK_RE.finditer(html):
        bid, inner = m.group(1), m.group(2)
        if bid not in order:
            order.append(bid)
        if '<' in inner:
            if bid not in wrapped:
                title = _clean_17k_title(_Y17K_TAG_RE.sub('', inner))
                if title:
                    wrapped[bid] = title
        elif bid not in plain:
            title = _clean_17k_title(inner)
            if title:
                plain[bid] = title
    books, seen = [], set()
    for bid in order:
        title = plain.get(bid) or wrapped.get(bid) or ''
        key = _norm_title(title)
        if not title or not key or key in seen:
            continue
        seen.add(key)
        books.append({'title': title, 'author': '',
                      'origin': '17K完本', 'douban_url': ''})
    return books


def fetch_17k_quanben_books(http_get) -> list[dict]:
    """17K 完本小说页（纯 SSR，book15 命中率实测 32%）。"""
    try:
        return parse_17k_quanben(http_get(f'{Y17K_BASE}/quanben/'))
    except Exception as e:
        print(f'  17K[完本页] 拉取失败: {e}', file=sys.stderr)
        return []


def build_webnovel_queue(http_get, include_douban: bool = True,
                         skip_titles: set | None = None,
                         pages: int | None = None, engine_cli=None) -> list[dict]:
    """网文站名单（主）+ 豆瓣 tag（补充）→ book15 打标队列。

    用户指令（2026-09-18）：网文站榜单是对口 book15 的一手来源，优先；
    豆瓣 tag 名单补充。2026-09-19 扩容：纵横完本 + 17K 完本 + 起点榜单 2→6；
    豆瓣翻页默认 1 页、3 页走 LABELER_DOUBAN_PAGES 开关（审查 D.3）。
    跨源按归一化书名去重（断点续传另按 url 去重，扩名单不会重标已完成的）；
    skip_titles = 已打标书名，搜索前跳过（收益最大的一刀）。
    产出与 fetch_rank_books() 同构，每个候选过 search_book15（LIKE + title_compatible）。
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

    # 顺序 = 预期命中率（完本经典 > 在更新书 > 豆瓣补充）；任何源失败只告警。
    add_batch(fetch_qidian_finish_books(http_get), '起点完本频道')
    add_batch(fetch_zongheng_complete_books(http_get), '纵横完本')
    add_batch(fetch_17k_quanben_books(http_get), '17K完本')
    add_batch(fetch_qidian_rank_books(http_get), '起点榜单')
    if include_douban:
        add_batch(fetch_douban_books(http_get, pages=pages), '豆瓣网文tag')
    return _resolve_candidates(candidates, http_get, skip_titles=skip_titles,
                               engine_cli=engine_cli)
