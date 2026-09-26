#!/usr/bin/env python3
"""书径 V2 批量打标器（部署在 phoenix 上跑）。

流程：榜单取书目 → 逐本抓前 40 万字 → 流式调 LLM 打标 → 标签写 Neon。
设计：串行 + 间隔控频；断点续传（已标过的跳过）；抓取/打标/入库分层，
将来主应用可直接复用 label_book / fetch_book_text。

用法:
  python3 labeler.py --limit 100            # 给前 100 本书打标
  python3 labeler.py --dry-run              # 只列书目不打标
  python3 labeler.py --book /books/details3168.html   # 指定单本
  python3 labeler.py --no-db-model          # 不读库，强制用 .env 的模型链
  python3 labeler.py --source douban        # 豆瓣网文 tag 名单选书（默认 rank=book15 榜单，行为不变）
  python3 labeler.py --source webnovel      # 网文站榜单（起点完本/月票/畅销）为主+豆瓣 tag 补充
  python3 labeler.py --categories 23 --max-pages 2    # rank 线叠加分类 t-23 前 2 页（小范围试跑）
  python3 labeler.py --categories all       # rank 线叠加全部分类（小时级扫页，慎用）
分类列表入口（list-t-N）叠加在 --source rank 线上：候选惰性只留 {url,title}，打标时现抓
详情页取元数据/章节/正文（1 次请求）。**默认关闭**（不给 --categories = 只走榜单，行为不变），
需显式 --categories 才开启；残本候选记入 labels-stub.jsonl，下轮跳过（人工删行可恢复）。
配置: /root/zhaoshu-labeler/.env（LLM_API_KEY 必填；DATABASE_URL 与 LLM_MODEL 可选）
      数据目录默认 = 脚本同目录（.env / labels.jsonl / labels-rejected.jsonl）；
      只有显式设置 LABELER_DATA_DIR 时才改指向该目录——给本地 dry-run 用副本数据复现，
模型: 优先读数据库 app_settings.label_model（管理界面里改，改完下次运行生效）；
      命中时该模型作为模型链链首，后接 .env 链；无 DATABASE_URL / 读库失败 / 值为空
      则静默回落到 .env。启动会打印「打标模型来源: database|environment」。
"""
import argparse
import atexit
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import douban_list

# ---- 配置 ----
TARGET_CHARS = 500_000      # 每本抓取字数上限
CHUNK_RETRY = 3             # 单章抓取重试
LLM_INTERVAL_SEC = 30       # 两次 LLM 调用最小间隔（控频）
CHAPTER_DELAY = 0.3         # 抓章节间隔（对目标站友好）
RANKS = (1, 2, 3)           # 榜单页
# 分类列表页 list-t-N（扩源入口，侦察报告 D:/ClaudeCode/projects/zhaoshu/source-scout-report.md §1/§4）。
# 叠加在 rank 线上：两路书目并进同一去重池（merge_books），不动 RANKS 既有行为。
# 🔴 默认关闭：不给 --categories 时 parse_categories(None)=() ⇒ 只走榜单（见 parse_categories）；
# 全量 17 类是小时级扫页且每轮重扫，gatekeeper 上线日须显式定死 --categories/--max-pages。
CATEGORY_PAGES = (3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 21, 22, 23)
CATEGORY_MAX_PAGES = 200    # 每个分类的翻页安全上界；真实尾页从 HTML 解析（不写死 133/93）
CATEGORY_PAGE_DELAY = 1.2   # 分类页翻页间隔（对目标站友好）；17 类全量是小时级
# 站点 GET 重试：侦察实测 list-t-4 有一次 25s 超时后重试成功，说明站点偶发慢响应。
HTTP_RETRY = 1              # 失败后重试次数（总尝试 = 1 + HTTP_RETRY）；0 = 只试 1 次
HTTP_RETRY_DELAY = 2.0      # 重试间隔（秒）
# 残本/空壳页下限（侦察报告 §5：details7984 只有 32KB，其余动辄 300KB+）。
# 这是**候选过滤**不是内容拒收：命中的书打标前直接跳过，记入 labels-stub.jsonl（不进
# labels-rejected.jsonl、不占钉子户终态名额），下轮据此跳过——避免残本永久占住 --limit 名额
# 让正常书饥饿（P1）。人工删 labels-stub.jsonl 里该行即重新并入候选。
STUB_MIN_CHAPTERS = 10
STUB_MIN_CHARS = 50_000
BASE = 'https://book15.net'
LLM_URL = 'https://api.cloud.us.kg/v1/chat/completions'
UA = {'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu-labeler/1.0)'}
# 钉子户终态（诊断 P1-1）：被拒的书不进 labels.jsonl，断点续传（done_urls）认不出来，
# 于是每轮都被重新抓取 + 重新打标 + 重新拒收——5 本钉子户历史被拒 34~51 次，
# 每轮白烧 ~25 分钟 LLM 调用。这里给「历史被拒 ≥ 此次数」的书一个终态：跳过。
# 恢复方式刻意保持简单：**不做自动恢复**。人工删掉 labels-rejected.jsonl 里该书的行
# 即重新并入候选；也可用 --book 单本模式强制重试（--book 不受本名单约束）。
REJECT_TERMINAL_THRESHOLD = 5
# 打标模型后备链：先 bohe，失败依次换 grok-4.6-hei → deepseek-v4.1-flash-hei → glm-5.3-agent。
# 可用 .env 的 LLM_MODELS=模型1,模型2,... 覆盖；无 LLM_MODELS 时兜底用旧 LLM_MODEL 单值。
MODELS = ['deepseek-v4-flash-bohe', 'grok-4.6-hei', 'deepseek-v4.1-flash-hei', 'glm-5.3-agent']
# 读库取模型名用的白名单：只是防呆（挡住空串/换行/注入了 SQL 的怪值），不是安全边界。
MODEL_NAME_RE = re.compile(r'^[A-Za-z0-9._/-]{1,200}$')
DB_MODEL_TIMEOUT_SEC = 5    # 读配置失败必须快速回落，不能拖住批量任务
# 自动导入连续失败升级阈值（审查 B.2）：本轮 SQL 失败达此次数就在 stdout 打醒目告警。
# 不做进程级 fail-fast（与「失败不阻断打标」一致），但坏配置不能长期静默。
AUTO_IMPORT_FAILURE_ALERT = 5

SYSTEM_PROMPT = (
    "你是网文编目员。阅读给定的小说文本（若干章），输出一个 JSON 对象"
    "（不要 markdown 代码块，不要多余文字），字段："
    "title_guess(书名猜测)、genre(题材)、style(文风,2-4个词)、pace(节奏)、"
    "protagonist(主角类型一句话)、strengths(爽点/看点,2-4条)、"
    "weaknesses(雷点风险,1-3条)、plot_stage(读到的内容进展到什么阶段,一句话)、"
    "worldbuilding(世界观一句话)、tone(基调)、confidence(0-1)、"
    "text_quality(文本质量,取值必须是 正常/疑似乱码/大面积重复/含广告注入 之一。"
    "「含广告注入」只指站点或转载站插进正文的推广、网址水印、导流语"
    "（如「首发--无弹出广告」「百度搜xx阅读最新章节」、整行网址），且在正文中反复出现、打断阅读；"
    "作者感言/求票/请假公告、章节标题里的推广字样（如「求收藏」「APP免费」）、"
    "偶发一两处的残留网址都不算广告注入，这些情况判 正常)、"
    "text_quality_evidence(数组：text_quality 不是 正常 时摘录至多 3 条正文原文片段作证据，"
    "每条不超过 50 字；正常 时给空数组)、"
    "is_beginning(读到的内容是否为全书开头,true 或 false)、"
    "quality(质量分对象: {\"prose\": 文笔0-10, \"worldbuilding\": 设定0-10, "
    "\"pacing\": 节奏0-10, \"enjoyment\": 读感0-10, \"overall\": 综合0-10}, "
    "整数或一位小数)、"
    "site_title_match(布尔值 true/false：判断正文内容是否确实是用户消息「验证段」中"
    "所给站点书名的作品，依据内容特征而非字面字符串，规则见验证段)、"
    "site_title_note(字符串：一句话说明 site_title_match 的判断依据)。"
)


def _build_verification(title: str, author: str) -> str:
    """校验段：告知本次抓取来源站点的书名与作者，令 LLM 输出 site_title_match / site_title_note。

    误杀根因：站点榜单书名常与正文无字面关联（如《茅山捉鬼笔记》正文全是「常青学院」），
    盲猜书名对不上榜单名就把好书丢掉了。这里让 LLM 依据正文内容特征判断是否确为该书。"""
    t = (title or '').strip()
    if not t:
        return (
            "\n\n=== 打标验证段 ===\n"
            "本次未提供可核验的站点书名，不要将 URL 或未知占位符当作作品名。"
            "site_title_match 输出 false，site_title_note 说明缺少站点书名；"
            "其余标签仍按正文给出。"
        )
    a = author or '（未知）'
    return (
        "\n\n=== 打标验证段 ===\n"
        f"本次文本抓取自站点书目《{t}》，作者：{a}。\n"
        f"请判断这份正文内容是否确实是对应《{t}》这部作品。\n"
        "判断依据必须是正文内容特征（主角名、核心设定、情节脉络等），"
        "而不是站点书名或作者名是否字面出现在正文里。"
        "站点书名可能与正文内容毫无字面关联，因此哪怕正文里一次都没提到站点书名，"
        "只要核心人物/设定确实吻合，就应判 true。\n"
        "据此输出两个字段：\n"
        "  site_title_match：true=正文确为该站点书名的作品；"
        "false=正文内容与站点书名对不上（如抓错书、章节拼接错位）。\n"
        "  site_title_note：一句话写出你判 true/false 的核心依据（引用具体主角/设定）。"
    )


def data_dir() -> Path:
    """数据目录（.env / labels.jsonl / labels-rejected.jsonl 的所在目录）。

    默认 = 脚本同目录，服务器行为一字不变；仅当显式设置环境变量 LABELER_DATA_DIR
    时改指向该目录——供本地用副本数据跑 --dry-run 复现线上行为，不碰服务器路径。"""
    override = os.environ.get('LABELER_DATA_DIR')
    return Path(override) if override else Path(__file__).parent


def data_path(name: str) -> Path:
    return data_dir() / name


def load_env():
    env = {}
    env_path = data_path('.env')
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                # 与 import_one.py CLI 的 --env 解析保持一致：剥掉取值两侧的引号。
                # .env 里写 `DATABASE_URL="postgresql://…"` 是常见做法（dotenv 约定），
                # 不剥的话取值会带上引号 → urlsplit 得到 scheme `"postgresql` →
                # 自动导入报「DATABASE_URL 不是 postgres 连接串」而静默失败。
                env[k.strip()] = v.strip().strip('"').strip("'")
    missing = [k for k in ('LLM_API_KEY',) if not env.get(k)]
    if missing:
        sys.exit(f'缺少环境变量: {missing}（应在 {env_path} 里）')
    return env


def _env_models(env: dict) -> list[str]:
    """解析 .env 里的打标模型链：优先 LLM_MODELS 逗号列表覆盖，缺省用 MODELS 常量链。
    旧 LLM_MODEL 仅作兼容：若它指向 MODELS 之外的模型，按单值兜底；否则并入默认链。"""
    if env.get('LLM_MODELS'):
        models = [m.strip() for m in env['LLM_MODELS'].split(',') if m.strip()]
        if models:
            return models
    legacy = (env.get('LLM_MODEL') or '').strip()
    if legacy and legacy not in MODELS:
        # 用户显式指定了默认链之外的模型，按旧的单值行为兜底
        return [legacy]
    return list(MODELS)


def fetch_label_model_from_db(database_url: str) -> str | None:
    """经 Neon 的 HTTP SQL 接口只读一行 app_settings.label_model。

    打标机刻意不装 PG 驱动（见文件末尾说明），所以走 HTTPS；连接串只放在请求头里，
    不打印、不写日志。任何失败都返回 None，由调用方静默回落到 .env。"""
    if not database_url:
        return None
    parsed = urllib.parse.urlsplit(database_url)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
        return None
    body = json.dumps({
        'query': 'SELECT label_model FROM app_settings WHERE id = 1',
        'params': [],
    }).encode('utf-8')
    req = urllib.request.Request(
        f'https://{parsed.hostname}/sql', data=body, method='POST',
        headers={'Content-Type': 'application/json',
                 'Neon-Connection-String': database_url,
                 'Neon-Raw-Text-Output': 'true'})
    with urllib.request.urlopen(req, timeout=DB_MODEL_TIMEOUT_SEC) as res:
        payload = json.loads(res.read().decode('utf-8'))
    rows = payload.get('rows') or []
    value = rows[0].get('label_model') if rows else None
    if isinstance(value, str) and MODEL_NAME_RE.match(value):
        return value
    return None


def resolve_models(env: dict, use_db: bool = True) -> tuple[list[str], str]:
    """(模型链, 来源)。数据库的 label_model 命中时作为链首，后接 .env 链（去重）；
    无 DATABASE_URL / 读库失败 / 值为空或非法，一律静默回落 .env，绝不中断批量任务。"""
    chain = _env_models(env)
    if use_db:
        try:
            db_model = fetch_label_model_from_db(env.get('DATABASE_URL', ''))
        except Exception:
            db_model = None
        if db_model:
            return [db_model] + [m for m in chain if m != db_model], 'database'
    return chain, 'environment'


def http_get(url: str, timeout: int = 30) -> str:
    """站点页面 GET（失败重试 HTTP_RETRY 次）。签名保持 (url, timeout) 不变，
    便于单测继续用 `labeler.http_get = lambda url, timeout=30: ...` 替换传输层。

    注意：章节抓取路径上还有 fetch_book_text 的 CHUNK_RETRY=3 外层重试，
    两处叠加时「持续失败的单章」最坏尝试 3×(1+HTTP_RETRY) 次——只影响失败页，
    正常页面仍是 1 次请求。"""
    last_err = None
    for attempt in range(1 + HTTP_RETRY):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read().decode('utf-8', 'replace')
        except Exception as e:      # noqa: BLE001 —— 网络层异常一律重试，最后一次原样抛出
            last_err = e
            if attempt < HTTP_RETRY:
                print(f'  GET 失败，重试 {attempt + 1}/{HTTP_RETRY}: {url} ({e})',
                      file=sys.stderr)
                time.sleep(HTTP_RETRY_DELAY)
    raise last_err


# ---- 书源适配层：把「基址 + 站点解析」从主流程解耦 ----
# 目前唯一适配器是 book15：它的实现**逐字复用**解耦前的逻辑（章节链接正则、章节页
# 清洗函数、重试/异常语义、日志文案全部原样），所以行为与改前完全相同。
# 【T5 接入点】接第二个源时：构造一个 BookSource（自己的 base / 章节链接正则 /
# 章节页解析函数），注册进 SOURCES；取正文链路（fetch_chapters / fetch_chapter_text /
# fetch_book_text / split_queue）已全部只依赖本抽象，无需再认识具体站点。
@dataclass(frozen=True)
class BookSource:
    """书源适配：base + URL 归一 + 章节列表解析 + 章节正文解析。

    - base：站内相对路径的基址（如 https://book15.net）。
    - chapter_link_re：详情页 html -> [(章节相对路径, 章节标题)] 的匹配正则
      （两个捕获组，顺序为「相对路径, 标题」）。
    - parse_chapter_html：章节页 html -> (正文, 统计)。统计须含 `container` 键
      （closed/fallback/missing）与 `drop_ratio`（closed 时用于过度清洗告警）；
      字段口径与 clean_chapter_text 的统计一致，fetch_chapter_text 的护栏告警依赖它。
    """
    name: str
    base: str
    chapter_link_re: re.Pattern
    parse_chapter_html: Callable[[str], tuple[str, dict]]

    def absolute(self, path: str) -> str:
        """站内相对路径 → 绝对 URL；已是绝对 URL（http 开头）的原样返回。

        兼容解耦前 `path if path.startswith('http') else BASE + path` 的既有语义。"""
        return path if path.startswith('http') else self.base + path

    def chapters_from_html(self, html: str) -> list[tuple[str, str]]:
        return self.chapter_link_re.findall(html)


_BOOK15_CHAPTER_LINK_RE = re.compile(
    r'<dd[^>]*>\s*<a[^>]*href="(/chapter/index\d+-\d+\.html)"[^>]*>([^<]{1,60})</a>')

BOOK15 = BookSource(
    name='book15.net',
    base=BASE,
    chapter_link_re=_BOOK15_CHAPTER_LINK_RE,
    # lambda 延迟绑定：clean_chapter_text 定义在本文件下方，调用时才解析名字。
    parse_chapter_html=lambda html: clean_chapter_text(html),
)

# 已注册的书源（基址不可变，故用 name -> 源 的字典；T5 在此追加第二个源）。
SOURCES: dict[str, BookSource] = {BOOK15.name: BOOK15}


