// ledgersync41：sync-ledger-capacity 的参数闸门、字节口径（排除 .snapshots/符号链接）、
// 树截断下钻补齐、幂等与「凭据不进输出」。
// repothresh44：新增压缩口径（GitHub `size` 字段 = pack 的 KiB）同步用例——
// 它是切仓门槛的判定量，逻辑字节降级为观测；取不到 size 一律失败关闭（不按 0 猜）。
//
// 夹具与既有容量用例同款：createProductionSchema + initializeArtifactSchema +
// initializeArtifactCapacitySchema 在隔离 PGlite 上建真实表；GitHub 侧是合成受控桩
// （明确只验证本脚本消费受控响应的行为，不证明真实 GitHub 可达或真实容量）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initializeArtifactSchema } from '../src/lib/business-schema';
import { initializeArtifactCapacitySchema } from '../src/lib/artifact-capacity-schema';
import { loadPGlite, type PGliteLike } from '../src/lib/fixtures/pglite';
import { createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import { createProductionSchema, seedV6MemberUser } from '../src/lib/fixtures/production-schema';
import {
  DEFAULT_TREE_ROOT, IncompleteTreeError, LEDGER_SYNC_HEALTH_ROW, createGitHubTreeRequest, isCountedPath,
  measureRepositoryCompressedBytes, parseSyncArgs, runSync, sumRegisteredLogicalBytes,
} from './sync-ledger-capacity.mjs';

describe('参数解析：目标与 token 来源都必须显式，缺省 dry-run', () => {
  it.each([
    [[], /--database-url-env/],
    [['--database-url-env=PROD_URL'], /--github-token-env/],
    [['--database-url-env=PROD_URL', '--github-token-env=lower'], /大写变量名/],
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
    // 服务器上唯一那个 DATABASE_URL 就是本脚本的生产目标，必须放行（见脚本头「自包含性」注释）。
    expect(parseSyncArgs(['--database-url-env=DATABASE_URL', '--github-token-env=GITHUB_TOKEN'], {}).dbEnv).toBe('DATABASE_URL');
  });
});

// obsfix45：心跳行名在脚本（.mjs，自包含不 import TS）与 src/lib/source-health.ts 里各写一次
// 字面值。没有编译期手段能钉住这条一致性——行名漂移的话脚本照写、端点照读，两边永远对不上，
// 表现是「探针报 ledgerSync 从未记录到成功」而 journal 里明明每小时都 recorded。
describe('心跳行名两侧逐字同名', () => {
  it('src/lib/source-health.ts 的 LEDGER_SYNC_HEALTH_ROW 与本脚本导出的行名一致', () => {
    const tsSource = readFileSync(new URL('../src/lib/source-health.ts', import.meta.url), 'utf8');
    const declared = /export const LEDGER_SYNC_HEALTH_ROW = '([^']+)'/.exec(tsSource);
    expect(declared, 'source-health.ts 里找不到 LEDGER_SYNC_HEALTH_ROW 声明（改名了？两处必须同改）').not.toBeNull();
    expect(LEDGER_SYNC_HEALTH_ROW).toBe(declared![1]);
    // 端点侧还得真把这行映射进 crons.ledgerSync，否则读了也不透传。
    expect(tsSource).toContain(`[LEDGER_SYNC_HEALTH_ROW]: 'ledgerSync'`);
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
    expect(() => sumRegisteredLogicalBytes('not-an-array' as never)).toThrow(IncompleteTreeError);
  });
});

describe('认证请求：token 只进请求头', () => {
  it('固定 api.github.com + Authorization 头；返回值不含 token', async () => {
    const seen: Array<{ url: string, headers: Record<string, string> }> = [];
    const request = createGitHubTreeRequest('ghp_supersecret', (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return { status: 200, json: async () => ({ truncated: false, tree: [] }) };
    }) as never);
    const res = await request('/repos/o/r/git/trees/main?recursive=1');
    expect(seen[0].url).toBe('https://api.github.com/repos/o/r/git/trees/main?recursive=1');
    expect(seen[0].headers.Authorization).toBe('Bearer ghp_supersecret');
    expect(JSON.stringify({ status: res.status })).not.toContain('ghp_supersecret');
    expect(() => createGitHubTreeRequest('')).toThrow(/token 为空/);
  });
});

