import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { applyAuthorBackfill, parseArgs, planAuthorBackfill, run } from './backfill_authors.mjs';

const tempRoot = mkdtempSync(join(tmpdir(), 'novel-finder-author-backfill-test-'));
let fileIndex = 0;
after(() => {
  const target = realpathSync(tempRoot);
  assert.equal(dirname(target), realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith('novel-finder-author-backfill-test-'));
  rmSync(target, { recursive: true, force: true });
});
const outputPath = () => join(tempRoot, 'plan-' + (++fileIndex) + '.json');
const fixtureUrl = 'postgresql://fixture:fixture@127.0.0.1:1/test';
const envPath = join(tempRoot, 'fixture.env');
writeFileSync(envPath, '# 仅测试凭据\nexport DATABASE_URL = "' + fixtureUrl + '"\n');

function book(id, author = '埃里克&middot;霍弗', extra = {}) {
  return {
    id, title: '测试书' + id, author, source_site: 'book15.net',
    source_url: 'https://book15.net/books/details' + id + '.html',
    labels: { author, note: '原始标签 &middot;' },
    labeled_at: '2026-09-16T00:00:00.000Z', category: '文学', chars_labeled: 1234,
    ...extra,
  };
}

// 有事务状态的数据库替身：提交才保留修改，回滚恢复整个事务前的行。
// 接受的 SQL 形状是封闭的，任何 DDL、删除、UPSERT 或其他表写入均导致失败。
function mockClient(initialRows, options = {}) {
  let data = structuredClone(initialRows);
  let saved = null;
  let readOnly = false;
  let updates = 0;
  const lower = options.lower ?? ((value) => value.toLowerCase());
  const client = {
    calls: [], connected: 0, ended: 0,
    get data() { return data; },
    async connect() {
      client.connected += 1;
      if (options.connectError) throw options.connectError;
    },
    async end() { client.ended += 1; },
    async query(query, values = []) {
      const text = query.replace(/\s+/g, ' ').trim();
      client.calls.push({ text, values: structuredClone(values) });
      await options.beforeQuery?.(text, values, client);
      if (text.startsWith('BEGIN ')) {
        assert.equal(saved, null, '不能嵌套事务');
        saved = structuredClone(data);
        readOnly = text.endsWith('READ ONLY');
        return { rows: [], rowCount: 0 };
      }
      if (text === 'COMMIT') {
        assert.notEqual(saved, null);
        if (options.failApplyCommit && !readOnly) throw new Error('fixture commit failure');
        saved = null;
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        assert.notEqual(saved, null);
        data = saved;
        saved = null;
        return { rows: [], rowCount: 0 };
      }
      if (text === 'LOCK TABLE labeled_books IN SHARE ROW EXCLUSIVE MODE') {
        assert.notEqual(saved, null);
        assert.equal(readOnly, false);
        return { rows: [], rowCount: 0 };
      }
      if (text === 'SELECT id, title, author, source_site, source_url FROM labeled_books ORDER BY id') {
        const rows = structuredClone(data).sort((a, b) => a.id - b.id);
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM jsonb_to_recordset($1::jsonb)')) {
        assert.match(text, /lower\(r\.title\) AS title_key/);
        assert.match(text, /lower\(r\.author\) AS author_key/);
        assert.match(text, /dense_rank\(\) OVER \(ORDER BY lower\(r\.title\), lower\(r\.author\)\) AS identity_key/);
        assert.equal(values.length, 1);
        const identities = new Map();
        const collationKey = options.collationKey ?? ((value) => value);
        const rows = JSON.parse(values[0]).map((row) => {
          const title_key = lower(row.title);
          const author_key = lower(row.author);
          const identity = JSON.stringify([collationKey(title_key), collationKey(author_key)]);
          if (!identities.has(identity)) identities.set(identity, String(identities.size + 1));
          return { id: row.id, title_key, author_key, identity_key: identities.get(identity) };
        });
        return { rows: options.keyRows ? options.keyRows(rows) : rows, rowCount: rows.length };
      }
      if (text.startsWith('UPDATE ')) {
        assert.equal(text, 'UPDATE labeled_books SET author = $1 WHERE id = $2 AND author = $3 AND title = $4 RETURNING id, title, author');
        assert.notEqual(saved, null);
        assert.equal(readOnly, false, 'dry-run 事务严禁写入');
        assert.equal(values.length, 4);
        updates += 1;
        if (options.failAtUpdate === updates) throw new Error('fixture unique constraint failure');
        if (options.missAtUpdate === updates) return { rows: [], rowCount: 0 };
        const [newAuthor, id, oldAuthor, title] = values;
        const row = data.find((item) => item.id === id && item.author === oldAuthor && item.title === title);
        if (!row) return { rows: [], rowCount: 0 };
        if (data.some((item) => item.id !== id && lower(item.title) === lower(title) && lower(item.author) === lower(newAuthor))) {
          throw new Error('fixture unique constraint failure');
        }
        row.author = newAuthor;
        const result = { rows: [{ id: row.id, title: row.title, author: row.author }], rowCount: 1 };
        options.afterUpdate?.(row, data);
        return result;
      }
      assert.fail('未预期的 SQL: ' + text);
    },
  };
  return client;
}

