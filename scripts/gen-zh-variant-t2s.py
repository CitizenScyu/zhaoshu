#!/usr/bin/env python3
"""从 src/lib/zh-variant-fold.ts 生成 douban_list.py 里内嵌的「书名繁简折叠表」。

为什么要有这份表（41-authtag）：
  Python 打标线（douban_list）判「名单书名 vs 站点书名」是否同一本时，繁体/简体写法
  （魔道祖師 / 魔道祖师）会被判成两本书而拒收。JS 侧书源线（src/lib/source-parser.ts 的
  sourceBookMatches / sourceTitleSimilarity）早已用 src/lib/zh-variant-fold.ts 做同样的事。
  两线对同一本书名必须给出同一个结论，故 Python 侧内嵌同一张表，而不是各自维护一份词表。

为什么内嵌而不是运行时读 TS：
  phoenix 打标目录只放 4 个 .py 运行文件（无 src/**），运行时读不到 TS 文件。

为什么只用于**书名**、不动作者侧的表：
  作者侧 `_to_simplified` 复用 `import_one._T2S`，而入库身份键是
  `_norm_author(_to_simplified(raw))`——两条路径必须同表。本书名表比那张大得多
  （2884 vs 83），若顺手把作者侧也换成本表，`_loose_author_key` 与 `_norm_author`
  就不在一个表上了。**作者侧是否也换成这张大表，是另一件需要同时改 import_one 与其
  幂等孪生判定的事，本次不做**（见报告 §6）。因此：书名用本表，作者维持 import_one._T2S。

为什么一对一：
  折叠两侧同时做，只有「同一个字的繁简两种写法」会被折到一个字；不同的字绝不判等
  （生成规则见 src/lib/zh-variant-fold.ts 头注释与 gen-zh-variant-fold.mjs）。
  逐字折叠是单射，故不会因为折叠凭空造出新的前缀/包含关系。

用法：
  python scripts/gen-zh-variant-t2s.py            # 校验 douban_list.py 内嵌表与 TS 表一致
  python scripts/gen-zh-variant-t2s.py --write    # 重新生成并写回 douban_list.py
离线：只读本仓文件，不联网、不读 .env。

改动 TS 表时的动作：改完 src/lib/zh-variant-fold.ts 后跑 --write 重生成，再跑
scripts/test_douban_list.py 的 TestTitleTraditionalFold.test_fold_table_matches_ts_source
（两者同判据，任一不一致即红）。
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
TS_PATH = os.path.join(REPO, 'src', 'lib', 'zh-variant-fold.ts')
PY_PATH = os.path.join(HERE, 'douban_list.py')

BEGIN = '# >>> AUTHTAG_TITLE_FOLD_BEGIN'
END = '# <<< AUTHTAG_TITLE_FOLD_END'
EXPECTED_PAIRS = 2884
LINE_WIDTH = 96


def read_ts_pairs():
    """src/lib/zh-variant-fold.ts → {繁体字: 简体字}（一对一）。"""
    src = io.open(TS_PATH, encoding='utf-8').read()
    start = src.index('const PAIRS = [')
    end = src.index("].join('');")
    joined = ''.join(re.findall(r"'([^']*)'", src[start:end]))
    pairs = {}
    i = 0
    while i < len(joined):
        trad = joined[i]
        i += 1
        if i >= len(joined):
            raise SystemExit('字串长度为奇数，无法两两配对')
        simp = joined[i]
        i += 1
        pairs[trad] = simp
    if len(pairs) != EXPECTED_PAIRS:
        raise SystemExit(f'解析出 {len(pairs)} 对，期望 {EXPECTED_PAIRS}（TS 表被改动？）')
    if len(set(pairs.values())) != len(pairs):
        raise SystemExit('目标字有重复：不是一对一表，折叠会造出假等价类')
    leftovers = [v for v in set(pairs.values()) if v in pairs]
    if leftovers:
        raise SystemExit(f'存在目标字仍是键的字（会二次折叠）: {leftovers[:10]}')
    return pairs


def render_block(pairs):
    order = sorted(pairs, key=ord)
    trad = ''.join(order)
    simp = ''.join(pairs[ch] for ch in order)

    def wrap(text):
        return '\n'.join("    '" + text[k:k + LINE_WIDTH] + "'"
                         for k in range(0, len(text), LINE_WIDTH))

    return (
        f'{BEGIN}\n'
        f'# 由 scripts/gen-zh-variant-t2s.py 生成，勿手改。\n'
        f'# 数据来源与许可同书源线那张表：OpenCC（Apache-2.0，见 THIRD_PARTY_NOTICES.md）。\n'
        f'# 一对一映射共 {len(pairs)} 对——只吸收「同一个字的繁简两种写法」，不同的字不判等；\n'
        f'# 表外的字原样保留。只用于**书名比较**，不改任何写入值（见 _fold_variants 注释）。\n'
        f'_TITLE_FOLD_TRAD = (\n{wrap(trad)}\n)\n'
        f'_TITLE_FOLD_SIMP = (\n{wrap(simp)}\n)\n'
        f'assert len(_TITLE_FOLD_TRAD) == len(_TITLE_FOLD_SIMP), \\\n'
        f'    "书名繁简折叠表两串长度必须相等"\n'
        f'{END}'
    )


def main():
    write = '--write' in sys.argv[1:]
    block = render_block(read_ts_pairs())
    # newline='' 保留原行尾（本仓 .py 用 CRLF 检出，core.autocrlf=true）；读写都不翻译，
    # 免得「改一段表」把整文件的 CRLF 洗成 LF、在 diff 里留下一整个文件的噪声。
    with io.open(PY_PATH, encoding='utf-8', newline='') as handle:
        source = handle.read()
    newline = '\r\n' if '\r\n' in source else '\n'
    block = block.replace('\n', newline)
    try:
        begin = source.index(BEGIN)
        end = source.index(END) + len(END)
    except ValueError:
        raise SystemExit(f'douban_list.py 里找不到标记 {BEGIN} / {END}')

    if source[begin:end] == block:
        print('OK: 内嵌表与 TS 表一致（未改动）')
        return 0
    if not write:
        print('NG: 内嵌表与 TS 表不一致（加 --write 重新生成）')
        return 1
    with io.open(PY_PATH, 'w', encoding='utf-8', newline='') as handle:
        handle.write(source[:begin] + block + source[end:])
    print('已写回 douban_list.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
