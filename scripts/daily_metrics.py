#!/usr/bin/env python3
"""书径每日北极星指标（部署在 phoenix 上，每天只读跑一次）。

背景：局外审视 F9.1 —— 项目流程奖励「活动量」而非「结果」，没人每天盯结果指标。
本脚本每天自动算好五个北极星数字 + 下载附加项，输出：
  - JSON：{out}/YYYY-MM-DD.json（机器可读，供次日对比）
  - 中文一页 markdown：{out}/latest.md（含与前一天的对比箭头，主会话第一眼读这个）

设计要点（与仓库现有 phoenix 脚本同风格：零第三方依赖、纯 stdlib）：

1. **只读**：连库走 Neon 兼容 HTTP SQL 通道（`POST https://{host}/sql`，
   `Neon-Connection-String` 头）—— 与 labeler/import_one 同一条已验证路径，phoenix
   不需要 PG 驱动。**SQL 层自设白名单**（只放行 SELECT/WITH，禁多语句），不是安全边界
   兜底，而是防呆：本脚本任何路径都不该发出写语句。
2. **能算就算，算不了写 null + 原因**（判据写死，不编）。缺数据源只记 null，不抛。
3. **凭据**：DATABASE_URL 按键名白名单逐行读，禁整文件读入再脱敏；连接串**不进**任何
   产物（JSON/markdown 都不含）。
4. **复用的口径不重写**：review 积压分类复用 import_one.validate_record（打标端自动导入
   的同一判据），避免两套分类各自演化。

用法:
  python3 daily_metrics.py                       # 默认路径，写 /root/zhaoshu-metrics/
  python3 daily_metrics.py --out-dir /tmp/metrics-dryrun --env-file /root/zhaoshu-labeler/.env
  python3 daily_metrics.py --date 2026-09-27      # 覆盖「今天」（给离线/回放用）
  python3 daily_metrics.py --dry-run             # 打印 markdown 到 stdout，不落盘
"""
import argparse
import gzip
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# ---- 默认路径（phoenix 实机布局，2026-09-26 勘察确认）----
DEFAULT_OUT_DIR = '/root/zhaoshu-metrics'
DEFAULT_ENV_FILE = '/root/zhaoshu-labeler/.env'
DEFAULT_LABELER_DIR = '/root/zhaoshu-labeler'
DEFAULT_NGINX_LOGS = (
    '/var/log/nginx/zhaoshu-tempdb.access.log.1',
    '/var/log/nginx/zhaoshu-tempdb.access.log',
)

# env 白名单：只认这一个键（逐行读，命中即取，不整文件读入再脱敏）。
ENV_ALLOWED_KEYS = ('DATABASE_URL',)

SQL_TIMEOUT_SEC = 30
WINDOW_HOURS = 24

# phoenix 生产机时区 = CST（UTC+8，`date` 实测）。gate.log 的时间戳与 nginx 日志的
# `+0800` 都是该本地时间——**必须带 tzinfo 解析**再与 now(UTC) 比较，否则窗口整体偏移
# 8 小时（2026-09-26 实测：按 UTC 误读会把传输量从 684 MB 算成 1.9 GB）。
LOCAL_TZ = timezone(timedelta(hours=8))

# ---- gate.log 行格式（2026-09-26 实测样本）----
#   [2026-09-27 00:28:12] [pid=3276683] [书目=… ] …
#     80993 字 | 现代言情/青春校园/暗恋成长 | conf 0.99 | 1 次调用
#     → 已写入书库
#   跳过: 候选《九鼎记》（名单《九鼎》上汤豆苗 vs 引擎 我吃西红柿）
#   文本质量异常(含广告注入),跳过
#   完成: 成功 95 / 失败 14 / 残本候选跳过 0，结果在 labels.jsonl
# 时间戳只在部分行出现 ⇒ 其余行继承最近一次出现的时间戳（状态机）。
GATE_TS_RE = re.compile(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]')
GATE_CHARS_RE = re.compile(r'^\s+(\d+)\s*字\s*\|')
GATE_CALLS_RE = re.compile(r'(\d+)\s*次调用')
GATE_SKIP_CAND_RE = re.compile(r'跳过:\s*候选《')
GATE_REJECTED_RE = re.compile(r'记入 rejected')
GATE_AD_RE = re.compile(r'文本质量异常\(([^)]*)\)')
GATE_REJECT_HIST_RE = re.compile(r'跳过（历史被拒')
GATE_INVALID_SRC_RE = re.compile(r'跳过本轮已失效源')
GATE_DONE_BOOK_RE = re.compile(r'跳过已完成')
GATE_ALREADY_RE = re.compile(r'跳过已打标')

