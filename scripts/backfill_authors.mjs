#!/usr/bin/env node
// labeled_books 存量作者规范化。执行窗口应暂停导入，先审阅 dry-run 清单。
//   node scripts/backfill_authors.mjs --env <env文件> [--out <清单.json>]
//   node scripts/backfill_authors.mjs --env <env文件> --apply [--out <新清单.json>]
// 默认 dry-run：只读全表及数据库 lower() 键，不执行 UPDATE。
// --apply 也先保存本次清单；冲突/待核验行保留原值，其他变更在一个事务内提交。
// 仅修改 labeled_books.author，不处理 books / download_tasks 或下载文件。
import { Client } from '@neondatabase/serverless';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './import_labels.mjs';
import { normalizeAuthor } from './normalize_author.mjs';

const SNAPSHOT_FIELDS = ['id', 'title', 'author', 'source_site', 'source_url'];
const SNAPSHOT_SQL =
  'SELECT id, title, author, source_site, source_url FROM labeled_books ORDER BY id';
const KEYS_SQL = [
  'SELECT r.id, lower(r.title) AS title_key, lower(r.author) AS author_key,',
  'dense_rank() OVER (ORDER BY lower(r.title), lower(r.author)) AS identity_key',
  'FROM jsonb_to_recordset($1::jsonb)',
  'AS r(id integer, title text, author text)',
  'ORDER BY r.id',
].join('\n');
const UPDATE_SQL = [
  'UPDATE labeled_books SET author = $1',
  'WHERE id = $2 AND author = $3 AND title = $4',
  'RETURNING id, title, author',
].join('\n');

export function parseArgs(argv) {
  const args = { env: null, out: null, dryRun: true, help: false };
  let mode;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') args.help = true;
    else if (arg === '--dry-run' || arg === '--apply') {
      if (mode && mode !== arg) throw new Error('--dry-run 与 --apply 不能同时使用');
      mode = arg;
      args.dryRun = arg === '--dry-run';
    } else if (arg === '--env' || arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(arg + ' 缺少路径');
      const key = arg.slice(2);
      if (args[key] !== null) throw new Error(arg + ' 不能重复指定');
      args[key] = value;
    } else {
      throw new Error('未知参数: ' + arg);
    }
  }
  if (!args.help && !args.env) throw new Error('缺少 --env <path>（不使用环境变量中的连接串）');
  return args;
}

function copySnapshot(rows) {
  if (!Array.isArray(rows)) throw new Error('全表快照不是数组');
  const ids = new Set();
  const snapshot = rows.map((row) => {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id) ||
        SNAPSHOT_FIELDS.slice(1).some((field) => typeof row[field] !== 'string')) {
      throw new Error('全表快照含无效字段或重复 ID');
    }
    ids.add(row.id);
    return Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, row[field]]));
  });
  return snapshot.sort((a, b) => a.id - b.id);
}

export async function readAuthorSnapshot(client) {
  const result = await client.query(SNAPSHOT_SQL);
  return copySnapshot(result.rows);
}

async function transaction(client, begin, action) {
  await client.query(begin);
  try {
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '操作失败且回滚未获确认，请核验数据库状态');
    }
    throw error;
  }
}

function proposeAuthors(snapshot) {
  return snapshot.map((row) => {
    const normalized = normalizeAuthor(row.author, { sourceSite: row.source_site });
    return {
      id: row.id, title: row.title, oldAuthor: row.author,
      newAuthor: normalized.status === 'ready' ? normalized.value : row.author,
      sourceSite: row.source_site, sourceUrl: row.source_url,
      status: normalized.status === 'ready' ? (normalized.changed ? 'update' : 'unchanged') : 'review',
      ...(normalized.status !== 'ready' ? {
        reasonCode: normalized.reasonCode, reason: normalized.reason,
        normalizationStatus: normalized.status,
      } : {}),
    };
  });
}