const updatesOf = (client) => client.calls.filter((call) => call.text.startsWith('UPDATE '));
const snapshotFields = (row) => Object.fromEntries(
  ['id', 'title', 'author', 'source_site', 'source_url'].map((key) => [key, row[key]]),
);

describe('全表回填清单和数据库唯一键', () => {
  it('扫描全表全部 ID，清单保留旧/新作者和来源证据，不修改原数据', async () => {
    const input = Array.from({ length: 205 }, (_, i) => book(i + 1, '普通作者' + i));
    input.push(book(259), book(999, '乔治&#183;奥威尔', { title: '1984' }));
    const before = structuredClone(input);
    const client = mockClient(input);
    const plan = await planAuthorBackfill(client);
    assert.equal(plan.snapshot.length, 207);
    assert.deepEqual(plan.snapshot.map((row) => row.id), input.map((row) => row.id));
    assert.deepEqual(plan.counts, { total: 207, update: 2, unchanged: 205, review: 0, conflict: 0 });
    const row = plan.rows.find((item) => item.id === 259);
    assert.equal(row.oldAuthor, '埃里克&middot;霍弗');
    assert.equal(row.newAuthor, '埃里克·霍弗');
    assert.equal(row.sourceSite, 'book15.net');
    assert.equal(row.sourceUrl, input[205].source_url);
    assert.deepEqual(client.data, before);
    assert.deepEqual(input, before);
    assert.equal(updatesOf(client).length, 0);
    assert.equal(client.calls[0].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.calls.at(-1).text, 'COMMIT');
  });

  it('命名/十进制/十六进制共享规范化行为，书名和标签不参与解码', async () => {
    const input = ['&middot;', '&#183;', '&#xB7;'].map((entity, i) =>
      book(i + 1, '作者' + entity, { title: '书名&middot;' + i }));
    const client = mockClient(input);
    const plan = await planAuthorBackfill(client);
    assert.equal(plan.counts.update, 3);
    assert.deepEqual(plan.rows.map((row) => row.newAuthor), ['作者·', '作者·', '作者·']);
    assert.deepEqual(plan.rows.map((row) => row.title), input.map((row) => row.title));
    assert.deepEqual(client.data, input);
  });

  it('未知来源、未知/多层/非法实体和超长作者单列待核验', async () => {
    const input = [
      book(1, '&middot;', { source_site: 'fixture.invalid' }),
      book(2, '&unknown;'), book(3, '&amp;middot;'), book(4, '&#0;'),
      book(5, '&middot'), book(6, '字'.repeat(201)), book(7, '正常作者😀'),
    ];
    const plan = await planAuthorBackfill(mockClient(input));
    assert.deepEqual(plan.counts, { total: 7, update: 0, unchanged: 1, review: 6, conflict: 0 });
    for (const row of plan.rows.filter((item) => item.status === 'review')) {
      assert.equal(row.newAuthor, row.oldAuthor);
      assert.ok(row.reason);
    }
  });

  it('两个待改行在规范化后的唯一键互撞时均保留原行', async () => {
    const input = [
      book(1, '作者&middot;', { title: 'Same Book' }),
      book(2, '作者&#183;', { title: 'same BOOK' }),
    ];
    const client = mockClient(input);
    const plan = await planAuthorBackfill(client);
    assert.equal(plan.counts.update, 0);
    assert.equal(plan.counts.conflict, 2);
    assert.deepEqual(plan.conflicts, [{ titleKey: 'same book', authorKey: '作者·', ids: [1, 2] }]);
    assert.equal((await applyAuthorBackfill(client, plan)).applied, 0);
    assert.deepEqual(client.data, input);
    assert.equal(updatesOf(client).length, 0);
  });

  it('待改行撞上已有正常作者行时保留两行及各自 ID', async () => {
    const input = [book(1, '作者&#xB7;', { title: '书' }), book(2, '作者·', { title: '书' })];
    const plan = await planAuthorBackfill(mockClient(input));
    assert.equal(plan.counts.update, 0);
    assert.equal(plan.counts.conflict, 2);
    assert.deepEqual(plan.conflicts[0].ids, [1, 2]);
    assert.deepEqual(plan.rows.map((row) => row.oldAuthor), ['作者&#xB7;', '作者·']);
  });

  it('使用数据库返回的 lower 结果，即使它与 JS 的 Unicode 小写不同', async () => {
    const input = [book(1, 'İ&middot;', { title: 'BOOK' }), book(2, 'i·', { title: 'book' })];
    assert.notEqual('İ·'.toLowerCase(), 'i·');
    const client = mockClient(input, { lower: (value) => value.replaceAll('İ', 'i').toLowerCase() });
    const plan = await planAuthorBackfill(client);
    assert.equal(plan.counts.conflict, 2);
    assert.equal(plan.conflicts[0].authorKey, 'i·');
    const keyQuery = client.calls.find((call) => call.text.includes('jsonb_to_recordset'));
    assert.equal(JSON.parse(keyQuery.values[0])[0].author, 'İ·');
  });

  it('以数据库的同组标记检查碰撞，不在 JS 中假设字符串等值规则', async () => {
    const input = [
      book(1, 'résumé&middot;', { title: '书' }), book(2, 'resume·', { title: '书' }),
    ];
    const client = mockClient(input, {
      collationKey: (value) => value.normalize('NFD').replace(/\p{M}/gu, ''),
    });
    const plan = await planAuthorBackfill(client);
    assert.equal(plan.counts.conflict, 2);
    assert.deepEqual(plan.conflicts[0].ids, [1, 2]);
    assert.equal(plan.counts.update, 0);
  });

  it('不同书名不误合并，也不把书名中的书名号或空格规范化', async () => {
    const plan = await planAuthorBackfill(mockClient([
      book(1, '作者&middot;', { title: '书' }), book(2, '作者·', { title: '《书》' }),
      book(3, '作者·', { title: ' 书' }),
    ]));
    assert.equal(plan.counts.update, 1);
    assert.equal(plan.conflicts.length, 0);
  });

  it('空表可生成零变更清单，不计算空的身份键集合', async () => {
    const client = mockClient([]);
    const plan = await planAuthorBackfill(client);
    assert.deepEqual(plan.counts, { total: 0, update: 0, unchanged: 0, review: 0, conflict: 0 });
    assert.equal(client.calls.length, 3);
  });

  for (const [name, input] of [
    ['重复 ID', [book(1), book(1)]], ['非法 ID', [book(0)]],
    ['作者类型', [book(1, null)]], ['来源类型', [book(1, '作者', { source_site: null })]],
  ]) {
    it('快照结构异常时回滚只读事务：' + name, async () => {
      const client = mockClient(input);
      await assert.rejects(planAuthorBackfill(client), /快照含无效字段或重复 ID/);
      assert.equal(client.calls.at(-1).text, 'ROLLBACK');
      assert.equal(updatesOf(client).length, 0);
    });
  }

  for (const [name, keyRows] of [
    ['少行', (rows) => rows.slice(1)],
    ['重复', (rows) => [rows[0], rows[0]]],
    ['未知 ID', (rows) => [{ ...rows[0], id: 9999 }, rows[1]]],
    ['类型异常', (rows) => [{ ...rows[0], author_key: null }, rows[1]]],
    ['分组标记缺失', (rows) => [{ ...rows[0], identity_key: null }, rows[1]]],
  ]) {
    it('数据库身份键结果异常时不生成可执行计划：' + name, async () => {
      const client = mockClient([book(1), book(2)], { keyRows });
      await assert.rejects(planAuthorBackfill(client), /数据库身份键/);
      assert.equal(client.calls.at(-1).text, 'ROLLBACK');
    });
  }
});

