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
配置: /root/zhaoshu-labeler/.env（LLM_API_KEY 必填；DATABASE_URL 与 LLM_MODEL 可选）
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
from pathlib import Path

# ---- 配置 ----
ENV_PATH = Path(__file__).parent / '.env'
TARGET_CHARS = 500_000      # 每本抓取字数上限
CHUNK_RETRY = 3             # 单章抓取重试
LLM_INTERVAL_SEC = 30       # 两次 LLM 调用最小间隔（控频）
CHAPTER_DELAY = 0.3         # 抓章节间隔（对目标站友好）
RANKS = (1, 2, 3)           # 榜单页
BASE = 'https://book15.net'
LLM_URL = 'https://api.cloud.us.kg/v1/chat/completions'
UA = {'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu-labeler/1.0)'}
# 打标模型后备链：先 bohe，失败依次换 grok-4.6-hei → deepseek-v4.1-flash-hei → glm-5.3-agent。
# 可用 .env 的 LLM_MODELS=模型1,模型2,... 覆盖；无 LLM_MODELS 时兜底用旧 LLM_MODEL 单值。
MODELS = ['deepseek-v4-flash-bohe', 'grok-4.6-hei', 'deepseek-v4.1-flash-hei', 'glm-5.3-agent']
# 读库取模型名用的白名单：只是防呆（挡住空串/换行/注入了 SQL 的怪值），不是安全边界。
MODEL_NAME_RE = re.compile(r'^[A-Za-z0-9._/-]{1,200}$')
DB_MODEL_TIMEOUT_SEC = 5    # 读配置失败必须快速回落，不能拖住批量任务

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


def load_env():
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    missing = [k for k in ('LLM_API_KEY',) if not env.get(k)]
    if missing:
        sys.exit(f'缺少环境变量: {missing}（应在 {ENV_PATH} 里）')
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


# ---- 抓取层（将来可整体搬进主应用）----
def fetch_rank_books() -> list[dict]:
    """榜单页 → [{url, title, author, category, status}]"""
    books, seen = [], set()
    for rank in RANKS:
        try:
            html = http_get(f'{BASE}/books/rank{rank}.html')
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
            html = http_get(BASE + b['url'])
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


def fetch_chapters(detail_url: str) -> list[tuple[str, str]]:
    """详情页 → [(chapter_url, chapter_title)]"""
    html = http_get(BASE + detail_url)
    return re.findall(
        r'<dd[^>]*>\s*<a[^>]*href="(/chapter/index\d+-\d+\.html)"[^>]*>([^<]{1,60})</a>', html)


def fetch_chapter_text(chapter_url: str) -> str:
    """章节页 → 纯文本（段落级 <p> 提取，嵌套 div 正则会截断）"""
    html = http_get(BASE + chapter_url)
    start = html.find('chapter-content-panel')
    seg = html[start:start + 25_000]
    paras = re.findall(r'<p[^>]*>([\s\S]*?)</p>', seg)
    text = '\n'.join(re.sub(r'<[^>]+>|&nbsp;', '', p).strip() for p in paras)
    return re.sub(r'\n{2,}', '\n', text).strip()


def fetch_book_text(detail_url: str, target_chars: int = TARGET_CHARS) -> tuple[str, int]:
    """整本（到字数上限）→ (拼接文本, 实际字数)"""
    chapters = fetch_chapters(detail_url)
    parts, chars = [], 0
    for url, title in chapters:
        if chars >= target_chars:
            break
        text = ''
        for attempt in range(CHUNK_RETRY):
            try:
                text = fetch_chapter_text(url)
                break
            except Exception:
                time.sleep(2 * (attempt + 1))
        if len(text) > 100:
            parts.append(f'【{title.strip()}】\n{text}')
            chars += len(text)
        time.sleep(CHAPTER_DELAY)
    return '\n\n'.join(parts), chars


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
# @neondatabase/serverless 驱动统一执行（scripts/import_labels.mjs），
# phoenix 无需任何 PG 依赖。


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=100)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--book', help='指定单本详情页路径，如 /books/details3168.html')
    ap.add_argument('--no-db-model', action='store_true',
                    help='不读数据库 app_settings.label_model，直接用 .env 的模型链')
    args = ap.parse_args()

    env = load_env()
    models, model_source = resolve_models(env, use_db=not args.no_db_model)
    print(f'打标模型来源: {model_source}')
    print(f'模型链: {models}')
    # 断点续传：已写入 labels.jsonl 的书跳过（按详情页 url 判定）
    done_urls: set[str] = set()
    done_path = Path(__file__).parent / 'labels.jsonl'
    if done_path.exists():
        for line in done_path.read_text(encoding='utf-8').splitlines():
            try:
                done_urls.add(json.loads(line).get('url', ''))
            except json.JSONDecodeError:
                continue

    if args.book:
        queue = [{'url': args.book, 'title': args.book}]
    else:
        print('拉取榜单书目...')
        all_books = fetch_rank_books()
        print(f'榜单共 {len(all_books)} 本（去重后）')
        queue = all_books[:args.limit]
        done_count = sum(1 for b in queue if BASE + b['url'] in done_urls)
        queue = [b for b in queue if BASE + b['url'] not in done_urls]
        print(f'本轮处理 {len(queue)} 本（跳过已完成 {done_count} 本）')

    if args.dry_run:
        for b in queue:
            print(' -', b.get('title'), '|', b.get('author', '?'), '|',
                  b.get('category', '?'), '|', b.get('status', '?'), '|', b['url'])
        return 0

    ok = fail = 0
    for i, b in enumerate(queue, 1):
        print(f'[{i}/{len(queue)}] {b.get("title")} ...')
        try:
            text, chars = fetch_book_text(b['url'])
            if chars < 10_000:
                print(f'  仅抓到 {chars} 字，跳过')
                reject = {
                    'site_title': '' if args.book else (b.get('title') or '').strip(),
                    'author': b.get('author', ''),
                    'category': b.get('category', ''),
                    'url': BASE + b['url'],
                    'reason': f'抓取字数不足: {chars}',
                }
                rej_path = Path(__file__).parent / 'labels-rejected.jsonl'
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
                    'url': BASE + b['url'],
                    'title_guess': guess,
                    'site_title_match': labels.get('site_title_match'),
                    'site_title_note': labels.get('site_title_note'),
                    'reason': reason,
                }
                rej_path = Path(__file__).parent / 'labels-rejected.jsonl'
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
                    'url': BASE + b['url'],
                    'title_guess': guess,
                    'site_title_match': labels.get('site_title_match'),
                    'site_title_note': labels.get('site_title_note'),
                    'reason': f'文本质量异常: {quality}',
                }
                rej_path = Path(__file__).parent / 'labels-rejected.jsonl'
                with open(rej_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(reject, ensure_ascii=False) + '\n')
                fail += 1
                time.sleep(LLM_INTERVAL_SEC)
                continue
            b_out = {
                'title': labels.get('title_guess') or b.get('title', ''),
                'site_title': site_title,
                'author': b.get('author', ''),
                'category': b.get('category', ''),
                'status': b.get('status', ''),
                'source': 'book15.net',
                'url': BASE + b['url'],
                'chars': chars,
                'labels': labels,
            }
            print(f'  {chars} 字 | {labels.get("genre")} | conf {labels.get("confidence")} | {calls} 次调用')
            out_path = Path(__file__).parent / 'labels.jsonl'
            with open(out_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(b_out, ensure_ascii=False) + '\n')
            ok += 1
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
