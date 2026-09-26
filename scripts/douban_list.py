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
import unicodedata
import urllib.parse
from collections import defaultdict
from math import ceil
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


# M4-r：站点常在书名后挂固定装饰尾缀（全文阅读/最新章节/无弹窗/笔趣阁…）。名单无作者路径
# 要求书名完全相等，这类尾缀会把真同书误拒。只作为**尾缀**成组剥离，且限定装饰词表——
# 同人续写尾缀（之XX/外传…）不在表内，故 C6「前缀续写」仍不相等、照拦（不触幂等红线）。
_SITE_DECOR_SUFFIX = (
    '全文阅读', '全文免费阅读', '免费阅读', '免費閱讀', '在线阅读', '在線閱讀', '免费在线阅读',
    '最新章节', '最新章節', '最新章节列表', '章节列表', '章節列表', '无弹窗', '無彈窗',
    '无广告', '無廣告', '无错阅读', '无删减', 'txt下载', 'TXT下载', 'txt全集下载', 'txt免费下载',
    '全本', '全本阅读', '手机阅读', '手機閱讀', '手机版', '笔趣阁', '筆趣閣', '小说网', '小說網',
    '免费小说', '在线阅读网', '全文阅读全文', '正版阅读',
)
_SITE_DECOR_RE = re.compile(
    r'(?:' + '|'.join(re.escape(w) for w in _SITE_DECOR_SUFFIX) + r')+$')


def _norm_title_bare(title: str) -> str:
    """名单无作者路径专用（M4-r）：先归一，再成组剥掉**站点装饰尾缀**（全文阅读/最新章节/
    笔趣阁…）。装饰词表之外的尾缀（同人续写「之XX」、系列卷号已由 _STRIP_RE 处理）不剥，
    故前缀同人续写书名仍不相等——C6 红线不变。"""
    t = _norm_title(title)
    prev = None
    while prev != t and t:
        prev = t
        t = _SITE_DECOR_RE.sub('', t)
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
# 前导「作者」标签（labelerdiag41：引擎源作者规则连标签一起取，「作者：唐家三少」
# 剥冒号后成「作者唐家三少」≠「唐家三少」，约 15% 失败）。含「作　者」排版空格、
# 半/全角冒号、冒号可缺省（`<span>作者</span>唐家三少` 取 textContent 无分隔）。
_AUTHOR_LABEL_RE = re.compile(r'^作\s*者\s*([:：])?\s*')


def _strip_author_label(text: str) -> str:
    """循环剥前导「作者」标签。带冒号 ⇒ 必是标签，剩余为空即作者未知（''）；
    无冒号 ⇒ 剩余非空才剥（整串就是「作者」时原样保留）。

    误伤取舍：以「作者」起头的真实笔名（如「作者君」）会被剥成「君」。归一化两端
    对称、且**循环**剥（「作者：作者君」与「作者君」都到「君」），所以同一作者两端
    写法仍相等；代价只是「作者X」与「X」被视为同一作者——还须书名同时兼容才会命中，
    概率可忽略，远小于标签前缀造成的系统性误拒。"""
    while True:
        m = _AUTHOR_LABEL_RE.match(text)
        if not m:
            return text
        rest = text[m.end():]
        if not (m.group(1) or rest):
            return text
        text = rest


_T2S_TRANS = None


def _to_simplified(text: str) -> str:
    """繁转简（authcv41 §8）：复用 import_one._T2S 同一张表，使打标期身份口径与入库身份键
    （import_one._loose_author_key / find_twin，本就 `_norm_author(_to_simplified(raw))`）对齐。
    表按 str.translate 缓存一次；import_one 不可用时退化为不转换（不影响原有严格相等判定）。"""
    global _T2S_TRANS
    if _T2S_TRANS is None:
        try:
            import import_one
            _T2S_TRANS = str.maketrans(import_one._T2S)
        except Exception:
            _T2S_TRANS = {}
    return text.translate(_T2S_TRANS)


def _norm_author(s: str) -> str:
    """作者身份比对前的归一化：前导「作者：」标签/空白（含全角）/分隔标点/尾部著述后缀/前导国籍段/casefold。

    与 import 线（import_one.normalize_author）的分工：那条线管**入库身份键**，
    宁 review 不冒进；本函数只管**打标前的候选过滤与 toc 校验**，把两端写法差
    桥接掉即可。HTML 实体按「&...; 整体替换为 ·」处理（乔治&middot;奥威尔 →
    乔治·奥威尔），与标点剥离天然衔接；未成对的 & / ; 当普通标点剥。"""
    text = (s or '').casefold()
    text = re.sub(r'&[a-zA-Z]+;', '·', text)      # &middot; 等实体 → 分隔符
    # 前导「作者：」标签：先于括号段与标点剥离（「作者：（美）乔治」→「（美）乔治」→…；
    # 标点层会先吃掉冒号，之后就分不清标签和名字了）。
    text = _strip_author_label(text.strip())
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
    return _to_simplified(text)     # authcv41 §8：繁转简，与入库身份键 _loose_author_key 对齐


# 占位作者（非真实署名）：对齐 src/lib/source-parser.ts knownSourceAuthor 的 {佚名/未知/未知作者}，
# 再并入常见的 暂无/匿名/无名氏 及其繁体形态（無名氏/暫無/無，rvauthor 增量建议 2——本清单不做
# 繁转简，故繁体形态直接列出）。归一化（NFKC+去空白+casefold）后命中即视同空作者
# （回写不写、身份键不参与匹配）。
_PLACEHOLDER_AUTHORS = frozenset({
    '佚名', '未知', '未知作者', '暂无', '暂无作者', '匿名', '无名氏', '佚名氏', '无',
    '無名氏', '暫無', '暫無作者', '無',
})


def is_placeholder_author(value: str) -> bool:
    """作者是否为占位串（视同空作者：不回写、不参与孪生/身份判定）。"""
    norm = re.sub(r'\s+', '', unicodedata.normalize('NFKC', (value or '').strip())).casefold()
    return norm == '' or norm in _PLACEHOLDER_AUTHORS
# authmis41 对 phoenix 393 行「作者不符跳过」分类：归一化真漏配只剩结构差——
#   引擎多署名串：「马伯庸著 刘巴布编绘」「软星科技原著 执笔：苏末那」；
#   非前导括号注：「[美]斯蒂芬·金（Stephen King）」；
#   外文名只署末节：名单「[美]乔治·R.R.马丁」vs 引擎「马丁」。
# 三条规则的判据仍是**整段严格相等**，不做子串包含（「金庸」≠「金庸新」、
# 「唐家三少」≠「唐家三少之子」照旧拒）。中外文异体（「J.R.R.托尔金」vs
# 「J.R.R.Tolkien」）需音译表，自动推导必误配，不做。
# 多署名分隔（见 _split_signatures）：分号/顿号/逗号/斜杠恒切（HTML 实体须先替换，否则 &middot;
# 的分号会被切开；&nbsp; 在 _author_text 里换成斜杠，恒切）。空白**默认不切**——名内空格
# 很常见：「Stephen King」「J.R.R. 托尔金」「上條 一輝」「司马 迁」都是一个人，切开后
# 「上條 一輝」与「上條 二輝」会因共有姓氏段被判同一人（authrev41 增量）。空白只在有明确
# 多署名证据时切：左边以署名角色结尾（「马伯庸著 刘巴布编绘」）、右边以「执笔：」类角色
# 标签开头，或两边都是带「·」的外文全名（「阿卡迪·斯特鲁伽茨基 鲍里斯·斯特鲁伽茨基」）。
_AUTHOR_SEP_RE = re.compile(r'[;；、，,/]+')
_AUTHOR_SPACE_RE = re.compile(r'[\s　]+')
# 空白左侧 token 以署名角色结尾 ⇒ 该空白是多署名分隔
_AUTHOR_ROLE_END_RE = re.compile(r'(?:著|译|绘|编|校|注|执笔|口述|整理)$')
# 单人署名判定前剥掉的尾部角色（「杰西卡·汤森 著」「汤森 著」）
_AUTHOR_TRAILING_ROLE_RE = re.compile(r'[\s　]*(?:原著|执笔|编绘|口述|整理|编著|主编|著|译|绘|编|校|注)$')
# 任意位置的括号段：全/半角圆括号、方括号、【】（书名号不算）；内层不含括号
_AUTHOR_BRACKET_RE = re.compile(r'[（(【\[][^（()）【】\[\]]*[）)】\]]')
# 署名角色：前导须带冒号（「执笔：苏末那」）；尾部只认多字角色（「软星科技原著」）。
# 不并进 _norm_author：「原著」作通用尾缀会把「高原著」剥成「高」，只在分段比对里作变体。
_AUTHOR_ROLE_LABEL_RE = re.compile(
    r'^(?:执\s*笔|原\s*著|编\s*绘|绘\s*者|译\s*者|主\s*编|编\s*者|著\s*者|口\s*述|整\s*理)\s*[:：]\s*')
_AUTHOR_ROLE_SUFFIX_RE = re.compile(r'(?:原著|执笔|编绘|口述|整理)$')
# 外文姓名的分节符（长侧必须含「·」或「•」才视为外文名；切末节时半角/全角点也算分节）
_AUTHOR_FOREIGN_MARK_RE = re.compile(r'[·•]')
_AUTHOR_NAME_SEP_RE = re.compile(r'[·•．.]')


def _strip_author_brackets(s: str) -> str:
    """剥所有括号段（循环，处理「[美]斯蒂芬·金（Stephen King）」这类多段）。"""
    prev = None
    while prev != s:
        prev, s = s, _AUTHOR_BRACKET_RE.sub('', s)
    return s


def _author_text(s: str) -> str:
    """比对前的实体还原：&nbsp; 视为多署名分隔（换成「/」恒切——「马伯庸&nbsp;刘巴布」是两人）；
    其余实体（&middot; 等）按名内分隔符 · 处理，与 _norm_author 口径一致。"""
    text = re.sub(r'&(?:nbsp|#160|#xa0);', '/', s or '', flags=re.IGNORECASE)
    return re.sub(r'&[a-zA-Z]+;', '·', text)


def _space_separates(left: str, right: str) -> bool:
    """两个空白分隔的 token 之间是否是多署名分隔（规则见 _AUTHOR_SEP_RE 上方注释）。"""
    return bool(_AUTHOR_ROLE_END_RE.search(left) or _AUTHOR_ROLE_LABEL_RE.match(right)
                or (_AUTHOR_FOREIGN_MARK_RE.search(left) and _AUTHOR_FOREIGN_MARK_RE.search(right)))


def _split_signatures(text: str) -> list[str]:
    """多署名串 → 各署名段（剥括号后为空的国籍段不算一段）。"""
    parts: list[str] = []
    for piece in _AUTHOR_SEP_RE.split(text.strip()):
        tokens = [t for t in _AUTHOR_SPACE_RE.split(piece.strip()) if t]
        if not tokens:
            continue
        cur = tokens[0]
        for left, right in zip(tokens, tokens[1:]):
            if _space_separates(left, right):
                parts.append(cur)
                cur = right
            else:
                cur += ' ' + right
        parts.append(cur)
    return [p for p in parts if _strip_author_brackets(p).strip()]


def _author_segments(s: str) -> list[str]:
    """整串 + 按多署名分隔切出的各段（整串在前；只有一段时不重复）。"""
    text = _author_text(s)
    parts = _split_signatures(text)
    return [text] + (parts if len(parts) > 1 else [])