describe('带旧值条件的原子回填', () => {
  it('只更新作者，保留总数、ID、书名、来源、标签与 labeled_at', async () => {
    const input = [book(259), book(260, '普通作者😀'), book(261, '乔治&#183;奥威尔')];
    const client = mockClient(input);
    const plan = await planAuthorBackfill(client);
    const result = await applyAuthorBackfill(client, plan);
    assert.deepEqual(result, { applied: 2, ids: [259, 261], total: 3 });
    assert.deepEqual(client.data, input.map((row) => ({
      ...row, author: row.id === 259 ? '埃里克·霍弗' : row.id === 261 ? '乔治·奥威尔' : row.author,
    })));
    assert.deepEqual(updatesOf(client)[0].values, ['埃里克·霍弗', 259, '埃里克&middot;霍弗', '测试书259']);
    const begin = client.calls.findIndex((call) => call.text === 'BEGIN ISOLATION LEVEL SERIALIZABLE');
    assert.equal(client.calls[begin + 1].text, 'LOCK TABLE labeled_books IN SHARE ROW EXCLUSIVE MODE');
    assert.equal(client.calls.at(-1).text, 'COMMIT');
  });

  it('冲突行保留原值，其他独立且无冲突的映射可更新', async () => {
    const input = [
      book(1, '作者&middot;', { title: '书' }), book(2, '作者·', { title: '书' }), book(3),
      book(4, '&unknown;'),
    ];
    const client = mockClient(input);
    const plan = await planAuthorBackfill(client);
    assert.deepEqual(plan.counts, { total: 4, update: 1, unchanged: 0, review: 1, conflict: 2 });
    assert.equal((await applyAuthorBackfill(client, plan)).applied, 1);
    assert.deepEqual(client.data, input.map((row) => row.id === 3 ? { ...row, author: '埃里克·霍弗' } : row));
  });

  for (const field of ['author', 'title', 'source_site', 'source_url']) {
    it('快照后旧值变化则停止并回滚：' + field, async () => {
      const client = mockClient([book(1), book(2)]);
      const plan = await planAuthorBackfill(client);
      client.data[0][field] = '其他写入的新值';
      const changed = structuredClone(client.data);
      await assert.rejects(applyAuthorBackfill(client, plan), /更新前快照旧值或更新结果不一致/);
      assert.equal(updatesOf(client).length, 0);
      assert.equal(client.calls.at(-1).text, 'ROLLBACK');
      assert.deepEqual(client.data, changed);
    });
  }

  for (const [name, mutate] of [
    ['新增行', (rows) => rows.push(book(3))],
    ['删除行', (rows) => rows.pop()],
    ['总数相同但 ID 改变', (rows) => { rows[0].id = 100; }],
  ]) {
    it('全表快照集合变化时拒绝使用旧清单：' + name, async () => {
      const client = mockClient([book(1), book(2)]);
      const plan = await planAuthorBackfill(client);
      mutate(client.data);
      const changed = structuredClone(client.data);
      await assert.rejects(applyAuthorBackfill(client, plan), /全表总数或 ID 集合发生变化/);
      assert.deepEqual(client.data, changed);
      assert.equal(client.calls.at(-1).text, 'ROLLBACK');
    });
  }

  for (const [name, options, message] of [
    ['条件 UPDATE 零行', { missAtUpdate: 2 }, /条件 UPDATE 未精确更新一行/],
    ['唯一键错误', { failAtUpdate: 2 }, /unique constraint failure/],
    ['提交失败', { failApplyCommit: true }, /commit failure/],
    ['更新后 ID 集合异常', { afterUpdate: (row) => { row.id += 1000; } }, /全表总数或 ID 集合发生变化/],
  ]) {
    it('整批回滚已执行的前序更新：' + name, async () => {
      const input = [book(1), book(2)];
      const client = mockClient(input, options);
      const plan = await planAuthorBackfill(client);
      await assert.rejects(applyAuthorBackfill(client, plan), message);
      assert.ok(updatesOf(client).length >= 1);
      assert.equal(client.calls.at(-1).text, 'ROLLBACK');
      assert.deepEqual(client.data, input);
    });
  }

  it('更新后再次 dry-run 为零变更，重复 apply 不创建写事务', async () => {
    const client = mockClient([book(1), book(2, '正常😀')]);
    await applyAuthorBackfill(client, await planAuthorBackfill(client));
    const after = structuredClone(client.data);
    const plan = await planAuthorBackfill(client);
    assert.equal(plan.counts.update, 0);
    assert.equal(plan.counts.unchanged, 2);
    const calls = client.calls.length;
    assert.deepEqual(await applyAuthorBackfill(client, plan), { applied: 0, ids: [], total: 2 });
    assert.equal(client.calls.length, calls);
    assert.deepEqual(client.data, after);
  });

  it('拒绝被改写的新作者映射', async () => {
    const client = mockClient([book(1)]);
    const plan = await planAuthorBackfill(client);
    plan.rows[0].newAuthor = '未经核实的作者';
    await assert.rejects(applyAuthorBackfill(client, plan), /更新计划与规范化快照不一致/);
    assert.equal(updatesOf(client).length, 0);
  });
});