# ---- 抓取层（将来可整体搬进主应用）----
# 详情页 anchor 正则：榜单页与分类列表页的这段 HTML 逐字节一致，两路复用同一条。
_DETAIL_ANCHOR_RE = re.compile(r'href="(/books/details\d+\.html)"[^>]*>([^<]+)</a>')
# 分类页「尾页」锚：<li><a href="/books/list-t-3.html?page=133">尾页</a></li>
# 🔴 尾页页码一律从 HTML 解析，不写死——各类不同（t-3=133 / t-21=93 / t-23=2）且随书目增长。
_LAST_PAGE_RE = re.compile(r'href="[^"]*[?&]page=(\d+)"[^>]*>\s*尾页\s*</a>')
# 详情页 og:novel 元数据（惰性元数据路径用；与解耦前 fetch_rank_books 同款正则，行为不变）。
_DETAIL_META_PATTERNS = (
    ('author', r'og:novel:author"\s+content="([^"]+)"'),
    ('category', r'og:novel:category"\s+content="([^"]+)"'),
    ('status', r'og:novel:status"\s+content="([^"]+)"'),
)


def parse_last_page(html: str) -> int | None:
    """分类列表页 html → 尾页页码；无「尾页」链接（单页 / 结构变化）返回 None。纯函数。"""
    m = _LAST_PAGE_RE.search(html)
    if not m:
        return None
    n = int(m.group(1))
    return n if n >= 1 else None


def parse_book_meta(html: str) -> dict:
    """详情页 html → {author, category, status}（缺字段为空串）。纯函数，可离线单测。"""
    meta = {}
    for field, pat in _DETAIL_META_PATTERNS:
        m = re.search(pat, html)
        meta[field] = m.group(1).strip() if m else ''
    return meta


def fetch_book_meta(detail_url: str) -> dict:
    """单本详情页 url → 元数据 dict（失败返回全空，不抛）。

    惰性元数据：解耦前在**候选阶段**对每本书多抓一次详情页补 author/category/status，
    232 本尚可忍、扩源到数千本时成为主要耗时；改成候选只留 {url, title}，
    轮到打标时再抓——打标本来就要抓详情页，这次抓取顺带取元数据。"""
    try:
        return parse_book_meta(http_get(BOOK15.absolute(detail_url)))
    except Exception:
        return {'author': '', 'category': '', 'status': ''}


def fetch_rank_books() -> list[dict]:
    """榜单页 → [{url, title}]（元数据改为惰性，见 fetch_book_meta / main 打标循环）"""
    books, seen = [], set()
    for rank in RANKS:
        try:
            html = http_get(f'{BOOK15.base}/books/rank{rank}.html')
        except Exception as e:
            print(f'  rank{rank} 拉取失败: {e}', file=sys.stderr)
            continue
        for m in _DETAIL_ANCHOR_RE.finditer(html):
            url, title = m.group(1), m.group(2).strip()
            if url not in seen:
                seen.add(url)
                books.append({'url': url, 'title': title})
    return books


def category_url(cat: int, page: int) -> str:
    """分类列表页 URL：/books/list-t-{cat}.html?page={page}"""
    return f'{BOOK15.base}/books/list-t-{cat}.html?page={page}'


def fetch_category_books(categories=CATEGORY_PAGES, max_pages=CATEGORY_MAX_PAGES,
                         page_delay=CATEGORY_PAGE_DELAY) -> list[dict]:
    """分类列表页 → [{url, title}]（跨类去重，元数据同样惰性）。

    每类先拉 page=1，解析「尾页」页码（不写死），再逐页迭代到 min(尾页, max_pages)。
    每页 35 个 details 链接 = 15 本真网格 + 20 本固定侧栏；侧栏 20 本每页完全相同，
    由 seen 自然去重，无需特判。翻页间隔 page_delay 秒。
    17 类全量 ≈ 1500+ 页是小时级，首轮用 --categories / --max-pages 限范围试跑。"""
    books, seen = [], set()
    for cat in categories:
        try:
            html = http_get(category_url(cat, 1))
        except Exception as e:
            print(f'  分类 t-{cat} 第 1 页拉取失败: {e}', file=sys.stderr)
            continue
        last = parse_last_page(html) or 1
        if last > max_pages:
            print(f'  分类 t-{cat} 尾页 {last} 超过上界 {max_pages}，只取前 {max_pages} 页',
                  file=sys.stderr)
            last = max_pages
        added = 0
        for page in range(1, last + 1):
            if page > 1:
                time.sleep(page_delay)
                try:
                    html = http_get(category_url(cat, page))
                except Exception as e:
                    print(f'  分类 t-{cat} 第 {page} 页拉取失败: {e}', file=sys.stderr)
                    continue
            for m in _DETAIL_ANCHOR_RE.finditer(html):
                url, title = m.group(1), m.group(2).strip()
                if url not in seen:
                    seen.add(url)
                    books.append({'url': url, 'title': title})
                    added += 1
        print(f'  分类 t-{cat}: {last} 页，本类新增 {added} 本')
    return books


# ---- 候选池（纯函数，可离线单测）----
def merge_books(*groups: list[dict]) -> list[dict]:
    """多路书目按 url 去重合并（先出现者优先，保留其 title）。榜单路在前、分类路在后。"""
    merged, seen = [], set()
    for group in groups:
        for b in group:
            url = b.get('url')
            if url and url not in seen:
                seen.add(url)
                merged.append(b)
    return merged


def is_stub_candidate(chapter_count: int, chars: int) -> str | None:
    """残本/空壳页判据：命中返回原因字符串，未命中返回 None。

    章节数 < STUB_MIN_CHAPTERS 或 正文字数 < STUB_MIN_CHARS ⇒ 残本。
    这是**候选过滤**不是内容拒收：调用方跳过 + 记 labels-stub.jsonl（不写 rejected）。"""
    if chapter_count < STUB_MIN_CHAPTERS:
        return f'章节数 {chapter_count} < {STUB_MIN_CHAPTERS}'
    if chars < STUB_MIN_CHARS:
        return f'正文字数 {chars} < {STUB_MIN_CHARS}'
    return None


def parse_categories(spec: str | None) -> tuple[int, ...]:
    """CLI --categories → 分类 ID 元组。

    🔴 默认安全：None（未给参数）= **关闭分类入口**（返回空元组，只走榜单，行为不变）。
    空串 / `none` 同样关闭；`all` 才是全部 CATEGORY_PAGES（显式全量，慎用）。
    逗号列表指定具体分类（如 `3,21,23`）。非法值直接退出，不静默忽略——
    省得以为限了范围其实没限、或以为开了其实没开。"""
    if spec is None:
        return ()
    spec = spec.strip()
    if not spec or spec.lower() == 'none':
        return ()
    if spec.lower() == 'all':
        return tuple(CATEGORY_PAGES)
    out: list[int] = []
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            sys.exit(f'--categories 解析失败: {part!r} 不是整数（或 none/all）')
        if n < 1:
            sys.exit(f'--categories 解析失败: {n} 必须是正整数')
        if n not in out:
            out.append(n)
    return tuple(out)


def fetch_chapters(detail_url: str,
                   source: BookSource | None = None) -> list[tuple[str, str]]:
    """详情页 → [(chapter_url, chapter_title)]（经书源适配器取基址与解析）"""
    src = source or BOOK15
    html = http_get(src.absolute(detail_url))
    return src.chapters_from_html(html)


# ---- 抓取层清洗：站点 UI / 导航 / 推广行（纯函数，可离线单测）----
# 背景（t76 只读排查，证据 D:/ClaudeCode/projects/zhaoshu/.t76-analysis/）：
# 旧实现从 chapter-content-panel 起**固定截 25k** 再抽 <p>，把容器闭合之后的页脚/推荐位，
# 以及容器内的按钮行一起塞进提示词。t76 抽样显示约 18% 行是站点 UI 噪声（按钮行 + 导航行），
# 噪声把模型推向自报 text_quality=含广告注入——470 条拒收里 337 条是这一项；且 45 个书名
# 既被「含广告注入」拒收过、又有入库记录（最多的是《我的老婆是阴阳眼》31 次），
# 说明该判定非确定、被噪声放大。（注：《极品透视》28 次拒收全是「大面积重复」，与广告无关。）
# 本层**只做清洗**：不改 text_quality 判定门（见 main()），不改提示词，不改入库语义。

CONTENT_MARKER = 'chapter-content-panel'  # 站点章节页正文容器标记
CONTAINER_FALLBACK_WINDOW = 25_000        # 容器闭合标签不可用时的兜底窗口（=旧行为）
CONTAINER_MIN_INNER = 100                 # 容器内长度短于此视为定位失败，退回兜底窗口

# 以下三个是「护栏」：正常正文行远长于 UI 行，超限的行一律不进对应规则，宁漏勿误删。
UI_LINE_MAX_LEN = 20        # UI 按钮行
NAV_LINE_MAX_LEN = 60       # 「上一章/下一章」导航行
INJECT_LINE_MAX_LEN = 120   # 站点推广行
CLEAN_MAX_DROP_RATIO = 0.30  # 清洗后字符数较清洗前少逾此比例 → 告警（防选择器失效）

# UI 按钮行词表。CORE = t76 抽样命中的真实样本
# （「章节目录/阅读设置/书架/手机等按钮行」+「上一章/下一章」+「加入书签/字体大小」）；
# EXT = 同族变体，无逐条实测样本，但均为纯 UI 词、正常正文不会整行由它们构成。
UI_TOKENS_CORE = (
    '章节目录', '阅读设置', '目录', '设置', '书架', '手机',
    '上一章', '下一章', '加入书签', '字体大小',
)
UI_TOKENS_EXT = (
    '加入书架', '字体', '背景', '亮度', '返回目录', '章节报错', '打赏',
    '推荐本书', '投推荐票', '自动订阅', '夜间模式', '日间模式', '上一节', '下一节',
)
# 长词在前：先删「章节目录」再删「目录」，否则「章节目录」会残留「章节」而逃过规则。
_UI_TOKENS_SORTED = tuple(sorted(UI_TOKENS_CORE + UI_TOKENS_EXT, key=len, reverse=True))
# 行内允许出现的分隔/装饰字符（含中英文标点与全角空格）；纯标点行由「必须命中过 UI 词」兜住。
_UI_SEP_RE = re.compile(r'[\s\u3000|/\\·、,，;；:：!！?？。…~～\-—_+=*()（）\[\]【】<>《》「」『』]+')
# 正文特征标点：出现即判为叙述/对白文本，UI 与导航规则一律不碰。
# 交叉审查实测的误删形态正是这一类：单行「手机。」「打赏。」「「手机。」」，
# 以及对白「“你翻上一章看看，下一章就明白了”」——真实按钮行不含句读与引号。
_PROSE_MARK_RE = re.compile(r'[。！？；，、…“”‘’「」『』]')

# 站点推广行黑名单·正则部分。四条 = t76 实测命中样本，第五条是第一条的形态变体。
# 只收**整句标语**：「多多分享本站」「高速首发…最新章节」这类句子在小说正文里
# 不可能出现。交叉审查证明「本站/手机用户」这类**站点自指泛化**会误伤对白
# （“你给我记住本站的规矩。” / “手机用户请注意，前面是雷区。”），带 `?`/分组的
# 泛化写法（`请?记住本站(网址)?`、`手机用户请`）已删除，不再恢复。
INJECT_PATTERNS = (
    re.compile(r'无弹窗全文字在线阅读'),        # 「提供无弹窗全文字在线阅读」
    re.compile(r'多多分享本站'),                # 「多多分享本站」
    re.compile(r'高速首发.{0,12}?最新章节'),     # 「高速首发…最新章节」
    re.compile(r'qq\s*群和微博', re.I),          # 「向您qq群和微博里的朋友推荐」
    re.compile(r'全文字在线阅读'),               # = 第一条去掉「无弹窗」的变体
)

# 站点推广行黑名单·固定字面部分（t79 第二轮复核实测：独立成行的口号碎片）。
# 上一轮把 `分享本站` 与 `请?记住本站(网址)?` 一整族删掉，代价是这两类碎片一起漏剥；
# 本轮只把**固定字面**补回：刻意存真值字符串再 re.escape，匹配面严格等于该串本身。
# 第二条刻意收成**带「网址」的完整口号**——裸形 `请记住本站` 会命中 `“请记住本站的规矩。”`
# （与复核 A 组「应留」样例同形），属本轮要消灭的误删类，故不收。
INJECT_LITERALS = (
    '分享本站',          # 「分享本站」/「分享本站。」
    '请记住本站网址',     # 「请记住本站网址」
    '记住本站不迷路',     # 「记住本站不迷路」
)
# 🔴 上面三个是**短固定串**，必须整行锚定后才能上：裸用 search 只要求子串相邻，
# 会命中任何含该相邻串的正文行（实测误删：`他分享本站的帖子。` /
# `“我分享本站的东西，你有意见？”` / `“大家都记住本站不迷路就好。”`）。
# 锚定后匹配面 = 「整行只由该串 + 首尾空白/句读构成」，这才是「独立成行」的字面含义。
# tail 是**行尾可接受的标点集**，方向上是「更容易删」，每次扩都要按正文句回归验一遍；
# 之所以安全，是因为 `$` 仍要求字面串**之后整段**都在该集合内——`分享本站？他不敢相信。`
# 里的「他不敢相信」不在集合内，照样不命中。
_LITERAL_EDGE = r'[\s　]'
_LITERAL_TAIL = r'[\s　。！!，,、…？?；;：:~～—]'
INJECT_LITERAL_PATTERNS = tuple(
    re.compile(r'^' + _LITERAL_EDGE + r'*' + re.escape(s) + _LITERAL_TAIL + r'*$')
    for s in INJECT_LITERALS
)
# 注意：CORE 的 INJECT_PATTERNS（上一行）**保持无锚 search**，不与上面合并——
# 它收的是**整句标语**，真实噪声行「本站提供无弹窗全文字在线阅读，更新速度快，
# 请记住本站网址。」正是靠子串命中才剥得掉；给 CORE 加锚会把它整条漏掉。
# 两类目标不同：CORE 剥「含标语的整句」，字面表剥「只由碎片构成的整行」。
_NAV_SENTENCE_RE = _PROSE_MARK_RE

# ---- 导航行（含**分行**形态）----
# t79 真数据实测（labeler-p0-report §2.2e）：book15.net 把「上一章」「下一章」渲染成**两行**，
# 形如 `上一章(章节名)` 与 `(章节名)下一章`（抽样 90 章里 86 章残留这类行）。
# 旧规则要求**同一行内同时**含两词 ⇒ 在这批页面上几乎永不触发。
# 分行形态单行只有一个词，所以不能再用「含导航词」作判据，必须改用**整行结构**判据：
#   整行 = 可选分隔符 + (章节名括号 或 导航词) 的序列 + 可选分隔符，
#   且至少有一个导航词、且括号内不得剩下正文（`《上一章》` 里的括号只裹着导航词，算导航词）。
# 这样 `他想起了上一章的内容` / `（他想起上一章的事）` / `上一章的内容和下一章的内容`
# 全部落在结构外，一律保留。正文标点闸（_NAV_SENTENCE_RE）仍在前面兜底。
# 真数据回测（25 章）另发现章节名括号**自带嵌套括号**的写法
# （`上一章(狼子野心（二）)` / `(缓兵之计（四更）)下一章` / `上一章(第五十三章(完))`），
# 故括号按**深度配对**取最外层，而不是 find 第一个闭合符。
_NAV_WORD_RE = re.compile(r'上一章|下一章')
_NAV_BRACKET_PAIRS = {'（': '）', '(': ')', '[': ']', '【': '】', '《': '》'}
_NAV_BRACKET_MAX_INNER = 30        # 括号内章节名的长度上限（章节名可能不短，上限只作病态兜底）
_NAV_SEP_CHARS = ' \t\r\n　' + '-—_=+*|/\\<>·、,，;；:：!！?？~～^&' + '←→↑↓'

# ---- 上游书源水印行 ----
# t79 真数据实测（同上）：上游书源（三七中文）拷进正文的水印，**在容器内**，每章 1 行：
#   `〖三七中文www.37zw.com〗百度搜索“37zw”访问`
#   `[三七中文www.37zw.com]百度搜索“37zw.com”`
# 现有 INJECT_PATTERNS 五条全不匹配（它们收的是「无弹窗全文字在线阅读」这类整句标语）。
# 判据分两步，第一步是**锚点**：括号（〖〗/【】/[]/（）/()）内紧贴闭合符处必须有域名。
# 第二步是收口：整行去掉「水印括号 + 推广词 + 域名/字母数字残片 + 分隔/引号」后必须不剩东西。
# 这里**刻意不用** _PROSE_MARK_RE 闸——真实样本自己就带中文引号（`“37zw”`），
# 而锚点（括号内域名）比正文标点强得多：正文里出现 `[www.xxx.com]` 这种整括号包裹的域名
# 几乎不可能，且还要整行残渣为零才算数。
_WATERMARK_BRACKET_RE = re.compile(
    r'[〖\[【（(]\s*.{0,12}?(?:www\.)?[A-Za-z0-9-]{2,32}\.[A-Za-z]{2,6}\s*[〗\]】）)]')
_WATERMARK_RESIDUE_WORDS_RE = re.compile(
    r'百度搜索|百度一下|百度|搜索引擎|搜索|访问|本站|网址|首发|最新章节|'
    r'免费阅读|在线阅读|全文字|无弹窗|温馨提示|记住')
_WATERMARK_RESIDUE_ALNUM_RE = re.compile(r'[A-Za-z0-9]{1,32}')
_WATERMARK_SEP_RE = re.compile(
    r'[\s　\-—_=+*|/\\<>·、,，;；:：!！?？。~～^&.'
    r'“”"\'‘’()（）\[\]【】〖〗《》{}]+')

