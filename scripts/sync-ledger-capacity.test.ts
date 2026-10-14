// ledgersync41：sync-ledger-capacity 的参数闸门、字节口径（排除 .snapshots/符号链接）、
// 树截断下钻补齐、幂等与「凭据不进输出」。
//
// 夹具与既有容量用例同款：createProductionSchema + initializeArtifactSchema +
// initializeArtifactCapacitySchema 在隔离 PGlite 上建真实表；GitHub 侧是合成受控桩
// （明确只验证本脚本消费受控响应的行为，不证明真实 GitHub 可达或真实容量）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeArtifactSchema } from '../src/lib/business-schema';
import { initializeArtifactCapacitySchema } from '../src/lib/artifact-capacity-schema';
import { createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import { createProductionSchema, seedV6MemberUser } from '../src/lib/fixtures/production-schema';
import {
  DEFAULT_TREE_ROOT, IncompleteTreeError, createGitHubTreeRequest, isCountedPath, parseSyncArgs,
  runSync, sumRegisteredLogicalBytes,
} from './sync-ledger-capacity.mjs';

describe('参数解析：目标与 token 来源都必须显式，缺省 dry-run', () => {
  it.each([
    [[], /--database-url-env/],
    [['--database-url-env=PROD_URL'], /--github-token-env/],
    [['--database-url-env=PROD_URL', '--github-token-env=lower'], /大写变量名/],
    [['--database-url-env=DATABASE_URL', '--github-token-env=GITHUB_TOKEN'], /不能是 DATABASE_URL/],
    [['--database-url-env=TEST_DATABASE_URL', '--github-token-env=GITHUB_TOKEN'], /不能是 TEST_DATABASE_URL/],
    [['--database-url-env=PROD_URL', '--database-url-env=OTHER_URL', '--github-token-env=GH'], /只能给一次/],
    [['--database-url-env=PROD_URL', '--github-token-env=GH1', '--github-token-env=GH2'], /只能给一次/],
    [['--database-url-env=PROD_URL', '--github-token-env=GH', '--dry-run', '--apply'], /不能同时给/],
    [['--database-url-env=PROD_URL', '--github-token-env=GH', '--bogus'], /未知参数/],
    [['--database-url-env=PROD_URL', '--github-token-env=GH', '--tree-root=a/b'], /单层目录名/],
    [['--database-url-env=PROD_URL', '--github-token-env=GH', '--tree-root=  '], /单层目录名/],
  ])('%j 被拒绝', (argv, message) => {
    expect(() => parseSyncArgs(argv, {})).toThrow(message);
  });

  it('缺省：dry-run + books 树根 + 不回显任何秘密', () => {
    const parsed = parseSyncArgs(['--database-url-env=PROD_URL', '--github-token-env=GH'], {});
    expect(parsed).toEqual({ dbEnv: 'PROD_URL', ghEnv: 'GH', treeRoot: DEFAULT_TREE_ROOT, mode: 'dry-run' });
    // 解析结果里既没有 token 值也没有连接串：env 只被用来校验变量名形状。
    expect(JSON.stringify(parsed)).not.toMatch(/gh[pousr]_token/i);
    expect(parseSyncArgs(['--database-url-env=PROD_URL', '--github-token-env=GH', '--apply'], {}).mode).toBe('apply');
    expect(parseSyncArgs(['--database-url-env=PROD_URL', '--github-token-env=GH', '--tree-root=/books/'], {}).treeRoot).toBe('books');
  });
});

describe('字节口径：只算 books 下普通 blob，排除 .snapshots', () => {
  it('isCountedPath 边界', () => {
    expect(isCountedPath('books/a/b.txt')).toBe(true);
    expect(isCountedPath('books/a/.snapshots/b.txt')).toBe(false);
    expect(isCountedPath('books/.snapshots/x/y.txt')).toBe(false);
    expect(isCountedPath('other/a.txt')).toBe(false);
    expect(isCountedPath('booksX/a.txt')).toBe(false);
    // 路径谓词只看前缀+不命中 .snapshots；'books' 单独一行在求和前会被 type==='blob' 过滤掉，
    // 故此谓词单独返回 true 在求和语境下不产生影响。
    expect(isCountedPath('books')).toBe(true);
    expect(isCountedPath('books/snapshots/b.txt')).toBe(true);
  });

  it('求和：100644/100755 计入；符号链接、gitlink、目录、非 books 路径、.snapshots 一律不计', () => {
    const total = sumRegisteredLogicalBytes([
      { path: 'books/a/1.txt', type: 'blob', mode: '100644', size: 100 },
      { path: 'books/a/2.txt', type: 'blob', mode: '100755', size: 50 },
      { path: 'books/a/3.txt', type: 'blob', mode: '120000', size: 999 },
      { path: 'books/a', type: 'tree', mode: '040000' },
      { path: 'books/sub', type: 'commit', mode: '160000', size: 0 },
      { path: 'docs/readme.md', type: 'blob', mode: '100644', size: 7777 },
      { path: 'books/a/.snapshots/1.txt', type: 'blob', mode: '100644', size: 8888 },
    ]);
    expect(total).toEqual({ bytes: BigInt(150), fileCount: 2 });
  });

  it('缺 size 失败关闭（不用 0 顶替：0 会静默低估容量）', () => {
    expect(() => sumRegisteredLogicalBytes([{ path: 'books/a.txt', type: 'blob', mode: '100644' }]))
      .toThrow(IncompleteTreeError);
    expect(() => sumRegisteredLogicalBytes([{ path: 'books/a.txt', type: 'blob', mode: '100644', size: -1 }]))
      .toThrow(IncompleteTreeError);
    expect(() => sumRegisteredLogicalBytes('not-an-array')).toThrow(IncompleteTreeError);
  });
});

describe('认证请求：token 只进请求头', () => {
  it('固定 api.github.com + Authorization 头；返回值不含 token', async () => {
    const seen = [];
    const request = createGitHubTreeRequest('ghp_supersecret', async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { status: 200, json: async () => ({ truncated: false, tree: [] }) };
    });
    const res = await request('/repos/o/r/git/trees/main?recursive=1');
    expect(seen[0].url).toBe('https://api.github.com/repos/o/r/git/trees/main?recursive=1');
    expect(seen[0].headers.Authorization).toBe('Bearer ghp_supersecret');
    expect(JSON.stringify({ status: res.status })).not.toContain('ghp_supersecret');
    expect(() => createGitHubTreeRequest('')).toThrow(/token 为空/);
  });
});