def _is_single_author(s: str) -> bool:
    """剥括号/前导「作者：」/尾部署名角色后只剩一段署名。尾部角色先剥：「[澳]杰西卡·汤森 著」
    是单人（否则「著」前的空白按角色规则算分隔，R4 被关掉，authrev41 增量）；多署名串剥掉
    末尾角色后仍有分隔（「乔治·马丁著 某某编绘」→「乔治·马丁著 某某」），不会被误放行。"""
    core = _strip_author_brackets(_strip_author_label(_author_text(s).strip())).strip()
    while True:
        stripped = _AUTHOR_TRAILING_ROLE_RE.sub('', core).strip()
        if stripped == core or not stripped:
            break
        core = stripped
    return len(_split_signatures(core)) <= 1


def _author_forms(seg: str) -> set[str]:
    """一段署名的可比形态：原样归一化、剥括号后归一化、剥角色标签后归一化（非空）。
    剥括号/角色后的形态要求 ≥2 字，防「（佚名）」「高原著」这类剥过头后撞短名。"""
    forms = {_norm_author(seg)}
    for s in (_strip_author_brackets(seg),
              _AUTHOR_ROLE_SUFFIX_RE.sub('', _AUTHOR_ROLE_LABEL_RE.sub('', seg.strip()))):
        v = _norm_author(s)
        if len(v) >= 2:
            forms.add(v)
    forms.discard('')
    return forms


def _identity_forms(s: str) -> set[str]:
    """整串及各多署名分段的可比形态并集；切出来的分段只认 ≥2 字形态
    （「[美] X」切出的「美」不得撞单字笔名）。"""
    forms: set[str] = set()
    for i, seg in enumerate(_author_segments(s)):
        f = _author_forms(seg)
        forms |= {x for x in f if len(x) >= 2} if i else f
    return forms


def _foreign_surname_match(long_raw: str, short_raw: str) -> bool:
    """外文名末节匹配（R4）：「乔治·R.R.马丁」vs「马丁」、「詹姆斯·马修·巴利」vs「（英）巴利著」。

    护栏：长侧（剥括号/实体替换后）必须含「·」或「•」——中文名没有分节符，
    「金庸」vs「金庸新」、「唐家三少」vs「唐家三少之子」不会走到这里；短侧 = 长侧按
    分节符切出的**最后一段**（整段严格相等，不是后缀包含）且 ≥2 字。
    两侧都必须是单人署名（_is_single_author）：多署名串切出的一段不做末节匹配，否则
    「乔治·马丁著 某某编绘」会同时匹配「马丁」和「某某」两个不同名单作者（authrev41）。"""
    if not (_is_single_author(long_raw) and _is_single_author(short_raw)):
        return False
    long_s = _strip_author_brackets(_strip_author_label(_author_text(long_raw).strip()))
    if not _AUTHOR_FOREIGN_MARK_RE.search(long_s):
        return False
    short = _norm_author(_strip_author_brackets(short_raw or ''))
    if len(short) < 2:
        return False
    last = _norm_author(_AUTHOR_NAME_SEP_RE.split(long_s.strip().rstrip('·•．.'))[-1])
    return last == short and _norm_author(long_s) != short


def author_matches(list_author: str, engine_author: str) -> bool:
    """名单作者与引擎作者是否同一人（search_engine 候选过滤与 labeler toc 二次校验共用）。

    名单侧归一化为空（''、「---」「。。。」）⇒ 永不匹配（作者未知的语义由调用方先行处理，
    这里不能因为两端都剥成空串就判相等）。否则先比归一化严格相等；不等再按两端各自的
    整串 + 多署名各段比：
      R2 分段/角色标签：名单任一段与引擎任一段（剥「执笔：」「原著」等角色后）归一化相等；
      R3 剥括号：两端剥所有括号段后归一化相等（剥后须非空）；
      R4 外文名末节：见 _foreign_surname_match（两个方向都试，两侧须单人署名）。
    全部是整段严格相等，不做子串包含。"""
    want = _norm_author(list_author)
    if not want:
        return False
    if want == _norm_author(engine_author):
        return True
    if _identity_forms(list_author) & _identity_forms(engine_author):
        return True
    return (_foreign_surname_match(list_author, engine_author)
            or _foreign_surname_match(engine_author, list_author))


# ---- 豆瓣 tag 页解析（纯函数，可离线单测）----
# 出版机构特征（豆瓣 pub 首段）。只用明确的机构词：「柯山梦 / 2012-8」「饭卡 / 2024」这类
# 「作者 / 日期」无出版社的形态首段仍是作者，不能按「第二段是日期」反推（2026-09-25 实测 tag 页）。
_PUBLISHER_RE = re.compile(r'出版|[书書]局|書房|\bpress\b|\bpublish', re.IGNORECASE)


# ---- 名单作者字段污染识别（authcv41 §7）----
# 豆瓣/名单偶把「分类名」（悬疑灵异/轻小说）或「出版社」塞进作者字段：gate.log 实测
# `名单 悬疑灵异` 169 行、`名单 轻小说` 52 行、《偷偷藏不住》名单「青岛出版社」。这类
# 「作者」不是人名、永不匹配任何候选、恒被拦。识别后降级为「名单无作者」，进入内容聚类
# 路径（_content_rescue_unknown）安全救回；写回作者只取候选作者，绝不把分类名写进去。
# 严格从紧防误降级（天蚕土豆/辰东等真名不受影响）：
#   分类——归一后**整串精确等于**已知分类（PRIMARY_GENRES + 少量繁体/名单分类）才判；
#   出版社——机构后缀须落在**串尾**（青岛出版社/中国友谊出版公司/Penguin Press），故「出版」
#   二字、以及「出版社的猫」这类恰好含机构词的真名都不误判。
_BOGUS_PUBLISHER_RE = re.compile(
    r'(?:出版社|出版公司|出版集团|出版发行|图书公司|文化传媒|書局|书局'
    r'|press|publishing|publisher|verlag)\s*$', re.IGNORECASE)
# 名单特有/繁体分类，并入 import_one.PRIMARY_GENRES（后者已含「悬疑灵异」「轻小说」等简体形态）
_EXTRA_LIST_GENRES = frozenset({'輕小說', '懸疑靈異', '網遊', '网游'})


def _genre_key(s: str) -> str:
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', s or '')).casefold()


def _known_genre_keys() -> frozenset:
    """已知分类名的归一键集合（复用 import_one.PRIMARY_GENRES；导入失败则仅用本地补集）。"""
    names = set(_EXTRA_LIST_GENRES)
    try:
        import import_one
        names |= set(import_one.PRIMARY_GENRES)
    except Exception:
        pass
    return frozenset(_genre_key(n) for n in names)


def is_bogus_list_author(author: str) -> bool:
    """名单作者字段是否是被污染的非人名（分类名整串 / 出版社机构名）→ 应降级为名单无作者。"""
    s = (author or '').strip()
    if not s:
        return False
    if _genre_key(s) in _known_genre_keys():     # 分类：整串精确匹配
        return True
    return bool(_BOGUS_PUBLISHER_RE.search(s))    # 出版社：机构后缀


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
            # pub 形如「有花在野 / 广东旅游出版社」，取第一段；译者/丛书形态同样取第一段。
            # 该版本没列作者时首段就是出版机构（「青岛出版社 / 2020-4 / 59.8」，authfix41）
            # → 作者先置空并打 publisher_only 标记，由 fetch_douban_books 去 subject 页补作者；
            # 补不到才以「名单无作者」进引擎（受作者歧义护栏约束）。不拿出版社当人名去拒真作者。
            first = p.group(1).split('/')[0].strip()
            author = '' if _PUBLISHER_RE.search(first) else first
        book = {'title': t.group(2).strip(), 'author': author, 'douban_url': t.group(1)}
        if p and not author and first:
            book['publisher_only'] = True     # fetch_douban_books 据此去 subject 页补作者
        books.append(book)
    return books


def parse_douban_subject_author(html: str) -> str:
    """豆瓣 subject 页 → 第一作者（取不到返回 ''）。

    两处来源（2026-09-25 实测）：
      #info 的「<span class="pl"> 作者</span>: <a>天蚕土豆</a>」——常规版本；
      「作者」卡片 ul.authors-list > li.author > a.name + span.role——tag 页 pub 首段是
      出版社的版本（偷偷藏不住 35003286、剑来1 35022388），#info 里**没有作者行**，只有这里有。
    卡片只收 role 含「作者/著」的（译者/绘者不算）。"""
    m = re.search(r'<span class="pl">\s*作者\s*:?\s*</span>\s*:?([\s\S]*?)</span>', html)
    if m:
        a = re.search(r'<a[^>]*>([^<]+)</a>', m.group(1))
        if a and a.group(1).strip():
            return re.sub(r'\s+', ' ', a.group(1)).strip()
    for li in re.finditer(r'<li class="author">([\s\S]*?)</li>', html):
        name = re.search(r'class="name">([^<]+)</a>', li.group(1))
        role = re.search(r'<span class="role">([^<]*)</span>', li.group(1))
        if name and name.group(1).strip() and (not role or re.search(r'作者|著', role.group(1))):
            return re.sub(r'\s+', ' ', name.group(1)).strip()
    return ''


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
    # authfix41：pub 首段是出版社的条目去 subject 页补作者（作者卡片）。同样隔 DOUBAN_PAGE_DELAY、
    # 单次尝试不重试；失败/取不到保持 ''（引擎侧按「名单无作者」走歧义护栏）。标记不外带。
    for b in [b for b in books if b.pop('publisher_only', False)]:
        time.sleep(DOUBAN_PAGE_DELAY)
        try:
            author = parse_douban_subject_author(http_get(b['douban_url']))
        except Exception as e:
            print(f'  豆瓣subject《{b["title"]}》补作者失败: {e}', file=sys.stderr)
            continue
        if author:
            b['author'] = author
            print(f'  豆瓣subject 补作者: 《{b["title"]}》→ {author}')
        else:
            print(f'  豆瓣subject《{b["title"]}》无作者字段，按名单无作者处理')
    return books


def _search_book15_once(http_get, title: str) -> list[tuple[str, str]]:
    kw = urllib.parse.quote(title)
    html = http_get(f'/books/search.html?kw={kw}')
    return parse_book15_search(html)


# ---- book15 搜索熔断（labelerdiag41：book15 整站 522/超时，每本 3 次全失败，一轮白耗十几小时）----
# 连续 N 本搜索「重试全失败」（网络/5xx/超时，区别于正常 miss）即熔断：本轮剩余候选不再发
# book15 搜索，直接走引擎兜底（未开兜底则记 miss）。任一次搜索拿到页面即清零计数。
# 阈值走 .env / 进程环境 LABELER_BOOK15_BREAKER，≤0 关闭熔断；非法值回落默认。
BOOK15_BREAKER_ENV = 'LABELER_BOOK15_BREAKER'
BOOK15_BREAKER_DEFAULT = 5


def resolve_book15_breaker(env: dict | None = None) -> int:
    """熔断阈值：env 字典 → 进程环境 → 默认 5；非整数回落默认，≤0 表示关闭。"""
    raw = ''
    if env and env.get(BOOK15_BREAKER_ENV) is not None:
        raw = str(env.get(BOOK15_BREAKER_ENV)).strip()
    if not raw:
        raw = (os.environ.get(BOOK15_BREAKER_ENV) or '').strip()
    if not raw:
        return BOOK15_BREAKER_DEFAULT
    try:
        return int(raw)
    except ValueError:
        return BOOK15_BREAKER_DEFAULT