# ---- 作者求票行 / 章末标记 / 纯分隔线（lblqual41）----
# 实证（bqquge《斗罗大陆III》前 12 章，本机重取）：逐章都有作者写在正文里的求票/感言，
#   `求收藏、求推荐票！` / `四更啦！求推荐票、求收藏。唐门万岁，书友们万岁！` /
#   `今天的第二章送上，再次拜求推荐票、拜求收藏支持。今天保底四更哦。冲榜、冲榜…`，
# 外加每章末尾的 `(本章完)` 和 `－－－－…` 分隔线。这是原书自带的，不是站点注入，但对打标模型
# 来说与推广注入同形（该书被判「含广告注入」）。判据：「求」紧接收藏/推荐票/月票/订阅/打赏，
# 且整行无引号（有引号 = 对白，如 `“求收藏！”他在直播间里喊`，一律保留）。
# 刻意收窄：`求推荐` 后必须是「票」或标点/行尾（挡 `求推荐信`），`收藏` 后不能接家/品/室/馆/夹。
# 第二道闸（lblqualfix41，复审阻断②）：只凭「整行无引号」会误删无引号的第三人称叙述
# （`他跪在雪地里向过往的行人求打赏，嗓子已经哑了。` 一类）。作者求票是**对读者说话**的口吻，
# 所以再要求行内出现呼语/作者口吻词（各位/大家/书友/兄弟们/拜托/谢谢/本书/新书/作者…），
# 或「求…」出现在行首/行尾（呼告的典型位置）。两者都不满足的叙述行保留。
# 再收窄（lblfu41，lblqualrev2 非阻断B/C + §1② B4）：
# - 口吻词表去掉正文高频词（作者/读者/更新/上传/感谢）：`作者求月票，读者求订阅，场面热闹。` 是叙述；
# - 原「行尾是求票词」锚去掉：`那些网络主播正在直播里求打赏` 是叙述，`今天三更，求月票！` 靠作者口吻信号删；
# - 行内有第三人称（他/她/它）→ 叙述，保留（作者求票时自称我/小X，不写他/她）；
# - 补单用的「求票」「求下月票」（`求票啦！`、`各位，求票！` 漏删）。「求票」在叙述里常见（车票/选票：
#   `排队求票的人…`），所以单用的「求票」只在自成一个分句时才算（行首或标点之后、后面是标点/语气词/行尾）。
# 统一叙述判定（lblfu41 审查后，lblfurev 发现 1/5）：「众人围上来，求票。」「求收藏的人排成长队。」是叙述。
# - 行首分支：行首的「求X」本身得是一个完整分句（后面是标点/语气词/行尾），`求收藏的人…` 不算；
# - 非行首分支（句中求票词 / 单用求票分句）：还得有作者口吻的信号
#   （呼语/口吻词、`投我`、`三更/加更`），光有「，求票。」不算；
# - 两个分支都过第三人称闸（「其他/其它」不算第三人称）。
# 再收窄（lblfurev41 §7.3，本分支）：「今天/今日/明天/本章/上架/首订」是**叙述里也高频**的元词，
#   裸放当口吻词会把叙述拉进删除（`今天，村里人聚在祠堂求月票。`/`本章讲述主角如何求推荐票。`/
#   `上架之后，读者纷纷求订阅。`/`首订那天，书生在街上求打赏。`/`今天求月票的人特别多。` 全被误删）。
#   故把这 6 个词从 `_PLEA_AUTHOR_RE` 移出，改为 `_PLEA_META_PLEA_RE`：
#   **必须与「求」同属一个分句** ——
#     元词 +（可选 `了/的/啦`）+（可选连接词 `第N天/当天/首日/那天/之后/以后/后/更新/加更`）
#     +（可选 `了/的/啦`）+ 若干标点或空白 + 求告词 + 票类词
#     +（顿号/逗号枚举再接 求告词+票类词）* + **严尾**
#   严尾 = 只接受**分句结束**的标点（`！!。．…～~；;`）或行尾，**不接受 `，`/`、`/空白**。
#   道理：`，`/`、`/空白意味着后面还有续句，而续句大多是叙述
#   （`上架求订阅，读者很捧场。`、`今天更新，求月票的读者很多。`）；
#   分隔槽与连接词槽反而放宽——只要分句还在继续，尾部就不会落在分句结束标点/行尾，
#   叙述拉不进来。两处放宽换来的是 `上架了！求订阅！`、`上架之后，求订阅！`、
#   `上架首日，求订阅！`、`首订当天，求月票！` 这类真求票仍能删掉。
# 再收窄（jiageng41，本分支）：「加更」同属「叙述里也高频」的口吻词，裸放在 `_PLEA_AUTHOR_RE`
#   会误删 `今天加更，求月票的读者很多。`/`加更求订阅的读者很多。` 一类叙述（穷举里约 900 条，
#   plea41/plearev41 已定性为既有问题）。故把 `加更` 也从 `_PLEA_AUTHOR_RE` 移出、并入
#   `_PLEA_META_PLEA_RE` 的**起始锚**（与 6 个元词同一套「同分句 + 严尾」判据）：
#   `加更` 既可作起始锚（`加更了！求推荐票！`/`加更，求月票！`），也仍作 6 元词后的连接词
#   （`今天加更，求月票！`）。求票词收尾才删，续句叙述（`加更完毕，求推荐票的读者渐渐多了。`）保留。
#   注：`二更/三更/四更` 等 `[一二三四…]更` 仍在 `_PLEA_AUTHOR_RE`（`四更啦！求推荐票` 这类真求票
#   走 AUTHOR 分支，未触碰）。
#   续做（jiagengrev41 必修）：起始锚后补**有界交代槽** `(?:章/更/字数|奉上|送上|送到|到|完毕|
#   答谢|爆更|多更|感谢)*`——`加更三章，求月票！`/`加更奉上，求推荐票～`/`加更到！求收藏。` 是网文
#   最标准的求票写法，缺此槽会漏删（穷举里 660 漏 600）。槽有界、仍要求求票词收尾，故不重引入叙述误删。
PLEA_LINE_MAX_LEN = 150
_PLEA_RE = re.compile(
    r'求(?:一下|一波|下|个|张)?(?:推荐票|推荐(?=[、，,。！!～~\s]|$)|收藏(?![家品室馆夹])|月票|订阅|打赏)')
_PLEA_QUOTE_RE = re.compile(r'[“”‘’「」『』"]')
_PLEA_VOICE_RE = re.compile(
    r'各位|大家|书友|兄弟们|兄弟姐妹|拜托|谢谢|本书|新书|冲榜|保底|送上|拜求|跪求|求一|求个')
_PLEA_AUTHOR_RE = re.compile(
    _PLEA_VOICE_RE.pattern
    + r'|投我|投给我|给我投|[一二三四五六七八九十两0-9]更')
_PLEA_CLAUSE_TAIL = r'(?:啦|了|呀|吧|哦|喔|啊)?(?:[！!。．…~～、，,；;\s]|$)'
_PLEA_META_PLEA_RE = re.compile(
    r'(?:'
    # 元词分支：6 个日期元词 +（可选日期连接词 / 或「加更」连接词后接交代槽）
    r'(?:今天|今日|明天|本章|上架|首订)(?:了|的|啦)?'
    r'(?:(?:第[0-9一二三四五六七八九十两]+[天日]|当天|首日|那天|之后|以后|后|更新)'
    r'|加更(?:了|的|啦)?'
    # 「加更」后的作者交代槽（章/更/字数、奉上/送上/送到/到/完毕/答谢/爆更/多更/感谢），有界。
    r'(?:[0-9一二三四五六七八九十百千万两]+(?:章|更|万字|千字|字)'
    r'|奉上|送上|送到|到|完毕|答谢|爆更|多更|感谢)*)?'
    # 「加更」起始锚分支：加更 + 同一交代槽（`加更三章，求月票！`/`加更奉上，求推荐票～`）。
    r'|加更(?:了|的|啦)?'
    r'(?:[0-9一二三四五六七八九十百千万两]+(?:章|更|万字|千字|字)'
    r'|奉上|送上|送到|到|完毕|答谢|爆更|多更|感谢)*'
    r')'
    r'(?:了|的|啦)?[，,、。．！!～~…；;：:\s]*'
    r'(?:拜求|跪求|再求|还求|求)(?:一下|一波|下|个|张)?'
    r'(?:推荐票|推荐|收藏|月票|订阅|打赏|票+)'
    r'(?:[、，,][，,、。．！!～~…；;：:\s]*'
    r'(?:拜求|跪求|再求|还求|求)(?:一下|一波|下|个|张)?'
    r'(?:推荐票|推荐|收藏|月票|订阅|打赏|票+))*'
    r'(?:啦|了|呀|吧|哦|喔|啊)?(?:[！!。．…～~；;]|$)')
_PLEA_START_RE = re.compile(
    r'^(?:求|拜求|跪求|再求|还求)(?:一下|一波|下|个|张)?'
    r'(?:推荐票|推荐|收藏|月票|订阅|打赏|票+|支持|点击)' + _PLEA_CLAUSE_TAIL)
_PLEA_CLAUSE_HEAD = r'(?:^|[，,。．！!、；;：:\s～~…])(?:拜求|跪求|再求|还求|求)(?:一下|一波|下|个|张)?'
_PLEA_TICKET_RE = re.compile(_PLEA_CLAUSE_HEAD + r'票+' + _PLEA_CLAUSE_TAIL)
_PLEA_THIRD_PERSON_RE = re.compile(r'(?<![其吉])[他她它]')
_CHAPTER_END_RE = re.compile(r'^[（(]\s*本章完\s*[）)]$')
_SEPARATOR_LINE_RE = re.compile(r'^[－\-—=＝_＿*＊~～·]{5,}$')

_DIV_TOKEN_RE = re.compile(r'</?div\b', re.I)


def _clean_warn(message: str) -> None:
    print(f'    [清洗告警] {message}', file=sys.stderr, flush=True)


def _container_span(html: str) -> tuple[int, int, str]:
    """正文容器在 html 中的 [start, end)。返回 (start, end, how)。

    how='closed'   由 marker 所在 <div> 的配对闭合标签定界（顺带切掉页脚/推荐位）
    how='fallback' 闭合标签配不上或容器过短，退回 marker 后 25k 的旧窗口
    how='missing'  页面里没有 marker（定位失败）
    """
    i = html.find(CONTENT_MARKER)
    if i < 0:
        return -1, -1, 'missing'
    open_start = html.rfind('<div', 0, i + 1)
    if open_start >= 0:
        depth, pos = 0, open_start
        while True:
            m = _DIV_TOKEN_RE.search(html, pos)
            if not m:
                break
            depth += -1 if m.group(0)[1] == '/' else 1
            pos = m.end()
            if depth == 0:
                # 闭合点必须在 marker 之后（否则配到的是 marker 之前那个已闭合的 div，
                # 取回来的是页头不是正文）；容器太短同样判为定位失败，退回兜底窗口。
                if m.start() > i and m.start() - open_start >= CONTAINER_MIN_INNER:
                    return open_start, m.start(), 'closed'
                break
    return i, min(len(html), i + CONTAINER_FALLBACK_WINDOW), 'fallback'


def extract_chapter_lines(html: str) -> tuple[list[str], str]:
    """章节页 html → (正文行列表, 容器定位方式)。<br> 视为换行，便于逐行清洗。"""
    start, end, how = _container_span(html)
    if start < 0:
        return [], how
    lines: list[str] = []
    for para in re.findall(r'<p[^>]*>([\s\S]*?)</p>', html[start:end]):
        text = re.sub(r'<br\s*/?>', '\n', para, flags=re.I)
        text = re.sub(r'<[^>]+>|&nbsp;', '', text)
        lines.extend(s for s in (x.strip() for x in text.split('\n')) if s)
    return lines, how


def _nav_shape_ok(line: str) -> bool:
    """整行是否是导航行结构（含书源站分屏渲染出的**单行半截**形态）。

    逐字符扫：分隔符/箭头跳过，`上一章`/`下一章` 记一个 nav，章节名括号记一个 name
    （括号内只剩导航词与分隔符时改记为 nav，覆盖 `《上一章》|《下一章》` 这类写法）。
    出现任何其它字符 → 结构不成立。要求至少有一个 nav（挡住 `（他想起上一章的事）`
    这种整句被括号裹住、导航词只出现在括号内的情况）。括号按**深度**取最外层，
    以容纳章节名里自带的嵌套括号（`(缓兵之计（四更）)下一章`）。

    对照（t79 现场样本）：`(英雄救美)下一章` → [name, nav] ✅；
    `他想起了上一章的内容` → 首字符 `他` 即失败 ✅；`（他想起了上一章的事）` → [name] 无 nav ✅。"""
    tokens: list[str] = []
    i, n = 0, len(line)
    while i < n:
        ch = line[i]
        if ch in _NAV_SEP_CHARS:
            i += 1
            continue
        m = _NAV_WORD_RE.match(line, i)
        if m:
            tokens.append('nav')
            i = m.end()
            continue
        if ch in _NAV_BRACKET_PAIRS:
            depth, j = 0, i
            while j < n:
                if line[j] in _NAV_BRACKET_PAIRS:
                    depth += 1
                elif line[j] in _NAV_BRACKET_PAIRS.values():
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j >= n or j - i - 1 > _NAV_BRACKET_MAX_INNER:
                return False
            inner = line[i + 1:j]
            residue = _NAV_WORD_RE.sub('', inner)
            residue = ''.join(c for c in residue if c not in _NAV_SEP_CHARS)
            tokens.append('nav' if not residue and _NAV_WORD_RE.search(inner) else 'name')
            i = j + 1
            continue
        return False
    return 'nav' in tokens


def _is_watermark_line(line: str) -> bool:
    """整行是否只有「书源水印 + 推广词残句」构成（锚点：括号内紧贴闭合符的域名）。"""
    if not _WATERMARK_BRACKET_RE.search(line):
        return False
    rest = _WATERMARK_BRACKET_RE.sub('', line)
    rest = _WATERMARK_RESIDUE_WORDS_RE.sub('', rest)
    rest = _WATERMARK_RESIDUE_ALNUM_RE.sub('', rest)
    return not _WATERMARK_SEP_RE.sub('', rest)


def _drop_rule(line: str) -> str | None:
    """命中返回规则名，否则 None。

    1)、2)、4) 要求**整行只由噪声构成**（不做局部删除）；3) 分两类目标：
    CORE `INJECT_PATTERNS` 收**整句标语**，用无锚子串命中（真实噪声行常是长句，
    只有子串命中才剥得掉）；字面表 `INJECT_LITERAL_PATTERNS` 收**独立成行的口号碎片**，
    必须整行锚定——裸 search 会误删含该相邻串的叙述/对白行。"""
    # 1) UI 按钮行：行短、不含正文标点，且剥掉所有 UI 词后（连同分隔符）整行为空。
    #    必须真的命中过词，否则「……」这类纯标点正文行会被误删。
    if len(line) <= UI_LINE_MAX_LEN and not _PROSE_MARK_RE.search(line):
        core, hit = line, False
        for tok in _UI_TOKENS_SORTED:
            if tok in core:
                hit = True
                core = core.replace(tok, '')
        if hit and not _UI_SEP_RE.sub('', core):
            return 'ui'
    # 2) 导航行：同行形态（两词都在）与**分行**形态（单行半截，如 `(英雄救美)下一章`）
    #    统一走整行结构判据；含正文标点（含引号）视为对白，一律不剥。
    if len(line) <= NAV_LINE_MAX_LEN and _NAV_WORD_RE.search(line) \
            and not _NAV_SENTENCE_RE.search(line) and _nav_shape_ok(line):
        return 'nav'
    # 3) 站点推广行：CORE 整句标语（无锚子串）或独立成行的口号碎片（整行锚定）。
    if len(line) <= INJECT_LINE_MAX_LEN and (
            any(p.search(line) for p in INJECT_PATTERNS)
            or any(p.search(line) for p in INJECT_LITERAL_PATTERNS)):
        return 'inject'
    # 4) 上游书源水印行（`〖三七中文www.37zw.com〗百度搜索“37zw”访问` 一类）。
    if len(line) <= INJECT_LINE_MAX_LEN and _is_watermark_line(line):
        return 'inject'
    # 5) 作者求票/求收藏行：整行、无引号、无第三人称，且是作者口吻：行首就是一个求告分句，
    #    或行内有求票词 / 单用「求票」分句且带作者口吻信号；或更新元词（今天/本章/上架/首订/加更…）
    #    与「求票词」同属一个分句、且求票词收尾。叙述行不删（lblqualfix41/lblfu41/lblfurev41/jiageng41）。
    # 6) 章末 `(本章完)` 与纯分隔线（lblqual41）。
    if len(line) <= PLEA_LINE_MAX_LEN and not _PLEA_QUOTE_RE.search(line) \
            and not _PLEA_THIRD_PERSON_RE.search(line) and (
                _PLEA_START_RE.search(line)
                or _PLEA_META_PLEA_RE.search(line)
                or ((_PLEA_RE.search(line) or _PLEA_TICKET_RE.search(line))
                    and _PLEA_AUTHOR_RE.search(line))):
        return 'plea'
    if _CHAPTER_END_RE.match(line) or _SEPARATOR_LINE_RE.match(line):
        return 'marker'
    return None