describe('runSync（PGlite 真表 + 合成 GitHub 桩）', () => {
  let pg;
  let sql;

  /** 合成 GitHub 桩：按路由返回受控树；不触网、不证明真实 GitHub 可达。 */
  const stubRequest = (trees) => async (route) => {
    const body = trees[route];
    if (!body) return { status: 404, json: async () => ({ message: 'not found' }) };
    if (body instanceof Error) throw body;
    return { status: 200, json: async () => body };
  };

  const blob = (path, size) => ({ path, type: 'blob', mode: '100644', size });

  beforeAll(async () => {
    pg = new (await import('@electric-sql/pglite')).PGlite();
    sql = createPGliteSql(pg);
    await createProductionSchema(sql as never, statement => pg.exec(statement));
    await seedV6MemberUser(pg);
    await pg.exec(`INSERT INTO labeled_books(id,title,author) VALUES(1,'synthetic','author');`);
    await initializeArtifactSchema(sql as never);
    await initializeArtifactCapacitySchema(sql as never);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  beforeEach(async () => {
    await pg.exec(`
      DELETE FROM artifact_capacity_reservations;
      DELETE FROM book_artifacts;
      DELETE FROM repository_capacity_ledger;
      DELETE FROM download_tasks;
      DELETE FROM storage_repositories;
      INSERT INTO storage_repositories(id,owner,repo,branch,enabled,is_private,read_only,target_bytes)
        VALUES(1,'fixture','repo-a','main',true,true,false,1000000000),
              (2,'fixture','repo-b','main',true,true,false,1000000000),
              (3,'fixture','repo-off','main',false,true,false,1000000000);
      INSERT INTO repository_capacity_ledger(repository_id,state,target_bytes,registered_bytes,reserved_bytes,baseline_epoch)
        VALUES(1,'ready',1000000000,0,0,'epoch-1'),
              (2,'ready',1000000000,1850000000,0,'epoch-1');
    `);
  });

  // 整仓递归树（未截断）——这是 GitHub 对 ?recursive=1 的真实语义：path 是**仓内绝对路径**。
  const trees = {
    '/repos/fixture/repo-a/git/trees/main?recursive=1': {
      truncated: false,
      tree: [blob('books/x/1.txt', 300), blob('books/x/2.txt', 200), blob('books/x/.snapshots/1.txt', 5000), blob('README.md', 42)],
    },
    '/repos/fixture/repo-b/git/trees/main?recursive=1': {
      truncated: false,
      tree: [blob('books/y/1.txt', 400)],
    },
  };

  // PGlite 对 bigint 列的返回类型随值而异（小值走 number），断言一律按字符串比较。
  const registered = async () => (await pg.query('SELECT repository_id, registered_bytes FROM repository_capacity_ledger ORDER BY repository_id')).rows
    .map(row => ({ repository_id: row.repository_id, registered_bytes: String(row.registered_bytes) }));

  it('dry-run 零写：报告每仓新旧值，库中 registered_bytes 原样不动', async () => {
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'dry-run' });
    expect(report.mode).toBe('dry-run');
    expect(report.failedCount).toBe(0);
    expect(report.repositories).toEqual([
      { repositoryId: 1, repo: 'fixture/repo-a', branch: 'main', status: 'dry-run', fileCount: 2, previousBytes: '0', bytes: '500' },
      { repositoryId: 2, repo: 'fixture/repo-b', branch: 'main', status: 'dry-run', fileCount: 1, previousBytes: '1850000000', bytes: '400' },
    ]);
    expect(await registered()).toEqual([
      { repository_id: 1, registered_bytes: '0' },
      { repository_id: 2, registered_bytes: '1850000000' },
    ]);
  });

  it('apply 写对的行：只动 enabled 仓的 registered_bytes（禁用仓不进列表）', async () => {
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(report.repositories.map(r => r.status)).toEqual(['applied', 'applied']);
    expect(await registered()).toEqual([
      { repository_id: 1, registered_bytes: '500' },
      { repository_id: 2, registered_bytes: '400' },
    ]);
  });

  it('幂等：重跑 apply 同值即 unchanged，不再产生写', async () => {
    await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    const stamp = (await pg.query('SELECT updated_at FROM repository_capacity_ledger WHERE repository_id = 1')).rows[0].updated_at;
    const again = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(again.repositories.map(r => r.status)).toEqual(['unchanged', 'unchanged']);
    expect((await pg.query('SELECT updated_at FROM repository_capacity_ledger WHERE repository_id = 1')).rows[0].updated_at)
      .toEqual(stamp);
  });

  it('树截断时按子树下钻补齐：仍得到完整和，不写部分和', async () => {
    const C = 'c'.repeat(40);
    const D = 'd'.repeat(40);
    const drilled = {
      // 整仓递归被截断（partial 里的 books/x/1.txt=1 字节**不得**进和）
      '/repos/fixture/repo-a/git/trees/main?recursive=1': { truncated: true, tree: [blob('books/x/1.txt', 1)] },
      '/repos/fixture/repo-a/git/trees/main?recursive=0': {
        truncated: false,
        tree: [{ path: 'books', type: 'tree', mode: '040000', sha: C }, blob('README.md', 42)],
      },
      // books 子树递归也被截断 → 再下钻一层
      [`/repos/fixture/repo-a/git/trees/${C}?recursive=1`]: { truncated: true, tree: [blob('x/1.txt', 1)] },
      [`/repos/fixture/repo-a/git/trees/${C}?recursive=0`]: {
        truncated: false,
        tree: [
          { path: 'x', type: 'tree', mode: '040000', sha: D },
          { path: '.snapshots', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
          blob('top.txt', 7),
        ],
      },
      // 子树列举的 path 是**相对子树**的：'x/1.txt' 需靠 prefix 补成 'books/x/1.txt' 才计入
      [`/repos/fixture/repo-a/git/trees/${D}?recursive=1`]: { truncated: false, tree: [blob('x/1.txt', 300), blob('x/2.txt', 200)] },
      [`/repos/fixture/repo-a/git/trees/${'e'.repeat(40)}?recursive=1`]: { truncated: false, tree: [blob('.snapshots/s.txt', 9999)] },
    };
    const report = await runSync({ sql, request: stubRequest(drilled), mode: 'apply' });
    const first = report.repositories.find(r => r.repositoryId === 1);
    expect(first.status).toBe('applied');
    // books/top.txt(7) + books/x/1.txt(300) + books/x/2.txt(200) = 507；books/.snapshots/s.txt(9999) 与
    // 两次截断响应里的 partial(1) 都不进和。
    expect(first.bytes).toBe('507');
    expect(first.fileCount).toBe(3);
  }, 60_000);

  it('补不齐就失败关闭：该仓不写库、如实标 failed 并计数', async () => {
    const broken = {
      ...trees,
      '/repos/fixture/repo-a/git/trees/main?recursive=1': { truncated: true, tree: [] },
      '/repos/fixture/repo-a/git/trees/main?recursive=0': { truncated: true, tree: [] },
    };
    const report = await runSync({ sql, request: stubRequest(broken), mode: 'apply' });
    expect(report.failedCount).toBe(1);
    expect(report.repositories[0]).toMatchObject({ repositoryId: 1, status: 'failed' });
    expect(report.repositories[0].error).toMatch(/INCOMPLETE_TREE/);
    // 失败仓的 registered_bytes 保持原值（没被部分和覆盖）
    expect(String((await pg.query('SELECT registered_bytes FROM repository_capacity_ledger WHERE repository_id = 1')).rows[0].registered_bytes)).toBe('0');
    // 另一仓照常推进
    expect(String((await pg.query('SELECT registered_bytes FROM repository_capacity_ledger WHERE repository_id = 2')).rows[0].registered_bytes)).toBe('400');
  });

  it('无台账行 / 无 books 目录：不写、不谎报 0', async () => {
    // repo-b 无台账行 → no-ledger（不 INSERT）
    await pg.exec(`DELETE FROM repository_capacity_ledger WHERE repository_id = 2;`);
    // repo-a 树里没有 books 段 → no-tree-root（不把「目录没了/仓空」写成 0 容量）
    const noRoot = {
      ...trees,
      '/repos/fixture/repo-a/git/trees/main?recursive=1': { truncated: false, tree: [blob('README.md', 42)] },
    };
    const report = await runSync({ sql, request: stubRequest(noRoot), mode: 'apply' });
    expect(report.repositories[0].status).toBe('no-tree-root');
    expect(report.repositories[1].status).toBe('no-ledger');
    // 两仓的 registered_bytes 都保持原值：no-tree-root 不写 0、no-ledger 不 INSERT。
    expect(await registered()).toEqual([{ repository_id: 1, registered_bytes: '0' }]);
  });

  it('输出不含任何秘密字面量（连接串 / token 都不进报告）', async () => {
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    const dumped = JSON.stringify(report);
    expect(dumped).not.toContain('postgres://');
    expect(dumped).not.toMatch(/gh[pousr]_/i);
    expect(dumped).not.toContain('Bearer');
  });
});
