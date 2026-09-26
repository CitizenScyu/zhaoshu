"""生成 scripts/fixtures/import-verdict-parity.json（对照测试共享输入）。

每条记录同时给 py/mjs 两侧的期望结论 + agree 标记：agree=true 表示两条导入路径
对这条输入**必须给出同一结论**，两侧测试各自断言自己那一侧等于期望值。
agree=false 是**已知且刻意**的分叉，必须在 why 里写明理由，两侧各自钉住自己的值，
任何一侧漂移都会红。

该文件同时要求 ASCII（书名/作者用 T1/A1 这类），避免两端编码差异造成假失败。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import import_one  # noqa: E402

NORMAL, GARBLED = '正常', '疑似乱码'


def labels(guess, quality=NORMAL, match=True):
    d = {'title_guess': guess, 'text_quality': quality, 'genre': 'g'}
    if match is not None:
        d['site_title_match'] = match
    d['quality'] = {'overall': 8}
    return d


def rec(title, site, author, guess=None, quality=NORMAL, match=True, **kw):
    base = {'title': title, 'site_title': site, 'author': author, 'category': 'cat',
            'status': 'done', 'source': 'book15.net', 'url': 'https://book15.net/books/d.html',
            'chars': 1000, 'labels': labels(guess if guess is not None else title,
                                            quality=quality, match=match)}
    base.update(kw)
    return base


ROWS = [
    ('baseline ready: guess equals site title, strict true match', 'ready',
     rec('T1', 'T1', 'A1')),
    ('lblmeta41: guess != site title but site_title_match true -> ready (was review)', 'ready',
     rec('T2-guess', 'T2', 'A2')),
    ('lblmeta41: title equals site title but site_title_match false -> review (gate kept)', 'review',
     rec('T3', 'T3', 'A3', match=False)),
    ('lblmeta41: mismatch AND site_title_match false -> review (gate dominates mismatch)', 'review',
     rec('T4-guess', 'T4', 'A4', match=False)),
    ('legacy without site_title_match: guess != title -> review (blind-guess path unchanged)', 'review',
     rec('T5', 'T5', 'A5', guess='T5-other', match=None)),
    ('legacy without site_title_match: guess equals title -> ready', 'ready',
     rec('T6', 'T6', 'A6', guess='T6', match=None)),
    ('empty author -> review (idempotency red line, unchanged)', 'review',
     rec('T7', 'T7', '')),
    ('known-bad text_quality -> skipped', 'skipped',
     rec('T8', 'T8', 'A8', quality=GARBLED)),
    ('unknown author_encoding -> review (same code path both sides)', 'review',
     rec('T9', 'T9', 'A9', author_encoding='v2', guess='T9-guess')),
    ('lblmeta41 metadata fields accepted as strings', 'ready',
     rec('T10', 'T10', 'A10', guess='T10-other', label_model='m1',
         prompt_version='v1', label_source='text_book15')),
    ('label_source not a string -> failed (both type-check)', 'failed',
     rec('T11', 'T11', 'A11', label_source=1)),
    ('unknown future top-level field is ignored by both importers (no field whitelist)',
     'ready', rec('T12', 'T12', 'A12', guess='T12-other',
                  some_future_field={'nested': [1, 2]}, another=3)),
    ('site_title with surrounding spaces still strips to equal title -> ready', 'ready',
     rec('T13', '  T13  ', 'A13')),
]

# 已知且刻意的分叉：import_one.py 对「作者含 HTML 实体」一律 review（更保守，避免实体解码
# 与 JS 侧漂移造出第二行，见其 normalize_author docstring）；import_labels.mjs 是完整导入器，
# 对 book15 来源的实体作者会解码后入库。这是**既有**设计差异，不是本次 title/判据统一的目标，
# 故钉住不扩大、不消除。
DIVERGENT = [
    ('KNOWN DIVERGENCE: author with HTML entity -- py review (conservative), mjs ready (decodes book15)',
     'review', 'ready', rec('T13', 'T13', 'A&amp;13', guess='T13-other', source='book15.net')),
]

rows = []
for why, expected, record in ROWS:
    rows.append({'why': why, 'agree': True, 'py': expected, 'mjs': expected, 'record': record})
for why, py, mjs, record in DIVERGENT:
    rows.append({'why': why, 'agree': False, 'py': py, 'mjs': mjs, 'record': record})

bad = 0
for row in rows:
    got = import_one.validate_record(row['record'])['status']
    if got != row['py']:
        print('MISMATCH(py)', row['why'], 'expected', row['py'], 'got', got)
        bad += 1
if bad:
    raise SystemExit(f'python 侧自检失败 {bad} 条')

path = os.path.join(ROOT, 'scripts', 'fixtures', 'import-verdict-parity.json')
with open(path, 'w', encoding='utf-8') as f:
    f.write(json.dumps(rows, ensure_ascii=True, indent=1) + '\n')
print('wrote', len(rows), 'rows ->', path)