def clean_chapter_text(html: str) -> tuple[str, dict]:
    """章节页 html → (清洗后正文, 统计)。统计含 drop_ratio / container / dropped。

    纯函数：不联网、不打印（告警由调用方 fetch_chapter_text 负责），便于离线单测。"""
    lines, how = extract_chapter_lines(html)
    before = len('\n'.join(lines))
    kept, dropped = [], 0
    for line in lines:
        if _drop_rule(line):
            dropped += 1
        else:
            kept.append(line)
    text = re.sub(r'\n{2,}', '\n', '\n'.join(kept)).strip()
    after = len(text)
    stats = {
        'container': how,
        'lines_before': len(lines),
        'lines_dropped': dropped,
        'chars_before': before,
        'chars_after': after,
        'drop_ratio': (1 - after / before) if before else 0.0,
    }
    return text, stats


# ---- 调模型之前的本地预检（lblqual41）----
# 事故（2026-09-25 phoenix 一轮 6 本拒 5 本）：模型调用全部成功，却被自报的 text_quality 拦下。实证：
# - cuoceng「大面积重复」是真重复：CLI content 没有翻页停止点，每章都顺着「下一章」翻满 20 页，
#   相邻两章的返回有 19/20 重叠（根治在 engine-fetch --stop-urls-file，本层去重兜底）；
# - yunqi「含广告注入」：付费试读源，每章只有约 100 字，标题还带「APP免费」——没有正文可打；
# - bqquge《斗罗大陆III》「含广告注入」：作者求票行逐章都有，而引擎正文根本不过清洗层。
# 所以在调模型前：引擎正文逐行过 _drop_rule；跨章去掉重复的长行（串章/分页重叠/重复章节）；
# 试读截断源和去重后字数不足的书直接跳过，不花模型调用。模型的 text_quality 判定门不动。
DEDUPE_MIN_LINE = 20        # 只对这么长以上的行去重：短对白（“嗯。”）重复是正常写法
PREVIEW_MIN_CHAPTERS = 5    # 章数太少不判试读（样本不够）
PREVIEW_MEDIAN_MAX = 500    # 章正文中位数低于此 → 疑似试读/付费截断（正常网文一章 2000–5000 字）
PRECHECK_MIN_CHARS = 10_000  # 与主循环「抓取字数不足」同一阈值
# 试读门是「又短又碎」：中位数低但全书字数已经够打标的，是正常的短章写法，不按试读拒
# （复审非阻断③：30 章×450 字共 1.3 万字被误判）。阈值与「去重后不足」同一口径。
PREVIEW_MIN_TOTAL = PRECHECK_MIN_CHARS
# 章节标题 = 本层自己拼出来的 '【标题】\n'，标题取自 toc，行首必是「第X章/卷/节/回/集/话/部/篇」。
# 正文里独占一段的「【叮！获得xx点经验值】」一类系统提示/弹幕/法宝名不含章号，不算章节标题
# （lblqualfix41，复审阻断①：60 章系统流被切成 120 章、中位数腰斩、整本按试读拒收）。
_CHAPTER_HEAD_RE = re.compile(
    r'(?:\A|\n\n)(【第[0-9一二三四五六七八九十百千万零〇两\d]+[章节卷回集话部篇][^\n]*】)\n')

# ---- 广告注入门的清洗补洞（lbladfix41，依据 lbladdiag-41-report §2/§4）----
# 诊断实证：被判「含广告注入」的 8 本里，送模型文本中的「推广」大多不是站点插的推广段，而是
# (a) 作者公告/感言类目录条目被当章节抓进来；(b) 章节标题里的求票括注、APP免费（标题不过清洗）；
# (c) 嵌在段落里的盗版站水印（整行规则删不到半行）；(d) 付费试读源的约 100 字预览章。

# (c) 段内水印：只剥匹配到的子串，段落其余正文保留。
_INLINE_NOISE_PATTERNS = (
    # kxdu《雪中悍刀行》：`…极土木之盛。 首发--无弹出广告(喜欢本书,请收藏)`，括号内容可空
    re.compile(r'\s*首发-{1,3}无弹出?广告(?:[(（][^()（）\n]{0,20}[)）])?'),
    # kxdu《斗罗大陆》：`…孤傲之辈。#百度搜（手打吧）阅读本书最新手打章节#在这个方面…`。
    # 要求 # 后紧跟「百度」且段内有 手打/章节/阅读本书：都市文里的微博话题（`#某某最新消息#`）不碰。
    re.compile(r'#\s*百度[^#\n]{0,40}?(?:手打|章节|阅读本书)[^#\n]{0,20}?#'),
    # `（未完待续）`、`(未完待续。如果您喜欢这部作品，欢迎您来起点投推荐票…)` 一类章尾标记
    re.compile(r'\s*[（(]\s*未完待续[^()（）\n]{0,80}[)）]'),
)
# 整行只有网址（kxdu《鬼吹灯》章尾的 `http://.cn`：域名被剥掉后的残渣，不带括号，水印行规则收不到）
_BARE_URL_LINE_RE = re.compile(r'^\s*(?:https?://|www\.)[\w.\-/?=&%#:~]*\s*$', re.I)


def _strip_inline_noise(line: str) -> str:
    """段内水印子串剥除（纯函数）。返回剥完后的行（首尾空白已去）；整行是裸网址 → ''。"""
    if _BARE_URL_LINE_RE.match(line):
        return ''
    for pattern in _INLINE_NOISE_PATTERNS:
        line = pattern.sub('', line)
    return line.strip()


# (b) 章节标题清洗：`第2章 道生（求收藏！）`、`第91章 杀破狼（求月票）APP免费`、`第9章 xx（为盟主加更）`、
# 标题尾部的更新时间。只动标题，不动章号（切章正则依赖「第X章」前缀）。
_TITLE_NOISE_PATTERNS = (
    # 「求」后必须紧跟求票类词：`（求而不得）` 这种章名括注不碰
    re.compile(r'\s*[（(]\s*(?:跪求|拜求|求)(?:收藏|推荐|月票|票|订阅|打赏|支持|点击|首订|全订)'
               r'[^()（）]{0,10}[)）]'),
    re.compile(r'\s*[（(][^()（）]{0,12}(?:盟主|加更|[一二三四五六七八九十0-9]更)[^()（）]{0,6}[)）]'),
    re.compile(r'\s*APP\s*免费', re.I),
    re.compile(r'\s*(?:(?:更新时间|更新于|更新)\s*[:：]?|[:：|｜\-—–])\s*'
               r'\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*$'),
)
# 带「更新」前缀或分隔符（`:`/`｜`/`-`，lblfurev 发现 4）的日期尾巴是站点时间戳，连同分隔符一起剥。
# 只隔空格的日期尾巴：只在剥完还剩章名时才剥。`第100章 2012.12.21` 的日期就是章名本身，
# 剥掉只剩章号（lblfu41，lbladrev §1 A3）。
_TITLE_DATE_TAIL_RE = re.compile(
    r'\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*$')


def clean_chapter_title(title: str) -> str:
    """章节标题 → 去掉求票括注 / APP免费 / 更新时间尾巴后的标题（纯函数，幂等）。"""
    title = (title or '').strip()
    for pattern in _TITLE_NOISE_PATTERNS:
        title = pattern.sub('', title)
    title = title.strip()
    rest = _TITLE_DATE_TAIL_RE.sub('', title).strip()
    return rest if _CHAPTER_NUMBER_TITLE_RE.sub('', rest).strip() else title


# (a) 非正文目录条目：标题不是「第X章/卷…」格式，且命中公告/感言类关键词 → 不抓。
# 有章号前缀的一律保留（正文章节标题恰好带「感言」二字，如 `第八十章 上台感言`）。
_CHAPTER_NUMBER_TITLE_RE = re.compile(
    r'^\s*(?:正文\s*)?第[0-9一二三四五六七八九十百千万零〇两]+[章节卷回集话部篇]')
_NONBODY_TITLE_RE = re.compile(
    r'感言|公告|上架|推荐一本|请假|通知|冲榜|加更|单章|书友|作品相关|人物列表|月末总结|新书|'
    r'^\s*关于')


def is_nonbody_toc_title(title: str) -> bool:
    """目录条目是否是作者公告/感言类非正文（纯函数）。"""
    title = (title or '').strip()
    return bool(title) and not _CHAPTER_NUMBER_TITLE_RE.match(title) \
        and bool(_NONBODY_TITLE_RE.search(title))


# (d) 付费试读章：标题带 APP免费，或正文 ≤ PREVIEW_CHAPTER_MAX 字且以省略号收尾（截断预览）。
# 丢弃，不计章数与字数；丢完剩下的正文不足 PREVIEW_MIN_TOTAL → 按试读源拒收（见 prepare_book_text）。
# 正文判据按整本口径（lblfu41，lbladrev 非阻断1）：单看一章会把 101–200 字、以省略号收尾的正常短章
# （楔子/过场章）当试读丢掉。试读源的截断预览是成批出现的，所以只有「目录里有 APP免费 章」或
# 「正文判定的章 ≥ PREVIEW_SOURCE_MIN_CHAPTERS」时才认定是试读源、丢正文判定的章；零星一两章照常保留。
# 阈值只数 >100 字的正文判定章（lblfurev 发现 2）：≤100 字的章本来就不收录，不能拿它们凑数把
# 101–200 字的正常短章拖下水。
PREVIEW_CHAPTER_MAX = 200
PREVIEW_SOURCE_MIN_CHAPTERS = PREVIEW_MIN_CHAPTERS
_PREVIEW_TITLE_RE = re.compile(r'APP\s*免费', re.I)
_PREVIEW_TAIL_RE = re.compile(r'(?:\.\.\.|…)\s*$')


def is_preview_title(title: str) -> bool:
    return bool(_PREVIEW_TITLE_RE.search(title or ''))


def is_preview_body(body: str) -> bool:
    """正文形如截断预览（纯函数）：≤200 字且以 ... / … 结尾。单章命中不等于试读章，见 is_preview_source。"""
    body = (body or '').strip()
    return len(body) <= PREVIEW_CHAPTER_MAX and bool(_PREVIEW_TAIL_RE.search(body))


def is_preview_chapter(title: str, body: str) -> bool:
    """试读章形态判定（纯函数）：标题带 APP免费，或正文形如截断预览。"""
    return is_preview_title(title) or is_preview_body(body)


def is_preview_source(known_previews: int, body_previews: int) -> bool:
    """整本是否是试读源（纯函数）。known_previews = 目录里 APP免费 章数 + 上游已按试读源丢掉的章数，
    >0 即认定；body_previews = 正文形如截断预览、且 >100 字（会被收录）的章数，成批（≥5）才认定。"""
    return known_previews > 0 or body_previews >= PREVIEW_SOURCE_MIN_CHAPTERS


