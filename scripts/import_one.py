#!/usr/bin/env python3
"""单条增量导入：labeler 打标产物 → Neon labeled_books（全自动即时入库）。

## 为什么是 python + Neon HTTP SQL 接口（零依赖）

phoenix（打标机）刻意不装 PG 驱动（见 labeler.py「入库层」注释）。但 labeler.py
读 app_settings.label_model 时已经在用 Neon 的 HTTPS SQL 通道
（`POST https://{host}/sql` + `Neon-Connection-String` 头，见 fetch_label_model_from_db），
那是**已在生产跑通**的路径。本模块沿用同一通道，于是：

- 不需要在 phoenix 上确认/安装 node，也不需要 psycopg；
- 「打标在跑、书库没书」的错位由 labeler.py 每标完一本即调本模块消除，
  不再依赖本地人工跑 scripts/import_labels.mjs。

## 幂等红线（同一本书不得出现第二行）

三层：

1. **ON CONFLICT (title_key, author_key) DO UPDATE** —— 与 import_labels.mjs 同一条
   UPSERT；身份键是 migrations/0002_identity_key.sql 的确定性生成列（NFKC + 去书名号
   + lower）。重复写同一本书 = 更新同一行，不新增。
2. **R02 非不动点孪生行前置拦截**（import_labels.mjs 同判据的保守移植）：存量行的作者
   经实体解码后与本次作者同身份、但原文不同 → 跳过写入，不凭空多一行。
3. **labels-imported.jsonl 标记**：已导入的 url 不重写 labels，只补系统任务账。

labels 与系统任务通过同一 SQL 原子写入，与 importer-enqueue.ts 对齐。
重复标记只补账，不刷新 labeled_at；显式重导与 TS 一样刷新 labeled_at。

## 写入必须自证（否则「标记说写了、库里没有」）

`/sql` 返回 2xx 不等于写成功：空 body / HTML 错误页 / 代理劫持页 / 截断响应都可能
是 2xx。这些响应一旦被当成功，`_mark_imported` 就会写下 labels-imported.jsonl 标记，
该书从此**静默缺席书库**（补录按标记跳过，除非人工删标记）。所以：

- `_http_sql` 只接受「2xx + 可解析 JSON 对象 + 无 error 字段」，其余一律抛
  （官方 @neondatabase/serverless 对 2xx 同样无条件 `.json()`，即 2xx 必是 JSON）；
- `_write` 按 labeled_book_id 校验 UPSERT 语句确实返回了 labeled_book_id
  （与 importer-enqueue.ts 的 `positiveIntOrNull(result.labeled_book_id)` 同判据），
  拿不到就抛 → import_record 记 'failed' → 不落标记 → 下轮 retry_backlog 自动重试。
  补账路径（build_ensure_system_task）**不套用**该校验：TS 侧 ensureSystemTask 同样
  不用 labeled_book_id 当门，只靠 SELECT id 与 created_task_id/count 判结果。

**抛的范围**：只有 `_http_sql` / `_write` / 补账这几条写路径会抛；对外入口
`import_record` 仍吞掉一切异常改写 fail log 并返回 'failed'，`labeler.py` 那层还有
try/except 兜底——所以「写路径抛」不会变成「打标循环崩」，而是变成「记 failed」。

## 失败不阻断打标

本模块所有对外入口都不抛异常：失败写 labels-import-fail.log（每行带时间戳，供巡检），
打标循环照常继续。下一次运行会自动重试（标记文件只记成功项）。

## 校验语义与 import_labels.mjs 的关系

只做**保守子集**：拿不准的记录一律不自动导入，留给完整导入器 / 人工。具体差异见
validate_record 与 normalize_author 的注释（宁缺勿滥，绝不凭空造行）。

命令行：
  python3 import_one.py --dry-run --file labels.jsonl
  python3 import_one.py --file labels.jsonl --limit 500     # 补齐未导入的（新→旧）
  python3 import_one.py --file labels.jsonl --url https://book15.net/books/details3168.html

退出码（与 import_labels.mjs 同口径）：0=无失败；1=有 failed 条目。
"""
import argparse
import html
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import douban_list          # 复用作者身份归一（_norm_author），使孪生判定与 author_matches 口径一致

# ---- 配置 ----
IMPORT_TIMEOUT_SEC = 15          # 单次 HTTP SQL 超时；导入失败绝不能拖住打标循环
IMPORT_BACKLOG_DEFAULT = 20      # labeler 每轮启动时自动补录的历史欠账条数上限
# 补录扫描上限（审查 A.5）：配额按**成功**计，永失败（review/twin-skipped）不再吃死
# 最新 N 条的历史欠账。但也不能无限回溯整个 labels.jsonl → 给一个最大尝试条数。
IMPORT_BACKLOG_SCAN_CAP = 500
MARKER_NAME = 'labels-imported.jsonl'
FAIL_LOG_NAME = 'labels-import-fail.log'
AUTO_IMPORT_ENV = 'LABELER_AUTO_IMPORT'
BACKLOG_ENV = 'LABELER_IMPORT_BACKLOG'

