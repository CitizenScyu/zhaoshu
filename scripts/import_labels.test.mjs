import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanJson, parseArgs, parseQuality, run, titleMatches, validateImportRecord, writeImportRecord,
} from './import_labels.mjs';
import { parseQualityResponse } from './backfill_quality.mjs';

const tempRoot = mkdtempSync(join(tmpdir(), 'novel-finder-import-test-'));
let fileIndex = 0;
after(() => {
  // 只清理本测试创建的临时目录，先检查 Windows 绝对路径和父目录。
  const target = realpathSync(tempRoot);
  assert.equal(dirname(target), realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith('novel-finder-import-test-'));
  rmSync(target, { recursive: true, force: true });
});

const base = {
  title: '测试书', author: '作者', category: '武侠修真', status: '完结',
  source: 'fixture.invalid', url: 'https://fixture.invalid/book/1', chars: 400000,
  labels: {
    title_guess: '测试书', text_quality: '正常', genre: '仙侠、成长',
    quality: { overall: 8.5, prose: 8, worldbuilding: 9, pacing: 8, enjoyment: 8 },
  },
};
function record(overrides = {}) { return { ...structuredClone(base), ...overrides }; }
function fixture(lines) {
  const file = join(tempRoot, 'labels-' + (++fileIndex) + '.jsonl');
  writeFileSync(file, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'));
  return file;
}
function validated(value) {
  const result = validateImportRecord(value);
  assert.equal(result.status, 'ready', result.reason);
  return result.record;
}

const invalidScores = [
  ['null', null], ['undefined', undefined], ['empty', ''], ['whitespace', ' \t '],
  ['false', false], ['true', true], ['array', []], ['numeric array', [0]], ['object', {}],
  ['NaN', NaN], ['Infinity', Infinity], ['non-finite string', 'Infinity'],
  ['hex', '0x08'], ['exponent string', '1e0'], ['words', '八分'], ['negative', -0.1], ['over ten', 10.1],
];
describe('explicit quality values shared by import and backfill', () => {
  for (const [name, value] of invalidScores) {
    it('rejects ' + name + ' without coercing it to zero', () => {
      assert.equal(parseQuality(value), null);
      assert.throws(() => parseQualityResponse({ overall: value }), /overall.*有效数值/);
      const input = record({ labels: { ...base.labels, quality: { overall: value } } });
      const out = validated(input);
      assert.equal(out.quality, null);
      // 存储的是 JSON 材料；清洗器会复制数组并使用无原型对象。
      assert.equal(JSON.stringify(out.labels.quality), JSON.stringify({ overall: value }));
      assert.equal(input.labels.quality.overall, value);
    });
  }

  for (const value of [0, '0', ' 0 ', 0.0, '0.0', 8.5, ' 8.5 ', 10, '10']) {
    it('keeps valid quality ' + JSON.stringify(value), () => {
      assert.equal(parseQuality(value), Number(value));
      assert.equal(parseQualityResponse({ overall: value }), Number(value));
      assert.equal(validated(record({ labels: { ...base.labels, quality: { overall: value } } })).quality, Number(value));
    });
  }

  it('validates the backfill JSON root instead of reading an assumed object', () => {
    for (const value of [null, [], false, '8', 8, {}]) {
      assert.throws(() => parseQualityResponse(value), /overall.*有效数值/);
    }
  });

  it('reads nested labels.quality only, retaining other original quality dimensions', () => {
    const input = record({ quality: { overall: 0 }, labels: { ...base.labels } });
    const out = validated(input);
    assert.equal(out.quality, 8.5);
    assert.deepEqual(JSON.parse(JSON.stringify(out.labels)), input.labels);
    assert.equal(validated(record({ quality: 10, labels: { title_guess: '测试书' } })).quality, null);
  });
});

describe('old and new label records', () => {
  it('accepts legacy labels without text_quality and never mutates the original material', () => {
    const input = record({ labels: { title_guess: '《 测试书 》', genre: '仙侠' } });
    const original = JSON.stringify(input);
    const out = validated(input);
    assert.equal(out.title, '测试书');
    assert.equal(out.labels.title_guess, '《 测试书 》');
    assert.equal(out.primaryGenre, '仙侠');
    assert.equal(out.quality, null);
    assert.equal(JSON.stringify(input), original);
  });

  it('uses a confirmed site title while retaining the independent blind guess and note', () => {
    const input = record({
      site_title: '测试书',
      labels: { ...base.labels, title_guess: '盲猜的另一书名', site_title_match: true, site_title_note: '正文与站点书名相符' },
    });
    const original = JSON.stringify(input);
    const out = validated(input);
    assert.equal(out.title, '测试书');
    assert.deepEqual(JSON.parse(JSON.stringify(out.labels)), input.labels);
    assert.equal(JSON.stringify(input), original);
  });

  it('accepts an explicit site_title without substituting a missing title_guess', () => {
    const input = record({ title: undefined, site_title: '站点书名', labels: { site_title_match: true } });
    const out = validated(input);
    assert.equal(out.title, '站点书名');
    assert.equal(Object.hasOwn(out.labels, 'title_guess'), false);
  });

  it('normalizes equivalent book-name forms only for comparison', () => {
    assert.equal(titleMatches(' 《ＡＢＣ》 ', 'abc'), true);
    assert.equal(titleMatches('测试书', '测试书续篇'), false);
    assert.equal(titleMatches('测试书续篇', '测试书'), false);
    assert.equal(titleMatches('', ''), false);
    assert.equal(titleMatches(1, '1'), false);
    assert.equal(validated(record({ title: 'ＡＢＣ', labels: { title_guess: 'abc' } })).title, 'ＡＢＣ');
  });

  it('keeps mismatched, missing, or prefix-only legacy guesses pending review', () => {
    for (const guess of ['另一书', '', undefined, '测试书续篇', '测试']) {
      assert.equal(validateImportRecord(record({ labels: { title_guess: guess } })).status, 'review');
    }
  });

  it('does not resolve conflicting top-level titles automatically', () => {
    assert.equal(validateImportRecord(record({ site_title: '另一书', labels: { ...base.labels, site_title_match: true } })).status, 'review');
  });

  it('requires a strict true confirmation when site_title_match is present', () => {
    for (const flag of [false, null, 'true', 'false', '不确定', 1, 0]) {
      assert.equal(validateImportRecord(record({ labels: { ...base.labels, site_title_match: flag } })).status, 'review');
    }
  });

  it('distinguishes known bad text from an unknown quality flag', () => {
    for (const text_quality of ['疑似乱码', '大面积重复', '含广告注入']) {
      assert.equal(validateImportRecord(record({ labels: { ...base.labels, text_quality } })).status, 'skipped');
    }
    assert.equal(validateImportRecord(record({ labels: { ...base.labels, text_quality: '不确定' } })).status, 'review');
    assert.equal(validateImportRecord(record({ labels: { ...base.labels, text_quality: false } })).status, 'failed');
  });

  it('fails malformed roots and field types without stringifying them into identities', () => {
    for (const value of [
      null, [], false, {}, { title: 'T', labels: [] }, record({ title: {} }), record({ title: '' }),
      record({ author: false }), record({ site_title: 1 }), record({ category: [] }),
      record({ labels: { title_guess: false } }), record({ labels: { site_title_note: [] } }),
      record({ title: '字'.repeat(201) }),
    ]) {
      assert.equal(validateImportRecord(value).status, 'failed');
    }
  });

  it('holds illegal title/author characters for review while preserving valid emoji', () => {
    for (const bad of [String.fromCharCode(0), '\ud800', '\udc00']) {
      assert.equal(validateImportRecord(record({ title: '测试书' + bad })).status, 'review');
      assert.equal(validateImportRecord(record({ author: '作者' + bad })).status, 'review');
    }
    assert.equal(validated(record({ author: '作者😀' })).author, '作者😀');
  });

  it('retains existing database character cleaning without modifying raw labels', () => {
    const original = { title_guess: '测试书', note: 'a' + String.fromCharCode(0) + 'b\ud800😀' };
    const out = validated(record({ labels: original }));
    assert.equal(out.labels.note, 'ab�😀');
    assert.equal(original.note, 'a' + String.fromCharCode(0) + 'b\ud800😀');
    const unusual = JSON.parse('{"__proto__":{"polluted":true},"normal":"kept"}');
    const cleaned = cleanJson(unusual);
    assert.equal(Object.getPrototypeOf(cleaned), null);
    assert.equal(cleaned.__proto__.polluted, true);
    assert.equal({}.polluted, undefined);
  });

  it('bounds the sampled character count to the existing PostgreSQL int column', () => {
    for (const chars of [false, -1, 1.5, 'x', 2147483648, Infinity]) {
      assert.equal(validateImportRecord(record({ chars })).status, 'failed');
    }
    for (const chars of [undefined, null, '', 0, '0']) {
      assert.equal(validated(record({ chars })).charsLabeled, 0);
    }
    assert.equal(validated(record({ chars: '400000' })).charsLabeled, 400000);
  });
});

describe('incremental source and score preservation', () => {
  it('treats missing or unusable URLs as absent and never invents a source', () => {
    for (const url of [undefined, null, '', '  ', false, {}, '/book/1', 'javascript:alert(1)', 'https://u:p@fixture.invalid/']) {
      const out = validated(record({ url, source: undefined }));
      assert.equal(out.sourceUrl, null);
      assert.equal(out.sourceSite, '');
    }
    assert.equal(validated(record({ url: '  https://fixture.invalid/book/2  ' })).sourceUrl, 'https://fixture.invalid/book/2');
  });

  it('binds missing URL/score as absent and protects old columns in the UPSERT', async () => {
    const out = validated(record({ url: undefined, labels: { ...base.labels, quality: { overall: null } } }));
    let query;
    await writeImportRecord(async (strings, ...values) => { query = { text: strings.join('?'), values }; }, out);
    assert.equal(query.values[5], '');
    assert.equal(query.values[10], null);
    assert.match(query.text, /source_url\s*=\s*COALESCE\(NULLIF\(EXCLUDED\.source_url,\s*''\),\s*labeled_books\.source_url\)/);
    assert.match(query.text, /quality\s*=\s*COALESCE\(EXCLUDED\.quality,\s*labeled_books\.quality\)/);
    assert.doesNotMatch(query.text, /\b(?:CREATE|ALTER|DELETE|DROP)\b/);
    assert.equal(query.values[7], JSON.stringify(out.labels));
  });

  it('binds a genuine zero and a supplied URL as updates, leaving raw scores intact', async () => {
    const input = record({ url: 'https://fixture.invalid/new', labels: { ...base.labels, quality: { overall: '0', prose: 2 } } });
    let values;
    await writeImportRecord(async (_strings, ...args) => { values = args; }, validated(input));
    assert.equal(values[5], 'https://fixture.invalid/new');
    assert.equal(values[10], 0);
    assert.deepEqual(JSON.parse(values[7]).quality, { overall: '0', prose: 2 });
  });
});

describe('作者在身份键和 SQL 绑定前规范化', () => {
  const book15 = { source: 'book15.net', url: 'https://book15.net/books/details6728.html' };

  for (const entity of ['&middot;', '&#183;', '&#xB7;']) {
    it('SQL 作者绑定解码后的 ' + entity + '，原始记录和 labels 不变', async () => {
      const input = record({
        ...book15, author: ' 埃里克' + entity + '霍弗 ',
        labels: { ...base.labels, author: '埃里克' + entity + '霍弗', note: '&middot;' },
      });
      const original = structuredClone(input);
      Object.freeze(input.labels);
      Object.freeze(input);
      const out = validated(input);
      let query;
      await writeImportRecord(async (strings, ...values) => {
        query = { text: strings.join('?'), values };
      }, out);
      assert.equal(out.author, '埃里克·霍弗');
      assert.equal(query.values[1], '埃里克·霍弗');
      assert.match(query.text, /ON CONFLICT \(lower\(title\), lower\(author\)\)/);
      assert.deepEqual(JSON.parse(query.values[7]), original.labels);
      assert.deepEqual(input, original);
    });
  }

  it('实体的不同写法与普通文本进入同一个唯一身份键，重复导入不新增 mock 行', async () => {
    const rows = new Map();
    const sql = async (strings, ...values) => {
      assert.match(strings.join('?'), /ON CONFLICT \(lower\(title\), lower\(author\)\)/);
      const key = JSON.stringify([values[0].toLowerCase(), values[1].toLowerCase()]);
      rows.set(key, values);
    };
    for (let pass = 0; pass < 2; pass += 1) {
      for (const author of ['埃里克&middot;霍弗', '埃里克&#183;霍弗', '埃里克&#xB7;霍弗', '埃里克·霍弗']) {
        await writeImportRecord(sql, validated(record({ ...book15, author })));
      }
    }
    assert.equal(rows.size, 1);
    assert.equal([...rows.values()][0][1], '埃里克·霍弗');
  });

  it('未知、多层、缺分号、非法实体和未知来源进入核验', () => {
    for (const author of ['&unknown;', '&amp;middot;', '&middot', '&#0;', '&#xD800;', '&Tab;']) {
      const input = record({ ...book15, author });
      assert.equal(validateImportRecord(input).status, 'review');
      assert.equal(input.author, author);
    }
    assert.equal(validateImportRecord(record({ author: '&middot;' })).status, 'review');
  });

  it('作者编码标记显式跳过已解码文本，未知标记不猜测', () => {
    assert.equal(validated(record({ ...book15, author: '&middot;', author_encoding: 'text-v1' })).author, '&middot;');
    assert.equal(validated(record({ ...book15, author: '&middot;', author_encoding: 'html-v1' })).author, '·');
    assert.equal(validateImportRecord(record({ author_encoding: 'v2' })).status, 'review');
    assert.equal(validateImportRecord(record({ author_encoding: 1 })).status, 'failed');
  });

  it('作者长度在解码之后校验，原有书名、身份和质量校验保持生效', () => {
    assert.equal(validated(record({ ...book15, author: '&middot;'.repeat(200) })).author, '·'.repeat(200));
    assert.equal(validated(record({ author: '😀'.repeat(200) })).author, '😀'.repeat(200));
    assert.equal(validateImportRecord(record({ ...book15, author: '&middot;'.repeat(201) })).status, 'failed');
    const author = '埃里克&middot;霍弗';
    assert.equal(validateImportRecord(record({ ...book15, author, title: '字'.repeat(201) })).status, 'failed');
    assert.equal(validateImportRecord(record({ ...book15, author, title: '测试书\0' })).status, 'review');
    assert.equal(validateImportRecord(record({ ...book15, author, labels: { title_guess: '另一书' } })).status, 'review');
    assert.equal(validateImportRecord(record({ ...book15, author, labels: { ...base.labels, text_quality: '含广告注入' } })).status, 'skipped');
  });

  it('dry-run 保留 JSONL、统计待核验作者且不读取 env 或创建 SQL 客户端', async () => {
    const file = fixture([
      record({ ...book15, author: '埃里克&middot;霍弗' }),
      record({ ...book15, author: '&amp;middot;' }),
      record({ ...book15, author: '&unknown;' }),
      record({ author: '&middot;' }),
    ]);
    const original = readFileSync(file, 'utf8');
    const logs = [];
    const code = await run(['--dry-run', '--file', file, '--env', join(tempRoot, 'missing-author.env')], {
      env: {}, log: (line) => logs.push(line),
      createSql: () => assert.fail('dry-run 不能创建数据库客户端'),
    });
    assert.equal(code, 0);
    assert.equal(logs.at(-1), '[dry-run] 总数 4 / 可导入 1 / 跳过 0 / 待核验 3 / 失败 0');
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('真实导入路径只将已核实的规范作者交给 SQL mock', async () => {
    const file = fixture([
      record({ ...book15, author: '埃里克&#xB7;霍弗' }),
      record({ ...book15, author: '&unknown;' }),
      record({ ...book15, author: '&amp;middot;' }),
    ]);
    const calls = [];
    const logs = [];
    const code = await run(['--file', file], {
      env: { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/test' },
      createSql: () => async (_strings, ...values) => { calls.push(values); },
      log: (line) => logs.push(line),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], '埃里克·霍弗');
    assert.equal(logs.at(-1), '总数 3 / 入库 1 / 跳过 0 / 待核验 2 / 失败 0');
  });
});

describe('offline dry-run and existing command entry', () => {
  it('retains env/file and positional arguments while rejecting missing paths', () => {
    assert.deepEqual(parseArgs(['--env', '.env.local', '--file', 'labels.jsonl']), { env: '.env.local', file: 'labels.jsonl', dryRun: false });
    assert.deepEqual(parseArgs(['labels.jsonl', '--dry-run']), { env: null, file: 'labels.jsonl', dryRun: true });
    for (const args of [['--env'], ['--file'], ['--file', '--dry-run'], ['--unknown'], ['a', 'b']]) {
      assert.throws(() => parseArgs(args));
    }
  });

  it('summarizes ready/skipped/review/failed without credentials or creating a client', async () => {
    const file = fixture([
      record(), '',
      record({ url: undefined, labels: { ...base.labels, quality: { overall: false } } }),
      record({ labels: { ...base.labels, site_title_match: false } }),
      record({ labels: { ...base.labels, text_quality: '疑似乱码' } }),
      '{bad json',
    ]);
    const original = readFileSync(file, 'utf8');
    const logs = [];
    const code = await run(['--dry-run', '--file', file, '--env', join(tempRoot, 'does-not-exist.env')], {
      env: {}, log: (line) => logs.push(line),
      createSql: () => assert.fail('dry-run must not create a database client'),
    });
    assert.equal(code, 1);
    assert.equal(logs.at(-1), '[dry-run] 总数 5 / 可导入 2 / 跳过 1 / 待核验 1 / 失败 1');
    assert.ok(logs.some((line) => line.includes(file + ':6 [失败] JSON 解析失败')));
    assert.ok(logs.some((line) => line.includes(file + ':4 [待核验]')));
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('runs the real CLI offline with no DATABASE_URL and no network access', () => {
    const file = fixture([record({ labels: { ...base.labels, quality: { overall: 0 } } }), record({ labels: { title_guess: '测试书' }, url: undefined })]);
    const marker = join(tempRoot, 'network-attempt');
    const preload = join(tempRoot, 'deny-network.mjs');
    writeFileSync(preload, [
      "import { writeFileSync } from 'node:fs';",
      "import { Socket } from 'node:net';",
      'const deny = () => { writeFileSync(' + JSON.stringify(marker) + ', "attempt"); throw new Error("network must not be used"); };',
      'globalThis.fetch = deny;',
      'Socket.prototype.connect = deny;',
    ].join('\n'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/DATABASE_URL|NEON|LLM|GITHUB_TOKEN/.test(key)) delete env[key];
    const child = spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('./import_labels.mjs', import.meta.url)), '--dry-run', '--file', file,
    ], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /\[dry-run\] 总数 2 \/ 可导入 2 \/ 跳过 0 \/ 待核验 0 \/ 失败 0/);
    assert.equal(existsSync(marker), false);
  });

  it('imports only ready records and counts database failures without losing later rows', async () => {
    const file = fixture([
      record(),
      record({ labels: { ...base.labels, site_title_match: false } }),
      record({ labels: { ...base.labels, text_quality: '含广告注入' } }),
      record({ title: '后续书', labels: { title_guess: '后续书' } }),
    ]);
    const logs = [];
    const calls = [];
    let clients = 0;
    const code = await run(['--file', file], {
      env: { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/test' },
      createSql: (url) => {
        clients += 1;
        assert.equal(url, 'postgresql://fixture:fixture@127.0.0.1:1/test');
        return async (_strings, ...values) => {
          calls.push(values);
          if (calls.length === 1) throw new Error('fixture database failure');
        };
      },
      log: (line) => logs.push(line),
    });
    assert.equal(code, 1);
    assert.equal(clients, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], '后续书');
    assert.equal(logs.at(-1), '总数 4 / 入库 1 / 跳过 1 / 待核验 1 / 失败 1');
  });

  it('still requires an explicit database configuration for actual imports', async () => {
    await assert.rejects(run(['--file', fixture([record()])], {
      env: {}, createSql: () => assert.fail('client should not be created'), log: () => {},
    }), /缺少 DATABASE_URL/);
  });

  it('accepts a BOM and reports only nonblank source records', async () => {
    const file = fixture(['\uFEFF' + JSON.stringify(record()), '', '']);
    const logs = [];
    assert.equal(await run(['--dry-run', '--file', resolve(file)], {
      env: {}, log: (line) => logs.push(line), createSql: () => assert.fail('offline'),
    }), 0);
    assert.equal(logs.at(-1), '[dry-run] 总数 1 / 可导入 1 / 跳过 0 / 待核验 0 / 失败 0');
  });
});