def prepare_book_text(text: str, clean: bool,
                      preview_dropped: int = 0) -> tuple[str, int, str | None, dict]:
    """拼接好的整本文本 → (预处理后文本, 字数, 拒收原因或 None, 统计)。纯函数，可离线单测。

    输入形态同 fetch_book_text / fetch_book_text_engine 的产出：'【章节标题】\\n正文' 以空行相连。
    clean=True（引擎正文）时：章节标题过 clean_chapter_title，试读章（标题带 APP免费；认定为试读源时
    再加正文形如截断预览的章，见 is_preview_source）整章丢弃，
    正文逐行先剥段内水印（_strip_inline_noise）再过 _drop_rule；book15 正文在抓取层已清洗过，传 False。
    preview_dropped = 抓取层已丢弃的试读章数（fetch_book_text_engine 的 stats），与本层丢的合计：
    有试读章被丢、且剩余正文不足 PREVIEW_MIN_TOTAL → 按试读源拒收。
    去重：某行（去首尾空白后 ≥ DEDUPE_MIN_LINE 字）在本书前文出现过 → 删；删空的章整章丢
    （短章在抓取层已按 ≤100 字丢过，这里不再按长度丢）。章节标题行不参与去重。"""
    pieces = _CHAPTER_HEAD_RE.split(text)
    chapters = [('', pieces[0])] if pieces[0].strip() else []
    chapters += list(zip(pieces[1::2], pieces[2::2]))
    seen: set[str] = set()
    parts, lengths, chars = [], [], 0
    stats = {'chapters_before': len(chapters), 'clean_lines': 0, 'dup_lines': 0,
             'dup_chars': 0, 'chars_before': 0, 'inline_strips': 0, 'preview_chapters': 0}
    preview_source = clean and is_preview_source(
        preview_dropped + sum(1 for head, _ in chapters if head and is_preview_title(head[1:-1])),
        sum(1 for head, body in chapters
            if head and is_preview_body(body) and len(body.strip()) > 100))
    for head, body in chapters:
        if clean and head:
            title = head[1:-1]
            if is_preview_title(title) or (preview_source and is_preview_body(body)):
                stats['preview_chapters'] += 1
                continue
            head = f'【{clean_chapter_title(title)}】'
        kept, body_len = [], 0
        for raw in body.split('\n'):
            line = raw.strip()
            if not line:
                continue
            stats['chars_before'] += len(line)
            if clean:
                stripped = _strip_inline_noise(line)
                if stripped != line:
                    stats['inline_strips'] += 1
                line = stripped
                if not line:
                    stats['clean_lines'] += 1
                    continue
            if clean and _drop_rule(line):
                stats['clean_lines'] += 1
                continue
            body_len += len(line)
            if len(line) >= DEDUPE_MIN_LINE:
                if line in seen:
                    stats['dup_lines'] += 1
                    stats['dup_chars'] += len(line)
                    continue
                seen.add(line)
            kept.append(line)
        chapter_text = '\n'.join(kept)
        # 试读判据看去重**之前**的章长：整章重复（目录里同一章出现两次）去重后是 0，不能拉低中位数。
        lengths.append(body_len)
        if chapter_text:
            parts.append(f'{head}\n{chapter_text}' if head else chapter_text)
            chars += len(chapter_text)
    out = '\n\n'.join(parts)
    lengths.sort()
    median = lengths[len(lengths) // 2] if lengths else 0
    previews = preview_dropped + stats['preview_chapters']
    stats.update(chapters_after=len(parts), chars_after=chars, median_chapter=median)
    if previews and chars < PREVIEW_MIN_TOTAL:
        return out, chars, (f'章节正文过短（试读章 {previews} 章已丢弃，剩余 {chars} 字，'
                            f'疑似试读/付费截断）'), stats
    if len(lengths) >= PREVIEW_MIN_CHAPTERS and median < PREVIEW_MEDIAN_MAX \
            and chars < PREVIEW_MIN_TOTAL:
        return out, chars, f'章节正文过短（中位 {median} 字，疑似试读/付费截断）', stats
    if chars < PRECHECK_MIN_CHARS:
        return out, chars, f'清洗去重后仅 {chars} 字', stats
    return out, chars, None, stats


def fetch_chapter_text(chapter_url: str, source: BookSource | None = None) -> str:
    """章节页 → 纯文本。先按容器配对标签精确定界正文，再逐行剥 UI/导航/推广行。

    抓取层的修复（缺陷样本见 .t76-analysis/）；判定门与提示词不动。
    基址与正文解析经书源适配器取得（book15 语义与解耦前逐字相同）。"""
    src = source or BOOK15
    html = http_get(src.absolute(chapter_url))
    text, stats = src.parse_chapter_html(html)
    if stats['container'] == 'missing':
        _clean_warn(f'{chapter_url} 未找到正文容器 {CONTENT_MARKER}，本页判为无正文')
    elif stats['container'] == 'fallback':
        # 退回旧窗口意味着页脚/推荐位噪声会一起回来，不能静默。
        _clean_warn(
            f'{chapter_url} 正文容器未能配对闭合标签，退回 {CONTAINER_FALLBACK_WINDOW} 字'
            f'窗口（页脚噪声可能回归，需核对页面结构）')
    elif stats['drop_ratio'] > CLEAN_MAX_DROP_RATIO:
        _clean_warn(
            f'{chapter_url} 清洗丢弃 {stats["drop_ratio"]:.0%} 字符'
            f'（{stats["chars_before"]}→{stats["chars_after"]}，'
            f'丢 {stats["lines_dropped"]}/{stats["lines_before"]} 行）'
            f'容器={stats["container"]}，疑规则过激或页面结构变化')
    return text


def fetch_book_text(detail_url: str, target_chars: int = TARGET_CHARS,
                    source: BookSource | None = None,
                    detail_html: str | None = None) -> tuple[str, int]:
    """整本（到字数上限）→ (拼接文本, 实际字数)

    detail_html 传入时复用调用方已抓的详情页解析章节（省一次 GET，也保证元数据/章节
    同源）——章节列表经书源适配器 chapters_from_html 解析（不引入重复正则）。默认 None，
    签名向后兼容：主应用照旧 `fetch_book_text(url)` / `fetch_book_text(url, source=src)`。"""
    src = source or BOOK15
    chapters = (src.chapters_from_html(detail_html) if detail_html is not None
                else fetch_chapters(detail_url, source=source))
    parts, chars = [], 0
    for url, title in chapters:
        if chars >= target_chars:
            break
        text = ''
        for attempt in range(CHUNK_RETRY):
            try:
                text = fetch_chapter_text(url, source=source)
                break
            except Exception:
                time.sleep(2 * (attempt + 1))
        if len(text) > 100:
            parts.append(f'【{title.strip()}】\n{text}')
            chars += len(text)
        time.sleep(CHAPTER_DELAY)
    return '\n\n'.join(parts), chars


# ---- 引擎源取正文（T5：book15 miss 回落的引擎源，走 engine-fetch.mjs CLI）----
# 队列条目带 engine=True 的书不走 BookSource 适配器（那是 book15 站点结构），
# 改调 engine CLI：toc 拿章节清单 → 逐章 content → 拼接。正文**不过 clean_chapter_text**
# （引擎 engineFetchContent 已抽干净文本；调研 §4：多源正文优先引擎结果，少依赖 book15
# 结构的 Python 清洗）。产出与 fetch_book_text 同构：'【章节标题】\n正文'。
def _engine_json(engine_cli, subcommand: str, *args: str) -> dict:
    """调引擎 CLI 子命令并解析 JSON stdout；非零退出 → EngineCliError（RuntimeError 子类，脱敏摘要）。

    凭据红线：stderr 不原样透传——只留单行化 + 截断的错误摘要（CLI 侧另有 safeReason）。
    giveup41：新 CLI 在 --json 出错时于 stderr 末行给 {"errorKind": …}，解析进 EngineCliError.kind
    （旧 CLI 无此行 → kind=''，行为同改前）；该行不进摘要。"""
    proc = engine_cli.run(subcommand, *args)
    if proc.returncode != 0:
        summary, kind = _split_engine_stderr(proc.stderr)
        raise EngineCliError(f'引擎 {subcommand} 失败 rc={proc.returncode}: {summary}', kind)
    return json.loads(proc.stdout)


def _split_engine_stderr(stderr: str | None) -> tuple[str, str]:
    """CLI stderr → (单行化截断摘要, errorKind)。末行不是合法的 errorKind JSON 就当普通文本。"""
    lines = [line for line in (stderr or '').splitlines() if line.strip()]
    kind = ''
    if lines and lines[-1].lstrip().startswith('{'):
        try:
            payload = json.loads(lines[-1])
        except ValueError:
            payload = None
        if isinstance(payload, dict) and isinstance(payload.get('errorKind'), str):
            kind = payload['errorKind']
            lines = lines[:-1]
    return ' '.join(' '.join(lines).split())[:200], kind


class EngineCliError(RuntimeError):
    """引擎 CLI 非零退出。kind = CLI 给出的 errorKind（见 scripts/engine-error-kind.mjs），旧 CLI 为 ''。"""

    def __init__(self, message: str, kind: str = ''):
        super().__init__(message)
        self.kind = kind


# ---- 源整站失效提前放弃（giveup41）----
# 事故（2026-09-25 phoenix）：www.bqquge.org 对所有请求 302 → google，引擎按跨站跳转拒绝，
# 而逐章循环吞掉一切错误继续下一章，一本书打满上千章、70+ 分钟零产出。改为：
# - 只有**确定性**错误类别（同一 URL 重试结果不变）参与放弃判定；超时/未知类别不参与（防误杀）。
# - 同一本书在同一源上连续 SOURCE_GIVEUP_STREAK 章同一确定性类别 → 放弃该源（任一章成功或出现别的
#   结果即清零）；toc 本身就确定性失败 → 直接放弃该源。放弃后按队列条目的 engine_alternates 换源。
# - 5xx 残留（giveuprev41）：CLI 内 page() 已对 5xx 重试过、labeler 又重试 CHUNK_RETRY 次后该章仍是
#   http_5xx，才算一章「5xx 章」；连续 SERVER_ERROR_GIVEUP_STREAK 章（比确定性阈值长）→ 放弃。
#   否则整站 500/502 仍会把整本目录打满。超时仍不参与。
# - 同一 host 本轮累计放弃 ≥ DEAD_HOST_GIVEUPS 次 → 本轮后续条目/备选凡在该 host 的不再发请求。
#   （一轮是先搜完全部书名再打标，打标阶段已无「后续搜索」，故本轮跳过落在打标阶段。）
SOURCE_GIVEUP_STREAK = 5
SERVER_ERROR_GIVEUP_STREAK = 8
SERVER_ERROR_KIND = 'http_5xx'
DEAD_HOST_GIVEUPS = 2
DETERMINISTIC_ENGINE_ERRORS = frozenset({'policy', 'http_4xx', 'no_source'})
# 主源与全部备选都在本轮已失效 host 上、一个请求都没发时的放弃 kind（不是 CLI 错误类别）。
DEAD_HOST_SKIP_KIND = 'dead_host_skipped'
MIN_BOOK_CHARS = 10_000     # 一本书至少要抓到的字数（不足记「抓取字数不足」）


class EngineSourceGaveUp(RuntimeError):
    """放弃某源：host + 触发类别 + 放弃前已抓到的部分正文（text/chars，供调用方决定是否够用）。"""

    def __init__(self, host: str, kind: str, detail: str, text: str = '', chars: int = 0):
        super().__init__(f'源 {host} 失效（{kind}）：{detail}')
        self.host, self.kind, self.text, self.chars = host, kind, text, chars


def _url_host(url: str) -> str:
    try:
        return urllib.parse.urlsplit(url).hostname or ''
    except ValueError:
        return ''


class SourceGiveupTracker:
    """单轮内按 host 累计放弃次数（不跨轮：站点可能恢复）。dead = 本轮判失效、后续不再请求的 host。"""

    def __init__(self, threshold: int = DEAD_HOST_GIVEUPS):
        self.threshold = threshold
        self.counts: dict[str, int] = {}
        self.dead: set[str] = set()

    def record(self, host: str) -> None:
        n = self.counts[host] = self.counts.get(host, 0) + 1
        if n >= self.threshold and host not in self.dead:
            self.dead.add(host)
            print(f'  源失效（本轮）: {host} 已累计放弃 {n} 次，本轮后续条目不再请求该源', flush=True)


class EngineIdentityMismatch(Exception):
    """N02：引擎 toc 自报的 title/author 与名单身份不符（错书防线）。

    消息含双端 title/author 摘要，供 labels-rejected.jsonl 的 reason 与 stdout 审计。
    只在引擎路径抛出（book15 路径无 toc 自报身份可用）；主循环在通用 except 之前
    专门 catch：写拒收、不调 LLM、不 sleep LLM_INTERVAL。"""


def fetch_book_text_engine(engine_cli, book_url: str,
                           target_chars: int = TARGET_CHARS,
                           expect_title: str = '',
                           expect_author: str = '',
                           giveup_streak: int = SOURCE_GIVEUP_STREAK,
                           server_error_streak: int = SERVER_ERROR_GIVEUP_STREAK,
                           stats: dict | None = None) -> tuple[str, int]:
    """引擎源整本（到字数上限）→ (拼接文本, 实际字数)。

    toc 失败（无章 / 环境错误，CLI 退出码非 0）→ 抛异常，交主循环计失败（不静默产空文本）。
    单章 content 失败（重试后仍空）跳过，隔离不拖垮整本；target_chars/CHUNK_RETRY/CHAPTER_DELAY
    与 book15 路径沿用同一常量。

    giveup41：toc 确定性失败、或连续 giveup_streak 章同一确定性错误类别 → 抛 EngineSourceGaveUp
    （带已抓到的部分正文）；确定性错误的单章不再重试（重试结果不变，白等退避）。
    重试后仍 http_5xx 的章连续 server_error_streak 章 → 同样放弃（5xx 章照旧重试）。

    lbladfix41：公告/感言类目录条目（is_nonbody_toc_title）与标题带 APP免费 的试读章抓取前跳过，
    抓回来形如截断预览（is_preview_body）的章在整本认定为试读源（is_preview_source）时丢弃；都不计字数，条数记进 stats
    （nonbody_chapters / preview_chapters，调用方传 dict 才拿得到）。章节标题过 clean_chapter_title。

    N02 二次校验（toc 取回后、逐章 content **之前**）：expect_title/expect_author
    是名单侧身份锚点（队列条目的 title/author）。**双侧非空才比对**——toc 缺自报
    身份（空串）不触发（向后兼容），名单没给期望值（空串）也不触发。
    title 用 title_compatible 语义比对；author 用 douban_list.author_matches（与候选
    过滤同一口径，否则候选阶段放行的多署名/外文末节写法会在这里被拒）。不符 → 抛 EngineIdentityMismatch（此时一个 content 调用都没发起，
    省掉整本抓取）。"""
    host = _url_host(book_url)
    try:
        toc = _engine_json(engine_cli, 'toc', '--url', book_url)
    except EngineCliError as e:
        if e.kind in DETERMINISTIC_ENGINE_ERRORS:
            raise EngineSourceGaveUp(host, e.kind, f'目录失败 {e}') from e
        raise
    toc_title = (toc.get('title') or '').strip()
    toc_author = (toc.get('author') or '').strip()
    if expect_title and toc_title and not douban_list.title_compatible(expect_title, toc_title):
        raise EngineIdentityMismatch(
            f'引擎目录身份不符: 名单《{expect_title}》/作者 {expect_author or "（未知）"}'
            f' vs 目录《{toc_title}》/作者 {toc_author or "（未知）"}（标题不兼容）')
    if expect_author and toc_author and not douban_list.author_matches(expect_author, toc_author):
        raise EngineIdentityMismatch(
            f'引擎目录身份不符: 名单《{expect_title}》/作者 {expect_author}'
            f' vs 目录《{toc_title}》/作者 {toc_author}（作者不符）')
    chapters = toc.get('chapters') or []
    parts, chars = [], 0
    stats = stats if stats is not None else {}
    stats.setdefault('nonbody_chapters', 0)
    stats.setdefault('preview_chapters', 0)
    # author17k41：把已通过身份校验（标题兼容）的 toc 自报作者/标题透出给记录组装层，
    # 供「名单作者为空」时回写（见 main 的 engine_toc 回写）。只读透出，不改取文行为。
    # 位置在两处 EngineIdentityMismatch 之后 → 出现在 stats 即代表目录身份已过。
    # toc_title 供回写点做「归一后书名完全相等」的收紧判据（rvauthor CE3：只前缀兼容不回写）。
    stats['toc_author'] = toc_author
    stats['toc_title'] = toc_title
    streak_limit = dict.fromkeys(DETERMINISTIC_ENGINE_ERRORS, giveup_streak)
    streak_limit[SERVER_ERROR_KIND] = server_error_streak
    streak_kind, streak = '', 0     # 连续同一放弃类别（确定性 / 重试后仍 5xx）的章数
    body_previews = []              # 正文形如截断预览的章：(parts 下标, 字数)；≤100 字未收的记 None
    for ch in chapters:
        if chars >= target_chars:
            break
        ch_url = ch.get('url') or ''
        title = (ch.get('title') or '').strip()
        if not ch_url:
            continue
        # lbladfix41：公告/感言类目录条目、标题带 APP免费 的试读章在抓取前就跳过（省请求，不计字数）
        if is_nonbody_toc_title(title):
            stats['nonbody_chapters'] += 1
            continue
        if is_preview_title(title):
            stats['preview_chapters'] += 1
            continue
        text = ''
        fail_kind = ''              # 本章最后一次尝试的失败类别；'' = 成功或不计入放弃的失败
        for attempt in range(CHUNK_RETRY):
            try:
                text = _engine_json(engine_cli, 'content', '--url', ch_url).get('text') or ''
                fail_kind = ''
                break
            except EngineCliError as e:
                fail_kind = e.kind if e.kind in streak_limit else ''
                if fail_kind in DETERMINISTIC_ENGINE_ERRORS:
                    break           # 确定性错误：重试结果不变，不退避
                time.sleep(2 * (attempt + 1))
            except Exception:
                fail_kind = ''
                time.sleep(2 * (attempt + 1))
        if fail_kind:
            streak = streak + 1 if fail_kind == streak_kind else 1
            streak_kind = fail_kind
            if streak >= streak_limit[fail_kind]:
                raise EngineSourceGaveUp(host, fail_kind, f'连续 {streak} 章 {fail_kind}',
                                         '\n\n'.join(parts), chars)
        else:
            streak_kind, streak = '', 0
        if text and is_preview_body(text):
            # 形如截断预览（≤200 字且以省略号收尾）：先记下，整本抓完再按 is_preview_source 定丢不丢
            body_previews.append((len(parts), len(text)) if len(text) > 100 else None)
        if len(text) > 100:
            parts.append(f'【{clean_chapter_title(title)}】\n{text}')
            chars += len(text)
        time.sleep(CHAPTER_DELAY)
    if is_preview_source(stats['preview_chapters'], sum(1 for p in body_previews if p)):
        # 试读源：正文判定的章丢弃，不计字数（≤100 字的本来就不收，这里只补计数）
        stats['preview_chapters'] += len(body_previews)
        drop = {i for i, _ in filter(None, body_previews)}
        chars -= sum(n for _, n in filter(None, body_previews))
        parts = [p for i, p in enumerate(parts) if i not in drop]
    return '\n\n'.join(parts), chars


def fetch_engine_book_with_giveup(engine_cli, book: dict, tracker: SourceGiveupTracker,
                                  giveup_streak: int = SOURCE_GIVEUP_STREAK,
                                  stats: dict | None = None) -> tuple[str, int, dict]:
    """引擎队列条目取正文，主源失效（确定性错误或持续 5xx）时按 engine_alternates 换源 → (text, chars, 实际所用源)。

    实际所用源 = {'url', 'title', 'source'}，调用方据此改写条目的 url/source_host（产物记真实来源）。
    - 主源：身份不符 / 其他失败照旧上抛（行为同改前）；EngineSourceGaveUp → tracker 记一次放弃、换下一个。
    - 备选：任何失败都只跳过该备选（身份不符也不写 rejected——备选不是名单选定的那条）。
    - 放弃前已抓够 MIN_BOOK_CHARS 字 → 直接用已抓到的部分，不再换源。
    - host 已在 tracker.dead → 不发请求直接跳过。全部用尽 → 抛 EngineSourceGaveUp。
    stats（可选）：填入**实际所用源**那一次取文的统计（fetch_book_text_engine 的 stats）。"""
    primary = {'url': book['url'], 'title': book.get('title') or '',
               'source': book.get('source_host') or _url_host(book['url'])}
    options = [primary] + list(book.get('engine_alternates') or [])
    last: Exception | None = None
    for i, src in enumerate(options):
        host = src.get('source') or _url_host(src['url'])
        if host in tracker.dead:
            print(f'  跳过本轮已失效源: {host}')
            last = last or EngineSourceGaveUp(host, DEAD_HOST_SKIP_KIND, '本轮已判失效')
            continue
        if i > 0:
            print(f'  换源: {host} {src["url"]}')
        attempt_stats: dict = {}
        try:
            text, chars = fetch_book_text_engine(
                engine_cli, src['url'],
                expect_title=book.get('title') or '',
                expect_author=book.get('author') or '',
                giveup_streak=giveup_streak, stats=attempt_stats)
            if stats is not None:
                stats.update(attempt_stats)
            return text, chars, src
        except EngineSourceGaveUp as e:
            print(f'  放弃源: {e}（已抓 {e.chars} 字）')
            if e.chars >= MIN_BOOK_CHARS:
                if stats is not None:
                    stats.update(attempt_stats)
                return e.text, e.chars, src     # 已抓够：本书算成功，不给 host 记放弃（giveuprev41 非阻断 4）
            tracker.record(host)
            last = e
        except Exception as e:
            if i == 0:
                raise
            print(f'  备选源 {host} 失败，跳过: {e}')
            last = e
    raise EngineSourceGaveUp(primary['source'], getattr(last, 'kind', 'other'),
                             f'{len(options)} 个候选源均不可用（最后: {last}）')


# ---- 每轮失败分类（labelerdiag41 P3：巡检要一眼分出是代码缺陷、LLM 渠道还是书源问题）----
# 旧口径只有「成功 N / 失败 M」，诊断时得逐本翻 gate.log 归类。main 每记一次失败就归一类，
# 轮末在「完成」行之后单独打一行分类计数（「完成」行逐字不变，门卫按它解析）。
def classify_failure(error: BaseException) -> str:
    """主循环 except 捕获的异常 → 失败类别（只看类型与消息，不含任何凭据）。"""
    msg = str(error)
    if isinstance(error, EngineIdentityMismatch):
        return '目录作者不符' if '作者不符' in msg else '目录标题不符'
    if isinstance(error, EngineSourceGaveUp):     # 先于下面按文案猜的分支（消息里可能含 HTTPS）
        return '源失效放弃'
    # 先于 JSON 判：模型链耗尽的消息里常带「最后错误: Unterminated string…」
    if '模型链' in msg and '耗尽' in msg:
        return 'LLM链耗尽'
    if isinstance(error, (json.JSONDecodeError, UnicodeDecodeError)):
        return '引擎输出截断'
    if 'HTTPS' in msg:
        return '非HTTPS源'
    if isinstance(error, TimeoutError) or 'timed out' in msg.lower() or '超时' in msg:
        return '书源超时'
    return '其他'


def format_failure_kinds(kinds: dict) -> str:
    """{类别: 次数} → 「失败分类: A 3 / B 1」（按次数降序，同数按类别名）。"""
    items = sorted(((k, v) for k, v in kinds.items() if v), key=lambda kv: (-kv[1], kv[0]))
    return '失败分类: ' + ' / '.join(f'{k} {v}' for k, v in items)


def _clean_engine_author(raw: str) -> str:
    """引擎 toc 自报作者 → 可入库的作者串：剥前导「作者：」标签与尾部「著/等著…」，保名、不 casefold。

    与 douban_list._norm_author 分工：那条是**身份比对**用的强归一（casefold + 去标点 + 剥国籍段），
    会把「乔治·奥威尔」压成小写去点、不适合直接入库；这里只做面向存储的轻清洗，复用同一套
    标签/尾缀正则，保证清洗口径与比对口径不打架。全空（如 toc 只给「作者：」）→ '' ⇒ 不回写。
    占位作者（佚名/未知/暂无/匿名…，对齐 source-parser.ts knownSourceAuthor）→ '' ⇒ 不回写、不入身份。"""
    s = douban_list._strip_author_label((raw or '').strip())
    while True:
        stripped = douban_list._AUTHOR_SUFFIX_RE.sub('', s)
        if stripped == s:
            break
        s = stripped
    s = s.strip()
    return '' if douban_list.is_placeholder_author(s) else s


def engine_author_writeback(list_author: str, toc_author: str,
                            list_title: str = '', toc_title: str = '') -> str:
    """名单作者为空、目录书名与名单书名归一后完全相等、且 toc 作者清洗后非空 → 返回应回写的作者；否则 ''。

    条件①名单作者为空 + ③toc_author 清洗后非空（且非占位作者）在此判；条件②「目录身份校验已通过」
    由调用点保证——toc_author/toc_title 仅在 fetch_book_text_engine 的两处 EngineIdentityMismatch
    之后才写进 stats，身份不符会先抛异常。**书名收紧（rvauthor CE3）**：搜索阶段 title_compatible
    允许前缀兼容（系列卷号），但前缀兼容可能是**另一本书**（《万古仙穹》vs《万古仙穹外传》）；
    回写把原本 review 的错书变成入库，故此处要求 _norm_title 完全相等才回写，只前缀兼容的保持
    作者为空、照旧进 review。toc_title 为空（源没自报标题）时无从确认完全相等 → 不回写（保守）。
    名单作者非空 ⇒ 恒 '' ⇒ 行为完全不变。不触碰作者歧义护栏（搜索阶段已判）。"""
    if (list_author or '').strip():
        return ''
    if douban_list._norm_title(list_title) != douban_list._norm_title(toc_title) \
            or not (toc_title or '').strip():
        return ''
    return _clean_engine_author(toc_author)


def _build_engine_cli(env: dict):
    """按 .env 装配并探测 EngineCli；开关关闭/配置缺失/探针失败 → 返回 None。

    需三者齐备：LABELER_ENGINE_FALLBACK=1 + LABELER_ENGINE_CLI（engine-fetch.mjs 绝对路径）
    + DATABASE_URL。node 路径由 LABELER_ENGINE_NODE 覆盖（默认 'node'）。
    探针会真实加载 CLI 的 TS 依赖但不访问 DB/网络，提前暴露旧 loader 等部署故障。
    凭据红线：DATABASE_URL 只交给 EngineCli 经子进程 env 注入，不打印。"""
    if not douban_list.engine_fallback_enabled(env):
        return None
    cli_path = (env.get('LABELER_ENGINE_CLI') or '').strip()
    database_url = env.get('DATABASE_URL') or ''
    if not cli_path or not database_url:
        print('  提示: LABELER_ENGINE_FALLBACK 已开，但缺 LABELER_ENGINE_CLI 或 '
              'DATABASE_URL，本轮降级 book15-only')
        return None
    node = (env.get('LABELER_ENGINE_NODE') or 'node').strip() or 'node'
    cli = douban_list.EngineCli(node=node, script_path=cli_path,
                                database_url=database_url)
    try:
        douban_list.validate_engine(cli)
    except douban_list.EngineUnavailable as e:
        print(f'  错误: LABELER_ENGINE_FALLBACK 已开，但引擎启动探针失败: {e}',
              file=sys.stderr)
        return None
    return cli


# ---- 引擎正文翻页停止点（lblqual41）----
# cuoceng 的 nextContentUrl 规则指向「下一章」，CLI content 又不知道目录，于是每章都翻满 20 页串进后续
# 章节（phoenix 实测一次调用 8.2 s、7.7 万字；目录序还与「下一章」链序不同，只给下一章拦不住）。
# 这里包一层 CLI：toc 成功后把整本目录写进临时文件，之后对目录内章节的 content 追加
# --stop-urls-file（翻到目录里任一章即停）。包在 CLI 外面而不是改逐章循环：主源/备选源各自先取 toc，
# 停止点跟着切换，取文循环本身零改动。
STOP_URLS_FLAG = '--stop-urls-file'
# 「不认识该参数」的报错形态（node 的 util.parseArgs / argparse / 自写 CLI 的常见措辞）。
# 只认这类才降级；新 CLI 自己报的「--stop-urls-file 无法读取」不含这些词，不算旧 CLI。
_UNKNOWN_OPTION_RE = re.compile(r'未知参数|未知选项|无法识别|unrecognized|unknown option', re.I)


class EngineStopUrls:
    """引擎 CLI 包装：记住最近一次 toc 的整本目录，给该目录内章节的 content 带上停止点清单。

    旧 CLI 不认这个参数（rc=2 且 stderr 点名它，部署顺序颠倒时）→ 本轮降级为不带停止点并重试一次，
    行为同改前。其余属性/方法原样转给被包装的 CLI。"""

    def __init__(self, cli, directory: str | None = None):
        self._cli = cli
        fd, self.path = tempfile.mkstemp(prefix='labeler-stop-urls-', suffix='.txt', dir=directory)
        os.close(fd)
        atexit.register(self._cleanup)
        self._urls: frozenset[str] = frozenset()
        self.supported = True

    def __getattr__(self, name):
        return getattr(self._cli, name)

    def _cleanup(self) -> None:
        try:
            os.unlink(self.path)
        except OSError:
            pass

    def _remember_toc(self, stdout: str) -> None:
        try:
            chapters = json.loads(stdout).get('chapters') or []
            urls = [c['url'] for c in chapters if isinstance(c, dict) and c.get('url')]
        except (ValueError, AttributeError, TypeError):
            urls = []
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write(''.join(u + '\n' for u in urls))
        self._urls = frozenset(urls)

    def run(self, subcommand: str, *args: str):
        url = args[1] if len(args) >= 2 and args[0] == '--url' else None
        if subcommand == 'content' and self.supported and url in self._urls:
            proc = self._cli.run(subcommand, *args, STOP_URLS_FLAG, self.path)
            # 只认「不认识这个参数」类报错（旧 CLI）。新 CLI 自己报的「--stop-urls-file 无法读取」
            # 也是 rc=2 且 stderr 含该参数名，不能当成旧 CLI 把整轮停止点静默关掉（lblqualfix41，复审非阻断①）。
            if proc.returncode != 2 or not _UNKNOWN_OPTION_RE.search(proc.stderr or ''):
                return proc
            self.supported = False
            print(f'  提示: 引擎 CLI 不支持 {STOP_URLS_FLAG}（旧版），本轮取正文不带翻页停止点',
                  file=sys.stderr)
        proc = self._cli.run(subcommand, *args)
        if subcommand == 'toc':
            if proc.returncode == 0:
                self._remember_toc(proc.stdout)
            else:
                self._urls = frozenset()
        return proc


# ---- 打标层（将来可整体搬进主应用）----
SEGMENT_CHARS = 250_000  # 每段字数上限（~160k tokens，远离 CF 100s prefill 死区）

MERGE_PROMPT_SUFFIX = (
    "以上是前一次阅读（全书开头部分）得到的初步结论。现在给出后续文本，"
    "请结合两者输出合并后的最终 JSON 对象（同样只要 JSON，不要多余文字），"
    "修正和补充初步结论中只看开头会误判的字段（如 pace、weaknesses、plot_stage）。"
    "text_quality 与 text_quality_evidence 只按【后续文本】判断，不要沿用前次结论。"
)

# ---- 文本质量判定合并（lbladfix41）----
# 分两段时，旧实现直接用第二段的 JSON，而第二段拿着第一段的完整结论（含 text_quality），开头的公告/感言
# 让「含广告注入」一路延续到最终结果（lbladdiag-41-report §3）。现在两段各自判 text_quality，代码合并：
# 任一段「正常」且其余段没给证据 → 正常；否则取最严重的判定，证据合并。未知取值按最严重算（照旧拒收）。
TEXT_QUALITY_NORMAL = '正常'
TEXT_QUALITY_AD = '含广告注入'
_TEXT_QUALITY_SEVERITY = {TEXT_QUALITY_NORMAL: 0, TEXT_QUALITY_AD: 1, '大面积重复': 2, '疑似乱码': 3}
_UNKNOWN_QUALITY_SEVERITY = 4
# 模型输出缺 text_quality 或给空串（lblfu41 审查后，主会话裁定）：按未知取值处理、走拒收路径，不按正常入库。
# 只在打标端这样判；导入端 import_one.py 对历史 jsonl 里缺该字段的行照旧放行（回迁重导要兼容）。
TEXT_QUALITY_MISSING = '（缺失）'
EVIDENCE_MAX_ITEMS = 3
EVIDENCE_MAX_CHARS = 50


# ---- main() 质量门：含广告注入降级入库（lbladfix41）----
# 判「含广告注入」但书名核验为 JSON true 且 confidence ≥ AD_DOWNGRADE_MIN_CONFIDENCE → 照常入库，
# labels.jsonl 行上加 quality_flag=ad_injection 与证据（导入端据 quality_flag 放行，见 import_one.py）。
# 其余非「正常」取值（大面积重复/疑似乱码/未知）照旧拒收。
AD_DOWNGRADE_MIN_CONFIDENCE = 0.8
AD_QUALITY_FLAG = 'ad_injection'
AD_REJECT_REASON = f'文本质量异常: {TEXT_QUALITY_AD}'
AD_GATE_FIELD = 'ad_gate'       # 新门槛下的广告拒收行带此字段（值=门槛版本），count_rejections 据此区分新旧
AD_GATE_VERSION = 2


def _confidence(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def ad_injection_downgradable(labels: dict) -> bool:
    """含广告注入能否降级入库：site_title_match 是 JSON true 且 confidence ≥ 0.8。"""
    conf = _confidence(labels.get('confidence'))
    return (labels.get('text_quality') == TEXT_QUALITY_AD
            and labels.get('site_title_match') is True
            and conf is not None and conf >= AD_DOWNGRADE_MIN_CONFIDENCE)


def normalize_evidence(value) -> list[str]:
    """模型给的 text_quality_evidence → 至多 3 条、每条 ≤50 字的字符串列表（非法值 → []）。"""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip()[:EVIDENCE_MAX_CHARS])
        if len(out) >= EVIDENCE_MAX_ITEMS:
            break
    return out


def normalize_text_quality(value) -> object:
    """模型给的 text_quality → 归一值（纯函数）：字符串去首尾空白（`正常 ` 算正常，lblfurev 发现 3）；
    缺失（None）或空串 → TEXT_QUALITY_MISSING；其他类型原样返回（按未知取值处理）。"""
    if value is None:
        return TEXT_QUALITY_MISSING
    if isinstance(value, str):
        return value.strip() or TEXT_QUALITY_MISSING
    return value


def merge_text_quality(segments: list[dict]) -> tuple[object, list[str]]:
    """各段标签 → (合并后的 text_quality, 合并后的证据)。text_quality 先过 normalize_text_quality，
    某段缺该字段 / 空串按未知取值参与合并；没有任何 dict 段 → (None, [])。"""
    judged = [(normalize_text_quality(seg.get('text_quality')),
               normalize_evidence(seg.get('text_quality_evidence')))
              for seg in segments if isinstance(seg, dict)]
    if not judged:
        return None, []
    # 未知取值（不在枚举里 / 非字符串）不被「正常」段盖掉（lblfu41，lbladrev 非阻断2）：回复没守枚举约定，
    # 这一段文本正不正常无从判断，静默改判「正常」会让它直接入库；按最严重走拒收路径，与单段时一致。
    unknown = any(not isinstance(q, str) or q not in _TEXT_QUALITY_SEVERITY for q, _ in judged)
    others = [ev for q, ev in judged if q != TEXT_QUALITY_NORMAL]
    if not unknown and any(q == TEXT_QUALITY_NORMAL for q, _ in judged) and not any(others):
        return TEXT_QUALITY_NORMAL, []
    worst = max((q for q, _ in judged),
                key=lambda q: _TEXT_QUALITY_SEVERITY.get(q, _UNKNOWN_QUALITY_SEVERITY)
                if isinstance(q, str) else _UNKNOWN_QUALITY_SEVERITY)
    evidence: list[str] = []
    for _, ev in judged:
        for item in ev:
            if item not in evidence and len(evidence) < EVIDENCE_MAX_ITEMS:
                evidence.append(item)
    return worst, evidence


MODEL_RETRY = 2            # 打标时每个模型最多尝试次数

# ---- LLM 输出预算与失败归因（llmchan41 §4）----
# glm-5.3-agent 坏 JSON 的大头：思考段把 max_tokens=1800 吃光，可见 JSON 截在中途（网关
# completion_tokens 成片恰好 1800）；另有上游秒回空（char 0）。所以：预算提到 6000 且可按模型覆盖；
# content 空时从 reasoning_content 兜底取 JSON；截断/空回单独报错并直接换模型（同模型同预算重试
# 大概率同样结果）；非 2xx 把脱敏截断后的响应体写进日志（此前只有「HTTP Error 400: Bad Request」）。
DEFAULT_MAX_TOKENS = 6000
MAX_TOKENS_ENV = 'LABELER_MAX_TOKENS'
HTTP_BODY_SUMMARY_CHARS = 200


class LlmOutputTruncated(RuntimeError):
    """输出触顶 max_tokens（finish_reason=length 或 completion_tokens≥上限）且拿不到完整 JSON。"""


class LlmEmptyReply(RuntimeError):
    """上游空回：content 为空，reasoning_content 里也没有可用 JSON，且未触顶。"""


def resolve_max_tokens(env: dict | None = None) -> dict:
    """LABELER_MAX_TOKENS → {'*': 默认上限, 模型名: 覆盖}。

    写法：「6000」或「6000,glm-5.3-agent=12000」（逗号分隔，裸数字=默认，模型=数字=覆盖）。
    非正整数的项忽略并告警，绝不因一个配置项拖垮整轮；缺省 DEFAULT_MAX_TOKENS。"""
    cfg = {'*': DEFAULT_MAX_TOKENS}
    raw = str((env or {}).get(MAX_TOKENS_ENV) or '').strip()
    for item in (p.strip() for p in raw.split(',')):
        if not item:
            continue
        model, _, value = item.rpartition('=')
        try:
            limit = int(value.strip())
        except ValueError:
            limit = 0
        if limit <= 0:
            print(f'  提示: {MAX_TOKENS_ENV} 项「{item}」不是正整数，已忽略', file=sys.stderr)
            continue
        cfg[model.strip() or '*'] = limit
    return cfg


def max_tokens_for(model: str, cfg: dict | None) -> int:
    cfg = cfg or {}
    return cfg.get(model) or cfg.get('*') or DEFAULT_MAX_TOKENS


def _redact(text: str, secrets: tuple = ()) -> str:
    """日志脱敏：已知秘密原值、URL、Bearer 令牌、sk- 形态密钥一律抹掉。"""
    for secret in secrets:
        if secret:
            text = text.replace(secret, '[redacted]')
    text = re.sub(r'\S*://\S*', '[redacted-url]', text)
    text = re.sub(r'(?i)bearer\s+\S+', 'Bearer [redacted]', text)
    return re.sub(r'\bsk-[A-Za-z0-9_\-]{6,}', 'sk-[redacted]', text)


def _http_error_message(error: urllib.error.HTTPError, secrets: tuple = ()) -> str:
    """非 2xx → 「HTTP Error 400: Bad Request | 响应体: …」（单行、脱敏、截断）。
    保留「HTTP Error <code>」前缀，旧日志的 grep 口径不变。"""
    try:
        body = error.read(4096).decode('utf-8', 'replace')
    except Exception:       # noqa: BLE001 —— 响应体读不到不能掩盖原错误
        body = ''
    summary = ' '.join(_redact(body, secrets).split())[:HTTP_BODY_SUMMARY_CHARS]
    return f'HTTP Error {error.code}: {error.reason} | 响应体: {summary or "（空）"}'


def _read_llm_stream(lines) -> dict:
    """SSE 流 → {content, reasoning, finish_reason, completion_tokens}（纯函数，可离线单测）。
    reasoning 兼容 reasoning_content / reasoning 两种字段名；usage 块出现才有 completion_tokens。"""
    content, reasoning = [], []
    finish_reason, completion_tokens = None, None
    for raw in lines:
        line = (raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)).strip()
        if not line.startswith('data: ') or line == 'data: [DONE]':
            continue
        try:
            chunk = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if not isinstance(chunk, dict):
            continue
        usage = chunk.get('usage')
        if isinstance(usage, dict) and isinstance(usage.get('completion_tokens'), int):
            completion_tokens = usage['completion_tokens']
        choices = chunk.get('choices')
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            continue
        delta = choices[0].get('delta')
        if isinstance(delta, dict):
            for key, sink in (('content', content), ('reasoning_content', reasoning),
                              ('reasoning', reasoning)):
                if isinstance(delta.get(key), str):
                    sink.append(delta[key])
        if choices[0].get('finish_reason'):
            finish_reason = choices[0]['finish_reason']
    return {'content': ''.join(content), 'reasoning': ''.join(reasoning),
            'finish_reason': finish_reason, 'completion_tokens': completion_tokens}