describe('CLI 默认只读、清单留存与连接生命周期', () => {
  it('默认 dry-run；仅 --apply 启用写入，互斥参数和缺路径拒绝执行', () => {
    assert.deepEqual(parseArgs(['--env', 'test.env']), { env: 'test.env', out: null, dryRun: true, help: false });
    assert.equal(parseArgs(['--env', 'test.env', '--dry-run']).dryRun, true);
    assert.equal(parseArgs(['--env', 'test.env', '--apply']).dryRun, false);
    for (const args of [
      [], ['--apply'], ['--env'], ['--env', '--apply'], ['--out'], ['--unknown'],
      ['--env', 'test.env', '--apply', '--dry-run'], ['--env', 'test.env', '--dry-run', '--apply'],
      ['--env', 'a', '--env', 'b'], ['--env', 'a', '--out', 'b', '--out', 'c'],
    ]) assert.throws(() => parseArgs(args));
  });

  it('dry-run 用指定 env 的连接串只读快照和 SQL 键，保存完整核验清单', async () => {
    const input = [book(259), book(260, '&unknown;')];
    const client = mockClient(input);
    const out = outputPath();
    const logs = [];
    assert.equal(await run(['--env', envPath, '--out', out], {
      createClient: (url) => { assert.equal(url, fixtureUrl); return client; },
      log: (line) => logs.push(line),
    }), 0);
    const text = readFileSync(out, 'utf8');
    const report = JSON.parse(text);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.counts.update, 1);
    assert.equal(report.counts.review, 1);
    assert.deepEqual(report.snapshot, input.map(snapshotFields));
    assert.equal(report.rows[0].newAuthor, '埃里克·霍弗');
    assert.equal(text.includes(fixtureUrl), false);
    assert.equal(logs.at(-1), '[dry-run] 未执行 UPDATE');
    assert.equal(client.connected, 1);
    assert.equal(client.ended, 1);
    assert.equal(updatesOf(client).length, 0);
    assert.deepEqual(client.data, input);
  });

  it('--apply 的第一条 UPDATE 之前已保存旧/新映射，结束时关闭连接', async () => {
    const out = outputPath();
    const client = mockClient([book(259)], {
      beforeQuery: (text) => {
        if (!text.startsWith('UPDATE ')) return;
        const report = JSON.parse(readFileSync(out, 'utf8'));
        assert.equal(report.mode, 'apply-plan');
        assert.equal(report.rows[0].oldAuthor, '埃里克&middot;霍弗');
        assert.equal(report.rows[0].newAuthor, '埃里克·霍弗');
      },
    });
    const logs = [];
    assert.equal(await run(['--env', envPath, '--out', out, '--apply'], {
      createClient: () => client, log: (line) => logs.push(line),
    }), 0);
    assert.equal(client.data[0].author, '埃里克·霍弗');
    assert.match(logs.at(-1), /\[apply\] 已提交 1 行 \/ 总数 1 .*更新 ID: \[259\]/);
    assert.equal(client.ended, 1);
  });

  it('清单路径已存在时不覆盖旧清单，也不执行回填', async () => {
    const out = outputPath();
    writeFileSync(out, '旧清单必须保留');
    const input = [book(1)];
    const client = mockClient(input);
    await assert.rejects(run(['--env', envPath, '--out', out, '--apply'], {
      createClient: () => client, log: () => {},
    }), /EEXIST/);
    assert.equal(readFileSync(out, 'utf8'), '旧清单必须保留');
    assert.deepEqual(client.data, input);
    assert.equal(updatesOf(client).length, 0);
    assert.equal(client.ended, 1);
  });

  it('连接配置缺失或 env 不存在时不创建数据库客户端', async () => {
    const emptyEnv = join(tempRoot, 'empty.env');
    writeFileSync(emptyEnv, '# 无连接串\nUNRELATED=value\n');
    for (const args of [[], ['--env', emptyEnv], ['--env', join(tempRoot, 'missing.env')]]) {
      await assert.rejects(run(args, {
        createClient: () => assert.fail('缺少显式连接配置时不能创建客户端'), log: () => {},
      }));
    }
  });

  for (const [name, options, apply] of [
    ['读快照失败', { beforeQuery: (text) => { if (text.startsWith('SELECT ')) throw new Error('fixture read failure'); } }, false],
    ['更新失败', { failAtUpdate: 1 }, true],
    ['连接失败', { connectError: new Error('fixture connect failure') }, false],
  ]) {
    it('失败路径始终关闭客户端：' + name, async () => {
      const input = [book(1)];
      const client = mockClient(input, options);
      const args = ['--env', envPath, '--out', outputPath()];
      if (apply) args.push('--apply');
      await assert.rejects(run(args, { createClient: () => client, log: () => {} }), /fixture/);
      assert.equal(client.ended, 1);
      assert.deepEqual(client.data, input);
    });
  }

  it('--help 不读取 env 或创建客户端', async () => {
    const logs = [];
    assert.equal(await run(['--help'], {
      createClient: () => assert.fail('help 不能创建客户端'), log: (line) => logs.push(line),
    }), 0);
    assert.match(logs[0], /--dry-run \| --apply/);
  });
});