class Book15Breaker:
    """单轮内的 book15 搜索熔断器（不跨轮：下一轮 labeler 进程重新探 book15 是否恢复）。"""

    def __init__(self, threshold: int = BOOK15_BREAKER_DEFAULT):
        self.threshold = threshold
        self.consecutive = 0
        self.open = False
        self.skipped = 0

    def record(self, failed: bool) -> None:
        if self.open:
            return
        if not failed:
            self.consecutive = 0
            return
        self.consecutive += 1
        if self.threshold > 0 and self.consecutive >= self.threshold:
            self.open = True
            print(f'  book15 熔断：连续 {self.consecutive} 本搜索全失败'
                  f'（阈值 {self.threshold}，{BOOK15_BREAKER_ENV}），'
                  f'本轮剩余候选跳过 book15 搜索、直接走引擎兜底', flush=True)


def search_book15(http_get, title: str, breaker: Book15Breaker | None = None) -> dict | None:
    """书名 → book15 详情页（带语义校验）。miss / 误匹配 / 全重试失败均返回 None。

    http_get 需接受 book15 站内相对路径（与 labeler 抓正文同一约定，
    便于测试注入与将来换 BASE）。
    breaker（可选）：已熔断 ⇒ 不发请求直接 None；拿到页面/全重试失败分别记成功/失败。"""
    if breaker is not None and breaker.open:
        breaker.skipped += 1
        return None
    last_err = None
    for attempt in range(SEARCH_RETRY):
        try:
            results = _search_book15_once(http_get, title)
        except Exception as e:
            last_err = e
            time.sleep(SEARCH_RETRY_DELAY * (attempt + 1))
            continue
        if breaker is not None:
            breaker.record(False)
        for url, site_title in results:
            if title_compatible(title, site_title):
                return {'url': url, 'title': site_title}
        return None
    print(f'  book15搜索[{title}] {SEARCH_RETRY} 次全失败: {last_err}', file=sys.stderr)
    if breaker is not None:
        breaker.record(True)
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
      node --import <file://.../ts-esm-loader.mjs> <.../engine-fetch.mjs> <sub> … --json
    Windows 裸驱动器路径给 --import 会 ERR_UNSUPPORTED_ESM_URL_SCHEME，故 hook 统一转
    file:// URI（Linux/phoenix 亦合法）。

    凭据红线：DATABASE_URL 只经**子进程 env** 注入（db.ts 模块初始化读它），
    绝不进命令行参数、日志或异常消息；stdout/stderr 只在调用方按需截断摘要。"""

    def __init__(self, node: str, script_path: str, database_url: str,
                 hook_path: str | None = None, timeout: int = ENGINE_CLI_TIMEOUT):
        self.node = node or 'node'
        self.script_path = script_path
        # hook 默认取 engine-fetch.mjs 同目录的 ts-esm-loader.mjs
        self.hook_path = hook_path or str(Path(script_path).parent / 'ts-esm-loader.mjs')
        self._database_url = database_url
        self.timeout = timeout

    def _import_target(self) -> str:
        """--import 目标转 file:// URI（跨平台安全）。"""
        return Path(self.hook_path).resolve().as_uri()

    def validate(self):
        """启动前探针：确认 node、CLI 与 TS loader 确实可用。

        用 CLI 的无副作用 ``doctor`` 子命令做真实模块加载；这能在抓几百本候选之前
        发现部署漏同步/旧 loader 等启动故障，而不是把它伪装成一轮正常 miss。
        返回 CompletedProcess，错误解释仍统一由调用方处理。"""
        return self.run('doctor')

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


def engine_url_supported(url: str) -> bool:
    """引擎 toc/content 能否接这个 URL：只收 HTTPS 完整地址 + 默认端口、无 userinfo
    （对齐 source-policy.checkSourceUrl 与 engine-fetch 的 --url 用法门）。

    labelerdiag41：http-only 源的兜底候选到 toc 必被拒（「仅支持 HTTPS 精确域名和默认端口/443」），
    09-22 一天白耗 50 本；在候选阶段就挡掉，让同书的 HTTPS 候选有机会顶上。"""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme.lower() == 'https' and bool(parts.hostname)
            and port in (None, 443) and '@' not in parts.netloc)


# ---- 查询不敏感的垃圾源（espfix41）----
# 4702.zejfxszmh.cc 这类源对任何书名都回同一批无关条目：书名校验会挡掉，但每本都白请求+解析一次。
# 单轮内识别：同一 host 对 JUNK_STREAK 个不同书名返回**完全相同**的非空候选 URL 集，且其间没有
# 任何一条书名兼容 → 判垃圾，本轮后续搜索经 CLI --skip-host 跳过。只影响本轮（下一轮重新观察）；
# 持久剔除走准入复核的查询不敏感判据（rule-engine/admission.ts）。
JUNK_STREAK = 3


class EngineJunkTracker:
    """单轮内的查询不敏感源识别器（不跨轮）。hosts = 已判垃圾、本轮跳过的 host。"""

    def __init__(self, streak: int = JUNK_STREAK):
        self.streak = streak
        self.hosts: set[str] = set()
        self._seen: dict[str, tuple[frozenset, set]] = {}   # host → (URL 集, 已见书名键)

    def observe(self, title: str, candidates: list) -> None:
        key = _norm_title(title)
        by_host: dict[str, list[dict]] = {}
        for c in candidates:
            if isinstance(c, dict) and c.get('source'):
                by_host.setdefault(c['source'], []).append(c)
        for host, items in by_host.items():
            if host in self.hosts or host == 'book15.net':
                continue
            urls = frozenset(c.get('bookUrl') or '' for c in items) - {''}
            if not urls or any(title_compatible(title, c.get('title') or '') for c in items):
                self._seen.pop(host, None)      # 有相关结果：是正常源，清零
                continue
            prev = self._seen.get(host)
            titles = prev[1] | {key} if prev and prev[0] == urls else {key}
            self._seen[host] = (urls, titles)
            if len(titles) >= self.streak:
                self.hosts.add(host)
                self._seen.pop(host, None)
                print(f'  垃圾源剔除（本轮）: {host} 对 {len(titles)} 个不同书名返回同一批'
                      f' {len(urls)} 条无关结果，后续搜索跳过', flush=True)


def search_engine(cli, title: str, author: str = '',
                  stats: dict | None = None,
                  junk: EngineJunkTracker | None = None) -> dict | None:
    """book15 miss 后的引擎兜底搜索：调 CLI `search --title …`，title + 作者双校验。

    N02 修复：author 不再只传不用——候选作者非空且归一化后与名单作者不等 → 必拒
    （防同名异作者的正文绑定名单身份，即身份错配污染共享数据）。
    两遍选择：先「title 兼容 + 作者已验证匹配」，再退「title 兼容 + 候选作者空」。
    名单作者为空（authfix41）：不再「第一个兼容候选即收」，兼容候选作者出现 ≥2 人即判作者歧义跳过
    （_pick_author_unknown）。
    返回命中 {'url': bookUrl（绝对）, 'title': site_title, 'source': host} 或 None（miss）。
    退出码：0=有候选（逐条校验，跳过 book15.net 源）；1=正常 miss；
    2/未知非零/无法调用 → 抛 EngineUnavailable（调用方本轮降级 book15-only、不重试）。
    stats（可选计数字典）：title 兼容但 URL 引擎取不了（非 HTTPS 等）的候选计入 stats['http_only']。
    espfix41：恒带 --no-builtin（book15 已由 search_book15 搜过或已熔断，其候选这里本来就跳过，
    CLI 里再搜一遍是纯浪费——book15 宕机时单这一步就 2×8s）；junk（可选）已判垃圾的 host 经
    --skip-host 跳过，本次候选再喂给 junk.observe 继续识别。"""
    # authcv41 §7/M3：名单作者字段被污染（分类名/出版社）→ 降级为名单无作者，交内容聚类救回。
    # 放在组 args 之前，故也不会把污染值当 --author 传给引擎搜索。bogus_raw 透出到返回 hit，
    # 由 _resolve_candidates 据此把队列条目 author 置空/采信候选作者，绝不让污染串流到 labeler。
    bogus_raw = ''
    if author and is_bogus_list_author(author):
        print(f'  名单作者疑似污染（分类/出版社），降级为名单无作者: 《{title}》原作者字段「{author}」')
        bogus_raw = author
        author = ''
    args = ['--title', title]
    if author:
        args += ['--author', author]
    args.append('--no-builtin')
    if junk is not None:
        for host in sorted(junk.hosts):
            args += ['--skip-host', host]
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
    if junk is not None:
        junk.observe(title, candidates)
    candidates = _deprioritize_sources(candidates)
    # ---- N02 两遍选择（只在引擎路径生效，CLI 调用形态不变）----
    # 第一遍：title 兼容 + author 已验证匹配（名单 author 已知且 author_matches 为真）。
    # 第二遍：名单 author 已知但无已验证匹配 → 退「title 兼容 + 候选 author 空」（降级收）。
    # 已验证错配的候选两遍都不收（必拒，防同名异作者正文绑错身份）。
    # 名单 author 为空 → 收齐全部 title 兼容候选，过作者歧义护栏（_pick_author_unknown）。
    want = _norm_author(author)
    fallback = None
    unknown_hits: list[tuple[dict, str]] = []
    for c in candidates:
        if not isinstance(c, dict):
            continue
        if c.get('source') == 'book15.net':
            continue          # book15 路径已搜过（这是兜底），跳过
        site_title = c.get('title') or ''
        book_url = c.get('bookUrl') or ''
        if not book_url or not title_compatible(title, site_title):
            continue
        if not engine_url_supported(book_url):
            if stats is not None:
                stats['http_only'] = stats.get('http_only', 0) + 1
            print(f'  非 HTTPS 源跳过: {site_title}（{c.get("source", "")}）')
            continue
        got = _norm_author(c.get('author') or '')
        if not want:          # 名单无作者（含 §7 降级）：先收齐，循环后统一判歧义/内容比对
            # M4：无作者路径要求书名**归一后完全相等**——title_compatible 的前缀命中（系列/同人/
            # 续写，如《神秘复苏》vs《神秘复苏之从回魂夜开始》）在这条路径一律不收，防降级后单候选
            # 靠前缀直接放行错书。M4-r：相等前先剥站点装饰尾缀（全文阅读/最新章节/笔趣阁…），
            # 减少真同书因装饰后缀被误拒；同人续写尾缀不在装饰表内，故 C6 仍不相等、照拦。
            if _norm_title_bare(title) != _norm_title_bare(site_title):
                continue
            unknown_hits.append(({'url': book_url, 'title': site_title,
                                  'source': c.get('source', '')}, c.get('author') or ''))
            continue
        if got and author_matches(author, c.get('author') or ''):
            return _with_alternates({'url': book_url, 'title': site_title,
                                     'source': c.get('source', '')},
                                    _known_author_alternates(title, author, candidates))
        if not got and fallback is None:
            fallback = {'url': book_url, 'title': site_title,
                        'source': c.get('source', '')}
        elif got:
            # 前导书名是**引擎候选**的（一本名单书常对应多行，authmis41 曾误读成名单书）
            print(f'  作者不符跳过: 候选《{site_title}》（名单《{title}》{author}'
                  f' vs 引擎 {c.get("author")}）')
    if not want:
        alt_pool = ([h for h, a in unknown_hits if _norm_author(a)]
                    + [h for h, a in unknown_hits if not _norm_author(a)])
        # authcv41：判歧义时先试内容比对救回（唯一主簇才放行）；救不回/未启用/引擎缺失
        # 才落回 _pick_author_unknown（原样打印歧义跳过、维持既有行为）。
        result = None
        if content_match_enabled() and cli is not None:
            result = _content_rescue_unknown(cli, title, unknown_hits)   # 已带采信作者
        if result is None:
            # 备选服从歧义护栏：判歧义（None）就没有备选；收了则其余兼容候选两两作者相容，作者已知的在前
            result = _attach_unknown_author(_pick_author_unknown(title, unknown_hits), unknown_hits)
        return _with_alternates(_annotate_bogus(result, bogus_raw), alt_pool)
    if fallback is not None:
        print(f'  作者未知命中（降级）: {fallback["title"]}（名单作者 {author}，引擎未给作者）')
        return _with_alternates(fallback, _known_author_alternates(title, author, candidates))
    return fallback


