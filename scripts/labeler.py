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
配置: /root/zhaoshu-labeler/.env（LLM_API_KEY 必填；DATABASE_URL 与 LLM_MODEL 可选）
      数据目录默认 = 脚本同目录（.env / labels.jsonl / labels-rejected.jsonl）；
      只有显式设置 LABELER_DATA_DIR 时才改指向该目录——给本地 dry-run 用副本数据复现，
模型: 优先读数据库 app_settings.label_model（管理界面里改，改完下次运行生效）；
      命中时该模型作为模型链链首，后接 .env 链；无 DATABASE_URL / 读库失败 / 值为空
      则静默回落到 .env。启动会打印「打标模型来源: database|environment」。
"""
import argparse
import json
import os
import re
import sys
import time
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
    "text_quality(文本质量,取值必须是 正常/疑似乱码/大面积重复/含广告注入 之一)、"
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
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode('utf-8', 'replace')


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
def fetch_rank_books() -> list[dict]:
    """榜单页 → [{url, title, author, category, status}]"""
    books, seen = [], set()
    for rank in RANKS:
        try:
            html = http_get(f'{BOOK15.base}/books/rank{rank}.html')
        except Exception as e:
            print(f'  rank{rank} 拉取失败: {e}', file=sys.stderr)
            continue
        for m in re.finditer(r'href="(/books/details\d+\.html)"[^>]*>([^<]+)</a>', html):
            url, title = m.group(1), m.group(2).strip()
            if url not in seen:
                seen.add(url)
                books.append({'url': url, 'title': title})
    # 补详情页元数据（作者/分类/状态）
    for b in books:
        try:
            html = http_get(BOOK15.absolute(b['url']))
            for field, pat in (
                ('author', r'og:novel:author"\s+content="([^"]+)"'),
                ('category', r'og:novel:category"\s+content="([^"]+)"'),
                ('status', r'og:novel:status"\s+content="([^"]+)"'),
            ):
                m = re.search(pat, html)
                if m:
                    b[field] = m.group(1)
        except Exception:
            b['author'] = b.get('author', '')
    return books


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
                    source: BookSource | None = None) -> tuple[str, int]:
    """整本（到字数上限）→ (拼接文本, 实际字数)"""
    chapters = fetch_chapters(detail_url, source=source)
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
    """调引擎 CLI 子命令并解析 JSON stdout；非零退出 → RuntimeError（脱敏摘要）。

    凭据红线：stderr 不原样透传——只留单行化 + 截断的错误摘要（CLI 侧另有 safeReason）。"""
    proc = engine_cli.run(subcommand, *args)
    if proc.returncode != 0:
        summary = ' '.join((proc.stderr or '').split())[:200]
        raise RuntimeError(f'引擎 {subcommand} 失败 rc={proc.returncode}: {summary}')
    return json.loads(proc.stdout)


class EngineIdentityMismatch(Exception):
    """N02：引擎 toc 自报的 title/author 与名单身份不符（错书防线）。

    消息含双端 title/author 摘要，供 labels-rejected.jsonl 的 reason 与 stdout 审计。
    只在引擎路径抛出（book15 路径无 toc 自报身份可用）；主循环在通用 except 之前
    专门 catch：写拒收、不调 LLM、不 sleep LLM_INTERVAL。"""


def fetch_book_text_engine(engine_cli, book_url: str,
                           target_chars: int = TARGET_CHARS,
                           expect_title: str = '',
                           expect_author: str = '') -> tuple[str, int]:
    """引擎源整本（到字数上限）→ (拼接文本, 实际字数)。

    toc 失败（无章 / 环境错误，CLI 退出码非 0）→ 抛异常，交主循环计失败（不静默产空文本）。
    单章 content 失败（重试后仍空）跳过，隔离不拖垮整本；target_chars/CHUNK_RETRY/CHAPTER_DELAY
    与 book15 路径沿用同一常量。

    N02 二次校验（toc 取回后、逐章 content **之前**）：expect_title/expect_author
    是名单侧身份锚点（队列条目的 title/author）。**双侧非空才比对**——toc 缺自报
    身份（空串）不触发（向后兼容），名单没给期望值（空串）也不触发。
    title 用 title_compatible 语义比对；author 用 douban_list._norm_author 归一化后
    严格相等。不符 → 抛 EngineIdentityMismatch（此时一个 content 调用都没发起，
    省掉整本抓取）。"""
    toc = _engine_json(engine_cli, 'toc', '--url', book_url)
    toc_title = (toc.get('title') or '').strip()
    toc_author = (toc.get('author') or '').strip()
    if expect_title and toc_title and not douban_list.title_compatible(expect_title, toc_title):
        raise EngineIdentityMismatch(
            f'引擎目录身份不符: 名单《{expect_title}》/作者 {expect_author or "（未知）"}'
            f' vs 目录《{toc_title}》/作者 {toc_author or "（未知）"}（标题不兼容）')
    if expect_author and toc_author and             douban_list._norm_author(expect_author) != douban_list._norm_author(toc_author):
        raise EngineIdentityMismatch(
            f'引擎目录身份不符: 名单《{expect_title}》/作者 {expect_author}'
            f' vs 目录《{toc_title}》/作者 {toc_author}（作者不符）')
    chapters = toc.get('chapters') or []
    parts, chars = [], 0
    for ch in chapters:
        if chars >= target_chars:
            break
        ch_url = ch.get('url') or ''
        title = (ch.get('title') or '').strip()
        if not ch_url:
            continue
        text = ''
        for attempt in range(CHUNK_RETRY):
            try:
                text = _engine_json(engine_cli, 'content', '--url', ch_url).get('text') or ''
                break
            except Exception:
                time.sleep(2 * (attempt + 1))
        if len(text) > 100:
            parts.append(f'【{title}】\n{text}')
            chars += len(text)
        time.sleep(CHAPTER_DELAY)
    return '\n\n'.join(parts), chars


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


# ---- 打标层（将来可整体搬进主应用）----
SEGMENT_CHARS = 250_000  # 每段字数上限（~160k tokens，远离 CF 100s prefill 死区）

MERGE_PROMPT_SUFFIX = (
    "以上是前一次阅读（全书开头部分）得到的初步结论。现在给出后续文本，"
    "请结合两者输出合并后的最终 JSON 对象（同样只要 JSON，不要多余文字），"
    "修正和补充初步结论中只看开头会误判的字段（如 pace、weaknesses、plot_stage）。"
)


MODEL_RETRY = 2            # 打标时每个模型最多尝试次数


def _log_model(context: str, message: str) -> None:
    stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f'    [{stamp}] [pid={os.getpid()}] [{context or "单段"}] {message}',
          file=sys.stderr, flush=True)


def label_book(text: str, api_key: str, models: list[str],
               site_title: str = '', site_author: str = '') -> tuple[dict, int]:
    """50 万字文本 → (标签 dict, 实际调用次数)。
    两段式：每段 ≤25 万字独立过 CF 100s 线（实测 40 万字单段 prefill 必撞 524）。
    第二段带第一段结论合并，可修正只看开头的误判。
    site_title / site_author 为本次来源站点书目，附加打标验证段供成分判定。
    models 为后备模型链（如 bohe → grok → ...），逐段内按链逐个尝试。"""
    verification = _build_verification(site_title, site_author)
    context = f'书目={site_title or "（未知）"}'
    if len(text) <= SEGMENT_CHARS:
        return _label_once(text, api_key, models, verification,
                           context=f'{context} 分段=1/1'), 1
    seg1, seg2 = text[:SEGMENT_CHARS], text[SEGMENT_CHARS:]
    labels1 = _label_once(seg1, api_key, models, verification,
                          context=f'{context} 分段=1/2')
    merged_user = (
        "【前次阅读结论】\n" + json.dumps(labels1, ensure_ascii=False)
        + "\n\n【后续文本】\n" + seg2 + MERGE_PROMPT_SUFFIX
    )
    labels2 = _label_once(merged_user, api_key, models, verification,
                          context=f'{context} 分段=2/2')
    return labels2, 2


def _label_once(user_content: str, api_key: str, models: list[str],
                verification: str = '', *, context: str = '') -> dict:
    """单次 LLM 调用。流式。对链中每个模型最多试 MODEL_RETRY 次，
    某模型连续 MODEL_RETRY 次失败即切换下一个；全部模型耗尽才算本次失败。"""
    if not models:
        raise RuntimeError('模型链为空，无法打标')
    _log_model(context, f'开始分段，模型链从链首 {models[0]} 开始')
    last_err = None
    current = models[0]
    for model in models:
        if model != current:
            _log_model(context, f'切换模型: {current} -> {model}')
            current = model
        for attempt in range(MODEL_RETRY):
            body = json.dumps({
                'model': model, 'stream': True, 'max_tokens': 1800,
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
                content = ''
                _log_model(context, f'请求模型 {model} 尝试 {attempt + 1}/{MODEL_RETRY}')
                with urllib.request.urlopen(req, timeout=300) as res:
                    for raw in res:
                        line = raw.decode('utf-8', 'replace').strip()
                        if not line.startswith('data: ') or line == 'data: [DONE]':
                            continue
                        try:
                            delta = json.loads(line[6:]).get('choices', [{}])[0].get('delta', {})
                            content += delta.get('content') or ''
                        except (json.JSONDecodeError, IndexError):
                            continue
                content = content.strip()
                if content.startswith('```'):
                    content = content.split('\n', 1)[1].rsplit('```', 1)[0].strip()
                parsed = json.loads(content)
                if not isinstance(parsed, dict):
                    raise ValueError('标签不是 JSON 对象')
                _log_model(context, f'模型 {model} 尝试 {attempt + 1}/{MODEL_RETRY} 成功')
                return parsed
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


def load_done_urls(path: Path) -> set[str]:
    """labels.jsonl → 已成功产出的详情页 url 集合（断点续传口径）。"""
    return set(_read_url_lines(path))


def count_rejections(path: Path) -> dict[str, int]:
    """labels-rejected.jsonl → {url: 被拒次数}（每行 = 一次拒收）。"""
    counts: dict[str, int] = {}
    for url in _read_url_lines(path):
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
    args = ap.parse_args()

    env = load_env()
    models, model_source = resolve_models(env, use_db=not args.no_db_model)
    print(f'打标模型来源: {model_source}')
    print(f'模型链: {models}')
    # 断点续传：已写入 labels.jsonl 的书跳过（按详情页 url 判定）
    done_urls = load_done_urls(data_path('labels.jsonl'))
    # 钉子户终态：历史被拒 ≥ REJECT_TERMINAL_THRESHOLD 次的书同样跳过，
    # 与 done_urls 同等地位（都算「本轮不处理」），止住每轮白烧的 LLM 调用。
    rejection_counts = count_rejections(data_path('labels-rejected.jsonl'))
    # 显式把常量传进去（而不是靠默认参数）：默认参数在 def 时就求值了，
    # 读模块常量本意是「改常量即调参/关闸（0 或负数关闭）」，这里保持这个语义。
    pinned = terminal_urls(rejection_counts, REJECT_TERMINAL_THRESHOLD)

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
            all_books = (douban_list.build_douban_queue(
                             bridged, skip_titles=skip_titles, pages=pages,
                             engine_cli=engine_cli)
                         if args.source == 'douban'
                         else douban_list.build_webnovel_queue(
                             bridged, skip_titles=skip_titles, pages=pages,
                             engine_cli=engine_cli))
            print(f'{args.source} 线共 {len(all_books)} 本（搜索命中后）')
        else:
            print('拉取榜单书目...')
            all_books = fetch_rank_books()
            print(f'榜单共 {len(all_books)} 本（去重后）')
        # --limit 切在 split_queue **之后**（审查 F.1）：命中数一旦 > limit，切在前缀会
        # 让队尾（多半是豆瓣/17K 尾部）永远进不了视野——每轮只处理前 limit 条，做完进
        # done_urls，之后每轮 queue=[] 却仍全量搜索。先剔除已完成/钉子户再取上限，
        # 语义 = 「本轮最多打 limit 本**未完成**的书」。
        queue, skipped_done, skipped_pinned = split_queue(all_books, done_urls, pinned)
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

    ok = fail = 0
    import_failures = 0
    for i, b in enumerate(queue, 1):
        print(f'[{i}/{len(queue)}] {b.get("title")} ...')
        try:
            # 引擎兜底条目走 CLI 取正文（toc/content，不过 clean_chapter_text）；
            # 其余走 book15 适配器路径，行为不变。
            if b.get('engine'):
                # N02：toc 自报身份与名单身份比对（双侧非空才比对），错书在抓正文前拦下。
                text, chars = fetch_book_text_engine(
                    engine_cli, b['url'],
                    expect_title=b.get('title') or '',
                    expect_author=b.get('author') or '')
            else:
                text, chars = fetch_book_text(b['url'])
            if chars < 10_000:
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
                continue
            # --book 的 title 是详情页路径，不作为可核验的站点书名。
            site_title = '' if args.book else (b.get('title') or '').strip()
            labels, calls = label_book(
                text, env['LLM_API_KEY'], models,
                site_title=site_title, site_author=b.get('author', ''))
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
                time.sleep(LLM_INTERVAL_SEC)
                continue
            quality = labels.get('text_quality')
            if quality and quality != '正常':
                print(f'  文本质量异常({quality}),跳过')
                reject = {
                    'site_title': site_title,
                    'author': b.get('author', ''),
                    'category': b.get('category', ''),
                    'url': BOOK15.absolute(b['url']),
                    'title_guess': guess,
                    'site_title_match': labels.get('site_title_match'),
                    'site_title_note': labels.get('site_title_note'),
                    'reason': f'文本质量异常: {quality}',
                }
                rej_path = data_path('labels-rejected.jsonl')
                with open(rej_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(reject, ensure_ascii=False) + '\n')
                fail += 1
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
            continue
        except Exception as e:
            print(f'  失败: {e}', file=sys.stderr)
            fail += 1
        time.sleep(LLM_INTERVAL_SEC)
    print(f'\n完成: 成功 {ok} / 失败 {fail}，结果在 labels.jsonl')
    # exit 2 = 整轮零成功（渠道坏，门卫据此回等待窗口）；1 = 部分失败；0 = 全成功
    if ok == 0 and fail > 0:
        return 2
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
