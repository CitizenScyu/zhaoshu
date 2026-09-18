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
3. **labels-imported.jsonl 标记**：成功导入过的 url 不再重复 POST（快的 no-op 层）。

另有一条刻意的改进：`labeled_at` 只在**内容真的变了**时才刷新
（`CASE WHEN labels IS DISTINCT FROM EXCLUDED.labels ...`），
避免首次全量补录把存量行的 labeled_at 整体推到当下、打乱书库「最近打标」排序。

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

# ---- 配置 ----
IMPORT_TIMEOUT_SEC = 15          # 单次 HTTP SQL 超时；导入失败绝不能拖住打标循环
IMPORT_BACKLOG_DEFAULT = 20      # labeler 每轮启动时自动补录的历史欠账条数上限
MARKER_NAME = 'labels-imported.jsonl'
FAIL_LOG_NAME = 'labels-import-fail.log'
AUTO_IMPORT_ENV = 'LABELER_AUTO_IMPORT'
BACKLOG_ENV = 'LABELER_IMPORT_BACKLOG'

# 与 import_labels.mjs 的 validateImportRecord 对齐：这些 text_quality 明确不合格 → skip
BAD_TEXT_QUALITY = ('疑似乱码', '大面积重复', '含广告注入')
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
    """与 import_labels.mjs writeImportRecord 同形的 UPSERT → (query, params)。

    params 顺序：title, author, category, finish_status, source_site, source_url,
    chars_labeled, labels(jsonb), primary_genre, sub_tags(jsonb), quality。
    唯一刻意的差异：labeled_at 只在内容真的变化时刷新，重复导入是真正的 no-op。"""
    query = (
        'INSERT INTO labeled_books\n'
        '  (title, author, category, finish_status, source_site, source_url,\n'
        '   chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)\n'
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), $9, $10::jsonb, $11)\n'
        'ON CONFLICT (title_key, author_key) DO UPDATE SET\n'
        '  labels = EXCLUDED.labels,\n'
        '  finish_status = EXCLUDED.finish_status,\n'
        '  chars_labeled = EXCLUDED.chars_labeled,\n'
        "  source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), labeled_books.source_url),\n"
        '  primary_genre = EXCLUDED.primary_genre,\n'
        '  sub_tags = EXCLUDED.sub_tags,\n'
        '  quality = COALESCE(EXCLUDED.quality, labeled_books.quality),\n'
        '  labeled_at = CASE\n'
        '    WHEN labeled_books.labels IS DISTINCT FROM EXCLUDED.labels\n'
        '      OR labeled_books.chars_labeled IS DISTINCT FROM EXCLUDED.chars_labeled\n'
        '    THEN now() ELSE labeled_books.labeled_at END'
    )
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
    return query, params


def find_twin(rows, author):
    """R02 非不动点孪生行判定（纯函数，便于离线单测）。

    存量行的作者经实体解码后与本次作者同身份、但原文不同 → 该行就是孪生行。
    与 import_labels.mjs 同判据；实体畸形（缺分号/未知）时本函数更保守（照样拦），
    宁可少写一条也不凭空多一行。"""
    target = author.lower()
    for row in rows or []:
        stored = row.get('author') or ''
        if not isinstance(stored, str) or stored.lower() == target:
            continue
        decoded = html.unescape(stored) if '&' in stored else stored
        if decoded.strip().lower() == target:
            return row
    return None


def _env_flag(value, default=True):
    if value is None or value == '':
        return default
    return str(value).strip().lower() not in ('0', 'false', 'no', 'off', 'disable', 'disabled')


class AutoImporter:
    """打标产物的即时导入器。所有方法都不抛异常（幂等 + 失败不阻断）。"""

    def __init__(self, database_url='', directory=None, enabled=True,
                 sql_exec=None, timeout=IMPORT_TIMEOUT_SEC, log=print):
        self.database_url = (database_url or '').strip()
        self.directory = Path(directory) if directory else Path(__file__).parent
        self.timeout = timeout
        self.log = log
        self._imported = set()
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
        if not payload.strip():
            return {}
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return {}

    def _rows(self, query, params):
        payload = self._sql_exec(query, params)
        return payload.get('rows') or []

    def _write(self, record):
        """前置孪生拦截 + UPSERT。返回 'imported' 或 'twin-skipped'。"""
        rows = self._rows('SELECT id, author FROM labeled_books WHERE lower(title) = lower($1)',
                          [record['title']])
        twin = find_twin(rows, record['author'])
        if twin is not None:
            self.log(f'  自动导入: 与既有非不动点行 id={twin.get("id")} 归一后身份相同，'
                     f'跳过写入（避免凭空多一行）')
            return 'twin-skipped'
        query, params = build_upsert(record)
        self._sql_exec(query, params)
        return 'imported'

    # ---- 对外入口（永不抛异常）----
    def import_record(self, rec):
        """导入一条 labels.jsonl 记录 → 状态字符串（imported/duplicate/skipped/
        review/failed/disabled/twin-skipped）。任何输入都不抛异常。"""
        if not self.enabled:
            return 'disabled'
        try:
            url = rec.get('url') if isinstance(rec, dict) else None
            if isinstance(url, str) and url in self._imported:
                return 'duplicate'
            result = validate_record(rec)
            if result['status'] != 'ready':
                if result['status'] in ('review', 'failed'):
                    self.log(f'  自动导入: {result["status"]}（{result.get("reason", "")}）→ '
                             f'不自动导入，留给完整导入器 import_labels.mjs')
                return result['status']
            for warning in result.get('warnings', []):
                self.log(f'  自动导入提示: {warning}')
            record = result['record']
            outcome = self._write(record)
            if outcome == 'twin-skipped':
                return 'twin-skipped'
            if record['source_url']:
                self._mark_imported(record)
            return 'imported'
        except Exception as error:              # 校验器/标记层的 bug 也不能拖垮打标
            try:
                self._log_failure(rec if isinstance(rec, dict) else {},
                                  self._redact(error))
            except Exception:
                pass
            return 'failed'

    def retry_backlog(self, jsonl_path, limit=IMPORT_BACKLOG_DEFAULT):
        """把 labels.jsonl 里**尚未导入标记**的记录补录（新→旧），最多尝试 limit 条。

        用途：部署切换时把历史欠账一次补齐；轮内某条导入失败后，下轮启动自动重试。
        已标记的 url 直接跳过且**不占配额**（否则标记越攒越多，每轮都停在同一批上）。
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
        for line in reversed(lines):
            if attempted >= limit:
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
    return 0


if __name__ == '__main__':
    sys.exit(main())