def _author_unknown_decision(hits: list[tuple[dict, str]]) -> tuple[dict | None, bool, list[str]]:
    """名单无作者时的选择判定（不打印）→ (hit_or_None, ambiguous, 去重非空作者原串)。

    判定与候选顺序无关：兼容候选的非空作者**两两** author_matches（任一方向）为真
    （或只有一个非空作者）才收，否则判歧义（ambiguous=True，hit=None）。见 _pick_author_unknown。"""
    if not hits:
        return None, False, []
    authors: list[str] = []
    seen: set[str] = set()
    for _, a in hits:
        key = _norm_author(a)
        if key and key not in seen:
            seen.add(key)
            authors.append(a)
    ambiguous = any(not (author_matches(x, y) or author_matches(y, x))
                    for k, x in enumerate(authors) for y in authors[k + 1:])
    if ambiguous:
        return None, True, authors
    if authors:
        return next(hit for hit, a in hits if _norm_author(a)), False, authors
    return hits[0][0], False, authors


def _pick_author_unknown(title: str, hits: list[tuple[dict, str]]) -> dict | None:
    """名单无作者时的选择（authfix41 主会话裁定：错绑比漏收更糟）。

    改前是「第一个 title 兼容候选即收」：《偷偷藏不住》的同名候选有 竹已（真作者）/旺仔/
    桑稚段嘉许，候选顺序每次搜索都不同（gate.log 有一次旺仔排第一）⇒ 绑哪本看运气。
    改后判定与候选顺序无关：兼容候选的非空作者**两两** author_matches（任一方向）为真
    （或只有一个非空作者）才收，否则判作者歧义跳过并记一行日志。
    不用「贪心聚簇」：author_matches 不传递（马伯庸 ~ 马伯庸著 刘巴布编绘 ~ 刘巴布，但
    马伯庸 ≁ 刘巴布），贪心的簇数随候选顺序变（authrev41 阻断 1）。
    收时作者已知的候选优先于作者空的；候选全无作者 ⇒ 收第一个（无从区分，同改前）。"""
    hit, ambiguous, authors = _author_unknown_decision(hits)
    if ambiguous:
        shown = sorted(authors, key=_norm_author)
        names = '、'.join(shown[:5]) + ('…' if len(shown) > 5 else '')
        print(f'  作者歧义跳过: 《{title}》名单无作者，兼容候选作者 {len(authors)} 人（{names}）')
    return hit


# ---- 内容比对（authcv41）：用目录 + 开头正文判断两个候选是不是同一本书 ----
# 动机（gate.log 实测，见 authcv-41-report §2）：作者护栏在「拦同名书」上是对的，但
# 「名单无作者 + 候选多作者」里有极少数是**假歧义**（候选其实是同一本书，作者串因繁简/
# 站点噪声虚增，如《凌霄之上！》觀棋 vs 观棋）。内容比对在有可靠依据时把这类救回来，同时
# 绝不放行真同名书（《长生》42 人这种多簇一律维持跳过）。
# 红线（任务书）：必须先有「参照本」才能比——名单有作者时参照本是作者与书单一致的候选
# （但那种候选一旦存在，搜索第一遍就已命中返回、书本不会被拦，故内容比对对「名单有作者」
# 无可救的被拦书，见 §3 说明）；名单无作者时靠候选间两两聚类。无参照本一律维持既有跳过、
# 不猜（同名不同书、名单作者是分类/出版社等被污染字段的情形都落在这里，交上游修，见 §6）。
CONTENT_MATCH_ENV = 'AUTHCV_CONTENT_MATCH'   # =0/false/no/off 关闭（默认开）；回滚即置 0
CONTENT_MAX_CANDIDATES = 3     # 每次最多取文比对的候选数（成本上限；distinct 作者超此数视为同名书泛滥，不试）
CONTENT_MAX_CHAPTERS = 3       # 每个候选取前几章正文做指纹
CONTENT_TOC_MIN_TITLES = 5     # 两侧**去通用标题后**的信息性标题都 ≥ 此数才用目录作判据（M1：3 太松）
CONTENT_NGRAM = 4              # 正文字符 n-gram 长度
CONTENT_MIN_BODY_CHARS = 3000  # 目录不足、只能靠正文判断时，两边去模板后正文都须 ≥ 此字数（M2）
# 阈值依据（authcv-41-report §2/§3、rvauthcv §M1/§M2 反例）：正例=同一本书跨站，章节标题去编号后
# 高度重合且**有序**、开头正文近乎一致；反例=同名不同书/同站模板，靠通用标题或模板段偶然重合。
# 目录是强判据但须防「通用标题（上架感言/尾声/后记…）饱和」打穿：故除集合 Jaccard 外再加**有序 LCS**，
# 二者同时达标才判同书；正文兜底阈值提到 0.60 且要求足够字数。数值取在正反例之间，待现网校准（§6）。
CONTENT_TOC_JACCARD = 0.60     # 目录信息性标题集合 Jaccard 下限
CONTENT_TOC_LCS = 0.60         # 目录前若干信息性标题的有序 LCS 比率下限（M1：与 Jaccard 同时达标）
CONTENT_TOC_LCS_N = 8          # 参与有序 LCS 的前 N 个信息性标题
CONTENT_TOC_MIN_CHARS = 10     # 目录判据的第二道结构闸（M1-r）：两侧**互异信息性章名**的总字符量
#                                都须 ≥ 此值，否则章名信息量不足（如 5 个单字章名）→ 判「目录不可判」转正文
CONTENT_TOC_MIN_MATCH = 5      # §12 绝对量门槛：两侧**匹配上（交集）**的信息性章名互异数须 ≥ 此值。
#                                同名异书至多共享辅助/通用条目，真正共享 ≥5 个情节章名的概率极低——这是
#                                「宁可少救」的结构闸，不靠继续给停用表加词。
CONTENT_TOC_MIN_NAME_CHARS = 4 # §12 信息性章名去编号后最短字数：<4 字（如单字/双字章名）信息量不足，不计入
CONTENT_BODY_JACCARD = 0.60    # 开头正文 n-gram Jaccard 下限（M2：0.30→0.60）

_TOC_NUM_RE = re.compile(
    r'^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节節回卷话話集部篇]'
    r'|[0-9]+\s*[\.、,，:：]?|楔子|序[章言曲]?|引子|正文|番外)\s*')
_TOC_PUNCT_RE = re.compile(
    r'[\s　·、，。：:；;!！?？\-—_()（）\[\]【】《》「」『』"\'“”‘’.]+')
_BODY_KEEP_RE = re.compile(r'[^一-鿿㐀-䶿a-zA-Z]+')


def content_match_enabled() -> bool:
    """内容比对开关（默认开）。AUTHCV_CONTENT_MATCH=0/false/no/off 关闭。"""
    return os.environ.get(CONTENT_MATCH_ENV, '1').strip().lower() not in ('0', 'false', 'no', 'off')


def _norm_toc_title(title: str) -> str:
    """章节标题归一：去「第X章/序/楔子/数字编号」前缀、空白与标点、casefold。"""
    return _split_toc_numbering(title)[1]


def _split_toc_numbering(title: str) -> tuple[bool, str]:
    """归一章节标题并判断**是否带章节编号/结构前缀**（M1-r 结构性判据）。

    返回 `(had_numbering, name)`：`had_numbering` 表示标题前缀命中了 `_TOC_NUM_RE`
    （第X章/节/回/卷/话/集/部/篇、阿拉伯或中文数字序号、序/楔子/引子/正文/番外）；
    `name` 是剥掉编号与标点、casefold 后剩下的章名（可能为空）。
    不带编号前缀的辅助条目（封推感言/更新说明/读者必看…）→ `had_numbering=False`，
    整条不参与目录比对，杜绝表外同义词打穿 Jaccard/LCS。"""
    t = unicodedata.normalize('NFKC', (title or '')).strip()
    stripped = _TOC_NUM_RE.sub('', t)
    had_numbering = stripped != t          # 前缀被 _TOC_NUM_RE 剥掉过 → 是编号章节
    name = _TOC_PUNCT_RE.sub('', stripped).casefold()
    return had_numbering, name


_CN_DIGITS = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
              '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
_CN_UNITS = {'十': 10, '百': 100, '千': 1000}
_CHAP_NUM_RE = re.compile(r'第\s*([0-9零〇一二三四五六七八九十百千两]+)\s*[章节節回卷话話集部篇]')
_CHAP_ARABIC_RE = re.compile(r'^\s*([0-9]+)\s*[\.、,，:：]')


def _cn_to_int(s: str) -> int | None:
    """常见中文数字（含十/百/千，如 十二/一百零三）→ int；解析失败返回 None。"""
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total, section, last_unit = 0, 0, 0
    for ch in s:
        if ch in _CN_DIGITS:
            section = section * 10 + _CN_DIGITS[ch] if last_unit else _CN_DIGITS[ch]
            last_unit = 0
        elif ch in _CN_UNITS:
            unit = _CN_UNITS[ch]
            section = (section or 1) * unit
            total += section
            section = 0
            last_unit = unit
        else:
            return None
    return total + section


def _toc_chapter_number(title: str) -> int | None:
    """章节标题 → 章号（阿拉伯/中文数字，`第X章` 或行首 `12、`）；取不到返回 None，供逐章配对按章号对齐。"""
    t = unicodedata.normalize('NFKC', (title or '')).strip()
    m = _CHAP_NUM_RE.search(t)
    if m:
        return _cn_to_int(m.group(1))
    m = _CHAP_ARABIC_RE.match(t)
    if m:
        return int(m.group(1))
    return None


# ---- 通用/辅助章节标题识别（M1 + §12）----
# 上架感言/尾声/后记/公告 等非情节条目在两本**不同**书里也常一字不差，若参与 Jaccard 会把
# 同名异书误并（rvauthcv M1 反例 C1/C2）。§12：改**子串归类**——只要章名（剥编号后）含下列
# 任一子串即视为辅助项，不计入目录判据。带编号的「第1章 求月票 / 第2章 求推荐票」也照剔
# （N1 反例 A），不再靠「有没有编号」区分。
_AUX_TOC_SUBSTRINGS = (
    '感言', '求票', '月票', '推荐票', '请假', '請假', '通知', '说明', '說明', '公告', '必看', '必看',
    '预告', '預告', '番外', '楔子', '序', '引子', '后记', '後記', '尾声', '尾聲', '上架', '加更', '加更',
    '新书', '新書', '感谢', '感謝', '完本', '完结', '完結', '声明', '聲明', '免责', '免責', '通告',
    '寄语', '寄語', '作品相关', '作品相關', '正文',
)
# 停用表（整词兜底，与子串判据并用）。§12 修复建表 bug：原先用 `_norm_toc_title(w)` 建键，而
# `_norm_toc_title('番外'/'序'/'楔子'/'引子'/'正文')` 会被 `_TOC_NUM_RE` 整词剥成空串 → 这些键
# 根本没进表。改用**只去标点+casefold、不剥编号**的 `_norm_generic_toc_word` 建键，使其生效。
_GENERIC_TOC_WORDS = (
    '上架感言', '完本感言', '新书感言', '完结感言', '感言', '尾声', '尾章', '后记', '後記',
    '前言', '引言', '引子', '序', '序章', '序言', '楔子', '请假条', '请假', '新书', '新書',
    '公告', '通知', '上架', '完本', '完结', '完結', '感谢', '感謝', '作品相关', '作品相關',
    '番外', '番外篇', '写在前面', '寫在前面', '内容简介', '內容簡介', '免责声明', '免責聲明',
    '温馨提示', '溫馨提示', '作者的话', '作者的話', '关于', '關於', '说明', '說明', '声明', '聲明',
    '正文',
)