# 跳过/拒收归因桶（顺序即匹配优先级；名字要能直接进报告）。
SKIP_BUCKETS = (
    ('作者不符/错书', GATE_SKIP_CAND_RE),
    ('书名核验不符', GATE_REJECTED_RE),
    ('历史被拒终态', GATE_REJECT_HIST_RE),
    ('源失效', GATE_INVALID_SRC_RE),
    ('已完成/已打标', GATE_DONE_BOOK_RE),
    ('已打标', GATE_ALREADY_RE),
    ('文本质量异常', GATE_AD_RE),
)

# nginx combined 日志：第 10 列 = 响应体字节。
NGINX_LINE_RE = re.compile(
    r'^(\S+) \S+ \S+ \[(\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}) [+-]\d{4}\] '
    r'"([A-Z]+) (\S+) [^"]*" (\d{3}) (\S+)')


# ======================================================================
# 只读 SQL 客户端（Neon HTTP SQL 通道）
# ======================================================================
# ---- 只读守卫（两道，结构性优先）----
#
# 第一道：**登记白名单**。脚本永远只发自己手写的常量 SQL，不接受任何外部输入。
# 把全部语句集中放在这里，query() 按**去注释+归一空白后**的文本精确匹配放行，
# 未登记一律拒。这是最硬的一道：新增/改动查询必须同时改这里，漏登记就会当场抛，
# 而不是静默发出去。
_RAW_STATEMENTS = (
    'SELECT count(*) AS n FROM labeled_books',
    "SELECT count(*) AS n FROM labeled_books WHERE labeled_at > now() - interval '24 hours'",
    "SELECT count(*) AS n FROM labeled_books WHERE labeled_at > now() - interval '48 hours' "
    "AND labeled_at <= now() - interval '24 hours'",
    'SELECT count(*) AS n FROM source_admission WHERE compile_ok AND search_ok',
    'SELECT count(*) AS n FROM source_admission WHERE compile_ok',
    'SELECT host, count(*) AS n FROM source_admission WHERE compile_ok AND search_ok '
    'GROUP BY host ORDER BY n DESC',
    'SELECT pg_database_size(current_database()) AS n',
    'SELECT datname, tup_returned, tup_fetched, xact_commit, blks_read, blks_hit '
    'FROM pg_stat_database WHERE datname = current_database()',
    "SELECT count(*) AS n FROM recommendations WHERE created_at > now() - interval '24 hours'",
    "SELECT count(*) AS n FROM recommendations WHERE status <> 'new'",
    "SELECT count(*) AS n FROM feedback WHERE created_at > now() - interval '24 hours'",
    "SELECT count(*) AS n FROM download_tasks WHERE status = 'done' "
    "AND updated_at > now() - interval '24 hours'",
    "SELECT count(*) AS n FROM download_tasks WHERE status = 'failed' "
    "AND updated_at > now() - interval '24 hours'",
    "SELECT count(*) AS n FROM download_tasks WHERE status = 'pending'",
)


def _normalize_sql(text):
    """去注释（行 + 块，非嵌套）、折叠空白、去首尾空白与一个尾分号。

    与 _guard 同款归一——白名单登记与 query() 匹配必须用同一把尺子，
    否则空白/换行差异会造成「登记了却匹配不上」的假阴性。"""
    stripped = re.sub(r'--[^\n]*', ' ', text)
    stripped = re.sub(r'/\*.*?\*/', ' ', stripped, flags=re.S)
    return re.sub(r'\s+', ' ', stripped).strip().rstrip(';').strip()


# 登记集：归一后的文本精确匹配放行（见 _RAW_STATEMENTS）。
_ALLOWED_SQL = frozenset(_normalize_sql(s) for s in _RAW_STATEMENTS)

# 第二道：关键字/函数黑名单（去注释后按**整词**匹配）。
# 为什么还要这一道：白名单靠「新增查询必须同步登记」，而黑名单是**反向**防线——
# 万一有人把某条登记 SQL 改成了写语句（改登记的同时漏看内容），黑名单仍能拦住。
# 两者正交，一起挡。黑名单只求宁枉勿纵（安全侧），误伤字符串里的关键字可接受。
_FORBIDDEN_WORDS = (
    'insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter',
    'create', 'grant', 'revoke', 'copy', 'call', 'do', 'lock', 'into',
    'vacuum', 'analyze', 'reindex', 'refresh',
)
_FORBIDDEN_PHRASES = (
    'for update', 'for share', 'for no key update', 'for key share',
)
_FORBIDDEN_FUNCS = (
    'pg_terminate_backend', 'pg_cancel_backend', 'nextval', 'setval',
    'lo_import', 'lo_export', 'lo_unlink', 'lo_create', 'pg_read_file',
    'pg_read_binary_file', 'pg_ls_dir', 'set_config', 'pg_advisory_lock',
    'pg_advisory_lock_shared', 'pg_advisory_xact_lock',
    'pg_advisory_xact_lock_shared', 'pg_try_advisory_lock', 'dblink',
)