// repothresh44：压缩口径读取。GitHub `GET /repos/{owner}/{repo}` 的 `size` 单位是 **KiB**
// （仓库 pack 的压缩体积），不是字节——单位搞错会让门槛相差 1024 倍，故单列一组边界。
describe('measureRepositoryCompressedBytes：size 是 KiB，取不到就抛（不按 0 猜）', () => {
  /** 造一个固定响应的 request 端口（与 createGitHubTreeRequest 同形状）；`as never` 沿用本文件既有桩写法。 */
  const requestReturning = (res: unknown) => (async (_route: string) => res) as never;
  const repo = { owner: 'fixture', repo: 'repo-a', branch: 'main' };

  it('size 为 KiB ⇒ 返回字节（×1024）；大值仍精确', async () => {
    expect(await measureRepositoryCompressedBytes(requestReturning(
      { status: 200, json: async () => ({ size: 100 }) },
    ), repo)).toBe(BigInt(102_400));
    expect(await measureRepositoryCompressedBytes(requestReturning(
      { status: 200, json: async () => ({ size: 0 }) },
    ), repo)).toBe(BigInt(0));
    // 1 GiB 量级（sizeKib ≈ 1048576）仍在安全整数内，BigInt 转换不丢精度。
    expect(await measureRepositoryCompressedBytes(requestReturning(
      { status: 200, json: async () => ({ size: 1_048_576 }) },
    ), repo)).toBe(BigInt(1_073_741_824));
  });

  // 每条 json() 都显式标返回类型：不标的话 tsc 在 it.each 的元组推断里会报 TS7023（隐式 any）。
  const body = (v: unknown) => async (): Promise<unknown> => v;
  it.each([
    [{ status: 200, json: body({}) }, /size missing or invalid/],
    [{ status: 200, json: body({ size: null }) }, /size missing or invalid/],
    [{ status: 200, json: body({ size: '1024' }) }, /size missing or invalid/],
    [{ status: 200, json: body({ size: -1 }) }, /size missing or invalid/],
    [{ status: 200, json: body({ size: 1.5 }) }, /size missing or invalid/],
    [{ status: 200, json: body({ size: Number.NaN }) }, /size missing or invalid/],
    [{ status: 200, json: body({ size: Number.POSITIVE_INFINITY }) }, /size missing or invalid/],
    [{ status: 200, json: body(null) }, /malformed repo body/],
    [{ status: 200, json: body('nope') }, /malformed repo body/],
    [{ status: 200, json: body([1, 2]) }, /size missing or invalid/],
    [{ status: 404, json: body({ message: 'Not Found' }) }, /GITHUB_REPO_HTTP_404/],
    [{ status: 403, json: body({ message: 'rate limited' }) }, /GITHUB_REPO_HTTP_403/],
    [{ status: 500, json: body({}) }, /GITHUB_REPO_HTTP_500/],
    [{ json: body({ size: 1 }) }, /malformed response envelope/],
    [{ status: '200', json: body({ size: 1 }) }, /malformed response envelope/],
    [{ status: 99, json: body({ size: 1 }) }, /malformed response envelope/],
    [{ status: 200.5, json: body({ size: 1 }) }, /malformed response envelope/],
  ])('坏响应 %j ⇒ 抛', async (res, message) => {
    await expect(measureRepositoryCompressedBytes(requestReturning(res), repo)).rejects.toThrow(message);
  });

  it('HTTP 错误信息里不带响应体（token/正文都不进日志与报告）', async () => {
    const res = { status: 403, json: async () => ({ message: 'ghp_supersecret leaked' }) };
    await expect(measureRepositoryCompressedBytes(requestReturning(res), repo))
      .rejects.toThrow(/^GITHUB_REPO_HTTP_403$/);
  });
});

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