def _norm_generic_toc_word(w: str) -> str:
    """停用词归一：只去标点/空白 + casefold，**不剥编号前缀**（否则 番外/序/楔子/引子/正文 塌成空）。"""
    return _TOC_PUNCT_RE.sub('', unicodedata.normalize('NFKC', w or '')).casefold()


_GENERIC_TOC_NORM = frozenset(
    t for t in (_norm_generic_toc_word(w) for w in _GENERIC_TOC_WORDS) if t)


def _is_auxiliary_toc_name(name: str) -> bool:
    """章名（剥编号后、已归一）是否辅助/通用条目（§12 子串归类 + 停用表兜底）。"""
    if name in _GENERIC_TOC_NORM:
        return True
    return any(s in name for s in _AUX_TOC_SUBSTRINGS)


def _informative_toc_titles(chapters) -> list[str]:
    """章节列表 → **信息性正文章名**去编号后的有序列表（保序、含重复；§12）。

    信息性章名判据（三者同时满足）：
      (1) 前缀带章节编号（第X章/节/回/卷…、数字序号）——不带编号的辅助条目整条不参与；
      (2) 去编号后章名长度 ≥ CONTENT_TOC_MIN_NAME_CHARS（<4 字信息量不足，不计）；
      (3) 章名不含辅助子串、不落停用表（求月票/更新说明/番外/序… 按**子串**归类，
          带编号的「第1章 求月票」也剔除，堵 N1）。
    这样两本不同书至多共享辅助条目，真正共享的情节章名极少——配合 same_book 的交集下限
    CONTENT_TOC_MIN_MATCH，同名异书无法靠通用/辅助标题打穿目录判据。"""
    seq = []
    for c in chapters:
        if not isinstance(c, dict):
            continue
        had_numbering, name = _split_toc_numbering(c.get('title') or '')
        if not (had_numbering and name):
            continue
        if len(name) < CONTENT_TOC_MIN_NAME_CHARS:
            continue
        if _is_auxiliary_toc_name(name):
            continue
        seq.append(name)
    return seq


def _lcs_ratio(a: list, b: list) -> float:
    """两个序列的最长公共子序列长度 / 较短序列长度（有序对齐比率，0..1）。"""
    if not a or not b:
        return 0.0
    m, n = len(a), len(b)
    prev = [0] * (n + 1)
    for i in range(1, m + 1):
        cur = [0] * (n + 1)
        ai = a[i - 1]
        for j in range(1, n + 1):
            cur[j] = prev[j - 1] + 1 if ai == b[j - 1] else max(prev[j], cur[j - 1])
        prev = cur
    return prev[n] / min(m, n)


def _char_ngrams(text: str, n: int = CONTENT_NGRAM) -> set[str]:
    """正文 → 字符 n-gram 集合：只留中日文与拉丁字母（去数字/标点/空白，抗排版噪声）。"""
    s = _BODY_KEEP_RE.sub('', unicodedata.normalize('NFKC', text or '')).casefold()
    if not s:
        return set()
    if len(s) <= n:
        return {s}
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _cli_json(cli, subcommand: str, *args: str):
    """调 CLI 子命令并解析 JSON；非零退出或坏 JSON → 抛 EngineUnavailable（不含凭据）。"""
    proc = cli.run(subcommand, *args)
    if proc.returncode != 0:
        raise EngineUnavailable(f'引擎 {subcommand} rc={proc.returncode}: {_short_stderr(proc.stderr)}')
    return json.loads(proc.stdout)


# ---- 正文清洗（M2）：比对前剥掉站点模板/广告行，正文兜底才不被打穿 ----
_BODY_DEDUPE_MIN_LINE = 20     # 只对这么长以上的行做跨章去重（对齐 labeler.DEDUPE_MIN_LINE）
_LABELER_DROP_RULE = False     # False=未尝试；None=不可用；callable=labeler._drop_rule

# §12/§13 正文模板模糊去重：逐章变化的模板（句中嵌章号/页码/日期，甚至嵌**汉字/字母变量**如
# 「本章由手打组甲录入」）跨章既不「完全相同」、归一也覆盖不到（任意变量形态）。故改为**行级相似**：
# 同一本书内，一行只要与**其他章**某行字符 bigram Jaccard ≥ 阈值即视为模板剔除，**无论在章内什么
# 位置**（§13：不再只取每章边缘若干行——埋在中段的共享模板同样要剔）。性能用**倒排前缀过滤**：
# 按行长度预筛（长度比 ≥_BODY_LEN_RATIO 才比）+ 按 bigram 文档频次排序、只索引每行最稀有的
# 前缀 bigram，取候选后再精确校验 Jaccard——不做全量 O(n²)。去模板后**保留全部剩余正文行**
# （不再按行长挑「最长前 N 段」——那会把长模板行顶成主体、丢掉短情节行），仅按字数封顶。
_BODY_SIM_BIGRAM = 0.70        # 跨章模糊去重：字符 bigram Jaccard ≥ 此值 → 同一模板行
_BODY_LEN_RATIO = 0.6          # 长度预筛：两行归一长度比 < 此值直接跳过（bigram Jaccard 不可能达标）
_BODY_KEEP_MIN_RATIO = 0.30    # §13 结构兜底：某章去模板后剩余正文 < 原章字数此比例 → 该章不参与正文判同
_BODY_MIN_CHAPTERS = 2         # §13 结构兜底：参与判同的章不足此数 → 正文不可判（与门下即不放行）
_BODY_MAX_CHARS_PER_CHAPTER = 20000  # 每章参与指纹的正文字数上限（按前 N 字封顶，非按行长挑选）
# §14 逐章一致：正文判同不再把参与章合并成一个指纹算一次 Jaccard（任何占住一部分正文的共享文本——
# 模板、公版段落——都能把合并分抬过线）。改为**逐章配对**：两侧参与章按章号（可用时）否则按位置对齐，
# 每对章单独算去模板后正文 n-gram Jaccard，≥CONTENT_BODY_JACCARD 记一对「匹配章对」；且这些匹配章对的
# 正文须**互不相同**（防同一段复制到多章顶替多对证据）——同侧两匹配章的 n-gram Jaccard ≥ 此下限视为
# 同一段，只算一份。至少 _BODY_MIN_PAIRS 个互异匹配章对，正文才判同；对齐后的章对不足 _BODY_MIN_PAIRS
# → 正文不可判（与门下不放行）。
_BODY_PAIR_DISTINCT = 0.60     # 匹配章对互异下限：同侧两匹配章 n-gram Jaccard ≥ 此值 → 视为同一段（不重复计数）
_BODY_MIN_PAIRS = 2            # 放行所需的**互异**匹配章对数下限（<此数 → 正文不判同）


def _line_bigrams(line: str) -> frozenset:
    """行 → 字符 bigram 集合（只留中日文/拉丁，抗排版噪声）；<2 字返回单元素或空集。"""
    s = _BODY_KEEP_RE.sub('', unicodedata.normalize('NFKC', line or '')).casefold()
    if not s:
        return frozenset()
    if len(s) < 2:
        return frozenset((s,))
    return frozenset(s[i:i + 2] for i in range(len(s) - 1))


def _norm_line(line: str) -> str:
    """行归一（NFKC + 只留中日文/拉丁 + casefold），供短行「归一后完全相同」精确剔除用。"""
    return _BODY_KEEP_RE.sub('', unicodedata.normalize('NFKC', line or '')).casefold()


def _lines_similar(bg_a: frozenset, bg_b: frozenset) -> bool:
    """两行 bigram 集合是否相似（Jaccard ≥ _BODY_SIM_BIGRAM）；带长度比预筛省算。"""
    if not bg_a or not bg_b:
        return False
    lo, hi = sorted((len(bg_a), len(bg_b)))
    if lo < hi * _BODY_LEN_RATIO:          # 长度差太大 → Jaccard 上界 lo/hi < 阈值，不可能相似
        return False
    return len(bg_a & bg_b) / len(bg_a | bg_b) >= _BODY_SIM_BIGRAM


def _labeler_drop_rule():
    """惰性取 labeler 的行级清洗规则（复用其广告/公告/求票判据）；不可用则返回 None。"""
    global _LABELER_DROP_RULE
    if _LABELER_DROP_RULE is False:
        try:
            import labeler
            _LABELER_DROP_RULE = labeler._drop_rule
        except Exception:
            _LABELER_DROP_RULE = None
    return _LABELER_DROP_RULE


def _prefix_len(n: int) -> int:
    """前缀过滤：Jaccard≥t 时两集合交集 ≥ t·max(|S|,|T|) ≥ t·|S|，故 S 落在交集外的元素
    ≤ (1-t)|S|；只索引每行按文档频次升序排的前 |S|-⌈t·|S|⌉+1 个（最稀有）bigram，相似行必在
    各自前缀里共享至少一个 bigram（前缀过滤定理），既取全候选又避开高频 bigram 的倒排爆炸。"""
    return max(1, n - ceil(_BODY_SIM_BIGRAM * n) + 1)


def _cross_chapter_template_lines(chapter_lines: list[list[str]]) -> set[str]:
    """（保留供旧调用/测试）全行参与（§13）：返回本书内**与其他章某行模糊相似**
    （bigram Jaccard≥_BODY_SIM_BIGRAM）的 ≥_BODY_DEDUPE_MIN_LINE 字长行**文本集合**。
    §14 起模板剔除实际由 `_template_drop_index`（按位置精确定位，含短行拼块）承担；本函数
    仅为兼容旧断言保留，只覆盖「长行」维度。"""
    drops = _template_drop_index(chapter_lines)
    out: set[str] = set()
    for ci, lines in enumerate(chapter_lines):
        for li, ln in enumerate(lines):
            if len(ln) >= _BODY_DEDUPE_MIN_LINE and (ci, li) in drops:
                out.add(ln)
    return out


def _chapter_segments(lines: list[str]) -> list[tuple[str, tuple[int, ...]]]:
    """把一章行序列切成参与跨章模板比对的**段**：
      - ≥_BODY_DEDUPE_MIN_LINE 字的长行 → 单独成段；
      - 连续的 <_BODY_DEDUPE_MIN_LINE 字短行 → 按序拼成块，块原始长度 ≥_BODY_DEDUPE_MIN_LINE 才成段
        （§14 必修：站点水印/底纹常被硬折成短行逃过行级检测，拼块后一起做跨章模板检测）。
    返回 [(seg_text, (line_idx,...)), ...]（seg_text 供 bigram/精确比对，line_idx 供命中后剔除原始行）。"""
    segs: list[tuple[str, tuple[int, ...]]] = []
    buf: list[str] = []
    buf_idx: list[int] = []

    def flush():
        if buf:
            text = ''.join(buf)
            if len(text) >= _BODY_DEDUPE_MIN_LINE:
                segs.append((text, tuple(buf_idx)))
        buf.clear()
        buf_idx.clear()

    for i, ln in enumerate(lines):
        if len(ln) >= _BODY_DEDUPE_MIN_LINE:
            flush()
            segs.append((ln, (i,)))
        else:
            buf.append(ln)
            buf_idx.append(i)
    flush()
    return segs