def _strip_fence(text: str) -> str:
    text = text.strip()
    if text.startswith('```'):
        parts = text.split('\n', 1)
        text = parts[1].rsplit('```', 1)[0].strip() if len(parts) > 1 else ''
    return text


def _json_object_in(text: str) -> dict | None:
    """整段就是 JSON 对象则用它；否则取文本里**最后一个**完整的顶层 JSON 对象
    （思考段通常是「推理文字 … 最终 JSON」）。没有则 None。"""
    text = _strip_fence(text)
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None   # 整段是对象：同旧口径（含 {}）
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    found, i = None, text.find('{')
    while i != -1:
        try:
            value, end = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            i = text.find('{', i + 1)
            continue
        if isinstance(value, dict) and value:
            found = value
        i = text.find('{', end)
    return found


def _labels_from_reply(reply: dict, max_tokens: int) -> tuple[dict, str]:
    """流式回复 → (标签 dict, 取自 'content'|'reasoning')；失败按原因抛不同异常。"""
    tokens = reply.get('completion_tokens')
    truncated = reply.get('finish_reason') == 'length' or (
        isinstance(tokens, int) and tokens >= max_tokens)
    budget = (f'finish_reason={reply.get("finish_reason")}，'
              f'completion_tokens={tokens if tokens is not None else "未知"}/max_tokens={max_tokens}')
    content = (reply.get('content') or '').strip()
    if content:
        labels = _json_object_in(content)
        if labels is not None:
            return labels, 'content'
        if truncated:
            raise LlmOutputTruncated(f'输出被截断（{budget}，content {len(content)} 字未成完整 JSON）')
        json.loads(_strip_fence(content))    # 抛出原始解析错误（保持旧日志口径）
        raise ValueError('标签不是 JSON 对象')
    reasoning = (reply.get('reasoning') or '').strip()
    if reasoning:
        labels = _json_object_in(reasoning)
        if labels is not None:
            return labels, 'reasoning'
    if truncated:
        raise LlmOutputTruncated(f'输出被截断（{budget}，思考内容耗尽输出预算，content 为空）')
    raise LlmEmptyReply(f'上游空回（content 为空{"，reasoning 无可用 JSON" if reasoning else ""}，'
                        f'finish_reason={reply.get("finish_reason")}）')