# 与 import_labels.mjs 的 validateImportRecord 对齐：这些 text_quality 明确不合格 → skip
BAD_TEXT_QUALITY = ('疑似乱码', '大面积重复', '含广告注入')
# lbladfix41：labeler 质量门对「含广告注入」降级入库时在行上打 quality_flag=ad_injection
# （书名核验为 true 且置信度够）；只有这一组合放行，其余不合格取值照旧 skip。
AD_QUALITY_FLAG = 'ad_injection'
AD_TEXT_QUALITY = '含广告注入'
FIELD_STRINGS = ('title', 'site_title', 'author', 'author_encoding',
                 'category', 'status', 'source')

# ---- 分类规范化（genre_map.mjs normalizeGenre 的 python 移植）----
PRIMARY_GENRES = ('玄幻', '仙侠', '武侠', '都市', '历史', '科幻', '悬疑灵异',
                  '无限流', '游戏竞技', '轻小说', '奇幻', '言情', '其他')
GENRE_RULES = (
    ('无限流', re.compile('无限流')),
    ('仙侠', re.compile('仙侠|修真|修仙|洪荒')),
    ('武侠', re.compile('武侠')),
    # 灵异/惊悚优先于都市：「都市灵异」按灵异归类
    ('悬疑灵异', re.compile('灵异|恐怖|悬疑|惊悚|诡')),
    ('都市', re.compile('都市')),
    ('历史', re.compile('历史')),
    ('科幻', re.compile('科幻|末世|星际|废土')),
    ('游戏竞技', re.compile('游戏|电竞')),
    ('轻小说', re.compile('轻小说|日系')),
    ('奇幻', re.compile('西幻|西方奇幻|蒸汽朋克|克苏鲁|剑与魔法')),
    ('玄幻', re.compile('玄幻')),
    ('言情', re.compile('言情|女频')),
)
SITE_CATEGORY_MAP = {
    '玄幻奇幻': '玄幻', '武侠修真': '仙侠', '恐怖灵异': '悬疑灵异',
    '都市言情': '都市', '历史军事': '历史',
}
_SUB_SPLIT_RE = re.compile(r'[、,，;；/|]')

# ---- 字符串清洗（import_labels.mjs cleanString/cleanJson 的 python 移植）----
_ENTITY_CANDIDATE_RE = re.compile(r'&(?:#[^&;\s]*;?|[A-Za-z][^&;\s]*;|[A-Za-z][A-Za-z0-9]*)')
_NUMBER_RE = re.compile(r'^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$')
_TITLE_STRIP_RE = re.compile(r'[《》\s﻿]')
_SQL_WS_RE = re.compile(r'\s+')


def clean_string(value):
    """去 NUL(0x00)、孤立代理项替换为 U+FFFD（与 cleanJson 同一套规则）。

    PG 的 text/jsonb 严禁 NUL；json.dumps(ensure_ascii=False) 也无法编码孤立代理项。
    上游（LLM 输出）里确实可能出现这类脏值，写入前必须清。"""
    out = []
    for char in value:
        point = ord(char)
        if point == 0:
            continue
        if 0xd800 <= point <= 0xdfff:
            out.append('�')
        else:
            out.append(char)
    return ''.join(out)


def clean_json(value):
    if isinstance(value, str):
        return clean_string(value)
    if isinstance(value, list):
        return [clean_json(v) for v in value]
    if isinstance(value, dict):
        return {clean_string(str(k)): clean_json(v) for k, v in value.items()}
    return value