def _template_drop_index(chapter_lines: list[list[str]]) -> set[tuple[int, int]]:
    """跨章模板/串章/分页重叠识别（§13 全行参与 + §14 短行拼块）→ 需剔除的 (章号, 行号) 集合。
      (1) 段级（长行 + 短行拼块）：段文本在 ≥2 章出现（精确）或与**其他章**某段 bigram Jaccard≥
          _BODY_SIM_BIGRAM（模糊，倒排前缀过滤避免 O(n²)）→ 该段构成的原始行全部剔；
      (2) 独立短行：<_BODY_DEDUPE_MIN_LINE 字的行，归一后完全相同且出现在 ≥2 章 → 精确剔
          （§14 必修：短行水印即便未连成块也剔）。"""
    segs: list[dict] = []
    for ci, lines in enumerate(chapter_lines):
        for text, idxs in _chapter_segments(lines):
            segs.append({'ci': ci, 'idx': idxs, 'bg': _line_bigrams(text), 'text': text})
    template_ids: set[int] = set()
    # (1a) 段文本精确跨章重复
    text_chapters: dict[str, set[int]] = defaultdict(set)
    for s in segs:
        text_chapters[s['text']].add(s['ci'])
    for i, s in enumerate(segs):
        if len(text_chapters[s['text']]) >= 2:
            template_ids.add(i)
    # (1b) 单章唯一的段建倒排前缀过滤，跨章模糊相似 → 模板
    fuzzy = [i for i, s in enumerate(segs) if i not in template_ids and s['bg']]
    df: dict[str, int] = defaultdict(int)
    for i in fuzzy:
        for b in segs[i]['bg']:
            df[b] += 1
    index: dict[str, list[int]] = defaultdict(list)
    prefixes: dict[int, frozenset] = {}
    for i in fuzzy:
        bg = segs[i]['bg']
        pref = frozenset(sorted(bg, key=lambda b: (df[b], b))[:_prefix_len(len(bg))])
        prefixes[i] = pref
        for b in pref:
            index[b].append(i)
    for i in fuzzy:
        if i in template_ids:
            continue
        s = segs[i]
        na = len(s['bg'])
        seen: set[int] = set()
        hit = False
        for b in prefixes[i]:
            for j in index[b]:
                if j == i or j in seen:
                    continue
                seen.add(j)
                o = segs[j]
                if o['ci'] == s['ci']:
                    continue                            # 同章不算跨章模板
                nb = len(o['bg'])
                lo, hi = (na, nb) if na <= nb else (nb, na)
                if lo < hi * _BODY_LEN_RATIO:
                    continue
                if len(s['bg'] & o['bg']) / len(s['bg'] | o['bg']) >= _BODY_SIM_BIGRAM:
                    template_ids.add(i)
                    template_ids.add(j)
                    hit = True
                    break
            if hit:
                break
    drops: set[tuple[int, int]] = set()
    for i in template_ids:
        for li in segs[i]['idx']:
            drops.add((segs[i]['ci'], li))
    # (2) 独立短行：归一后完全相同且出现在 ≥2 章 → 精确剔
    short_locs: dict[str, list[tuple[int, int]]] = defaultdict(list)
    short_chaps: dict[str, set[int]] = defaultdict(set)
    for ci, lines in enumerate(chapter_lines):
        for li, ln in enumerate(lines):
            if len(ln) < _BODY_DEDUPE_MIN_LINE:
                nm = _norm_line(ln)
                if nm:
                    short_locs[nm].append((ci, li))
                    short_chaps[nm].add(ci)
    for nm, chaps in short_chaps.items():
        if len(chaps) >= 2:
            drops.update(short_locs[nm])
    return drops


def _clean_body_chapters(parts: list[str]) -> list[str | None]:
    """章正文列表 → 每章去模板后的干净正文（保序）；某章去模板后为空或剩余 < 原章字数
    _BODY_KEEP_MIN_RATIO → None（该章不参与判同）。§13/§14：
      (1) 跨章模板/短行水印剔除（`_template_drop_index`，按位置精确剔，含短行拼块与短行精确剔）；
      (2) 复用 labeler 行级清洗 `_drop_rule` 剔广告/公告/求票行（best-effort）；
      (3) 保留全部剩余正文行（保序、不按行长挑选），仅按 _BODY_MAX_CHARS_PER_CHAPTER 封顶。"""
    chapter_lines = [[ln.strip() for ln in re.split(r'[\r\n]+', p) if ln.strip()] for p in parts]
    drops = _template_drop_index(chapter_lines)
    drop_rule = _labeler_drop_rule()
    out: list[str | None] = []
    for ci, lines in enumerate(chapter_lines):
        orig_chars = sum(len(ln) for ln in lines)
        kept: list[str] = []
        for li, ln in enumerate(lines):
            if (ci, li) in drops:
                continue                                # 跨章模板 / 短行水印，剔
            if drop_rule is not None:
                try:
                    if drop_rule(ln):
                        continue                        # labeler 判为广告/公告/求票
                except Exception:
                    pass
            kept.append(ln)
        kept_chars = sum(len(ln) for ln in kept)
        if not kept or (orig_chars and kept_chars < orig_chars * _BODY_KEEP_MIN_RATIO):
            out.append(None)                            # §13：该章去模板后剩余不足 → 不参与判同
        else:
            out.append('\n'.join(kept)[:_BODY_MAX_CHARS_PER_CHAPTER])  # 按字数封顶
    return out


def _clean_body_parts(parts: list[str]) -> tuple[str, int]:
    """（兼容口径）章正文列表 → (去模板后的合并正文, 参与判同的章数)。逐章清洗见
    `_clean_body_chapters`；合并文本仅供旧断言/日志，判同已改逐章配对（§14 `_body_decides`）。"""
    chaps = _clean_body_chapters(parts)
    kept = [c for c in chaps if c is not None]
    return '\n'.join(kept), len(kept)


def fetch_content_fingerprint(cli, book_url: str,
                              max_chapters: int = CONTENT_MAX_CHAPTERS,
                              cache: dict | None = None) -> dict | None:
    """取候选的内容指纹 {'toc': set[标题], 'body': set[n-gram]}；取不到返回 None。

    成本受控（N1）：目录 1 次 + **最多发起 max_chapters 次 content 调用**（按实际发起次数封顶，
    而非按收到 >100 字的章数——否则前若干章都是公告/空壳短章时会逐章发请求、远超预期）。
    cache（{url: 指纹}）在一次搜索内复用，同一 URL 不重复取文。任何异常（源失效/坏 JSON/
    超时）→ None（比对方按「无指纹」处理，绝不因取文失败而误判同书）。"""
    if cache is not None and book_url in cache:
        return cache[book_url]
    fp: dict | None = None
    try:
        toc = _cli_json(cli, 'toc', '--url', book_url) or {}
        chapters = toc.get('chapters') or []
        toc_seq = _informative_toc_titles(chapters)      # M1：有序、去通用标题、去编号空串
        body_parts: list[str] = []
        body_nums: list[int | None] = []                 # §14：各参与章的章号（供逐章配对按章号对齐）
        content_calls = 0
        for ch in chapters:
            if content_calls >= max_chapters:     # N1：按实际发起的 content 调用次数封顶
                break
            if not isinstance(ch, dict):
                continue
            ch_url = ch.get('url') or ''
            if not ch_url:
                continue
            content_calls += 1
            try:
                text = (_cli_json(cli, 'content', '--url', ch_url) or {}).get('text') or ''
            except Exception:
                text = ''
            if len(text) > 100:
                body_parts.append(text)
                body_nums.append(_toc_chapter_number(ch.get('title') or ''))
        cleaned = _clean_body_chapters(body_parts)        # M2/§13/§14：逐章去模板（含短行拼块）
        by_chapter = [{'num': body_nums[i], 'ngrams': _char_ngrams(txt), 'chars': len(txt)}
                      for i, txt in enumerate(cleaned) if txt is not None]
        merged = '\n'.join(txt for txt in cleaned if txt is not None)   # 仅供合并口径日志/旧断言
        fp = {'toc': toc_seq, 'body': _char_ngrams(merged),
              'body_chars': len(merged), 'body_chapters': len(by_chapter),
              'body_by_chapter': by_chapter}
    except Exception:
        fp = None
    if cache is not None:
        cache[book_url] = fp
    return fp


def _toc_decides(fp_a: dict, fp_b: dict) -> tuple[bool, bool, float, float]:
    """目录信号：返回 (judgeable, same, toc_jaccard, lcs)。

    judgeable=False 表示目录信息不足、**不可判**（信息性章名太少/字符量不足/交集不够）。
    §12 绝对量门槛：除 Jaccard/LCS 外，两侧**交集**的信息性章名互异数须 ≥ CONTENT_TOC_MIN_MATCH——
    同名异书至多共享辅助条目，真正共享 ≥5 个情节章名的概率极低，靠加词的停用表堵不住、靠这道
    交集下限才堵得住。judgeable 时才比 Jaccard≥CONTENT_TOC_JACCARD 且有序 LCS≥CONTENT_TOC_LCS。"""
    seq_a, seq_b = fp_a.get('toc') or [], fp_b.get('toc') or []
    set_a, set_b = set(seq_a), set(seq_b)
    toc_sim = _jaccard(set_a, set_b)
    inter = len(set_a & set_b)
    info_chars = min(sum(len(t) for t in set_a), sum(len(t) for t in set_b))
    judgeable = (min(len(set_a), len(set_b)) >= CONTENT_TOC_MIN_TITLES
                 and info_chars >= CONTENT_TOC_MIN_CHARS
                 and inter >= CONTENT_TOC_MIN_MATCH)
    if not judgeable:
        return False, False, toc_sim, 0.0
    lcs = _lcs_ratio(seq_a[:CONTENT_TOC_LCS_N], seq_b[:CONTENT_TOC_LCS_N])
    same = toc_sim >= CONTENT_TOC_JACCARD and lcs >= CONTENT_TOC_LCS
    return True, same, toc_sim, lcs


def same_book(fp_a: dict | None, fp_b: dict | None) -> tuple[bool, dict]:
    """两个内容指纹是否同一本书 → (bool, sim)。

    §12 **双信号与门**：放行必须「目录判同」`_toc_decides` **且**「正文判同」`_body_decides`
    两者同时成立。任一「不可判」（目录信息性章名不足/交集 <CONTENT_TOC_MIN_MATCH、正文字数不足、
    取文失败/无指纹）→ 一律不放行。删除了「目录不可判就只看正文」「只凭目录」的单信号放行路径——
    每个单信号都可能被站点噪声（通用标题、模板正文）单独抬过阈值，双信号与门要求两条证据齐备。
    原则：宁可少救，不可误放。sim 里 toc_ok/body_ok 分别记两信号是否「可判且判同」。"""
    empty = {'toc': 0.0, 'lcs': 0.0, 'body': 0.0, 'toc_ok': False, 'body_ok': False, 'basis': 'none'}
    if not fp_a or not fp_b:
        return False, empty
    toc_judgeable, toc_same, toc_sim, lcs = _toc_decides(fp_a, fp_b)
    body_judgeable, body_same, body_sim, body_pairs = _body_decides(fp_a, fp_b)
    toc_ok = toc_judgeable and toc_same
    body_ok = body_judgeable and body_same
    released = toc_ok and body_ok
    return released, {'toc': toc_sim, 'lcs': lcs, 'body': body_sim, 'body_pairs': body_pairs,
                      'toc_ok': toc_ok, 'body_ok': body_ok,
                      'basis': 'toc+body' if released else 'none'}