async function finishPlan(client, snapshot, proposals) {
  // lower() 与身份分组均在 PostgreSQL 中计算，包含数据库排序规则的等值语义。
  const ids = new Set(snapshot.map((row) => row.id));
  const blocked = new Set();
  const conflictIds = new Set();
  const conflicts = [];
  const seenGroups = new Set();
  let changed;
  do {
    changed = false;
    const keyInput = proposals.map((row) => ({
      id: row.id, title: row.title,
      author: row.status === 'update' && !blocked.has(row.id) ? row.newAuthor : row.oldAuthor,
    }));
    const keyRows = keyInput.length === 0 ? [] : (await client.query(KEYS_SQL, [JSON.stringify(keyInput)])).rows;
    const keys = new Map();
    if (!Array.isArray(keyRows) || keyRows.length !== snapshot.length) {
      throw new Error('数据库身份键数量与全表快照不一致');
    }
    for (const row of keyRows) {
      if (!row || !ids.has(row.id) || keys.has(row.id) ||
          typeof row.title_key !== 'string' || typeof row.author_key !== 'string' ||
          !/^[1-9]\d*$/.test(String(row.identity_key))) {
        throw new Error('数据库身份键缺失、重复或无效');
      }
      keys.set(row.id, row);
    }
    const groups = new Map();
    for (const row of proposals) {
      const identity = String(keys.get(row.id).identity_key);
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push(row);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const groupIds = group.map((row) => row.id);
      const { title_key: titleKey, author_key: authorKey } = keys.get(groupIds[0]);
      const signature = JSON.stringify([titleKey, authorKey, groupIds]);
      if (!seenGroups.has(signature)) {
        seenGroups.add(signature);
        conflicts.push({ titleKey, authorKey, ids: groupIds });
      }
      for (const row of group) {
        conflictIds.add(row.id);
        if (row.status === 'update' && !blocked.has(row.id)) {
          blocked.add(row.id);
          changed = true;
        }
      }
    }
    // 被拦截的行恢复旧身份，再检查其旧键是否与其他拟更新行碰撞。
  } while (changed);

  const rows = proposals.map((row) => conflictIds.has(row.id) ? {
    ...row, status: 'conflict', reasonCode: 'identity-conflict',
    reason: (row.reason ? row.reason + '；' : '') + '最终书名/作者唯一键碰撞，保留所有原行及 ID 待核验',
  } : row);
  const counts = { total: rows.length, update: 0, unchanged: 0, review: 0, conflict: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { schemaVersion: 1, snapshot, rows, conflicts, counts };
}

export async function planAuthorBackfill(client) {
  return transaction(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async () => {
    const snapshot = await readAuthorSnapshot(client);
    return finishPlan(client, snapshot, proposeAuthors(snapshot));
  });
}

function assertSnapshot(actual, expected, stage) {
  if (actual.length !== expected.length || actual.some((row, i) => row.id !== expected[i].id)) {
    throw new Error(stage + '全表总数或 ID 集合发生变化，请重新生成清单');
  }
  for (let i = 0; i < actual.length; i += 1) {
    if (SNAPSHOT_FIELDS.some((field) => actual[i][field] !== expected[i][field])) {
      throw new Error(stage + '快照旧值或更新结果不一致，id=' + actual[i].id + '，请重新生成清单');
    }
  }
}

export async function applyAuthorBackfill(client, plan) {
  const snapshot = copySnapshot(plan.snapshot);
  const byId = new Map(snapshot.map((row) => [row.id, row]));
  const updates = plan.rows.filter((row) => row.status === 'update');
  const replacements = new Map();
  for (const row of updates) {
    const original = byId.get(row.id);
    const normalized = original && normalizeAuthor(original.author, { sourceSite: original.source_site });
    if (!original || replacements.has(row.id) || original.title !== row.title || original.author !== row.oldAuthor ||
        normalized.status !== 'ready' || !normalized.changed || normalized.value !== row.newAuthor) {
      throw new Error('更新计划与规范化快照不一致，请重新生成清单');
    }
    replacements.set(row.id, row.newAuthor);
  }
  if (updates.length === 0) return { applied: 0, ids: [], total: snapshot.length };

  return transaction(client, 'BEGIN ISOLATION LEVEL SERIALIZABLE', async () => {
    // 只在 --apply 阶段锁表；阻止复核与提交之间的插入/删除/更新，读者不受影响。
    await client.query('LOCK TABLE labeled_books IN SHARE ROW EXCLUSIVE MODE');
    assertSnapshot(await readAuthorSnapshot(client), snapshot, '更新前');
    const ids = [];
    for (const row of updates) {
      const result = await client.query(UPDATE_SQL, [row.newAuthor, row.id, row.oldAuthor, row.title]);
      if (result.rowCount !== 1 || result.rows.length !== 1 ||
          result.rows[0].id !== row.id || result.rows[0].title !== row.title || result.rows[0].author !== row.newAuthor) {
        throw new Error('条件 UPDATE 未精确更新一行，id=' + row.id + '，整批回滚并重新生成清单');
      }
      ids.push(row.id);
    }
    const expected = snapshot.map((row) => ({
      ...row, author: replacements.has(row.id) ? replacements.get(row.id) : row.author,
    }));
    assertSnapshot(await readAuthorSnapshot(client), expected, '更新后');
    return { applied: ids.length, ids, total: expected.length };
  });
}

export async function run(argv = process.argv.slice(2), {
  createClient = (connectionString) => new Client({ connectionString }),
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log('用法: node scripts/backfill_authors.mjs --env <path> [--dry-run | --apply] [--out <清单.json>]');
    log('默认只读 dry-run；--apply 前保存清单，事务内仅更新无冲突的 labeled_books.author。');
    return 0;
  }
  const databaseUrl = loadEnvFile(resolve(args.env)).DATABASE_URL;
  if (!databaseUrl) throw new Error('指定 env 文件中缺少 DATABASE_URL');
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    const plan = await planAuthorBackfill(client);
    const generatedAt = new Date().toISOString();
    const output = resolve(args.out ?? ('authors-backfill-' + generatedAt.replace(/[:.]/g, '-') + '.json'));
    // 清单写入失败时必须停止，不能先改库再丢失旧/新映射；禁止覆盖既有清单。
    writeFileSync(output, JSON.stringify({
      ...plan, generatedAt, mode: args.dryRun ? 'dry-run' : 'apply-plan',
      keySemantics: 'PostgreSQL lower(title), lower(author); dense_rank() 使用数据库排序规则',
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    log('旧/新作者清单: ' + output);
    const counts = plan.counts;
    log('[计划] 总数 ' + counts.total + ' / 可更新 ' + counts.update +
      ' / 不变 ' + counts.unchanged + ' / 待核验 ' + counts.review +
      ' / 冲突行 ' + counts.conflict + ' / 冲突组 ' + plan.conflicts.length);
    if (args.dryRun) {
      log('[dry-run] 未执行 UPDATE');
    } else {
      const result = await applyAuthorBackfill(client, plan);
      log('[apply] 已提交 ' + result.applied + ' 行 / 总数 ' + result.total +
        ' / ID 集合保持不变 / 更新 ID: ' + JSON.stringify(result.ids));
    }
    return 0;
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  run().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