def explicit_number(value):
    """只认真正的数字或纯数字串；null/空串/false/NaN/十六进制/科学计数一律 None。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        text = value.strip()
        if not _NUMBER_RE.match(text):
            return None
        try:
            number = float(text)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def parse_quality(value):
    score = explicit_number(value)
    return score if score is not None and 0 <= score <= 10 else None


def source_url(value):
    """合法 http(s) URL 才返回原文，否则 None（本次不覆盖旧 URL）。"""
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url or len(url) > 2048 or clean_string(url) != url:
        return None
    if any(ord(char) <= 32 or ord(char) == 127 for char in url):
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return None
    if '@' in parsed.netloc:      # 带用户名/口令的 URL 不入库
        return None
    return url


def title_matches(guess, actual):
    """仅忽略全半角、书名号、空白和大小写；包含关系不足以证明是同一本书。"""
    if not isinstance(guess, str) or not isinstance(actual, str):
        return False

    def normalize(title):
        return _TITLE_STRIP_RE.sub('', unicodedata.normalize('NFKC', title)).lower()

    normalized = normalize(guess)
    return bool(normalized) and normalized == normalize(actual)


def _invalid_author_characters(value):
    for char in value:
        point = ord(char)
        if point <= 0x1f or 0x7f <= point <= 0x9f:
            return True
        if 0xd800 <= point <= 0xdfff or point > 0x10ffff:
            return True
        if 0xfdd0 <= point <= 0xfdef or (point & 0xffff) >= 0xfffe:
            return True
    return False


def normalize_author(value, encoding=None):
    """作者规范化 → (status, value, reason)。status ∈ ready/review/failed。

    比 import_labels.mjs 的 normalizeAuthor **更保守**的一处：只要作者里出现 HTML
    实体（`&...`）就不自动导入，转 review 留给完整导入器。理由是实体解码要分辨未知
    实体 / 缺分号 / 多层编码，重写一遍必然与 JS 侧漂移；而自动导入写错作者会造出
    **第二行**（身份键不同），触碰幂等红线。labeler 的名单作者是纯文本，实际不触发。"""
    if not isinstance(value, str):
        return 'failed', value, 'author 必须是字符串'
    if encoding is not None and encoding not in ('html-v1', 'text-v1'):
        return 'review', value, '作者编码标记未知，保留原值待核验'
    if _invalid_author_characters(value):
        return 'review', value, '作者含非法控制符/NUL/孤立代理项，保留原值待核验'
    if encoding != 'text-v1' and _ENTITY_CANDIDATE_RE.search(value):
        return 'review', value, '作者含 HTML 实体，自动导入不冒进，留给完整导入器'
    normalized = value.strip()
    if not normalized:
        # 幂等红线：身份键是 (title_key, author_key)。空作者 → author_key=''，
        # 与存量同一本书的 (title_key, '血红') **不冲突** → ON CONFLICT 不触发 →
        # 凭空插入第二行（17K 完本页写死 author='' 就是这条口子）。
        # 拿不准就不导：空作者一律 review，仍照常写 labels.jsonl 留给完整导入器/人工补作者。
        return 'review', value, '作者为空，自动导入无法判定身份（可能与存量非空作者行重复）'
    if len(normalized) > 200:
        return 'failed', value, '作者超过 200 字（Unicode 码点）'
    return 'ready', normalized, ''


def normalize_genre(site_category, llm_genre):
    """站点分类 + LLM genre → (主分类, 次级标签列表)，与 genre_map.mjs 同规则。"""
    llm = llm_genre if isinstance(llm_genre, str) else ''
    primary = None
    for name, pattern in GENRE_RULES:
        if pattern.search(llm):
            primary = name
            break
    if not primary:
        site = (site_category or '').strip()
        primary = SITE_CATEGORY_MAP.get(site) or (site if site in PRIMARY_GENRES else None)
    if not primary:
        primary = '其他'
    words = [w.strip() for w in _SUB_SPLIT_RE.split(llm)]
    sub = []
    for word in words:
        if (word and 2 <= len(word) <= 8 and word not in PRIMARY_GENRES
                and word != primary and word not in sub):
            sub.append(word)
        if len(sub) == 5:
            break
    return primary, sub


def validate_record(rec):
    """单条 labels.jsonl 记录 → {'status', 'reason'?, 'record'?, 'warnings'?}。

    status：ready 可导入 / skipped 明确不合格 / review 身份证据不足（**不自动导入**）/
    failed 数据结构损坏。语义对齐 import_labels.mjs 的 validateImportRecord。"""
    def failed(reason):
        return {'status': 'failed', 'reason': reason}

    def review(reason):
        return {'status': 'review', 'reason': reason}

    if not isinstance(rec, dict):
        return failed('记录不是对象')
    labels = rec.get('labels')
    if not isinstance(labels, dict):
        return failed('记录或 labels 字段不是对象')
    for field in FIELD_STRINGS:
        value = rec.get(field)
        if value is not None and not isinstance(value, str):
            return failed(field + ' 必须是字符串')

    author_status, author, author_reason = normalize_author(
        rec.get('author') or '', encoding=rec.get('author_encoding'))
    if author_status != 'ready':
        return {'status': author_status, 'reason': author_reason}

    listed_title = (rec.get('title') or '').strip()
    site_title = (rec.get('site_title') or '').strip()
    title = site_title or listed_title
    if not title or len(title) > 200 or len(listed_title) > 200:
        return failed('书名缺失或书名/作者超过 200 字')
    if (clean_string(title) != title or clean_string(listed_title) != listed_title
            or clean_string(author) != author):
        return review('书名或作者含非法字符，不能清洗后自动裁决身份')
    if site_title and listed_title and not title_matches(site_title, listed_title):
        return review('site_title 与 title 不一致，保留原记录待核验')

    if labels.get('title_guess') is not None and not isinstance(labels['title_guess'], str):
        return failed('labels.title_guess 必须是字符串')
    if labels.get('site_title_note') is not None and not isinstance(labels['site_title_note'], str):
        return failed('labels.site_title_note 必须是字符串')
    text_quality = labels.get('text_quality')
    if text_quality is not None and not isinstance(text_quality, str):
        return failed('text_quality 必须是字符串')
    ad_downgraded = (isinstance(text_quality, str) and text_quality.strip() == AD_TEXT_QUALITY
                     and rec.get('quality_flag') == AD_QUALITY_FLAG)
    if not ad_downgraded:
        if isinstance(text_quality, str) and text_quality.strip() in BAD_TEXT_QUALITY:
            return {'status': 'skipped', 'reason': '文本质量异常：' + text_quality}
        if text_quality is not None and text_quality.strip() != '正常':
            return review('无法识别的 text_quality')

    # 新格式：明确的布尔确认可替代盲猜；false/不确定不能被相似书名掩盖。
    if 'site_title_match' in labels:
        if labels['site_title_match'] is not True:
            return review('站点书名未获明确确认（site_title_match）')
    elif not title_matches(labels.get('title_guess'), title):
        return review('盲猜书名与站点书名不符或缺失')

    warnings = []
    url = source_url(rec.get('url'))
    if rec.get('url') not in (None, '') and url is None:
        warnings.append('来源 URL 无效，本次不覆盖旧 URL')
    quality_field = labels.get('quality')
    quality = parse_quality(quality_field.get('overall')) if isinstance(quality_field, dict) else None
    if (quality_field is not None and quality is None
            and (not isinstance(quality_field, dict) or quality_field.get('overall') is not None)):
        warnings.append('quality.overall 缺失或无效，本次不覆盖旧评分')

    chars = 0
    raw_chars = rec.get('chars')
    if raw_chars is not None and not (isinstance(raw_chars, str) and not raw_chars.strip()):
        number = explicit_number(raw_chars)
        if (number is None or not float(number).is_integer()
                or number < 0 or number > 2_147_483_647):
            return failed('chars 必须是 0 到 2147483647 的整数')
        chars = int(number)

    category = clean_string((rec.get('category') or '').strip())
    llm_genre = labels['genre'] if isinstance(labels.get('genre'), str) else ''
    primary, sub = normalize_genre(category, clean_string(llm_genre))
    return {
        'status': 'ready',
        'warnings': warnings,
        'record': {
            'title': title,
            'author': author,
            'category': category,
            'finish_status': clean_string((rec.get('status') or '').strip()),
            'source_site': clean_string((rec.get('source') or '').strip()),
            'source_url': url or '',
            'chars_labeled': chars,
            'labels': clean_json(labels),
            'primary_genre': primary,
            'sub_tags': sub,
            'quality': quality,
        },
    }


def _sql_text(query):
    """把 SQL 折成单行，便于错误信息与断言。"""
    return _SQL_WS_RE.sub(' ', query).strip()


def build_upsert(record):
    """TS importLabelWithSystemTask 同语句 SQL；默认采用 NO_ARTIFACTS 策略。"""
    query = r"""
    WITH upserted AS (
      INSERT INTO labeled_books
        (title, author, category, finish_status, source_site, source_url,
         chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)
      VALUES ($1, $2, $3, $4,
              $5, $6, $7,
              $8::jsonb, now(),
              $9, $10::jsonb, $11)
      ON CONFLICT (title_key, author_key) DO UPDATE SET
        labels = EXCLUDED.labels,
        finish_status = EXCLUDED.finish_status,
        chars_labeled = EXCLUDED.chars_labeled,
        source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), labeled_books.source_url),
        primary_genre = EXCLUDED.primary_genre,
        sub_tags = EXCLUDED.sub_tags,
        quality = COALESCE(EXCLUDED.quality, labeled_books.quality),
        labeled_at = now()
      RETURNING id, title, author, source_url
    ), inserted AS (
      INSERT INTO download_tasks
        (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision, policy_version, enqueue_key)
      SELECT NULL, u.id, u.title, u.author, u.source_url, 'pending', 'system',
             $12, $13, $14, $15,
             u.id::text || ':' || $16 || ':' || $17
      FROM upserted u
      WHERE $18
        -- 同书已有活动系统任务(pending/running)时不再插第二条:否则会撞
        -- download_tasks_system_active_book_idx 的 23505,把**整个导入**回滚掉,
        -- 让「书已在队列里」这个正常状态反而阻塞标签更新。T1 的 enqueue 函数对这类
        -- 竞争同样解析为「返回该书现有活动任务」,这里在 SQL 里提前等价处理。
        AND NOT EXISTS (
          SELECT 1 FROM download_tasks t
          WHERE t.requested_by = 'system' AND t.book_id = u.id
            AND t.status IN ('pending', 'running')
        )
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    SELECT (SELECT id FROM upserted)          AS labeled_book_id,
           (SELECT count(*)::int FROM inserted) AS created_task_count,
           (SELECT id FROM inserted)          AS created_task_id"""
    params = [
        record['title'],
        record['author'],
        record['category'],
        record['finish_status'],
        record['source_site'],
        record['source_url'],
        record['chars_labeled'],
        json.dumps(record['labels'], ensure_ascii=False),
        record['primary_genre'],
        json.dumps(record['sub_tags'], ensure_ascii=False),
        record['quality'],
    ]
    return query, params + _task_params() + [True]


def _task_params():
    """TS normalizeTaskPolicy defaults; repeated binds preserve its SQL exactly."""
    policy = (os.environ.get('LABELER_DOWNLOAD_POLICY_VERSION') or 't5-backfill-v1').strip()
    if not policy or len(policy) > 200:
        raise ValueError('policyVersion is invalid')
    return ['builtin', None, '', policy, policy, '']


def build_ensure_system_task(labeled_book_id):
    """Only pass an id resolved from labeled_books, never a books.id."""
    if isinstance(labeled_book_id, bool) or not isinstance(labeled_book_id, int) or labeled_book_id < 1:
        raise ValueError('invalid labeled_books id')
    return r"""
    WITH target AS (
      SELECT id, title, author, source_url FROM labeled_books WHERE id = $1
    ), inserted AS (
      INSERT INTO download_tasks
        (user_id, book_id, title, author, source_url, status, requested_by,
         source_kind, source_id, source_revision, policy_version, enqueue_key)
      SELECT NULL, t.id, t.title, t.author, t.source_url, 'pending', 'system',
             $2, $3, $4, $5,
             t.id::text || ':' || $6 || ':' || $7
      FROM target t
      WHERE NOT EXISTS (
        SELECT 1 FROM download_tasks d
        WHERE d.requested_by = 'system' AND d.book_id = t.id
          AND d.status IN ('pending', 'running')
      )
      ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    SELECT (SELECT id FROM target)              AS labeled_book_id,
           (SELECT count(*)::int FROM inserted) AS created_task_count,
           (SELECT id FROM inserted)            AS created_task_id""", [labeled_book_id] + _task_params()


FIND_LABELED_BOOK_SQL = r"""
    SELECT id FROM labeled_books
    WHERE title_key = lower(btrim(regexp_replace(btrim(normalize($1, NFKC)), '^《(.+)》$', '\1')))
      AND author_key = lower(btrim(normalize($2, NFKC)))
    ORDER BY id
    LIMIT 1"""


# 繁→简小映射表（团队授权：仓库无 opencc 等现成工具，用小表并写明覆盖范围）。
# 覆盖常见姓氏 + 高频人名用字；**不完整**——未覆盖的异体只会「漏判孪生」（多一行，等同改前，
# 无回归），绝不会把不同作者误判成同一人（只在宽松键完全相等时才判孪生；且每个繁体字都映射到
# 其唯一对应的简体字，不存在把两个不同简体字并到一处的风险）。
_TRAD = '張陳劉黃趙吳鄭謝羅韓馮蔣蕭賈鄒孫馬蘇盧葉閻餘鐘範譚陸萬錢湯喬賀賴龐顏嚴溫魯韋畢聶駱齊鄧龔龍顧華婁竇廬麗傑軍國慶學東遠飛風雲鳳曉靜詩書劍愛夢陽賢寶貴靈輝瓊潔嬋語樂憶戀護'
_SIMP = '张陈刘黄赵吴郑谢罗韩冯蒋萧贾邹孙马苏卢叶阎余钟范谭陆万钱汤乔贺赖庞颜严温鲁韦毕聂骆齐邓龚龙顾华娄窦庐丽杰军国庆学东远飞风云凤晓静诗书剑爱梦阳贤宝贵灵辉琼洁婵语乐忆恋护'
_T2S = {t: s for t, s in zip(_TRAD, _SIMP)}
assert len(_TRAD) == len(_SIMP), '繁简映射表两串长度必须相等'


def _to_simplified(text):
    return ''.join(_T2S.get(ch, ch) for ch in text)


def _loose_author_key(author):
    """宽松作者身份键（仅用于孪生判定）：占位/空 → ''。否则繁转简后走 douban_list._norm_author
    （剥「作者：」标签、剥尾缀「著」、剥前导国籍括注、统一中点/点号、去空白、casefold），
    与 author_matches / 搜索期身份口径一致。键相同 = 同一人的异体写法（no-op 不新增），
    键不同 = 不同人（同名异书照常入库）。"""
    raw = (author or '').strip()
    if douban_list.is_placeholder_author(raw):
        return ''
    return douban_list._norm_author(_to_simplified(raw))


def find_twin(rows, author):
    """R02 非不动点孪生行判定（纯函数，便于离线单测）。

    存量行的作者与本次作者**归一后同身份、但存量原文与本次身份键不同** → 该行就是孪生行，
    UPSERT 撞不上（author_key 不同）却是同一本书，写下去会凭空多一行（labeler-idempotency-redline
    家族）。三档判定，从严到宽：
      1. 存量原文 lower 与本次相同 → 精确同键，交 ON CONFLICT UPSERT，不算孪生（返回时跳过）；
      2. 存量按 HTML 实体解码后与本次相同 → 实体变体孪生（原行为）；
      3. 存量与本次的**宽松身份键**（_loose_author_key：剥标签/尾缀/国籍段、统一中点、去空白、
         繁转简、casefold）相同 → 繁简/中点/国籍段/尾缀/标签/空白等异体孪生（rvauthor CE1/CE1b）。
    宽松键为空（占位/空作者）不参与匹配；宽松键**不同**（同名不同人）仍判为不同书，照常入库。
    实体畸形（缺分号/未知）时本函数更保守（照样拦），宁可少写一条也不凭空多一行。"""
    target = author.lower()
    loose = _loose_author_key(author)
    for row in rows or []:
        stored = row.get('author') or ''
        if not isinstance(stored, str) or stored.lower() == target:
            continue
        decoded = html.unescape(stored) if '&' in stored else stored
        if decoded.strip().lower() == target:
            return row
        if loose and _loose_author_key(stored) == loose:
            return row
    return None


def _env_flag(value, default=True):
    if value is None or value == '':
        return default
    return str(value).strip().lower() not in ('0', 'false', 'no', 'off', 'disable', 'disabled')


def _written_book_id(document, action):
    """UPSERT 语句的自证：结果首行必须给出有效的 labeled_book_id。

    `/sql` 的 2xx body 是 `{"rows": [...]}`；本仓两条写语句都以
    `SELECT (SELECT id FROM ...) AS labeled_book_id` 收尾，所以「写成功」必须体现为
    首行有该字段且是正整数。拿不到 = 语句没按预期返回（Neon-Raw-Text-Output 下是
    字符串，故走 float 再判整数）。判据与 importer-enqueue.ts 的
    `positiveIntOrNull` 同义：正的安全整数。缺它即抛，让 import_record 记 'failed'，
    而不是让「标记说写了、库里没有」成立。"""
    rows = document.get('rows') if isinstance(document, dict) else None
    row = rows[0] if isinstance(rows, list) and rows else {}
    book_id = row.get('labeled_book_id') if isinstance(row, dict) else None
    try:
        number = float(book_id)
    except (TypeError, ValueError):
        number = None
    if number is None or not float(number).is_integer() or number < 1:
        raise RuntimeError(f'{action} 未返回 labeled_book_id（语句未自证写入）')
    return int(number)


class AutoImporter:
    """打标产物的即时导入器。所有方法都不抛异常（幂等 + 失败不阻断）。"""

    def __init__(self, database_url='', directory=None, enabled=True,
                 sql_exec=None, timeout=IMPORT_TIMEOUT_SEC, log=print):
        self.database_url = (database_url or '').strip()
        self.directory = Path(directory) if directory else Path(__file__).parent
        self.timeout = timeout
        self.log = log
        self._imported = set()
        # 最近一次导入失败的（已脱敏）错误文本；只给运维告警用，绝不落盘原始凭据。
        self.last_error = ''
        self.enabled = bool(enabled) and bool(self.database_url)
        self.disabled_reason = ''
        if not enabled:
            self.disabled_reason = '开关关闭'
        elif not self.database_url:
            self.disabled_reason = '无 DATABASE_URL'
        self._sql_exec = sql_exec or self._http_sql
        self._load_markers()

    # ---- 构造 ----
    @classmethod
    def from_env(cls, env, directory=None, log=print):
        env = env or {}
        enabled = _env_flag(env.get(AUTO_IMPORT_ENV))
        return cls(env.get('DATABASE_URL', ''), directory=directory,
                   enabled=enabled, log=log)

    # ---- 标记文件 ----
    @property
    def marker_path(self):
        return self.directory / MARKER_NAME

    @property
    def fail_log_path(self):
        return self.directory / FAIL_LOG_NAME

    def _load_markers(self):
        path = self.marker_path
        if not path.exists():
            return
        try:
            for line in path.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    url = json.loads(line).get('url')
                except (json.JSONDecodeError, AttributeError):
                    continue
                if isinstance(url, str) and url:
                    self._imported.add(url)
        except OSError as error:
            self.log(f'  自动导入: 读取标记文件失败（忽略）: {error}')

    def _mark_imported(self, record):
        self._imported.add(record['source_url'])
        try:
            with open(self.marker_path, 'a', encoding='utf-8') as handle:
                handle.write(json.dumps({
                    'url': record['source_url'], 'title': record['title'],
                    'at': time.strftime('%Y-%m-%d %H:%M:%S'),
                }, ensure_ascii=False) + '\n')
        except OSError as error:
            self.log(f'  自动导入: 写标记文件失败（不影响入库）: {error}')

    def _log_failure(self, record, message):
        stamp = time.strftime('%Y-%m-%d %H:%M:%S')
        line = (f'{stamp} | url={record.get("url", "")} '
                f'| title={record.get("title", "") or record.get("site_title", "")} '
                f'| 错误: {message}')
        try:
            with open(self.fail_log_path, 'a', encoding='utf-8') as handle:
                handle.write(line + '\n')
        except OSError:
            pass
        self.log(f'  自动导入失败（已记 {FAIL_LOG_NAME}，不阻断打标）: {message}')

    def forget_markers(self):
        """忽略已导入标记（本次进程内）。用途：库里那本书被人工删掉后需要重导，
        配合 CLI `--url <地址> --force` 使用；标记文件本身不改写。"""
        self._imported.clear()

    # ---- HTTP SQL（Neon）----
    def _redact(self, message):
        text = str(message)
        for secret in (self.database_url,
                       urllib.parse.urlsplit(self.database_url).password or ''):
            if secret:
                text = text.replace(secret, '***')
        return text

    def _http_sql(self, query, params):
        parsed = urllib.parse.urlsplit(self.database_url)
        if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
            raise ValueError('DATABASE_URL 不是 postgres 连接串')
        body = json.dumps({'query': query, 'params': params}).encode('utf-8')
        request = urllib.request.Request(
            f'https://{parsed.hostname}/sql', data=body, method='POST',
            headers={'Content-Type': 'application/json',
                     'Neon-Connection-String': self.database_url,
                     'Neon-Raw-Text-Output': 'true'})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            detail = ''
            try:
                detail = error.read().decode('utf-8', 'replace')[:300]
            except Exception:
                pass
            raise RuntimeError(f'HTTP {error.code}: {detail}') from None
        # 2xx 不等于写成功：空 body / HTML 错误页 / 代理劫持页 / 截断响应都可能是 2xx，
        # 而旧代码把它们一律 `return {}` 吞掉 → `_write` 看上去"导成功" → `_mark_imported`
        # 落标记 → 该书永久静默缺席书库（补录按标记跳过）。判据：2xx 必须是可解析的
        # JSON 对象且不带 error 字段。依据见文件头「写入必须自证」。异常消息只给原因
        # 类别，**不带响应原文**（响应里可能含站点内容，不进日志）。
        if not payload.strip():
            raise RuntimeError('Neon /sql 返回 2xx 但响应体为空')
        try:
            document = json.loads(payload)
        except json.JSONDecodeError:
            raise RuntimeError('Neon /sql 返回 2xx 但响应不是 JSON') from None
        if not isinstance(document, dict):
            raise RuntimeError('Neon /sql 返回 2xx 但响应不是 JSON 对象')
        if document.get('error'):
            raise RuntimeError('Neon /sql 返回 2xx 但响应带 error 字段')
        return document

    def _rows(self, query, params):
        payload = self._sql_exec(query, params)
        return payload.get('rows') or []

    def _exec_write(self, query, params, action):
        """执行 labels UPSERT，并要求语句按 RETURNING 自证确实写了行。

        自证判据与 src/lib/importer-enqueue.ts 的
        `positiveIntOrNull(result.labeled_book_id)`（importLabelWithSystemTask 路径）
        逐字同义：拿不到正的安全整数就抛 → import_record 记 'failed' → 不落标记。
        **刻意不对补账路径（build_ensure_system_task）做同一校验**：TS 侧
        ensureSystemTask 只用 SELECT 得到的 id + created_task_id/count 判结果，同样
        不拿 labeled_book_id 当门；照搬它可少一处「SQL 形状一变就全体记 failed」的误伤。"""
        return _written_book_id(self._sql_exec(query, params), action)

    def _write(self, record):
        """前置孪生拦截 + UPSERT。返回 'imported' 或 'twin-skipped'。
        写入未获语句自证时抛异常（→ import_record 记 'failed'，不落标记）。"""
        rows = self._rows('SELECT id, author FROM labeled_books WHERE lower(title) = lower($1)',
                          [record['title']])
        twin = find_twin(rows, record['author'])
        if twin is not None:
            self.log(f'  自动导入: 与既有非不动点行 id={twin.get("id")} 归一后身份相同，'
                     f'跳过写入（避免凭空多一行）')
            return 'twin-skipped'
        query, params = build_upsert(record)
        self._exec_write(query, params, '标签 UPSERT')
        return 'imported'

    # ---- 对外入口（永不抛异常）----
    def import_record(self, rec):
        """导入一条 labels.jsonl 记录 → 状态字符串（imported/duplicate/skipped/
        review/failed/disabled/twin-skipped）。任何输入都不抛异常。"""
        if not self.enabled:
            return 'disabled'
        try:
            url = rec.get('url') if isinstance(rec, dict) else None
            duplicate = isinstance(url, str) and url in self._imported
            result = validate_record(rec)
            if result['status'] != 'ready':
                if result['status'] in ('review', 'failed'):
                    self.log(f'  自动导入: {result["status"]}（{result.get("reason", "")}）→ '
                             f'不自动导入，留给完整导入器 import_labels.mjs')
                return result['status']
            for warning in result.get('warnings', []):
                self.log(f'  自动导入提示: {warning}')
            record = result['record']
            if duplicate:
                rows = self._rows(FIND_LABELED_BOOK_SQL, [record['title'], record['author']])
                if not rows:
                    raise ValueError('labeled book not found')
                query, params = build_ensure_system_task(int(rows[0]['id']))
                self._sql_exec(query, params)
                return 'duplicate'
            outcome = self._write(record)
            if outcome == 'twin-skipped':
                return 'twin-skipped'
            if record['source_url']:
                self._mark_imported(record)
            return 'imported'
        except Exception as error:              # 校验器/标记层的 bug 也不能拖垮打标
            self.last_error = self._redact(error)
            try:
                self._log_failure(rec if isinstance(rec, dict) else {},
                                  self.last_error)
            except Exception:
                pass
            return 'failed'

    def retry_backlog(self, jsonl_path, limit=IMPORT_BACKLOG_DEFAULT):
        """把 labels.jsonl 里**尚未导入标记**的记录补录（新→旧），直到补满 limit 本成功。

        用途：部署切换时把历史欠账一次补齐；轮内某条导入失败后，下轮启动自动重试。
        配额按**成功导入数**计（审查 A.5）：永失败记录（review / twin-skipped / failed）
        不再吃死最新 N 条——否则部署后积压一批身份可疑书时，补录净成功恒 0，
        历史欠账永不还。已标记的 url 跳过且不占配额（否则标记越攒越多，每轮停在同一批）。
        为免无限回溯整个文件，最多**尝试** IMPORT_BACKLOG_SCAN_CAP 条（或 limit，取大者）。
        只读 labels.jsonl，绝不改写它。返回成功导入条数。"""
        if not self.enabled or limit <= 0:
            return 0
        path = Path(jsonl_path)
        if not path.exists():
            return 0
        try:
            lines = path.read_text(encoding='utf-8').splitlines()
        except OSError as error:
            self.log(f'  自动导入: 读取 {path} 失败（忽略）: {error}')
            return 0
        done = attempted = 0
        scan_cap = max(limit, IMPORT_BACKLOG_SCAN_CAP)
        for line in reversed(lines):
            if done >= limit or attempted >= scan_cap:
                break
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            url = rec.get('url')
            if isinstance(url, str) and url in self._imported:
                continue
            attempted += 1
            if self.import_record(rec) == 'imported':
                done += 1
        return done

    def status_line(self):
        if not self.enabled:
            return f'自动导入: 关闭（{self.disabled_reason}）'
        return f'自动导入: 开启（标记 {len(self._imported)} 条已导入）'


def main(argv=None):
    parser = argparse.ArgumentParser(description='labels.jsonl → Neon 单条增量导入')
    parser.add_argument('--file', default=str(Path(__file__).parent / 'labels.jsonl'))
    parser.add_argument('--env', help='从这里读 DATABASE_URL（KEY=VALUE，默认用环境变量）')
    parser.add_argument('--limit', type=int, default=0,
                        help='最多处理最新 N 条（0=不限）')
    parser.add_argument('--url', help='只导入该 url 的记录')
    parser.add_argument('--force', action='store_true',
                        help='忽略 labels-imported.jsonl 标记（配合 --url 重导已被人工删除的书）')
    parser.add_argument('--dry-run', action='store_true', help='只校验与统计，不连库')
    args = parser.parse_args(argv)

    database_url = os.environ.get('DATABASE_URL', '')
    if args.env and not args.dry_run:
        env = {}
        for raw in Path(args.env).read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
        database_url = env.get('DATABASE_URL', '')

    path = Path(args.file)
    if not path.exists():
        sys.exit(f'找不到 {path}')
    records = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            print('  [失败] JSON 解析失败，跳过一行')
    if args.url:
        records = [r for r in records if isinstance(r, dict) and r.get('url') == args.url]
    # limit 取**最新**的 N 条（labels.jsonl 是追加写，越靠后越新）
    if args.limit > 0:
        records = records[-args.limit:]

    counts = {}
    if args.dry_run:
        for rec in records:
            status = validate_record(rec)['status']
            counts[status] = counts.get(status, 0) + 1
        print('[dry-run] ' + ' / '.join(f'{k} {v}' for k, v in sorted(counts.items())))
        return 0

    importer = AutoImporter(database_url, directory=path.parent)
    if not importer.enabled:
        sys.exit(f'自动导入不可用：{importer.disabled_reason}（--env 或 DATABASE_URL）')
    if args.force:
        importer.forget_markers()
    for rec in records:
        status = importer.import_record(rec)
        counts[status] = counts.get(status, 0) + 1
    print('导入结果: ' + ' / '.join(f'{k} {v}' for k, v in sorted(counts.items())))
    # 有 failed 即非 0：旧代码无条件 return 0，全批失败也"成功退出"，调用方无法察觉
    # 「标记说写了、库里没有」。判据与 import_labels.mjs 的 `failed>0 ? 1 : 0` 同口径。
    # review / skipped / twin-skipped 是**刻意不导入**（留给完整导入器/人工），不计失败。
    return 1 if counts.get('failed', 0) > 0 else 0


if __name__ == '__main__':
    sys.exit(main())