def _align_chapter_pairs(fp_a: dict, fp_b: dict) -> list[tuple[set, set]]:
    """两侧参与章按章号（两侧章号都齐全且无重号时）否则按位置对齐 → [(ngrams_a, ngrams_b), ...]（§14）。"""
    ca = fp_a.get('body_by_chapter') or []
    cb = fp_b.get('body_by_chapter') or []
    na = [c.get('num') for c in ca]
    nb = [c.get('num') for c in cb]
    if (na and nb and all(n is not None for n in na) and all(n is not None for n in nb)
            and len(set(na)) == len(na) and len(set(nb)) == len(nb)):
        mb = {c['num']: c for c in cb}
        return [(c['ngrams'], mb[c['num']]['ngrams']) for c in ca if c['num'] in mb]
    return [(ca[i]['ngrams'], cb[i]['ngrams']) for i in range(min(len(ca), len(cb)))]


def _body_decides(fp_a: dict, fp_b: dict) -> tuple[bool, bool, float, int]:
    """正文信号（M2 + §12/§13 + §14 逐章一致）：返回 (judgeable, same, 代表相似度, 互异匹配章对数)。

    §14：删除「参与章合并成一个指纹算一次 Jaccard」路径——共享模板/公版段落只要占住一部分正文就能把
    合并分抬过线。改为**逐章配对**：两侧参与章按章号（可用）否则按位置对齐，每对章单独算去模板后正文
    n-gram Jaccard，≥CONTENT_BODY_JACCARD 记一「匹配章对」；再要求匹配章对的正文**互不相同**（同侧两
    匹配章 n-gram Jaccard≥_BODY_PAIR_DISTINCT 视为同一段、只算一份，防同段复制到多章）。
    judgeable：两边去模板后正文都 ≥CONTENT_MIN_BODY_CHARS 字、两边参与章都 ≥_BODY_MIN_CHAPTERS、
    且对齐后的章对 ≥_BODY_MIN_CHAPTERS——否则「不可判」。same：互异匹配章对 ≥_BODY_MIN_PAIRS。"""
    pairs = _align_chapter_pairs(fp_a, fp_b)
    judgeable = (min(fp_a.get('body_chars', 0), fp_b.get('body_chars', 0)) >= CONTENT_MIN_BODY_CHARS
                 and min(fp_a.get('body_chapters', 0), fp_b.get('body_chapters', 0)) >= _BODY_MIN_CHAPTERS
                 and len(pairs) >= _BODY_MIN_CHAPTERS)
    sims = [_jaccard(pa, pb) for pa, pb in pairs]
    rep = max(sims) if sims else 0.0
    if not judgeable:
        return False, False, rep, 0
    # 匹配章对（每对各≥阈值）+ 互异去重（同侧不重复计同一段）
    kept_a: list[set] = []
    kept_b: list[set] = []
    distinct = 0
    for (pa, pb), j in zip(pairs, sims):
        if j < CONTENT_BODY_JACCARD:
            continue
        if any(_jaccard(pa, ka) >= _BODY_PAIR_DISTINCT for ka in kept_a):
            continue                                     # 与已计入的匹配章 A 侧同段 → 不重复计
        if any(_jaccard(pb, kb) >= _BODY_PAIR_DISTINCT for kb in kept_b):
            continue                                     # B 侧同段 → 不重复计
        kept_a.append(pa)
        kept_b.append(pb)
        distinct += 1
    return True, (distinct >= _BODY_MIN_PAIRS), rep, distinct


def _cluster_by_content(cli, reps: list[dict], cache: dict) -> tuple[list[list[int]], dict]:
    """reps 两两 same_book → 单链并查集聚类。返回 (簇列表[下标], 最高相似度信息)。"""
    fps = [fetch_content_fingerprint(cli, r['hit']['url'], cache=cache) for r in reps]
    n = len(reps)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    best = {'toc': 0.0, 'body': 0.0, 'body_pairs': 0, 'basis': 'none'}
    for i in range(n):
        for j in range(i + 1, n):
            ok, sim = same_book(fps[i], fps[j])
            if max(sim['toc'], sim['body']) > max(best['toc'], best['body']):
                best = sim
            if ok:
                parent[find(i)] = find(j)
    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    return list(clusters.values()), best


def _distinct_author_reps(unknown_hits: list[tuple[dict, str]]) -> list[dict]:
    """按归一化作者去重取代表（作者已知优先），上限 CONTENT_MAX_CANDIDATES。"""
    reps, seen = [], set()
    for hit, a in unknown_hits:
        key = _norm_author(a)
        if key and key not in seen:
            seen.add(key)
            reps.append({'hit': hit, 'author': a})
    return reps[:CONTENT_MAX_CANDIDATES]


def _content_rescue_unknown(cli, title: str,
                            unknown_hits: list[tuple[dict, str]]) -> dict | None:
    """名单无作者、判歧义时用内容比对救回：候选内容聚为**唯一主簇**才放行，返回代表 hit
    （作者已知优先，供 label 阶段 toc 回写作者）；多簇/无法判定/作者过多 → None（维持跳过）。"""
    _, ambiguous, authors = _author_unknown_decision(unknown_hits)
    if not ambiguous:
        return None                       # 非歧义：交常规路径，不额外取文
    if len(authors) > CONTENT_MAX_CANDIDATES:
        return None                       # 候选作者过多（同名书泛滥）：不试，维持跳过
    reps = _distinct_author_reps(unknown_hits)
    if len(reps) < 2:
        return None
    clusters, best = _cluster_by_content(cli, reps, cache={})
    if len(clusters) != 1:                # 未聚成唯一主簇 → 维持跳过
        return None
    known = [r for r in reps if _norm_author(r['author'])]
    chosen = known[0] if known else reps[0]
    print(f'  内容比对放行: 《{title}》名单无作者，{len(reps)} 个候选内容聚为一簇'
          f'（双信号 目录≈{best["toc"]:.2f}/正文≈{best["body"]:.2f}，{best.get("body_pairs", 0)} 对互异章），采信作者 {chosen["author"] or "（引擎待定）"}'
          f'，参照源 {chosen["hit"].get("source", "")}（content_match）')
    hit = chosen['hit']
    if chosen['author']:                  # M3：把采信作者回带到 hit，供条目 author 回写（不写污染串）
        hit['author'] = chosen['author']
    # §14 审计标记：经内容比对救回的条目透出诊断，供 _resolve_candidates 写入 entry
    # （author_source=content_match + content_match:{toc, body_pairs, basis}），日后按标记抽查/回滚。
    hit['content_match'] = {'toc': round(best.get('toc', 0.0), 4),
                            'body_pairs': best.get('body_pairs', 0),
                            'basis': best.get('basis', 'toc+body')}
    return hit


def _attach_unknown_author(hit: dict | None, unknown_hits: list[tuple[dict, str]]) -> dict | None:
    """把名单无作者路径选中 hit 所对应的候选作者回带到 hit['author']（M3，供条目 author 回写）。"""
    if hit is None:
        return None
    for h, a in unknown_hits:
        if (h is hit or h.get('url') == hit.get('url')) and a:
            hit['author'] = a
            break
    return hit


def _annotate_bogus(hit: dict | None, bogus_raw: str) -> dict | None:
    """§7/M3：污染降级来源的 hit 打标记 + 存原串（仅诊断），供 _resolve_candidates 置空条目 author。"""
    if hit is not None and bogus_raw:
        hit['list_author_bogus'] = True
        hit['list_author_raw'] = bogus_raw
    return hit



# ---- 换源备选（giveup41）----
# 主候选之外、过同一套判据（title 兼容 / 作者判定与主候选同口径 / 引擎可取的 HTTPS）的其他候选。
# 打标阶段主源整站失效（连续多章确定性错误）时按序换用。静默：不打印、不计 stats——日志与计数
# 仍只反映主候选的选择过程。只在有备选时才给 hit 加 alternates 键。
# 名单有作者：author_matches 已验证的在前、候选作者空的在后，错配不收（_known_author_alternates）；
# 名单无作者：服从 _pick_author_unknown——判歧义则无主候选也无备选，否则其余兼容候选都可作备选。
ENGINE_MAX_ALTERNATES = 3


def _known_author_alternates(title: str, author: str, candidates: list) -> list[dict]:
    verified, unknown = [], []
    for c in candidates:
        if not isinstance(c, dict) or c.get('source') == 'book15.net':
            continue
        book_url = c.get('bookUrl') or ''
        site_title = c.get('title') or ''
        if (not book_url or not title_compatible(title, site_title)
                or not engine_url_supported(book_url)):
            continue
        entry = {'url': book_url, 'title': site_title, 'source': c.get('source', '')}
        cand_author = c.get('author') or ''
        if not _norm_author(cand_author):
            unknown.append(entry)
        elif author_matches(author, cand_author):
            verified.append(entry)
    return verified + unknown


# ---- 付费试读源降权（lbladfix41）----
# yunqi.qq.com 实抓（lbladdiag-41-report §2）：目录大部分章标题带「APP免费」、正文是约 100 字截断预览，
# 打标只能用免费的前几十章；chuangshi.qq.com 同为腾讯系付费源。不拉黑（有时是唯一来源），
# 只在同一身份档内排到最后：主候选优先取别的源，备选里也排在末位。
DEPRIORITIZED_SOURCE_HOSTS = frozenset({'yunqi.qq.com', 'chuangshi.qq.com'})


def _is_deprioritized(entry) -> bool:
    if not isinstance(entry, dict):
        return False
    host = entry.get('source') or ''
    if not host:
        try:
            host = urllib.parse.urlsplit(entry.get('bookUrl') or entry.get('url') or '').hostname or ''
        except ValueError:
            host = ''
    return host.lower() in DEPRIORITIZED_SOURCE_HOSTS


def _deprioritize_sources(items: list) -> list:
    """稳定排序：降权 host 的条目挪到末尾，其余顺序不变。"""
    return sorted(items, key=_is_deprioritized)


def _with_alternates(hit: dict | None, pool: list[dict]) -> dict | None:
    """hit 加上 pool 中（去掉 hit 自身、按 URL 去重、上限 ENGINE_MAX_ALTERNATES）的备选。
    降权源（DEPRIORITIZED_SOURCE_HOSTS）排在备选末位。"""
    if hit is None:
        return None
    seen, alternates = {hit['url']}, []
    for entry in _deprioritize_sources(pool):
        if entry['url'] in seen:
            continue
        seen.add(entry['url'])
        alternates.append(dict(entry))
        if len(alternates) >= ENGINE_MAX_ALTERNATES:
            break
    if alternates:
        hit['alternates'] = alternates
    return hit


def validate_engine(cli) -> None:
    """验证引擎 CLI 可启动；失败按环境错误抛出且不泄露连接串。"""
    try:
        proc = cli.validate()
    except subprocess.TimeoutExpired:
        raise EngineUnavailable(f'引擎启动探针超时（{ENGINE_CLI_TIMEOUT}s）')
    except OSError as e:
        raise EngineUnavailable(f'引擎 CLI 无法调用: {type(e).__name__}')
    if proc.returncode != 0:
        raise EngineUnavailable(f'引擎启动探针失败（rc={proc.returncode}）: '
                                f'{_short_stderr(proc.stderr)}')
    try:
        payload = json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError):
        raise EngineUnavailable('引擎启动探针返回无效 JSON')
    if not isinstance(payload, dict) or payload.get('ok') is not True:
        raise EngineUnavailable('引擎启动探针返回异常结果')


def build_douban_queue(http_get, skip_titles: set | None = None,
                       pages: int | None = None, engine_cli=None,
                       book15_breaker: Book15Breaker | None = None) -> list[dict]:
    """豆瓣名单 → book15 打标队列 [{url, title, author, category, status, douban_url}]。

    与 labeler.fetch_rank_books() 的产出同构（url 为站内相对路径），
    打标循环零改动直接消费。搜不到 / 误匹配的书记日志跳过，不阻塞队列。
    skip_titles（归一化书名集合）= 已打标书名，搜索前直接跳过（审查 D.3）。"""
    douban_books = fetch_douban_books(http_get, pages=pages)
    print(f'豆瓣名单共 {len(douban_books)} 本（去重后）')
    return _resolve_candidates(douban_books, http_get, origin='豆瓣tag',
                               skip_titles=skip_titles, engine_cli=engine_cli,
                               book15_breaker=book15_breaker)