_WORD_BOUNDARY = r'\b'
_FORBIDDEN_WORD_RE = re.compile(r'\b(?:' + '|'.join(_FORBIDDEN_WORDS) + r')\b')
_FORBIDDEN_FUNC_RE = re.compile(r'\b(?:' + '|'.join(
    re.escape(name) for name in _FORBIDDEN_FUNCS) + r')')


class ReadOnlySql:
    """沿 Neon HTTP SQL 协议的只读客户端。

    只读保证（两道守卫，见上）：query() 只放行**登记白名单**里的常量 SQL
    （归一后精确匹配），未登记一律拒；再叠一层整词黑名单（写动词 / 行锁 / 副作用
    函数）。**结构性**优先：白名单约束「能发什么」，不靠语法启发式猜「什么是写」。"""

    def __init__(self, database_url, timeout=SQL_TIMEOUT_SEC):
        parsed = urllib.parse.urlsplit(database_url)
        if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
            raise ValueError('DATABASE_URL 不是 postgres 连接串')
        self._url = database_url
        self._endpoint = f'https://{parsed.hostname}/sql'
        self._timeout = timeout

    @staticmethod
    def _guard(query):
        """两道守卫：登记白名单（精确）→ 整词黑名单（兜底）。

        返回归一后的语句文本；不通过抛 ValueError。"""
        body = _normalize_sql(query)
        if ';' in body:
            raise ValueError('只读通道禁止多语句')
        if body not in _ALLOWED_SQL:
            raise ValueError('只读通道只放行已登记的常量语句')
        if _FORBIDDEN_WORD_RE.search(body):
            raise ValueError('只读通道拒绝写动词/行锁关键字')
        if _FORBIDDEN_FUNC_RE.search(body):
            raise ValueError('只读通道拒绝副作用函数')
        return body

    def query(self, sql, params=None):
        """执行只读查询，返回 rows（list[dict]）。失败抛异常，由调用方记 null。"""
        body = json.dumps({'query': self._guard(sql), 'params': params or []}).encode('utf-8')
        request = urllib.request.Request(
            self._endpoint, data=body, method='POST',
            headers={'content-type': 'application/json',
                     'Neon-Connection-String': self._url})
        with urllib.request.urlopen(request, timeout=self._timeout) as response:
            payload = json.loads(response.read().decode('utf-8'))
        if not isinstance(payload, dict) or payload.get('error'):
            raise RuntimeError(f'SQL 通道返回异常: {str(payload)[:200]}')
        return payload.get('rows', [])

    def scalar(self, sql, params=None):
        rows = self.query(sql, params)
        if not rows:
            return None
        return next(iter(rows[0].values()), None)


# ======================================================================
# 纯解析函数（离线可测）
# ======================================================================
def read_env_whitelist(path, allowed=ENV_ALLOWED_KEYS):
    """按键名白名单逐行读 env：只取 allowed 里的键，其余行直接丢弃（不看值）。
    禁「整文件读入再脱敏」——本函数读到的键值对里不会有白名单外的任何东西。"""
    env = {}
    try:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                if key not in allowed:
                    continue
                env[key] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def parse_gate_log(text, now=None, window_hours=WINDOW_HOURS):
    """解析 labeler/gate.log → 近 window 小时的打标活动。

    返回 dict：
      writes       近窗「已写入书库」本数
      chars        近窗字数样本 list
      calls        近窗「N 次调用」list
      skips        Counter，按 SKIP_BUCKETS 归因（只统计近窗）
      rounds       近窗完成的行数（round 完成）
    时间戳继承：无时间戳行归入最近一次出现的时间戳。
    """
    now = now or datetime.now(timezone.utc)
    cutoff_seconds = window_hours * 3600
    current_ts = None
    result = {'writes': 0, 'chars': [], 'calls': [], 'skips': Counter(), 'rounds': 0}

    def in_window():
        if current_ts is None:
            return False
        return (now - current_ts).total_seconds() < cutoff_seconds

    for raw in text.splitlines():
        match = GATE_TS_RE.search(raw)
        if match:
            try:
                current_ts = datetime.strptime(
                    match.group(1), '%Y-%m-%d %H:%M:%S').replace(tzinfo=LOCAL_TZ)
            except ValueError:
                pass
        if not in_window():
            continue
        if '已写入书库' in raw:
            result['writes'] += 1
            continue
        chars_match = GATE_CHARS_RE.match(raw)
        if chars_match:
            result['chars'].append(int(chars_match.group(1)))
            calls_match = GATE_CALLS_RE.search(raw)
            if calls_match:
                result['calls'].append(int(calls_match.group(1)))
            continue
        if raw.startswith('完成:'):
            result['rounds'] += 1
            continue
        for name, pattern in SKIP_BUCKETS:
            if pattern.search(raw):
                result['skips'][name] += 1
                break
    return result


