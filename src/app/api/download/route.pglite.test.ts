import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loadPGlite, type PGliteLike } from '@/lib/fixtures/pglite';
import { createPGliteSql } from '@/lib/fixtures/pglite-sql';
import {
  createProductionSchemaAtAuthV6, seedV6MemberUser, upgradeToAuthV7,
} from '@/lib/fixtures/production-schema';
import { downloadStatsForUserQuery } from '@/lib/user-data';

const db = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn() }));
vi.mock('@/lib/db', () => db);
vi.mock('@/lib/github', () => ({ triggerDownloadWorkflow: vi.fn() }));
import { GET, POST, DELETE } from './route';
import { GET as fileGET } from './[id]/file/route';
import { GET as observationGET } from '../admin/download-stats/route';
import { getReadableTask } from '@/lib/reader-server';

async function bootstrapV6(pg: PGliteLike): Promise<void> {
  // 生产 schema 底座（auth v1–v6：真实 users 全列 + 权限位/身份 CHECK，
  // registration_invites 的 code_hash 格式 CHECK；业务表 labeled_books 含 0002
  // 身份键生成列 + 唯一索引；download_tasks 含 request_identity_check）。
  // 由 fixtures/production-schema 复用生产初始化入口，**不手抄 DDL**：抄本会漂移，
  // 漂移过的 users 单列让权限位/身份冲突回归在测试里系统性隐形（2026-09-23 复核）。
  await createProductionSchemaAtAuthV6(createPGliteSql(pg) as never, pg);
  await seedV6MemberUser(pg);
}