def _log_model(context: str, message: str) -> None:
    stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f'    [{stamp}] [pid={os.getpid()}] [{context or "单段"}] {message}',
          file=sys.stderr, flush=True)


def label_book(text: str, api_key: str, models: list[str],
               site_title: str = '', site_author: str = '',
               max_tokens: dict | None = None) -> tuple[dict, int]:
    """50 万字文本 → (标签 dict, 实际调用次数)。
    两段式：每段 ≤25 万字独立过 CF 100s 线（实测 40 万字单段 prefill 必撞 524）。
    第二段带第一段结论合并，可修正只看开头的误判；text_quality 两段各判、按 merge_text_quality 合并。
    site_title / site_author 为本次来源站点书目，附加打标验证段供成分判定。
    models 为后备模型链（如 bohe → grok → ...），逐段内按链逐个尝试。
    max_tokens = resolve_max_tokens(env) 的结果（按模型的输出上限），None 用默认。"""
    verification = _build_verification(site_title, site_author)
    context = f'书目={site_title or "（未知）"}'
    if len(text) <= SEGMENT_CHARS:
        return _label_once(text, api_key, models, verification,
                           context=f'{context} 分段=1/1', max_tokens=max_tokens), 1
    seg1, seg2 = text[:SEGMENT_CHARS], text[SEGMENT_CHARS:]
    labels1 = _label_once(seg1, api_key, models, verification,
                          context=f'{context} 分段=1/2', max_tokens=max_tokens)
    merged_user = (
        "【前次阅读结论】\n" + json.dumps(labels1, ensure_ascii=False)
        + "\n\n【后续文本】\n" + seg2 + MERGE_PROMPT_SUFFIX
    )
    labels2 = _label_once(merged_user, api_key, models, verification,
                          context=f'{context} 分段=2/2', max_tokens=max_tokens)
    quality, evidence = merge_text_quality([labels1, labels2])
    if quality is not None:
        labels2['text_quality'] = quality
        labels2['text_quality_evidence'] = evidence
    return labels2, 2


def _label_once(user_content: str, api_key: str, models: list[str],
                verification: str = '', *, context: str = '',
                max_tokens: dict | None = None) -> dict:
    """单次 LLM 调用。流式。对链中每个模型最多试 MODEL_RETRY 次，
    某模型连续 MODEL_RETRY 次失败即切换下一个；全部模型耗尽才算本次失败。
    输出被截断 / 上游空回不在同模型上重试（同预算重试大概率同样结果），直接换下一个模型。"""
    if not models:
        raise RuntimeError('模型链为空，无法打标')
    _log_model(context, f'开始分段，模型链从链首 {models[0]} 开始')
    last_err = None
    current = models[0]
    for model in models:
        if model != current:
            _log_model(context, f'切换模型: {current} -> {model}')
            current = model
        limit = max_tokens_for(model, max_tokens)
        for attempt in range(MODEL_RETRY):
            body = json.dumps({
                'model': model, 'stream': True, 'max_tokens': limit,
                'messages': [
                    {'role': 'system', 'content': SYSTEM_PROMPT},
                    {'role': 'user', 'content': user_content + verification},
                ],
            }).encode('utf-8')
            try:
                req = urllib.request.Request(
                    LLM_URL, data=body, method='POST',
                    headers={**UA, 'Content-Type': 'application/json',
                             'Authorization': f'Bearer {api_key}'})
                _log_model(context, f'请求模型 {model} 尝试 {attempt + 1}/{MODEL_RETRY}'
                                    f'（max_tokens={limit}）')
                try:
                    with urllib.request.urlopen(req, timeout=300) as res:
                        reply = _read_llm_stream(res)
                except urllib.error.HTTPError as http_error:
                    # 响应体摘要进日志（脱敏+截断）；换成 RuntimeError，不让带未读 body 的异常外泄
                    raise RuntimeError(_http_error_message(http_error, (api_key,))) from None
                parsed, origin = _labels_from_reply(reply, limit)
                note = '（content 为空，取自 reasoning_content）' if origin == 'reasoning' else ''
                _log_model(context, f'模型 {model} 尝试 {attempt + 1}/{MODEL_RETRY} 成功{note}')
                return parsed
            except (LlmOutputTruncated, LlmEmptyReply) as e:
                last_err = e
                _log_model(context, f'模型 {model} 尝试 {attempt + 1}/{MODEL_RETRY} 失败: {e}；'
                                    f'不在同模型重试，直接换下一个')
                time.sleep(20)
                break
            except Exception as e:
                last_err = e
                _log_model(context, f'模型 {model} 尝试 {attempt + 1}/{MODEL_RETRY} 失败: {e}')
                time.sleep(20 * (attempt + 1))
        # 该模型 MODEL_RETRY 次全失败，若还有下一个模型则继续循环切换
    raise RuntimeError(f'打标失败: 模型链 {models} 全部耗尽, 最后错误: {last_err}')


# ---- 入库层 ----
# 试点期产物为 labels.jsonl（每行一本）；批量入库由本地用项目的
# @neondatabase/serverless 驱动统一执行（scripts/import_labels.mjs）。
# 全自动增量导入（2026-09-19 起）：每标完一本即调 import_one.py 走 Neon 的 HTTPS
# SQL 接口写库——同样零 PG 依赖（与上面读 label_model 同一通道），
# 消灭「打标在跑、书库没书」的错位。失败只记 labels-import-fail.log 不阻断打标；
# 用 labels-imported.jsonl 去重，重复导入同一 url 是 no-op。开关：.env 里
# LABELER_AUTO_IMPORT=0 可关闭（默认开），LABELER_IMPORT_BACKLOG 调每轮补录上限。


def title_matches(guess: str, actual: str) -> bool:
    """书名模糊匹配:去空白后相等 / 一方包含另一方 / 去掉《》和空格后相等。"""
    g, a = (guess or '').strip(), (actual or '').strip()
    if not g or not a:
        return False
    if g == a or g in a or a in g:
        return True
    clean = lambda s: re.sub(r'[《》\s]', '', s)
    cg, ca = clean(g), clean(a)
    return bool(cg) and cg == ca


# ---- 断点续传 / 钉子户终态（纯函数，可离线单测）----
def _read_url_lines(path: Path):
    """逐行解析 jsonl，产出非空 url 字符串。文件不存在 / 空行 / 坏行一律跳过。"""
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            url = json.loads(line).get('url') or ''
        except (json.JSONDecodeError, AttributeError):
            # 坏行（截断的 json / 非对象）不能拖垮整轮：跳过继续
            continue
        if isinstance(url, str) and url:
            yield url


def _read_rejection_rows(path: Path):
    """labels-rejected.jsonl → 逐行产出 (url, reason, 行对象)。文件不存在 / 空行 / 坏行跳过。"""
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            url = rec.get('url') or ''
            reason = rec.get('reason') or ''
        except (json.JSONDecodeError, AttributeError):
            continue
        if isinstance(url, str) and url:
            yield url, reason if isinstance(reason, str) else '', rec


def load_done_urls(path: Path) -> set[str]:
    """labels.jsonl → 已成功产出的详情页 url 集合（断点续传口径）。"""
    return set(_read_url_lines(path))


def load_stub_urls(path: Path) -> set[str]:
    """labels-stub.jsonl → 残本候选 url 集合。

    P1 修复：残本候选一旦命中即记入本文件，下轮与 done_urls 同口径参与跳过——
    不再每轮占住 --limit 名额、把正常书永久挡在队尾（残本 + 小 limit 时 exit 0 的饥饿）。
    人工删掉本文件里某行即把该书重新并入候选（与 rejected/钉子户的恢复方式一致）。"""
    return set(_read_url_lines(path))


def count_rejections(path: Path) -> dict[str, int]:
    """labels-rejected.jsonl → {url: 被拒次数}（每行 = 一次拒收）。

    本地预检拒收（reason 以「本地预检:」开头）不计入：它是规则判定，不是内容本身的问题，
    规则一改结论就变；计入的话误杀的合格书会在 5 次后成钉子户、只能人工删行恢复
    （lblqualfix41，复审非阻断②）。模型判定与字数不足等其余拒收照旧计数。

    lbladfix41：旧质量门下的「含广告注入」拒收（行上没有 ad_gate 字段）不计入——那道门已换成
    「书名核验通过且置信度够就降级入库」，旧拒收大多是清洗漏网加硬拒造成的，应按新门槛重试。
    新门槛下仍被拒的（核验不过或置信度不够）带 ad_gate 字段，照旧计数。降级入库不写 rejected，自然不计。"""
    counts: dict[str, int] = {}
    for url, reason, rec in _read_rejection_rows(path):
        if reason.startswith('本地预检:'):
            continue
        if reason == AD_REJECT_REASON and AD_GATE_FIELD not in rec:
            continue
        counts[url] = counts.get(url, 0) + 1
    return counts


def terminal_urls(counts: dict[str, int],
                  threshold: int = REJECT_TERMINAL_THRESHOLD) -> set[str]:
    """被拒次数 ≥ threshold 的 url = 钉子户终态名单。threshold ≤ 0 表示关闭该机制。"""
    if threshold <= 0:
        return set()
    return {url for url, n in counts.items() if n >= threshold}


