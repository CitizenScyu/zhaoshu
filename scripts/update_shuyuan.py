#!/usr/bin/env python3
"""从 yckceo.com 拉取书源合集并合并去重。

用法:
  python scripts/update_shuyuan.py --proxy http://127.0.0.1:7891          # 取列表页最新 3 个合集,按 bookSourceUrl 去重合并
  python scripts/update_shuyuan.py --proxy http://127.0.0.1:7891 --latest 1
  python scripts/update_shuyuan.py --proxy http://127.0.0.1:7891 --ids 1270,1271  # 手动指定
  python scripts/update_shuyuan.py --list --proxy http://127.0.0.1:7891   # 只看列表

说明:
  - yckceo 直连会被 SNI 重置,必须 --proxy(本机 7891 / .88 可用局域网代理)
  - 合并按 bookSourceUrl 去重,列表页靠前的合集(更新)优先
  - 输出 data/shuyuan.json + data/shuyuan-manifest.json,均在 .gitignore 中
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

INDEX_URL = 'https://www.yckceo.com/yuedu/shuyuans/index.html'
JSON_URL = 'https://www.yckceo.com/yuedu/shuyuans/json/id/{}.json'
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'data'

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) zhaoshu/1.0'}


def http_get(url: str, proxy: str | None, retries: int = 3) -> bytes:
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers=HEADERS)
    last_err = None
    for i in range(retries):
        try:
            with opener.open(req, timeout=60) as res:
                return res.read()
        except Exception as e:  # noqa: BLE001 - 统一重试
            last_err = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f'GET {url} 失败: {last_err}')


def parse_index(html: str) -> list[tuple[int, str]]:
    """列表页是静态 HTML,合集按 id 倒序(新→旧)排列。"""
    out = []
    for m in re.finditer(r'href="/yuedu/shuyuans/content/id/(\d+)\.html"[^>]*>([^<]+)', html):
        out.append((int(m.group(1)), m.group(2).strip()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description='更新书源合集')
    ap.add_argument('--proxy', help='HTTP 代理,如 http://127.0.0.1:7891(通常必需)')
    ap.add_argument('--latest', type=int, default=3, help='取列表页最新 N 个合集去重合并(默认 3)')
    ap.add_argument('--ids', help='手动指定合集 id,逗号分隔(忽略 --latest)')
    ap.add_argument('--list', action='store_true', help='只列出合集不下载')
    args = ap.parse_args()

    print(f'拉取列表页 {INDEX_URL} ...')
    index_html = http_get(INDEX_URL, args.proxy).decode('utf-8', 'replace')
    entries = parse_index(index_html)
    if not entries:
        print('!! 列表页解析到 0 个合集,页面结构可能变了', file=sys.stderr)
        return 1
    print(f'列表页共 {len(entries)} 个合集,最新 10 个:')
    for cid, title in entries[:10]:
        print(f'  id={cid}  {title}')

    if args.list:
        return 0

    if args.ids:
        wanted = [int(x) for x in args.ids.split(',') if x.strip()]
    else:
        wanted = [cid for cid, _ in entries[:args.latest]]

    merged: dict[str, dict] = {}  # bookSourceUrl(规范化) -> source
    manifest = {'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'collections': []}
    for cid in wanted:
        title = next((t for i, t in entries if i == cid), '')
        url = JSON_URL.format(cid)
        print(f'下载合集 id={cid} {title} ...')
        try:
            raw = http_get(url, args.proxy)
        except RuntimeError as e:
            print(f'  跳过: {e}', file=sys.stderr)
            manifest['collections'].append({'id': cid, 'title': title, 'ok': False})
            continue
        sources = json.loads(raw)
        if not isinstance(sources, list):
            print(f'  跳过: 不是书源数组', file=sys.stderr)
            manifest['collections'].append({'id': cid, 'title': title, 'ok': False})
            continue
        added = 0
        for s in sources:
            key = (s.get('bookSourceUrl') or '').strip().rstrip('/')
            if not key or key in merged:
                continue
            merged[key] = s
            added += 1
        print(f'  {len(sources)} 个源,新增 {added}')
        manifest['collections'].append({'id': cid, 'title': title, 'ok': True, 'count': len(sources)})

    DATA_DIR.mkdir(exist_ok=True)
    out = DATA_DIR / 'shuyuan.json'
    out.write_text(json.dumps(list(merged.values()), ensure_ascii=False), encoding='utf-8')
    (DATA_DIR / 'shuyuan-manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'合并后 {len(merged)} 个源 -> {out.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