def _resolve_candidates(candidates: list[dict], http_get, origin: str = '',
                        skip_titles: set | None = None, engine_cli=None,
                        book15_breaker: Book15Breaker | None = None) -> list[dict]:
    """候选名单（[{title, author, ...}]）→ 过 book15 搜索+校验的打标队列。

    各名单源共用：命中记队列（category 记来源标记，默认取候选自带 origin，
    调用方可用 origin 参数覆盖），miss 记日志跳过。
    skip_titles 命中（书名归一化后已在 labels.jsonl）→ **不发搜索**直接跳过：
    缓存是优化，「跳过已完成再搜」是正确性/产品问题（审查 D.3）。

    engine_cli（T5）：非空且 LABELER_ENGINE_FALLBACK 开启时，book15 miss 才回落引擎源池。
    engine_cli=None（开关关闭）时本函数行为**逐字不变**（红线）——不调 CLI、条目无 engine 标记。
    引擎命中的条目带 {'engine': True, 'source_host': host, url=bookUrl（绝对）}；
    退出码 2（环境错误）→ 本轮禁用引擎、降级 book15-only、不重试（不连坐后续候选）。

    book15_breaker（labelerdiag41）：book15 连续搜索全失败达阈值后，剩余候选不再搜 book15、
    直接走引擎兜底；None 时行为不变。"""
    queue: list[dict] = []
    miss: list[str] = []
    skipped = 0
    book15_hits = 0
    engine_hits = 0
    engine_stats: dict = {}
    engine_junk = EngineJunkTracker() if engine_cli is not None else None
    engine_disabled = False
    for b in candidates:
        key = _norm_title(b.get('title', ''))
        if skip_titles and key and key in skip_titles:
            skipped += 1
            continue
        # espfix41：book15 已熔断 ⇒ 本本不会请求 book15，SEARCH_DELAY（对 book15 的礼貌间隔）不再睡；
        # 引擎 CLI 内部自带按请求节流，且每本新起进程本身就隔开了对同站的两次搜索。
        book15_skipped = book15_breaker is not None and book15_breaker.open
        hit = search_book15(http_get, b['title'], breaker=book15_breaker)
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
                engine_hit = search_engine(engine_cli, b['title'], b.get('author', ''),
                                           stats=engine_stats, junk=engine_junk)
            except EngineUnavailable as e:
                # 环境错误：本轮降级 book15-only，后续候选不再尝试引擎（不连坐重试）
                print(f'  引擎兜底不可用，本轮降级 book15-only（不重试）: {e}',
                      file=sys.stderr)
                engine_disabled = True
        if engine_hit:
            entry = {'url': engine_hit['url'], 'title': engine_hit['title'],
                     # 名单书名（rvauthor 增量必修）：engine_hit['title'] 是候选站点标题，会覆盖
                     # 名单书名；打标回写要用名单书名与 toc 标题比「完全相等」，故在条目里另存一份。
                     'list_title': b.get('title', ''),
                     'author': b.get('author', ''),
                     'category': origin or b.get('origin', ''),
                     'status': '',
                     'douban_url': b.get('douban_url', ''),
                     'engine': True,
                     'source_host': engine_hit['source']}
            # M3：名单作者被污染而降级的条目——author 绝不能是污染原串。原串仅存 list_author_raw
            # 供诊断；condition author 取内容比对/唯一候选采信的候选作者（无则空，交 labeler toc 回写/review）。
            if engine_hit.get('list_author_bogus'):
                entry['list_author_raw'] = engine_hit.get('list_author_raw') or b.get('author', '')
                entry['author'] = engine_hit.get('author') or ''
            # §14 审计标记：经内容比对救回（作者不符/无作者被内容比对放行）的条目打标，
            # 供日后按标记抽查与回滚。诊断字段不入库表——import 两条路径（import_one.validate_record /
            # import_labels.mjs）都按已知字段名 .get 读取，未知顶层字段被忽略、不拒收。
            if engine_hit.get('content_match'):
                entry['author_source'] = 'content_match'
                entry['content_match'] = engine_hit['content_match']
            if engine_hit.get('alternates'):
                # giveup41：主源整站失效时打标阶段按序换用（labeler.fetch_engine_book_with_giveup）
                entry['engine_alternates'] = engine_hit['alternates']
            queue.append(entry)
            engine_hits += 1
        else:
            miss.append(b['title'])
        if not book15_skipped:
            time.sleep(SEARCH_DELAY)
    # 开关关闭时 engine_hits=0 且 book15_hits==len(queue)，本行逐字复现旧文案（红线）。
    engine_note = f'，引擎兜底命中 {engine_hits} 本' if engine_cli is not None else ''
    if engine_stats.get('http_only'):
        engine_note += f'（跳过非 HTTPS 源候选 {engine_stats["http_only"]} 条）'
    # 未熔断时本行逐字不变；熔断后补一段「熔断跳过 book15 搜索 N 本」。
    breaker_note = (f'，book15 熔断跳过搜索 {book15_breaker.skipped} 本'
                    if book15_breaker is not None and book15_breaker.open else '')
    print(f'book15 命中 {book15_hits} 本，未命中 {len(miss)} 本，'
          f'跳过已打标 {skipped} 本{engine_note}{breaker_note}'
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
# 起点分类全集（authfix41）：榜单页条目是「书名 → 简介 → 作者 → 分类 → 字数」，分类词不在
# 本集合里就会被 _looks_author 当成作者（phoenix 实测「悬疑灵异」101 行、「诸天无限」16、
# 「轻小说」14、「现实」2 把真作者顶掉）。宁可多列：分类词本来就不是人名，多列无误伤。
QIDIAN_GENRES = frozenset({
    # 男频（m.qidian.com/rank 页分类导航，2026-09-25 实测）
    '全站', '玄幻', '奇幻', '武侠', '仙侠', '都市', '现实', '军事', '历史', '游戏', '体育',
    '科幻', '悬疑灵异', '诸天无限', '轻小说',
    # 旧版/别名分类
    '悬疑', '灵异', '二次元', '短篇', '无限流', '游戏竞技', '同人', '其他', '言情',
    # 女频
    '古代言情', '现代言情', '幻想言情', '玄幻言情', '仙侠奇缘', '浪漫青春', '悬疑推理',
    '科幻空间', '现实生活', '衍生言情', '纯爱', 'N次元',
})
_QD_NOISE = {'完本', '完结', '连载', '更多', '男生', '女生', '返回', '取消'} | QIDIAN_GENRES


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
# author17k41（2026-09-26 实测）：头部精品书卡的 href 内嵌制表符（`book/\t3038645.html`），
# 旧正则 `book/(\d+)\.html` 吃不到 → 漏收约 11 本真完本书。放宽为容忍 book/ 与 .html 间的空白
# （clean 锚点零空白仍匹配，行为不变）。这些书卡正是页面唯一带作者的位置（见 _extract_17k_authors）。
_Y17K_BOOK_RE = re.compile(
    r'href="//www\.17k\.com/book/\s*(\d+)\s*\.html"[^>]*>(.*?)</a>', re.S)
_Y17K_TAG_RE = re.compile(r'<[^>]*>')
# 完本页作者来源（author17k41 调研，2026-09-26 实测）：
#   只有头部「精品专区」书卡带作者，形态 `作者：<a href="//user.17k.com/see/...">作者名</a>`
#   （既有 <span> 也有 <p class="author"> 两种外层）。主列表的纯书名锚点无作者。
#   详情页 /book/<id>.html、search.17k.com、wap./www. 的检索页对无 cookie 请求一律返回
#   阿里云 WAF 的 acw_sc__v2 JS 挑战；api.17k.com 需 appKey 签名；m./sou. 子域 DNS 不解析。
#   ⇒ 没有可用的「按 book id/书名」免 WAF、免鉴权的作者接口，只就地解析页面已有作者，
#   补不到保持空串（不硬造）。作者锚点专用 user.17k.com，据此与书名锚点区分。
_Y17K_ANY_ANCHOR_RE = re.compile(
    r'href="//(www|user)\.17k\.com/(?:book/\s*(\d+)\s*\.html|see/[^"]*)"[^>]*>(.*?)</a>', re.S)
_Y17K_AUTHOR_LABEL_RE = re.compile(r'作\s*者\s*[:：]\s*$')
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


def _extract_17k_authors(html: str) -> dict[str, str]:
    """完本页「精品专区」就地作者：{book_id: author}（补不到的 id 不入表）。

    页面唯一带作者的位置是头部书卡：`…<a href="//www.17k.com/book/ID.html">书名</a>…
    作者：<a href="//user.17k.com/see/…">作者名</a>`。按文档顺序扫描 book/user 两类锚点，
    user 锚点若紧跟「作者：」标签，就归给最近一个 book 锚点的 id。主列表的纯书名锚点无
    作者标签，天然不入表。作者名剥标签/空白，空则不记（不硬造）。"""
    authors: dict[str, str] = {}
    last_bid = ''
    for m in _Y17K_ANY_ANCHOR_RE.finditer(html):
        kind, bid, inner = m.group(1), m.group(2), m.group(3)
        if kind == 'www' and bid:
            last_bid = bid
            continue
        if kind != 'user' or not last_bid or last_bid in authors:
            continue
        # 该 user 锚点前是否紧跟「作者：」标签（匹配始于 href=，前面还挂着截断的
        # 开标签 <a …，先去掉再剥完整标签，才能让「作者：」落到串尾）
        prefix = re.sub(r'<[^>]*$', '', html[max(0, m.start() - 40):m.start()])
        prefix = _Y17K_TAG_RE.sub('', prefix)
        if not _Y17K_AUTHOR_LABEL_RE.search(prefix):
            continue
        name = _Y17K_TAG_RE.sub('', inner).strip()
        if name:
            authors[last_bid] = name
    return authors


def parse_17k_quanben(html: str) -> list[dict]:
    """17K 完本页 → [{title, author, origin}]（页面只有头部书卡带作者，其余 author 空）。

    同一本书在页面上有多个锚点（实测）：
    - **纯文本**锚点：`<a href=…>书名</a>`（权威书名，页面后段）；
    - **推广**锚点：`<a href=…><img …/><span>XX：书名</span></a>`（封面/推荐位）；
    - **简介**锚点：`<a href=…>整句简介</a>`。

    取法：按 book id 分组，**优先纯文本锚点**（旧行为，推广/简介锚点被天然跳过）；
    该 id 没有任何纯文本锚点时，才回退用带标签锚点剥标签后的文本——覆盖审查 C.1 指出的
    「8 个 id 书名只在 `<span>` 里」的漏收（例：`挣大钱斗极品：重生好媳妇`）。
    再按归一化书名跨 id 去重。宁缺勿滥：简介句仍被 _clean_17k_title 的标点/长度闸挡掉。

    author17k41（2026-09-26）：接入 _extract_17k_authors 就地补作者——头部书卡有「作者：」
    标签的 id 补上作者，其余保持空串（详情页/检索接口被 WAF 或需鉴权，无免拦来源，不硬造）。"""
    authors = _extract_17k_authors(html)
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
        books.append({'title': title, 'author': authors.get(bid, ''),
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
                         pages: int | None = None, engine_cli=None,
                         book15_breaker: Book15Breaker | None = None) -> list[dict]:
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
                               engine_cli=engine_cli, book15_breaker=book15_breaker)
