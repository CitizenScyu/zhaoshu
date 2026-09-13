#!/usr/bin/env python3
"""书径 V2 批量打标器（部署在 phoenix 上跑）。

流程：榜单取书目 → 逐本抓前 40 万字 → 流式调 LLM 打标 → 标签写 Neon。
设计：串行 + 间隔控频；断点续传（已标过的跳过）；抓取/打标/入库分层，
将来主应用可直接复用 label_book / fetch_book_text。

用法:
  python3 labeler.py --limit 100            # 给前 100 本书打标
  python3 labeler.py --dry-run              # 只列书目不打标
  python3 labeler.py --book /books/details3168.html   # 指定单本
配置: /root/zhaoshu-labeler/.env（LLM_API_KEY / DATABASE_URL / LLM_MODEL）
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

# ---- 配置 ----
ENV_PATH = Path(__file__).parent / '.env'
TARGET_CHARS = 400_000      # 每本抓取字数上限
CHUNK_RETRY = 3             # 单章抓取重试
LLM_INTERVAL_SEC = 30       # 两次 LLM 调用最小间隔（控频）
CHAPTER_DELAY = 0.3         # 抓章节间隔（对目标站友好）
RANKS = (1, 2, 3)           # 榜单页
BASE = 'https://book15.net'
LLM_URL = 'https://api.cloud.us.kg/v1/chat/completions'
UA = {'User-Agent': 'Mozilla/5.0 (compatible; zhaoshu-labeler/1.0)'}

SYSTEM_PROMPT = (
    "你是网文编目员。阅读给定的小说文本（若干章），输出一个 JSON 对象"
    "（不要 markdown 代码块，不要多余文字），字段："
    "title_guess(书名猜测)、genre(题材)、style(文风,2-4个词)、pace(节奏)、"
    "protagonist(主角类型一句话)、strengths(爽点/看点,2-4条)、"
    "weaknesses(雷点风险,1-3条)、plot_stage(读到的内容进展到什么阶段,一句话)、"
    "worldbuilding(世界观一句话)、tone(基调)、confidence(0-1)。"
)


def load_env():
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    missing = [k for k in ('LLM_API_KEY', 'LLM_MODEL') if not env.get(k)]
    if missing:
        sys.exit(f'缺少环境变量: {missing}（应在 {ENV_PATH} 里）')
    return env


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
def label_book(text: str, api_key: str, model: str) -> dict:
    """40 万字文本 → 标签 dict。流式 + 3 次重试（CF 100s 线规避）。"""
    body = json.dumps({
        'model': model, 'stream': True, 'max_tokens': 1500,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': text},
        ],
    }).encode('utf-8')
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                LLM_URL, data=body, method='POST',
                headers={**UA, 'Content-Type': 'application/json',
                         'Authorization': f'Bearer {api_key}'})
            content = ''
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
            return parsed
        except Exception as e:
            last_err = e
            print(f'    LLM 尝试 {attempt + 1} 失败: {e}', file=sys.stderr)
            time.sleep(20 * (attempt + 1))
    raise RuntimeError(f'打标失败: {last_err}')


# ---- 入库层 ----
# 试点期产物为 labels.jsonl（每行一本）；批量入库由本地用项目的
# @neondatabase/serverless 驱动统一执行（scripts/import_labels.mjs），
# phoenix 无需任何 PG 依赖。


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=100)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--book', help='指定单本详情页路径，如 /books/details3168.html')
    args = ap.parse_args()

    env = load_env()
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
                fail += 1
                continue
            labels = label_book(text, env['LLM_API_KEY'], env['LLM_MODEL'])
            b_out = {
                'title': labels.get('title_guess') or b.get('title', ''),
                'author': b.get('author', ''),
                'category': b.get('category', ''),
                'status': b.get('status', ''),
                'source': 'book15.net',
                'url': BASE + b['url'],
                'chars': chars,
                'labels': labels,
            }
            print(f'  {chars} 字 | {labels.get("genre")} | conf {labels.get("confidence")}')
            out_path = Path(__file__).parent / 'labels.jsonl'
            with open(out_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(b_out, ensure_ascii=False) + '\n')
            ok += 1
        except Exception as e:
            print(f'  失败: {e}', file=sys.stderr)
            fail += 1
        time.sleep(LLM_INTERVAL_SEC)
    print(f'\n完成: 成功 {ok} / 失败 {fail}，结果在 labels.jsonl')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