def parse_nginx_logs(paths, now=None, window_hours=WINDOW_HOURS,
                     only_path=None):
    """解析 nginx combined 日志（支持 .gz）→ 近 window 小时请求数与字节合计。

    only_path：只统计该请求路径（如 '/sql'），None 表示全部。

    返回 {'requests', 'bytes', 'available', 'opened'}：
      available=False 表示**传入的日志路径一个都打不开**——此时 bytes/requests
      是 null 而非 0。区分「今天真的没流量（0）」与「没量到（日志缺失/路径配错）」，
      后者把 shim 下线伪装成 0 字节，与本脚本「算不了写 null+原因」的判据相反。
      部分文件缺失仍按实到的部分统计（available=True）。
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=window_hours)
    total_bytes = 0
    requests = 0
    opened = 0
    for path in paths:
        opener = gzip.open if str(path).endswith('.gz') else open
        try:
            with opener(path, 'rt', encoding='utf-8', errors='replace') as handle:
                opened += 1
                for line in handle:
                    match = NGINX_LINE_RE.match(line)
                    if not match:
                        continue
                    _, stamp, _method, req_path, _status, size = match.groups()
                    if only_path is not None and req_path != only_path:
                        continue
                    try:
                        when = datetime.strptime(
                            stamp, '%d/%b/%Y:%H:%M:%S').replace(tzinfo=LOCAL_TZ)
                    except ValueError:
                        continue
                    if when < cutoff:
                        continue
                    requests += 1
                    if size.isdigit():
                        total_bytes += int(size)
        except OSError:
            continue
    if opened == 0:
        return {'requests': None, 'bytes': None, 'available': False, 'opened': 0}
    return {'requests': requests, 'bytes': total_bytes,
            'available': True, 'opened': opened}


def classify_review_backlog(lines, imported_urls, validate_record):
    """对 labels.jsonl 里「未导入」的行跑官方 validate_record，统计 review 积压。

    lines：labels.jsonl 的文本行 list（每行一条 JSON）。
    imported_urls：labels-imported.jsonl 里的 url 集合（命中即已入库，跳过）。
    validate_record：import_one.validate_record（权威判据，不重写）。
    返回：{'unimported', 'review', 'review_reasons': [(reason, count)…], 'other': Counter}
    """
    review_reasons = Counter()
    other = Counter()
    unimported = 0
    review = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            other['json损坏'] += 1
            continue
        if not isinstance(record, dict):
            other['非对象'] += 1
            continue
        if record.get('url') in imported_urls:
            continue
        unimported += 1
        try:
            verdict = validate_record(record)
        except Exception:                       # 校验器 bug 也不能让脚本挂
            other['校验异常'] += 1
            continue
        status = verdict.get('status')
        if status == 'review':
            review += 1
            review_reasons[(verdict.get('reason') or '未给原因')[:60]] += 1
        else:
            other[status or '未知'] += 1
    return {'unimported': unimported, 'review': review,
            'review_reasons': review_reasons.most_common(5),
            'other': dict(other)}


def read_imported_urls(path):
    urls = set()
    try:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get('url'):
                    urls.add(record['url'])
    except OSError:
        pass
    return urls


# ======================================================================
# 指标采集（连库 + 读文件）
# ======================================================================
# 报错脱敏：错误原文只进 JSON 的 error 字段（渲染层显示「—（查询失败）」），
# 且先截断到 200 字、去掉可能出现的连接串/host。DB 驱动与 shim 的报错通常不含
# 连接串（连接串在请求头里，不在 SQL 里），但这条不假设——按最坏情况清一遍。
_CONN_STRING_RE = re.compile(r'(?:postgres(?:ql)?|https?)://\S+', re.I)
_HOSTPORT_RE = re.compile(r'\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?\b', re.I)
_IPPORT_RE = re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b')


def redact_error(error, limit=200):
    """把异常/字符串清成可安全进产物的短文本：去连接串、去 host、截断。"""
    text = str(error)
    text = _CONN_STRING_RE.sub('<conn>', text)
    text = _IPPORT_RE.sub('<host>', text)
    text = _HOSTPORT_RE.sub('<host>', text)
    return text[:limit]


def _count(sql, query, params=None):
    """跑 COUNT 查询，失败记 {'error': 脱敏后原因}（不抛）。"""
    try:
        value = sql.scalar(query, params)
        return int(value) if value is not None else None
    except Exception as error:                  # noqa: BLE001 - 采集层吞异常记 null
        return {'error': redact_error(error)}


def collect_metrics(sql, labeler_dir, nginx_logs, now=None):
    """采集全部指标 → dict。任何子项失败都记 {'error': …} 而非抛。"""
    now = now or datetime.now(timezone.utc)
    labeler = Path(labeler_dir)
    metrics = {}

    # ---- 1. 书库 ----
    library = {
        'labeled_books_total': _count(sql, 'SELECT count(*) AS n FROM labeled_books'),
        'labeled_24h': _count(sql, "SELECT count(*) AS n FROM labeled_books "
                                   "WHERE labeled_at > now() - interval '24 hours'"),
        'labeled_48h_to_24h': _count(sql, "SELECT count(*) AS n FROM labeled_books "
                                          "WHERE labeled_at > now() - interval '48 hours' "
                                          "AND labeled_at <= now() - interval '24 hours'"),
    }
    try:
        lines = (labeler / 'labels.jsonl').read_text(encoding='utf-8').splitlines()
        imported = read_imported_urls(labeler / 'labels-imported.jsonl')
        library['imported_marked'] = len(imported)
        validate_record, import_error = _load_validate_record(labeler)
        if validate_record is None:
            library['review_backlog'] = {'error': redact_error(import_error)}
        else:
            backlog = classify_review_backlog(lines, imported, validate_record)
            library['review_backlog_unimported'] = backlog['unimported']
            library['review_backlog'] = backlog['review']
            library['review_backlog_by_reason'] = backlog['review_reasons']
            library['backlog_other'] = backlog['other']
    except OSError as error:
        library['review_backlog'] = {'error': redact_error(f'读 labels.jsonl 失败: {error}')}
    metrics['library'] = library

    # ---- 2. 打标效率 ----
    labeling = {}
    try:
        gate_text = (labeler / 'gate.log').read_text(encoding='utf-8', errors='replace')
        gate = parse_gate_log(gate_text, now=now)
        chars = gate['chars']
        calls = gate['calls']
        labeling['writes_24h_log'] = gate['writes']
        labeling['rounds_24h'] = gate['rounds']
        labeling['avg_chars_per_book_24h'] = (sum(chars) // len(chars)) if chars else None
        labeling['avg_llm_calls_per_book_24h'] = (
            round(sum(calls) / len(calls), 2)) if calls else None
        labeling['chars_sample_n_24h'] = len(chars)
        labeling['skip_reasons_top5'] = gate['skips'].most_common(5)
    except OSError as error:
        labeling['error'] = redact_error(f'读 gate.log 失败: {error}')
    # token：gate.log 不记 token；llm_usage 表不含打标 phase（见报告 §1.1/§1.2）
    labeling['avg_llm_tokens_per_book_24h'] = None
    labeling['avg_llm_tokens_note'] = '待打标侧记 token 后再算（gate.log 无 token；llm_usage 无打标 phase）'
    metrics['labeling'] = labeling

    # ---- 3. 换源 ----
    sources = {
        'readable_pool_size': _count(sql, 'SELECT count(*) AS n FROM source_admission '
                                          'WHERE compile_ok AND search_ok'),
        'pool_size_compile_ok': _count(sql, 'SELECT count(*) AS n FROM source_admission '
                                            'WHERE compile_ok'),
    }
    try:
        rows = sql.query('SELECT host, count(*) AS n FROM source_admission '
                         'WHERE compile_ok AND search_ok GROUP BY host ORDER BY n DESC')
        total = sum(int(r['n']) for r in rows) or 0
        top = [(r['host'], int(r['n'])) for r in rows[:5]]
        sources['pool_host_top5'] = top
        sources['pool_max_host_share'] = (round(top[0][1] / total, 3)
                                          if total and top else None)
        sources['pool_max_host_share_note'] = '口径=源池内 host 占比，非搜索/阅读命中占比'
    except Exception as error:                  # noqa: BLE001
        sources['pool_host_top5'] = {'error': redact_error(error)}
    # 命中占比：无按源命中日志（见报告 §1.5）
    sources['hit_max_host_share'] = None
    sources['hit_max_host_share_note'] = '无按源搜索/阅读命中日志，无法算'
    # 覆盖率基准集：待 F3.1
    sources['coverage_baseline'] = None
    sources['coverage_baseline_note'] = '待 F3.1 建基准集'
    metrics['sources'] = sources

    # ---- 4. 数据库 ----
    database = {
        'size_bytes': _count(sql, 'SELECT pg_database_size(current_database()) AS n'),
    }
    try:
        stats = sql.query("SELECT datname, tup_returned, tup_fetched, xact_commit, "
                          "blks_read, blks_hit FROM pg_stat_database "
                          "WHERE datname = current_database()")
        database['pg_stat'] = stats[0] if stats else None
        database['pg_stat_note'] = '累计口径（stats_reset 为空），非 24h 窗口'
    except Exception as error:                  # noqa: BLE001
        database['pg_stat'] = {'error': redact_error(error)}
    transfer = parse_nginx_logs(nginx_logs, now=now, only_path='/sql')
    database['transfer_24h_bytes'] = transfer['bytes']
    database['transfer_24h_requests'] = transfer['requests']
    database['transfer_available'] = transfer['available']
    if not transfer['available']:
        database['transfer_note'] = '日志文件一个都打不开（缺失/权限/路径配错），非「今日零流量」'
    database['transfer_method'] = 'nginx shim access log 响应体字节合计（POST /sql）'
    metrics['database'] = database

    # ---- 5. 推荐 ----
    recommendation = {
        'created_24h': _count(sql, "SELECT count(*) AS n FROM recommendations "
                                   "WHERE created_at > now() - interval '24 hours'"),
        'shelf_active': _count(sql, "SELECT count(*) AS n FROM recommendations "
                                    "WHERE status <> 'new'"),
        'feedback_24h': _count(sql, "SELECT count(*) AS n FROM feedback "
                                    "WHERE created_at > now() - interval '24 hours'"),
        'note': '临时库缺推荐数据（recommendations/feedback 近乎空），回迁 Neon 后再算转化率',
    }
    metrics['recommendation'] = recommendation

    # ---- 附加：下载 ----
    download = {
        'done_24h': _count(sql, "SELECT count(*) AS n FROM download_tasks "
                                "WHERE status = 'done' AND updated_at > now() - interval '24 hours'"),
        'failed_24h': _count(sql, "SELECT count(*) AS n FROM download_tasks "
                                  "WHERE status = 'failed' AND updated_at > now() - interval '24 hours'"),
        'pending': _count(sql, "SELECT count(*) AS n FROM download_tasks WHERE status = 'pending'"),
    }
    metrics['download'] = download

    metrics['generated_at'] = now.isoformat()
    metrics['window_hours'] = WINDOW_HOURS
    return metrics


def _load_validate_record(labeler_dir):
    """从 labeler 目录 import import_one.validate_record（打标端同一判据）。"""
    labeler_str = str(labeler_dir)
    if labeler_str not in sys.path:
        sys.path.insert(0, labeler_str)
    try:
        import import_one                      # noqa: PLC0415
        return import_one.validate_record, None
    except Exception as error:                  # noqa: BLE001
        return None, f'import import_one 失败: {error}'


# ======================================================================
# 渲染（纯函数，离线可测）
# ======================================================================
_FAILED_MARK = '—（查询失败）'
# 「没量到」的展示（日志不可读），与「查到 0」区分开。
_NO_DATA_MARK = '—（无数据：日志不可读）'


def _is_error(value):
    """采集失败标记：{'error': …} dict（DB 报错原文只进 JSON，不进 markdown）。"""
    return isinstance(value, dict) and 'error' in value


def _fmt_num(value):
    if _is_error(value):
        return _FAILED_MARK
    if isinstance(value, int):
        return f'{value:,}'
    if isinstance(value, float):
        return f'{value:,.2f}'
    if value is None:
        return '—（null）'
    return str(value)


def _fmt_bytes(value):
    if _is_error(value):
        return _FAILED_MARK
    if not isinstance(value, (int, float)) or value is None:
        return '—（null）'
    size = float(value)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if size < 1024 or unit == 'TB':
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} TB'


def _arrow(current, previous, lower_is_better=False, fmt=_fmt_num):
    """对比箭头：有前值且同类型才比，否则空串。delta 用与主值同款格式化。"""
    if current is None or previous is None:
        return ''
    if not isinstance(current, (int, float)) or not isinstance(previous, (int, float)):
        return ''
    delta = current - previous
    if delta == 0:
        return '（持平）'
    up = delta > 0
    good = (not up) if lower_is_better else up
    return f'（{"↑" if up else "↓"}{fmt(abs(delta))} {"好" if good else "差"}）'


def _get(metrics, *path):
    node = metrics
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def render_markdown(metrics, previous=None, day=None):
    """渲染中文一页 markdown。previous=None 时不画对比。"""
    previous = previous or {}
    day = day or metrics.get('date') or ''
    lines = [f'# 书径北极星 · {day}', '',
             f'（窗口：近 {metrics.get("window_hours", WINDOW_HOURS)} 小时；'
             f'生成于 {metrics.get("generated_at", "")}）', '']

    def row(label, value, prev_value=None, lower=False, fmt=_fmt_num):
        arrow = _arrow(value, prev_value, lower_is_better=lower, fmt=fmt)
        return f'| {label} | {fmt(value)} |{arrow} |'

    lines += ['## 1. 书库', '', '| 指标 | 值 | 环比昨日 |', '|---|---|---|']
    lines.append(row('labeled_books 总数', _get(metrics, 'library', 'labeled_books_total'),
                     _get(previous, 'library', 'labeled_books_total')))
    lines.append(row('近24h 净入库', _get(metrics, 'library', 'labeled_24h'),
                     _get(previous, 'library', 'labeled_24h')))
    lines.append(row('review 积压（未导入判 review）', _get(metrics, 'library', 'review_backlog'),
                     _get(previous, 'library', 'review_backlog'), lower=True))
    lines.append(row('已入库标记数（labels-imported）',
                     _get(metrics, 'library', 'imported_marked'),
                     _get(previous, 'library', 'imported_marked')))
    reasons = _get(metrics, 'library', 'review_backlog_by_reason') or []
    if reasons:
        lines.append('')
        lines.append('review 积压原因 top5：')
        for reason, count in reasons:
            lines.append(f'- {count} × {reason}')
    lines.append('')

    lines += ['## 2. 打标效率', '', '| 指标 | 值 | 环比昨日 |', '|---|---|---|']
    lines.append(row('近24h 写入书库（gate.log）', _get(metrics, 'labeling', 'writes_24h_log'),
                     _get(previous, 'labeling', 'writes_24h_log')))
    lines.append(row('每本平均抓取字数', _get(metrics, 'labeling', 'avg_chars_per_book_24h'),
                     _get(previous, 'labeling', 'avg_chars_per_book_24h')))
    lines.append(row('每本平均 LLM 调用次数', _get(metrics, 'labeling', 'avg_llm_calls_per_book_24h'),
                     _get(previous, 'labeling', 'avg_llm_calls_per_book_24h')))
    lines.append(f'| 每本平均 LLM token | —（null） |'
                 f'{_get(metrics, "labeling", "avg_llm_tokens_note") or ""} |')
    skips = _get(metrics, 'labeling', 'skip_reasons_top5') or []
    if skips:
        lines.append('')
        lines.append('跳过/拒收原因 top5（gate.log 近24h）：')
        for reason, count in skips:
            lines.append(f'- {count} × {reason}')
    lines.append('')

    lines += ['## 3. 换源', '', '| 指标 | 值 | 环比昨日 |', '|---|---|---|']
    lines.append(row('可读源池（compile_ok∧search_ok）',
                     _get(metrics, 'sources', 'readable_pool_size'),
                     _get(previous, 'sources', 'readable_pool_size')))
    lines.append(f'| 池内最大单 host 占比 | {_fmt_num(_get(metrics, "sources", "pool_max_host_share"))} |'
                 f'口径：源池占比，非命中占比 |')
    lines.append(f'| 命中最大单源占比 | —（null） |'
                 f'{_get(metrics, "sources", "hit_max_host_share_note") or ""} |')
    lines.append(f'| 覆盖率基准集 | —（null） |'
                 f'{_get(metrics, "sources", "coverage_baseline_note") or ""} |')
    lines.append('')

    lines += ['## 4. 数据库', '', '| 指标 | 值 | 环比昨日 |', '|---|---|---|']
    lines.append(row('库大小', _get(metrics, 'database', 'size_bytes'),
                     _get(previous, 'database', 'size_bytes'), fmt=_fmt_bytes))
    transfer_available = _get(metrics, 'database', 'transfer_available')
    if transfer_available is False:
        # 日志一个都打不开：显式区分「没量到」与「今日零流量」
        note = _get(metrics, 'database', 'transfer_note') or '日志不可读'
        lines.append(f'| 近24h 传输量（/sql 响应体） | {_NO_DATA_MARK} |{note} |')
        lines.append(f'| 近24h /sql 请求数 | {_NO_DATA_MARK} |— |')
    else:
        lines.append(row('近24h 传输量（/sql 响应体）',
                         _get(metrics, 'database', 'transfer_24h_bytes'),
                         _get(previous, 'database', 'transfer_24h_bytes'), fmt=_fmt_bytes))
        lines.append(f'| 近24h /sql 请求数 | '
                     f'{_fmt_num(_get(metrics, "database", "transfer_24h_requests"))} |'
                     f'{_get(metrics, "database", "transfer_method") or ""} |')
    lines.append('')

    lines += ['## 5. 推荐', '', '| 指标 | 值 | 环比昨日 |', '|---|---|---|']
    lines.append(row('近24h 推荐次数', _get(metrics, 'recommendation', 'created_24h'),
                     _get(previous, 'recommendation', 'created_24h')))
    lines.append(row('书架在架（status≠new）', _get(metrics, 'recommendation', 'shelf_active'),
                     _get(previous, 'recommendation', 'shelf_active')))
    lines.append(row('近24h 反馈数', _get(metrics, 'recommendation', 'feedback_24h'),
                     _get(previous, 'recommendation', 'feedback_24h')))
    note = _get(metrics, 'recommendation', 'note')
    if note:
        lines.append(f'\n> {note}')
    lines.append('')

    lines += ['## 附加：下载', '', '| 指标 | 值 | 环比昨日 |', '|---|---|---|']
    lines.append(row('近24h done', _get(metrics, 'download', 'done_24h'),
                     _get(previous, 'download', 'done_24h')))
    lines.append(row('近24h failed', _get(metrics, 'download', 'failed_24h'),
                     _get(previous, 'download', 'failed_24h'), lower=True))
    lines.append(row('pending', _get(metrics, 'download', 'pending'),
                     _get(previous, 'download', 'pending'), lower=True))
    lines.append('')
    return '\n'.join(lines) + '\n'


def load_previous(out_dir, day):
    """读前一天的 JSON 做对比；没有就拿 out_dir 里最新的更早文件。"""
    try:
        target = datetime.strptime(day, '%Y-%m-%d').date()
    except (ValueError, TypeError):
        return None
    candidates = []
    base = Path(out_dir)
    if not base.is_dir():
        return None
    for path in base.glob('*.json'):
        try:
            candidates.append((datetime.strptime(path.stem, '%Y-%m-%d').date(), path))
        except ValueError:
            continue
    candidates.sort()
    previous = None
    for when, path in candidates:
        if when < target:
            previous = path
        else:
            break
    if previous is None:
        return None
    try:
        return json.loads(previous.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None


# ======================================================================
# 入口
# ======================================================================
def main(argv=None):
    parser = argparse.ArgumentParser(description='书径每日北极星指标（只读）')
    parser.add_argument('--out-dir', default=DEFAULT_OUT_DIR)
    parser.add_argument('--env-file', default=DEFAULT_ENV_FILE)
    parser.add_argument('--labeler-dir', default=DEFAULT_LABELER_DIR)
    parser.add_argument('--nginx-log', action='append', default=None,
                        help='可多次；默认两条轮转文件')
    parser.add_argument('--date', default=None, help='覆盖「今天」（YYYY-MM-DD）')
    parser.add_argument('--dry-run', action='store_true', help='只打印 markdown，不落盘')
    args = parser.parse_args(argv)

    day = args.date or date.today().isoformat()
    nginx_logs = tuple(args.nginx_log) if args.nginx_log else DEFAULT_NGINX_LOGS

    env = read_env_whitelist(args.env_file)
    database_url = env.get('DATABASE_URL') or os.environ.get('DATABASE_URL', '')
    sql = None
    if database_url:
        sql = ReadOnlySql(database_url)

    if sql is not None:
        metrics = collect_metrics(sql, args.labeler_dir, nginx_logs)
    else:
        # 无连接串：不连库，仅文件侧指标（review 积压/打标/传输量仍可算）
        metrics = collect_metrics(_NullSql(), args.labeler_dir, nginx_logs)
        metrics['database_error'] = '无 DATABASE_URL，库侧指标为 null'

    metrics['date'] = day
    previous = load_previous(args.out_dir, day)
    markdown = render_markdown(metrics, previous, day=day)

    if args.dry_run:
        print(markdown)
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f'{day}.json'
    md_path = out_dir / 'latest.md'
    json_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
    md_path.write_text(markdown, encoding='utf-8')
    print(f'已写 {json_path} 与 {md_path}')
    return 0


class _NullSql:
    """无 DATABASE_URL 时的空 SQL 客户端：所有查询记 error，不抛。"""

    def query(self, sql, params=None):
        raise RuntimeError('无 DATABASE_URL')

    def scalar(self, sql, params=None):
        raise RuntimeError('无 DATABASE_URL')


if __name__ == '__main__':
    sys.exit(main())