def split_queue(books: list[dict], done_urls: set[str],
                pinned: set[str],
                source: BookSource | None = None) -> tuple[list[dict], list[dict], list[dict]]:
    """榜单 → (待处理, 已完成跳过, 钉子户终态跳过)。

    两个跳过名单**互斥**：已在 labels.jsonl 的书优先算「已完成」，不再算「钉子户」——
    它被拒过是历史，后来已成功，不该继续占用终态名额。
    书的站内相对路径经书源适配器归一到绝对 URL 后与跳过名单比对。"""
    src = source or BOOK15
    todo: list[dict] = []
    skipped_done: list[dict] = []
    skipped_pinned: list[dict] = []
    for b in books:
        url = src.absolute(b['url'])
        if url in done_urls:
            skipped_done.append(b)
        elif url in pinned:
            skipped_pinned.append(b)
        else:
            todo.append(b)
    return todo, skipped_done, skipped_pinned


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=100)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--book', help='指定单本详情页路径，如 /books/details3168.html')
    ap.add_argument('--no-db-model', action='store_true',
                    help='不读数据库 app_settings.label_model，直接用 .env 的模型链')
    ap.add_argument('--source', choices=('rank', 'douban', 'webnovel'), default='rank',
                    help='选书来源：rank=book15 榜单页（默认，行为不变）；'
                         'douban=豆瓣网文 tag 名单经 book15 站内搜索映射；'
                         'webnovel=网文站榜单（起点完本/月票/畅销）为主+豆瓣 tag 补充')
    ap.add_argument('--categories', default=None,
                    help='仅 --source rank 生效：逗号分隔的分类 ID（list-t-N），如 "23" 或 '
                         '"3,21"；none/空串=关闭（默认），all=全部分类 '
                         f'{CATEGORY_PAGES}（小时级扫页，慎用）')
    ap.add_argument('--max-pages', type=int, default=None,
                    help=f'每个分类最多抓取的页数（默认 {CATEGORY_MAX_PAGES}，即以页内尾页为准）')
    args = ap.parse_args()

    env = load_env()
    models, model_source = resolve_models(env, use_db=not args.no_db_model)
    print(f'打标模型来源: {model_source}')
    print(f'模型链: {models}')
    max_tokens = resolve_max_tokens(env)
    print(f'输出上限 max_tokens: {max_tokens}')
    # 断点续传：已写入 labels.jsonl 的书跳过（按详情页 url 判定）
    done_urls = load_done_urls(data_path('labels.jsonl'))
    # 钉子户终态：历史被拒 ≥ REJECT_TERMINAL_THRESHOLD 次的书同样跳过，
    # 与 done_urls 同等地位（都算「本轮不处理」），止住每轮白烧的 LLM 调用。
    rejection_counts = count_rejections(data_path('labels-rejected.jsonl'))
    # 显式把常量传进去（而不是靠默认参数）：默认参数在 def 时就求值了，
    # 读模块常量本意是「改常量即调参/关闸（0 或负数关闭）」，这里保持这个语义。
    pinned = terminal_urls(rejection_counts, REJECT_TERMINAL_THRESHOLD)
    # 残本候选终态（P1）：历史命中残本判据的书与 done_urls 同口径跳过，
    # 不再每轮占住 --limit 名额把正常书挡死。空文件 / 未开分类时为空集，行为不变。
    stub_urls = load_stub_urls(data_path('labels-stub.jsonl'))

    # T5 引擎兜底 CLI：仅 douban/webnovel 名单线用（下方分支按 .env 装配）；
    # rank / --book 线保持 None，取正文只走 book15，行为不变。
    engine_cli = None

    # 自动导入：打标完一本即写库（见文件头「入库层」）。启用与否由 .env 决定；
    # --book 是人工调试模式（无站点书名、身份证据弱），不进自动导入。
    importer = None
    if not args.book:
        import import_one
        importer = import_one.AutoImporter.from_env(env, directory=data_dir())
        print(importer.status_line())
        if not importer.enabled and args.source in ('douban', 'webnovel'):
            print(f'  提示: 自动导入未启用（{importer.disabled_reason}），'
                  f'产物仍只进 labels.jsonl，需人工跑 import_labels.mjs')
        if not args.dry_run and importer.enabled:
            # 历史欠账（上次导入失败 / 部署前的存量）自动补录；标记文件保证幂等。
            # .env 值坏掉（非数字）不能拖垮整轮 → 回落到默认上限。
            try:
                limit = int(env.get(import_one.BACKLOG_ENV) or import_one.IMPORT_BACKLOG_DEFAULT)
            except ValueError:
                limit = import_one.IMPORT_BACKLOG_DEFAULT
            retried = importer.retry_backlog(data_path('labels.jsonl'), limit=limit)
            if retried:
                print(f'  自动导入: 补录了 {retried} 本历史欠账')

    if args.book:
        queue = [{'url': args.book, 'title': args.book}]
    else:
        if args.source in ('douban', 'webnovel'):
            # 名单选书：豆瓣网文 tag / 网文站榜单 → book15 站内搜索（含误匹配校验）。
            # 产出与 fetch_rank_books() 同构，后续打标循环零改动复用。
            print('拉取名单并搜索 book15...')
            # 桥接：名单源（豆瓣/起点）传完整 URL，book15 搜索侧传站内相对路径。
            bridged = lambda path: http_get(BOOK15.absolute(path))
            # 搜索前跳过已打标书名（审查 D.3「收益最大的一刀」）：缓存是优化，
            # 跳过已完成再搜是正确性——否则扩容后稳态每轮全量空搜。
            skip_titles = douban_list.load_done_titles(data_path('labels.jsonl'))
            # 豆瓣翻页默认 1 页；.env 里 LABELER_DOUBAN_PAGES=3 才开 3 页（审查 D.3）。
            pages = douban_list.resolve_douban_pages(env)
            # T5 引擎兜底：book15 miss 才回落引擎源池（开关默认关，配置缺失自动降级）。
            engine_cli = _build_engine_cli(env)
            if engine_cli is not None:
                print('  引擎兜底已启用：book15 miss 将回落引擎源池')
                engine_cli = EngineStopUrls(engine_cli)
            # book15 熔断（labelerdiag41）：整站挂掉时别让每本 3 次全失败把一轮拖成十几小时。
            book15_breaker = douban_list.Book15Breaker(douban_list.resolve_book15_breaker(env))
            all_books = (douban_list.build_douban_queue(
                             bridged, skip_titles=skip_titles, pages=pages,
                             engine_cli=engine_cli, book15_breaker=book15_breaker)
                         if args.source == 'douban'
                         else douban_list.build_webnovel_queue(
                             bridged, skip_titles=skip_titles, pages=pages,
                             engine_cli=engine_cli, book15_breaker=book15_breaker))
            print(f'{args.source} 线共 {len(all_books)} 本（搜索命中后）')
        else:
            print('拉取榜单书目...')
            rank_books = fetch_rank_books()
            print(f'榜单共 {len(rank_books)} 本（去重后）')
            all_books = rank_books
            # 扩源：分类列表页（list-t-N）叠加在 rank 线上，并进同一去重池（榜单路在前）。
            # 默认关闭（parse_categories(None)=()）；须显式 --categories 才开。
            cat_ids = parse_categories(args.categories)
            if cat_ids:
                max_pages = (args.max_pages if args.max_pages is not None
                             else CATEGORY_MAX_PAGES)
                if max_pages < 1:
                    sys.exit('--max-pages 必须 ≥ 1')
                print(f'拉取分类列表书目（{len(cat_ids)} 类，每类最多 {max_pages} 页）...')
                # 显式传 CATEGORY_PAGE_DELAY（同 REJECT_TERMINAL_THRESHOLD 的理由：
                # 默认参数在 def 时就求值了，显式传才是「改常量即调参」）。
                cat_books = fetch_category_books(cat_ids, max_pages, CATEGORY_PAGE_DELAY)
                all_books = merge_books(rank_books, cat_books)
                print(f'分类入口新增 {len(all_books) - len(rank_books)} 本候选'
                      f'（分类页去重后 {len(cat_books)} 本，'
                      f'与 rank 并集去重后 {len(all_books)} 本）')
        # --limit 切在 split_queue **之后**（审查 F.1）：命中数一旦 > limit，切在前缀会
        # 让队尾（多半是豆瓣/17K 尾部 / 分类新书）永远进不了视野——每轮只处理前 limit 条，
        # 做完进 done_urls，之后每轮 queue=[] 却仍全量搜索。先剔除已完成/钉子户/残本再取上限，
        # 语义 = 「本轮最多打 limit 本**未完成**的书」。stub_urls 折进 done 侧一并跳过（P1）。
        queue, skipped_done, skipped_pinned = split_queue(
            all_books, done_urls | stub_urls, pinned)
        queue = queue[:args.limit]
        # X = 本轮跳过总数（已完成 + 钉子户终态，互斥不重叠），Y = 其中因钉子户终态跳过的。
        print(f'本轮处理 {len(queue)} 本（跳过已完成 {len(skipped_done) + len(skipped_pinned)} 本'
              f'（含钉子户 {len(skipped_pinned)} 本））')
        for b in skipped_pinned:
            print(f'  钉子户终态：跳过（历史被拒 {rejection_counts[BOOK15.absolute(b["url"])]} 次）'
                  f' {b.get("title")} | {b["url"]}')

    if args.dry_run:
        for b in queue:
            # 引擎兜底命中的条目标注来源 host，便于人工核对多源供给。
            engine_tag = f' | 引擎源:{b.get("source_host")}' if b.get('engine') else ''
            print(' -', b.get('title'), '|', b.get('author', '?'), '|',
                  b.get('category', '?'), '|', b.get('status', '?'), '|',
                  b['url'], engine_tag)
        return 0

    ok = fail = stub_skipped = 0
    fail_kinds: dict[str, int] = {}
    # giveup41：本轮按 host 累计「源失效」放弃次数，达阈值后后续条目不再请求该 host。
    source_giveups = SourceGiveupTracker(DEAD_HOST_GIVEUPS)

    def count_failure(kind: str) -> None:
        fail_kinds[kind] = fail_kinds.get(kind, 0) + 1
    import_failures = 0

    def record_stub(book: dict, reason: str) -> None:
        """残本候选跳过：记 labels-stub.jsonl（不写 rejected、不占钉子户名额），
        下轮据此跳过（P1 修复）。人工删该行即重新并入候选。"""
        print(f'  残本候选：{reason}，跳过并记入 labels-stub.jsonl（下轮不再取，人工删行可恢复）')
        rec = {'url': BOOK15.absolute(book['url']),
               'title': book.get('title', ''), 'reason': reason}
        with open(data_path('labels-stub.jsonl'), 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')

    for i, b in enumerate(queue, 1):
        print(f'[{i}/{len(queue)}] {b.get("title")} ...')
        fetch_stats: dict = {}      # 引擎取文统计（lbladfix41：跳过的公告条目 / 试读章数）
        try:
            # 引擎兜底条目走 CLI 取正文（toc/content，不过 clean_chapter_text）；
            # rank/分类线走 book15 惰性元数据路径；douban/webnovel 候选已带元数据、--book
            # 无元数据，二者直接取正文（行为不变）。
            if b.get('engine'):
                # N02：toc 自报身份与名单身份比对（双侧非空才比对），错书在抓正文前拦下。
                # 引擎条目 url 是绝对 host URL，绝不能走 http_get(BASE + url) 打错站。
                # giveup41：主源失效（连续多章跨站跳转/4xx，或持续 5xx）提前放弃并换备选源；
                # 换源成功则条目 url/source_host 改记实际来源（产物与入库记真实来源）。
                text, chars, used = fetch_engine_book_with_giveup(
                    engine_cli, b, source_giveups, giveup_streak=SOURCE_GIVEUP_STREAK,
                    stats=fetch_stats)
                if used['url'] != b['url']:
                    b['url'], b['source_host'] = used['url'], used['source']
                # author17k41：名单作者为空时，用已过身份校验（标题兼容）的 toc 自报作者回写
                # 记录 author，让引擎兜底书也能过 import_one 空作者护栏。名单有作者时**不动**；
                # 作者歧义护栏在搜索阶段已跑过（到这里的书都已通过），此处不绕开、不重判。
                # toc_author/toc_title 仅在目录身份校验通过后才进 fetch_stats（见 fetch_book_text_engine）。
                engine_author = engine_author_writeback(
                    b.get('author', ''), fetch_stats.get('toc_author') or '',
                    b.get('title', ''), fetch_stats.get('toc_title') or '')
                if engine_author:
                    b['author'], b['author_source'] = engine_author, 'engine_toc'
                    print(f'  引擎目录作者回写: {engine_author}（名单作者为空）')
                if fetch_stats.get('nonbody_chapters') or fetch_stats.get('preview_chapters'):
                    print(f'  取文跳过: 公告/感言条目 {fetch_stats.get("nonbody_chapters", 0)} 条，'
                          f'试读章 {fetch_stats.get("preview_chapters", 0)} 章')
            elif not args.book and args.source == 'rank':
                # 惰性元数据：rank/分类候选只带 {url,title}，这里现抓一次详情页——
                # og:novel 元数据 + 章节列表 + 全本正文都复用这份 html（共 1 次详情页请求）。
                # 把元数据写回 b，下方 reject/入库路径照旧读 b.get(...)，零改动复用。
                detail_html = http_get(BOOK15.absolute(b['url']))
                meta = parse_book_meta(detail_html)
                b['author'], b['category'], b['status'] = (
                    meta['author'], meta['category'], meta['status'])
                chapter_count = len(BOOK15.chapters_from_html(detail_html))
                # 残本候选过滤（P1/P2）：章节数已可判残本 → 先短路（不抓全本正文），
                # 命中即记 stub 侧车后跳过。chars=STUB_MIN_CHARS 使此处仅按章节数触发。
                stub_reason = is_stub_candidate(chapter_count, STUB_MIN_CHARS)
                if stub_reason:
                    record_stub(b, stub_reason)
                    stub_skipped += 1
                    continue
                text, chars = fetch_book_text(b['url'], detail_html=detail_html)
                # 章节够但正文过短的空壳页：抓完再按正文字数复判。
                stub_reason = is_stub_candidate(chapter_count, chars)
                if stub_reason:
                    record_stub(b, stub_reason)
                    stub_skipped += 1
                    continue
            else:
                text, chars = fetch_book_text(b['url'])
            # 丢过试读章的书字数不足时交给下面的本地预检按试读源拒收（不计钉子户），不在这里记字数不足
            if chars < MIN_BOOK_CHARS and not fetch_stats.get('preview_chapters'):
                print(f'  仅抓到 {chars} 字，跳过')
                reject = {
                    'site_title': '' if args.book else (b.get('title') or '').strip(),
                    'author': b.get('author', ''),
                    'category': b.get('category', ''),
                    'url': BOOK15.absolute(b['url']),
                    'reason': f'抓取字数不足: {chars}',
                }
                rej_path = data_path('labels-rejected.jsonl')
                with open(rej_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(reject, ensure_ascii=False) + '\n')
                fail += 1
                count_failure('字数不足')
                continue
            # lblqual41：调模型前的本地预检——引擎正文补过清洗层、跨章去重；试读截断源与去重后
            # 字数不足的直接跳过（不调模型、不 sleep LLM_INTERVAL）。见 prepare_book_text。
            text, chars, precheck_reason, pre = prepare_book_text(
                text, clean=bool(b.get('engine')),
                preview_dropped=fetch_stats.get('preview_chapters', 0))
            if pre['dup_lines'] or pre['clean_lines']:
                print(f'  本地预检: 去重 {pre["dup_lines"]} 行/{pre["dup_chars"]} 字，'
                      f'清洗 {pre["clean_lines"]} 行 → {chars} 字')
            if precheck_reason:
                print(f'  本地预检不合格({precheck_reason}),跳过（未调模型）')
                reject = {
                    'site_title': '' if args.book else (b.get('title') or '').strip(),
                    'author': b.get('author', ''),
                    'category': b.get('category', ''),
                    'url': BOOK15.absolute(b['url']),
                    'reason': f'本地预检: {precheck_reason}',
                }
                rej_path = data_path('labels-rejected.jsonl')
                with open(rej_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(reject, ensure_ascii=False) + '\n')
                fail += 1
                count_failure('本地预检拒收')
                continue
            # --book 的 title 是详情页路径，不作为可核验的站点书名。
            site_title = '' if args.book else (b.get('title') or '').strip()
            labels, calls = label_book(
                text, env['LLM_API_KEY'], models,
                site_title=site_title, site_author=b.get('author', ''),
                max_tokens=max_tokens)
            # 有站点书名时：原字符串匹配 或 JSON 布尔 true 任一通过即入库。
            # --book 保留跳过书名校验；榜单空书名必须拒绝，不能自动放行。
            site_match = labels.get('site_title_match') is True
            guess = labels.get('title_guess') or ''
            pass_check = bool(args.book) or (
                bool(site_title) and (title_matches(guess, site_title) or site_match))
            if not pass_check:
                reason = ('站点书名为空，无法核验' if not site_title else
                          'title_matches 未命中且 site_title_match 不是 JSON 布尔 true')
                print(f'  书名不符,疑似错书,记入 rejected(榜单: {site_title} / '
                      f'标签: {guess} / {reason})')
                reject = {
                    'site_title': site_title,
                    'author': b.get('author', ''),
                    'category': b.get('category', ''),
                    'url': BOOK15.absolute(b['url']),
                    'title_guess': guess,
                    'site_title_match': labels.get('site_title_match'),
                    'site_title_note': labels.get('site_title_note'),
                    'reason': reason,
                }
                rej_path = data_path('labels-rejected.jsonl')
                with open(rej_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(reject, ensure_ascii=False) + '\n')
                fail += 1
                count_failure('书名核验不符')
                time.sleep(LLM_INTERVAL_SEC)
                continue
            # 归一后写回：`正常 `/` 含广告注入` 按枚举值处理；缺失/空串 → TEXT_QUALITY_MISSING，下面按异常拒收
            quality = labels['text_quality'] = normalize_text_quality(labels.get('text_quality'))
            evidence = normalize_evidence(labels.get('text_quality_evidence'))
            quality_flag = None
            if quality == TEXT_QUALITY_AD and not args.book and ad_injection_downgradable(labels):
                # lbladfix41：书名核验通过且置信度够 → 降级入库（打 quality_flag），不拒收、不计钉子户
                quality_flag = AD_QUALITY_FLAG
                print(f'  文本质量: {quality}，书名核验通过且 confidence ≥ {AD_DOWNGRADE_MIN_CONFIDENCE}，'
                      f'降级入库（quality_flag={AD_QUALITY_FLAG}）证据: {evidence or "（无）"}')
            elif quality != TEXT_QUALITY_NORMAL:
                print(f'  文本质量异常({quality}),跳过')
                reject = {
                    'site_title': site_title,
                    'author': b.get('author', ''),
                    'category': b.get('category', ''),
                    'url': BOOK15.absolute(b['url']),
                    'title_guess': guess,
                    'site_title_match': labels.get('site_title_match'),
                    'site_title_note': labels.get('site_title_note'),
                    'confidence': labels.get('confidence'),
                    'text_quality_evidence': evidence,
                    'reason': f'文本质量异常: {quality}',
                }
                if quality == TEXT_QUALITY_AD:
                    reject[AD_GATE_FIELD] = AD_GATE_VERSION
                rej_path = data_path('labels-rejected.jsonl')
                with open(rej_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(reject, ensure_ascii=False) + '\n')
                fail += 1
                count_failure('内容质量拒收')
                time.sleep(LLM_INTERVAL_SEC)
                continue
            # 引擎兜底条目：source 记引擎源 host（如 www.yingsx.com）、url 记引擎源 bookUrl
            # （已是绝对，BOOK15.absolute 对 http 开头原样透传）；book15 条目现状不变。
            is_engine = bool(b.get('engine'))
            b_out = {
                'title': labels.get('title_guess') or b.get('title', ''),
                'site_title': site_title,
                'author': b.get('author', ''),
                'category': b.get('category', ''),
                'status': b.get('status', ''),
                'source': (b.get('source_host') or BOOK15.name) if is_engine else BOOK15.name,
                # 名单线选出的书记录来源标记，便于与榜单线的产出区分。
                'selected_by': (args.source if args.source != 'rank' else 'book15-rank')
                               if not args.book else 'book15-rank',
                'url': BOOK15.absolute(b['url']),
                'chars': chars,
                'labels': labels,
            }
            if quality_flag:
                b_out['quality_flag'] = quality_flag
                b_out['text_quality_evidence'] = evidence
            if b.get('author_source'):
                # author17k41：作者非名单原生（引擎 toc 回写）时留审计标记，供事后追溯
                b_out['author_source'] = b['author_source']
            print(f'  {chars} 字 | {labels.get("genre")} | conf {labels.get("confidence")} | {calls} 次调用')
            out_path = data_path('labels.jsonl')
            with open(out_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(b_out, ensure_ascii=False) + '\n')
            ok += 1
            # 即时导入书库。import_record 内部吞掉所有异常并记 fail log，
            # 这里的 try/except 只是最后一道保险：导入问题绝不能让打标循环中断。
            if importer is not None and importer.enabled:
                try:
                    import_status = importer.import_record(b_out)
                except Exception as import_error:      # pragma: no cover - 双保险
                    print(f'  自动导入异常（不阻断打标）: {import_error}', file=sys.stderr)
                    import_status = 'failed'
                if import_status == 'imported':
                    print('  → 已写入书库')
                elif import_status == 'duplicate':
                    print('  → 书库已有同书（自动导入 no-op）')
                elif import_status in ('failed', 'review', 'skipped', 'twin-skipped'):
                    # 只有 failed（异常路径）会写 labels-import-fail.log；review / skipped /
                    # twin-skipped 是**刻意不导入**，记录在 stdout 与 labels.jsonl 里，
                    # 指向 fail log 会误导操作员（审查 B.4）。
                    where = ('labels-import-fail.log' if import_status == 'failed'
                             else 'stdout / labels.jsonl')
                    print(f'  → 未自动入库（{import_status}），详见 {where}')
                if import_status == 'failed':
                    # 连续失败升级（审查 B.2）：坏配置下不能长期静默产 jsonl 却不入库。
                    import_failures += 1
                    if import_failures == AUTO_IMPORT_FAILURE_ALERT:
                        print(f'  ⚠️ 自动导入本轮已失败 {import_failures} 次，疑似 .env 配置'
                              f'或数据库不可达——打标不阻断，但产物可能没有入库：'
                              f'{getattr(importer, "last_error", "") or "（无错误详情）"}')
        except EngineIdentityMismatch as e:
            # N02：错书防线——toc 身份不符，一个 content/LLM 调用都没发起。
            # 与「抓取字数不足」同款落盘形态；不 sleep LLM_INTERVAL（没调模型）。
            print(f'  {e}')
            reject = {
                'site_title': '' if args.book else (b.get('title') or '').strip(),
                'author': b.get('author', ''),
                'category': b.get('category', ''),
                'url': BOOK15.absolute(b['url']),
                'reason': str(e),
            }
            rej_path = data_path('labels-rejected.jsonl')
            with open(rej_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(reject, ensure_ascii=False) + '\n')
            fail += 1
            count_failure(classify_failure(e))
            continue
        except Exception as e:
            print(f'  失败: {e}', file=sys.stderr)
            fail += 1
            count_failure(classify_failure(e))
        time.sleep(LLM_INTERVAL_SEC)
    print(f'\n完成: 成功 {ok} / 失败 {fail} / 残本候选跳过 {stub_skipped}，结果在 labels.jsonl')
    if fail:
        print(format_failure_kinds(fail_kinds))
    # exit 2 = 整轮零成功（渠道坏，门卫据此回等待窗口）；1 = 部分失败；0 = 全成功
    if ok == 0 and fail > 0:
        return 2
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