const PGlite = (await loadPGlite())!;
let pg: PGliteLike;
let sql: ReturnType<typeof import('@/lib/db').getSql>;
function request(method = 'GET', suffix = '', body?: unknown, authenticated = true) {
  return new NextRequest(`http://localhost/api/download${suffix}`, {
    method, headers: { ...(authenticated ? { Authorization: 'Bearer t6-synthetic-owner' } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(async () => {
  vi.stubEnv('APP_OWNER_TOKEN', 't6-synthetic-owner');
  vi.stubEnv('LEGACY_DOWNLOAD_DISPATCH_ENABLED', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
  pg = new PGlite();
  await bootstrapV6(pg);
  // 用带 transaction 的 PGlite 适配器：upgradeToAuthV7 走 sql.transaction(builder) 批内
  // 执行（与 neon 同形），plain tag 没有 transaction 会抛 "not a function"，v7 升级
  // 静默失败让 download_tasks 缺 requested_by。
  sql = createPGliteSql(pg) as unknown as typeof sql;
  await upgradeToAuthV7(sql as never);
  db.getSql.mockReturnValue(sql);
  db.ensureSchema.mockResolvedValue(undefined);
  await pg.exec(`
    INSERT INTO labeled_books(id,title,author,source_url) VALUES (7,'合成书','合成作者','https://book15.net/books/details7.html');
    INSERT INTO download_tasks(id,book_id,title,user_id,requested_by,status,updated_at,artifact_id) VALUES
      (1,7,'A',1,'user','pending',now(),NULL),
      (2,7,'B',2,'user','pending',now(),NULL),
      (3,7,'S',NULL,'system','pending',now(),NULL),
      (4,8,'S done',NULL,'system','done',now(),123),
      (5,9,'A stale',1,'user','running',now()-interval '31 minutes',NULL),
      (6,10,'S partial',NULL,'system','partial',now(),NULL),
      (7,11,'S failed',NULL,'system','failed',now(),NULL),
      (8,12,'S protected',NULL,'system','superseded_by_incomplete',now(),NULL),
      (9,13,'A live',1,'user','running',now(),NULL);
    UPDATE download_tasks SET retry_of=7 WHERE id=6;
    SELECT setval('download_tasks_id_seq', 9);
  `);
});
afterEach(async () => { await pg.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('T6 real v7 API isolation', () => {
  it('lists only A and hides B/system from detail, file and cancellation', async () => {
    const list = await (await GET(request())).json();
    expect(list.tasks.map((t: { id: number }) => t.id).sort()).toEqual([1,5,9]);
    for (const id of [2,3,4]) {
      expect((await GET(request('GET', `?id=${id}`))).status).toBe(404);
      expect((await fileGET(request(), { params: Promise.resolve({ id: String(id) }) })).status).toBe(404);
      expect((await DELETE(request('DELETE','',{ taskId: id }))).status).toBe(404);
    }
    expect((await (await GET(request('GET','?bookId=7'))).json()).task.id).toBe(1);
    expect((await (await GET(request('GET','?bookId=8'))).json()).task).toBeNull();
    expect((await DELETE(request('DELETE','',{taskId:1}))).status).toBe(200);
    expect((await pg.query('SELECT id FROM download_tasks WHERE id IN (2,3,4)')).rows).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shares completed system output through existing reader permissions, never its unfinished request', async () => {
    expect(await getReadableTask(4,1)).toMatchObject({ id:4, status:'done', artifact_id:'123' });
    await expect(getReadableTask(3,1)).rejects.toThrow('下载任务不存在');
  });
  // C4 真实差异暴露：生产 users 有权限位不变量（NOT can_download OR (can_find AND
  // can_read)）。旧手抄夹具把 users 建成单列，任何权限位组合都写得进去；换成
  // 生产入口后这条 INSERT 会被 CHECK 拒（23514）——这正是「权限位回归不可见」
  // 在测试里重新变可见的地方。
  it('生产 users 权限位 CHECK 在夹具里生效：给下载不给阅读/查找的成员不可建', async () => {
    await expect(pg.query(
      `INSERT INTO users (id, username, password_hash, role, can_find, can_read, can_download)
       VALUES (99, 'badmember', 'hash', 'member', false, false, true)`,
    )).rejects.toMatchObject({ code: '23514' });
  });
  it('creates a user request with dispatch off even when B and system have same book pending', async () => {
    await pg.exec('DELETE FROM download_tasks WHERE id=1');
    const response = await POST(request('POST','',{bookId:7,requestedBy:'system',userId:2}));
    expect(response.status).toBe(201);
    const { taskId } = await response.json();
    expect((await pg.query('SELECT requested_by,user_id,source_kind FROM download_tasks WHERE id=$1',[taskId])).rows[0])
      .toEqual({requested_by:'user',user_id:1,source_kind:'builtin'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('exposes metadata and disjoint six-state owner aggregates without contaminating personal totals', async () => {
    expect((await (await GET(request('GET','?id=5'))).json()).task).toMatchObject({requestedBy:'user',leaseExpired:true,retryOf:null,artifactId:null});
    const personal = await downloadStatsForUserQuery(sql as never,1) as unknown as Record<string, unknown>[];
    expect(personal[0]).toMatchObject({total:3,done:0,chars:0,chapters:0});
    const response = await observationGET(request());
    expect(response.status).toBe(200);
    const observation = await response.json();
    expect(observation.total).toBe(9);
    expect(observation.groups[0]).toMatchObject({total:4,leaseExpiredRate:0.25,states:{pending:2,running:1,leaseExpired:1,done:0,partial:0,failed:0}});
    expect(observation.groups[1]).toMatchObject({total:5,retries:1,withArtifact:1,states:{pending:1,running:0,leaseExpired:0,done:1,partial:2,failed:1}});
    expect((await observationGET(request('GET','',undefined,false))).status).toBe(401);
    await pg.exec('DELETE FROM download_tasks');
    const empty = await (await observationGET(request())).json();
    expect(empty.total).toBe(0);
    expect(empty.groups.every((group: { share: number; leaseExpiredRate: number }) => group.share === 0 && group.leaseExpiredRate === 0)).toBe(true);
  });
});