maybe('runSync（PGlite 真表 + 合成 GitHub 桩）', () => {
  let pg: PGliteLike;
  let sql: ReturnType<typeof createPGliteSql>;

  // size 声明为 unknown：失败关闭用例要能造 null / 字符串 / 负数等非法值。
  type StubBody = { truncated?: boolean, tree?: unknown[], size?: unknown } | Error;
  /**
   * 压缩口径桩（repothresh44）：`GET /repos/{owner}/{repo}` 的 size 单位是 **KiB**。
   * 单列一张表并由 stubRequest 兜底，好让既有树用例不必逐条重复声明 size 路由；
   * 用例内显式给出同一路由即覆盖（用于造「size 缺失/非法」）。
   */
  const sizes: Record<string, StubBody> = {
    '/repos/fixture/repo-a': { size: 100 }, // 100 KiB → 102400 B
    '/repos/fixture/repo-b': { size: 50 },  // 50 KiB → 51200 B
  };
  /** 合成 GitHub 桩：按路由返回受控响应；不触网、不证明真实 GitHub 可达。 */
  const stubRequest = (routes: Record<string, StubBody>) => async (route: string) => {
    const body = routes[route] ?? sizes[route];
    if (!body) return { status: 404, json: async () => ({ message: 'not found' }) };
    if (body instanceof Error) throw body;
    return { status: 200, json: async () => body };
  };

  const blob = (path: string, size: number) => ({ path, type: 'blob', mode: '100644', size });

  beforeAll(async () => {
    pg = new PGliteCtor!();
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
      INSERT INTO repository_capacity_ledger(repository_id,state,target_bytes,registered_bytes,reserved_bytes,github_size_bytes,baseline_epoch)
        VALUES(1,'ready',1000000000,0,0,0,'epoch-1'),
              (2,'ready',1000000000,1850000000,0,51200,'epoch-1');
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
  const capacity = async () => (await pg.query('SELECT repository_id, registered_bytes, github_size_bytes FROM repository_capacity_ledger ORDER BY repository_id')).rows
    .map(row => ({ repository_id: row.repository_id, registered_bytes: String(row.registered_bytes), github_size_bytes: String(row.github_size_bytes) }));

  // 冷建库路径（initializeArtifactCapacitySchema）与 migrations/0008 必须同构：
  // 两处缺省值不一致的话，新建台账行会拿到错门槛（0 会被运行期 requirePositiveBigint 判失败）。
  it('台账 DDL 缺省：github_size_bytes=0、target_compressed_bytes=1GiB，均 NOT NULL', async () => {
    expect((await pg.query(`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'repository_capacity_ledger'
        AND column_name IN ('github_size_bytes', 'target_compressed_bytes')
      ORDER BY column_name`)).rows).toEqual([
      { column_name: 'github_size_bytes', column_default: '0', is_nullable: 'NO' },
      { column_name: 'target_compressed_bytes', column_default: '1073741824', is_nullable: 'NO' },
    ]);
  });

  it('dry-run 零写：报告每仓两个口径的新旧值，库中原样不动', async () => {
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'dry-run' });
    expect(report.mode).toBe('dry-run');
    expect(report.failedCount).toBe(0);
    // repo-b 的压缩值与库中同值（51200）而逻辑值不同 ⇒ 仍须报 dry-run：
    // 「两值全等」才算 unchanged，任一变动都要写回，否则压缩门槛会长期停在陈旧值。
    expect(report.repositories).toEqual([
      { repositoryId: 1, repo: 'fixture/repo-a', branch: 'main', status: 'dry-run', fileCount: 2,
        previousBytes: '0', bytes: '500',
        previousGithubSizeBytes: '0', githubSizeBytes: '102400',
        admissionRenewal: 'skipped-not-eligible' },
      { repositoryId: 2, repo: 'fixture/repo-b', branch: 'main', status: 'dry-run', fileCount: 1,
        previousBytes: '1850000000', bytes: '400',
        previousGithubSizeBytes: '51200', githubSizeBytes: '51200',
        admissionRenewal: 'skipped-not-eligible' },
    ]);
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '0', github_size_bytes: '0' },
      { repository_id: 2, registered_bytes: '1850000000', github_size_bytes: '51200' },
    ]);
  });

  it('apply 写对的行：两个口径同时回写，且只动 enabled 仓（禁用仓不进列表）', async () => {
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(report.repositories.map(r => r.status)).toEqual(['applied', 'applied']);
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '500', github_size_bytes: '102400' },
      { repository_id: 2, registered_bytes: '400', github_size_bytes: '51200' },
    ]);
    // 门槛列 target_compressed_bytes 不被本脚本改写（它是配置，不是观测量）。
    expect((await pg.query('SELECT DISTINCT target_compressed_bytes FROM repository_capacity_ledger')).rows
      .map(r => String(r.target_compressed_bytes))).toEqual(['1073741824']);
  });

  it('只有压缩值变（逻辑值同值）⇒ 仍 applied，不误判 unchanged', async () => {
    await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    // GitHub pack 重算/仓库 GC 后 size 变了，而 books 下 blob 总字节没变。
    const grew = { ...trees, '/repos/fixture/repo-a': { size: 101 } };
    const again = await runSync({ sql, request: stubRequest(grew), mode: 'apply' });
    expect(again.repositories[0]).toMatchObject({
      status: 'applied', bytes: '500', previousBytes: '500',
      githubSizeBytes: '103424', previousGithubSizeBytes: '102400',
    });
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '500', github_size_bytes: '103424' },
      { repository_id: 2, registered_bytes: '400', github_size_bytes: '51200' },
    ]);
  });

  it('幂等：重跑 apply 两个口径都同值即 unchanged，不再产生写', async () => {
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
    // books/top.txt(7) + books/x/1.txt(300) + books/x/2.txt(200) = 507；books/.snapshots/s.txt(9999) 与
    // 两次截断响应里的 partial(1) 都不进和。压缩值走 sizes 兜底路由（100 KiB）。
    expect(report.repositories.find(r => r.repositoryId === 1))
      .toMatchObject({ status: 'applied', bytes: '507', fileCount: 3, githubSizeBytes: '102400' });
  }, 60_000);

  it('补不齐就失败关闭：该仓两个口径都不写库、如实标 failed 并计数', async () => {
    const broken = {
      ...trees,
      '/repos/fixture/repo-a/git/trees/main?recursive=1': { truncated: true, tree: [] },
      '/repos/fixture/repo-a/git/trees/main?recursive=0': { truncated: true, tree: [] },
    };
    const report = await runSync({ sql, request: stubRequest(broken), mode: 'apply' });
    expect(report.failedCount).toBe(1);
    expect(report.repositories[0]).toMatchObject({ repositoryId: 1, status: 'failed', admissionRenewal: 'not-verified', error: expect.stringContaining('INCOMPLETE_TREE') });
    // 失败仓的 registered_bytes/github_size_bytes 都保持原值（没被部分和或单侧新值覆盖）
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '0', github_size_bytes: '0' },
      { repository_id: 2, registered_bytes: '400', github_size_bytes: '51200' },
    ]);
  });

  // repothresh44：压缩值是切仓门槛的**判定量**，取不到就不能写——
  // 写 0 等于告诉运行期 decide「这仓无限空」，会一路写到撞 GitHub 5GB 硬限。
  it('GitHub size 缺失/非法 ⇒ 该仓 failed，两列都不写、不续期', async () => {
    for (const bad of [{}, { size: null }, { size: '100' }, { size: -5 }]) {
      await pg.exec(`UPDATE repository_capacity_ledger SET registered_bytes = 0, github_size_bytes = 0;`);
      const routes = { ...trees, '/repos/fixture/repo-a': bad };
      const report = await runSync({ sql, request: stubRequest(routes), mode: 'apply' });
      expect(report.failedCount).toBe(1);
      expect(report.repositories[0]).toMatchObject({
        repositoryId: 1, status: 'failed', admissionRenewal: 'not-verified',
        error: expect.stringContaining('repo size missing or invalid'),
      });
      expect(await capacity()).toEqual([
        { repository_id: 1, registered_bytes: '0', github_size_bytes: '0' },
        { repository_id: 2, registered_bytes: '400', github_size_bytes: '51200' },
      ]);
    }
  });

  it('逻辑值量到了但压缩值取不到 ⇒ 该仓 failed，两列都不写（不留「逻辑新鲜、压缩陈旧」的账）', async () => {
    const routes = { ...trees, '/repos/fixture/repo-b': new Error('synthetic transport failure') };
    const report = await runSync({ sql, request: stubRequest(routes), mode: 'apply' });
    expect(report.failedCount).toBe(1);
    expect(report.repositories[0]).toMatchObject({ repositoryId: 1, status: 'applied', githubSizeBytes: '102400' });
    expect(report.repositories[1]).toMatchObject({
      repositoryId: 2, status: 'failed', admissionRenewal: 'not-verified', error: 'synthetic transport failure',
    });
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '500', github_size_bytes: '102400' },
      { repository_id: 2, registered_bytes: '1850000000', github_size_bytes: '51200' },
    ]);
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
    // no-tree-root 仍如实报出本轮量到的压缩值（只是不写库），便于运维对照；
    // 但不报 bytes——没有可信的逻辑和就不给数，避免被当成 0 抄进别处。
    expect(report.repositories[0]).toMatchObject({
      status: 'no-tree-root', fileCount: 0, previousBytes: '0',
      previousGithubSizeBytes: '0', githubSizeBytes: '102400', admissionRenewal: 'not-verified',
    });
    expect(report.repositories[0]).not.toHaveProperty('bytes');
    expect(report.repositories[1]).toMatchObject({ status: 'no-ledger', admissionRenewal: 'not-verified' });
    // 两仓的字节账都保持原值：no-tree-root 不写 0、no-ledger 不 INSERT。
    expect(await capacity()).toEqual([{ repository_id: 1, registered_bytes: '0', github_size_bytes: '0' }]);
  });

  it('输出不含任何秘密字面量（连接串 / token 都不进报告）', async () => {
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    const dumped = JSON.stringify(report);
    expect(dumped).not.toContain('postgres://');
    expect(dumped).not.toMatch(/gh[pousr]_/i);
    expect(dumped).not.toContain('Bearer');
  });

  // F1（repofix43）：admission_valid_until 无续期机制 → 2026-11-12 悬崖。续期只对
  // 本轮核对成功且 ready+granted 的行；WHERE 自带双闸，不复活非 ready/非 granted 行。
  it('F1 续期：ready+granted 行 apply 后续期到约 30 天后；unchanged（字节同值）也照续', async () => {
    await pg.exec(`
      UPDATE repository_capacity_ledger
      SET admission_status='granted', admission_version='v1',
          admission_valid_until=NOW()+INTERVAL '5 days',
          admission_target=jsonb_build_object('repositoryId', repository_id, 'branch', 'main')
      WHERE repository_id IN (1,2);
    `);
    const first = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(first.repositories.map(r => [r.status, r.admissionRenewal])).toEqual([['applied', 'renewed'], ['applied', 'renewed']]);
    const spans = (await pg.query(`SELECT EXTRACT(EPOCH FROM admission_valid_until - NOW()) AS secs FROM repository_capacity_ledger ORDER BY repository_id`)).rows;
    for (const row of spans) {
      const secs = Number(row.secs);
      expect(secs).toBeGreaterThan(25 * 86400);
      expect(secs).toBeLessThan(31 * 86400);
    }
    // 第二跑字节同值（unchanged）——探针每小时续命走的正是这条路
    const second = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(second.repositories.map(r => [r.status, r.admissionRenewal])).toEqual([['unchanged', 'renewed'], ['unchanged', 'renewed']]);
  });

  it('F1 续期：非 granted / 非 ready 行不续期（双闸不复活），字节回写不受影响', async () => {
    await pg.exec(`
      UPDATE repository_capacity_ledger SET admission_status='denied', admission_valid_until=NOW()+INTERVAL '5 days' WHERE repository_id = 1;
      UPDATE repository_capacity_ledger SET state='uninitialized', admission_status='granted', admission_valid_until=NOW()+INTERVAL '5 days' WHERE repository_id = 2;
    `);
    const before = (await pg.query(`SELECT admission_valid_until FROM repository_capacity_ledger ORDER BY repository_id`)).rows.map(r => String(r.admission_valid_until));
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(report.repositories.map(r => [r.status, r.admissionRenewal])).toEqual([['applied', 'skipped-not-eligible'], ['applied', 'skipped-not-eligible']]);
    // 字节照常回写（续期闸不影响字节职责）
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '500', github_size_bytes: '102400' },
      { repository_id: 2, registered_bytes: '400', github_size_bytes: '51200' },
    ]);
    const after = (await pg.query(`SELECT admission_valid_until FROM repository_capacity_ledger ORDER BY repository_id`)).rows.map(r => String(r.admission_valid_until));
    expect(after).toEqual(before);
  });

  it('F1 续期：dry-run 只报告 would-renew，不落写', async () => {
    await pg.exec(`UPDATE repository_capacity_ledger SET admission_status='granted', admission_valid_until=NOW()+INTERVAL '5 days' WHERE repository_id = 1;`);
    const before = String((await pg.query(`SELECT admission_valid_until FROM repository_capacity_ledger WHERE repository_id = 1`)).rows[0].admission_valid_until);
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'dry-run' });
    expect(report.repositories.map(r => r.admissionRenewal)).toEqual(['would-renew', 'skipped-not-eligible']);
    const after = String((await pg.query(`SELECT admission_valid_until FROM repository_capacity_ledger WHERE repository_id = 1`)).rows[0].admission_valid_until);
    expect(after).toBe(before);
  });

  // obsfix45 缺陷2：成功心跳。本脚本是 admission_valid_until **全系统唯一**的续期入口，它停摆
  // = 30 天后准入悬崖重现（2026-11-12 那次三仓同时到期、发布全停）。而停摆在库里原本看不见：
  // 字节不变的轮次连 updated_at 都不动（unchanged 分支零写）。故每轮核对成功写一行 cron_health，
  // 由 /api/health/sources 透传、GitHub Actions 探针判龄。
  const heartbeatRows = async () => (await pg.query(
    `SELECT name, last_success_at FROM cron_health WHERE name = $1`, [LEDGER_SYNC_HEALTH_ROW],
  )).rows as { name: string, last_success_at: unknown }[];
  const clearHeartbeat = () => pg.exec(`DELETE FROM cron_health`);

  it('apply 且全部仓核对成功 ⇒ 写 ledger_sync 心跳（report.heartbeat=recorded）', async () => {
    await clearHeartbeat();
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(report.heartbeat).toBe('recorded');
    const rows = await heartbeatRows();
    expect(rows).toHaveLength(1);
    // 心跳记的是「刚刚成功」的时刻（过去/现在），不是租约那种 now()+TTL 的未来到期时刻。
    expect(Date.parse(String(rows[0].last_success_at))).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('dry-run 不写心跳：没续期就没有「续期成功」可记，写了等于拿干跑冒充真跑', async () => {
    await clearHeartbeat();
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'dry-run' });
    expect(report.heartbeat).toBe('skipped-dry-run');
    expect(await heartbeatRows()).toHaveLength(0);
  });

  it('有仓核对失败（not-verified）⇒ 不写心跳：exit 0 但某仓一直续不上，正是悬崖悄悄回来的形态', async () => {
    await clearHeartbeat();
    const broken = {
      ...trees,
      '/repos/fixture/repo-a/git/trees/main?recursive=1': { truncated: true, tree: [] },
      '/repos/fixture/repo-a/git/trees/main?recursive=0': { truncated: true, tree: [] },
    };
    const report = await runSync({ sql, request: stubRequest(broken), mode: 'apply' });
    // 另一仓照常 applied+续期，但本轮整体不算成功 ⇒ 心跳不写（判据是「有没有仓没续上」，不是「进程跑完没」）。
    expect(report.repositories.map(r => r.status)).toEqual(['failed', 'applied']);
    expect(report.heartbeat).toBe('skipped-not-verified');
    expect(await heartbeatRows()).toHaveLength(0);
  });

  it('no-ledger / no-tree-root 同样算 not-verified ⇒ 不写心跳', async () => {
    await clearHeartbeat();
    await pg.exec(`DELETE FROM repository_capacity_ledger WHERE repository_id = 2;`);
    const report = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(report.repositories[1]).toMatchObject({ status: 'no-ledger', admissionRenewal: 'not-verified' });
    expect(report.heartbeat).toBe('skipped-not-verified');
    expect(await heartbeatRows()).toHaveLength(0);
  });

  it('重跑 upsert 同一行：心跳不随轮次或仓数累积', async () => {
    await clearHeartbeat();
    await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    await pg.exec(`UPDATE cron_health SET last_success_at = now() - interval '2 hours'`);
    const again = await runSync({ sql, request: stubRequest(trees), mode: 'apply' });
    expect(again.heartbeat).toBe('recorded');
    const rows = await heartbeatRows();
    expect(rows).toHaveLength(1);
    expect((await pg.query(`SELECT count(*)::int AS n FROM cron_health`)).rows[0]).toMatchObject({ n: 1 });
    // 第二轮把时间戳推到 now()（不是保留 2h 前的旧值）。
    expect(Date.now() - Date.parse(String(rows[0].last_success_at))).toBeLessThan(60_000);
  });

  it('心跳写失败不影响本轮结果与出口码：只落日志、report.heartbeat=write-failed', async () => {
    await clearHeartbeat();
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    const failingSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('INSERT INTO cron_health')) return Promise.reject(new Error('postgresql://user:pass@host/db 心跳写失败'));
      return (sql as unknown as Tag)(strings, ...values);
    }) as unknown as typeof sql;
    const report = await runSync({ sql: failingSql, request: stubRequest(trees), mode: 'apply' });
    // 字节回写与续期照常完成（心跳在末尾，失败不回滚、不抛）。
    expect(report.heartbeat).toBe('write-failed');
    expect(report.failedCount).toBe(0);
    expect(report.repositories.map(r => r.status)).toEqual(['applied', 'applied']);
    expect(await capacity()).toEqual([
      { repository_id: 1, registered_bytes: '500', github_size_bytes: '102400' },
      { repository_id: 2, registered_bytes: '400', github_size_bytes: '51200' },
    ]);
    // 连接串被 safeError 脱敏后才进日志。
    expect(logged.join('\n')).toContain('heartbeat');
    expect(logged.join('\n')).not.toContain('postgresql://');
    spy.mockRestore();
  });

  // repothresh44 部署顺序护栏（放最后：临时改表结构）。未跑 migrations/0008 的库上没有
  // github_size_bytes 列 ⇒ 必须抛而不是按 0 猜：0 会让运行期 decide 认为满仓「无限空」，
  // 一路写到撞 GitHub 5GB 硬限。同时逻辑值也不写，避免只写半边账。
  it('台账缺 github_size_bytes 列（未跑 0008）⇒ 抛，不按 0 猜、不写库', async () => {
    await pg.exec(`ALTER TABLE repository_capacity_ledger DROP COLUMN github_size_bytes;`);
    try {
      await expect(runSync({ sql, request: stubRequest(trees), mode: 'apply' }))
        .rejects.toThrow(/github_size_bytes/);
      expect((await pg.query('SELECT registered_bytes FROM repository_capacity_ledger ORDER BY repository_id')).rows
        .map(r => String(r.registered_bytes))).toEqual(['0', '1850000000']);
    } finally {
      await pg.exec(`ALTER TABLE repository_capacity_ledger
        ADD COLUMN github_size_bytes bigint NOT NULL DEFAULT 0 CHECK (github_size_bytes >= 0);`);
    }
  });
});
