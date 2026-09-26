#!/usr/bin/env python3
"""backfill_17k_authors.py — 给 labels.jsonl 里「已打标但因作者为空未入库」的行补作者，
再交 import_one 幂等重放。dry-run 优先：默认只补作者、写出增补文件、打印统计，**不连库、不写库**。

背景（lblrate-41 §3/§5）：17K 完本来源的名单作者恒空（现已就地补部分，仍有大量空缺），
打标成功但被 import_one 的「作者为空」护栏挡成 review 不入库，积压 ~86 本、与库内零重复。
本脚本把这些行的作者补上后，产出一个新的 jsonl 交给 import_one 重放。

作者来源（按可靠性优先，补不到就**丢弃该行**、绝不写空作者，守幂等红线
labeler-idempotency-redline：空作者会与存量非空作者行造出第二行）：
  1) 引擎 toc 自报作者（--engine：行内 url 是打标时实际命中的书源，非 17K/WAF，可复取；
     这是打标身份校验用过的同一字段，最可信）；
  2) 17K 完本页就地作者（--quanben：按归一化书名匹配 douban_list.parse_17k_quanben 的产物）。

幂等与去重：import_one 自身按 labels-imported.jsonl 的 url 标记跳过已导入，DB 侧按身份键
(title_key, author_key) ON CONFLICT，故重放不会重复；本脚本只负责「补到可信作者」这一步，
补不到的留给人工。**不在服务器执行**——补完后由运维跑：
  python3 import_one.py --file <out> --dry-run          # 先看 ready/review 计数
  python3 import_one.py --file <out> --env <.env 路径>   # 确认后真导（幂等）
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import douban_list          # noqa: E402
import import_one           # noqa: E402

# 只从 --env 白名单读这几个键喂给引擎 CLI，值不打印（凭据红线）
_ENGINE_ENV_KEYS = ('LABELER_ENGINE_FALLBACK', 'LABELER_ENGINE_CLI',
                    'LABELER_NODE', 'LABELER_ENGINE_HOOK', 'DATABASE_URL')


def load_jsonl(path):
    rows = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def is_empty_author_review(rec):
    """打标合格但仅因作者为空被挡（validate_record → review「作者为空」）。"""
    if not isinstance(rec, dict) or (rec.get('author') or '').strip():
        return False
    verdict = import_one.validate_record(rec)
    return verdict['status'] == 'review' and '作者为空' in verdict.get('reason', '')


def _row_title(rec):
    return (rec.get('site_title') or rec.get('title') or '').strip()


def load_env_whitelist(env_path):
    """从 --env 只取白名单键（值不打印），供引擎 CLI 子进程 env 注入。"""
    env = {}
    for raw in Path(env_path).read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            key = key.strip()
            if key in _ENGINE_ENV_KEYS:
                env[key] = value.strip().strip('"').strip("'")
    return env


def build_17k_author_map(http_get):
    """{归一化书名: 作者}，只收 parse_17k_quanben 产出的非空作者。"""
    amap = {}
    for b in douban_list.fetch_17k_quanben_books(http_get):
        author = (b.get('author') or '').strip()
        if author:
            amap[douban_list._norm_title(b.get('title', ''))] = author
    return amap


def resolve_engine_author(engine_cli, url):
    """引擎 toc 自报作者，经与 labeler 回写路径**同一套**清洗（rvauthor CE5：两路径口径必须一致，
    否则同一本书写出不同 author_key → 第二行）。失败/空/占位 → ''（可降级不抛）。"""
    if not engine_cli or not url or not douban_list.engine_url_supported(url):
        return ''
    try:
        import labeler
        toc = labeler._engine_json(engine_cli, 'toc', '--url', url)
        return labeler._clean_engine_author(toc.get('author') or '')
    except Exception:                       # noqa: BLE001 —— 补作者失败只降级，不影响其余行
        return ''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--labels', default=str(Path(__file__).parent / 'labels.jsonl'),
                        help='源 labels.jsonl（默认脚本同目录）')
    parser.add_argument('--out', default=str(Path(__file__).parent / 'labels-17k-backfilled.jsonl'),
                        help='补作者后的增补 jsonl（交 import_one --file 重放）')
    parser.add_argument('--category', default='17K完本',
                        help='只处理该来源分类的空作者行（空串=不限分类）')
    parser.add_argument('--engine', action='store_true',
                        help='用引擎 toc 补作者（需 --env 指向 .env，提供 LABELER_ENGINE_* ）')
    parser.add_argument('--env', help='引擎 CLI 的 .env（只读白名单键，值不打印）')
    parser.add_argument('--no-17k', action='store_true',
                        help='不拉 17K 完本页做书名兜底（仅用引擎 toc）')
    args = parser.parse_args(argv)

    rows = load_jsonl(args.labels)
    targets = [r for r in rows if is_empty_author_review(r)
               and (not args.category
                    or (r.get('category') or '').strip() == args.category)]

    engine_cli = None
    if args.engine:
        if not args.env:
            sys.exit('--engine 需配 --env 指向 .env')
        import labeler
        engine_cli = labeler._build_engine_cli(load_env_whitelist(args.env))
        if engine_cli is None:
            sys.exit('引擎 CLI 装配失败：检查 .env 的 LABELER_ENGINE_FALLBACK / LABELER_ENGINE_CLI')

    author_map = {} if args.no_17k else build_17k_author_map(import_one_http_get())

    filled_engine = filled_17k = unresolved = 0
    out_rows = []
    for rec in targets:
        author = resolve_engine_author(engine_cli, rec.get('url') or '') if engine_cli else ''
        src = 'engine'
        if not author and author_map:
            author = author_map.get(douban_list._norm_title(_row_title(rec)), '')
            src = '17k'
        if not author:
            unresolved += 1
            continue
        filled = dict(rec)
        filled['author'] = author
        # 补作者后仍须过 validate_record 才算可导（避免补了作者却触发别的护栏）
        if import_one.validate_record(filled)['status'] != 'ready':
            unresolved += 1
            continue
        out_rows.append(filled)
        if src == 'engine':
            filled_engine += 1
        else:
            filled_17k += 1

    Path(args.out).write_text(
        ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in out_rows),
        encoding='utf-8')
    total = len(targets)
    print(f'空作者待补行: {total}')
    print(f'  引擎 toc 补到: {filled_engine}')
    print(f'  17K 页补到  : {filled_17k}')
    print(f'  仍补不到    : {unresolved}（留人工，未写空作者，守幂等红线）')
    print(f'已写 {len(out_rows)} 行 → {args.out}')
    print('下一步（运维执行，本脚本不连库）：')
    print(f'  python3 import_one.py --file {args.out} --dry-run')
    print(f'  python3 import_one.py --file {args.out} --env <.env 路径>')
    return 0


def import_one_http_get():
    """复用 labeler.http_get（同一 UA / 重试语义）拉 17K 完本页。"""
    import labeler
    return labeler.http_get


if __name__ == '__main__':
    raise SystemExit(main())
