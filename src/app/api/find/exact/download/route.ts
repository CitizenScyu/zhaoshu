import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getSql } from '@/lib/db';
import { withFindAccess, personalError } from '@/lib/personal-request';
import { boundedString, readJsonBody } from '@/lib/http';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';
import { asImporterSql, DEFAULT_POLICY_VERSION, importLabelWithSystemTask } from '@/lib/importer-enqueue';

// 精确找书的「下载全书」（finddl1113）：找书结果（本地或豆瓣命中）不必等批次打标入库，
// 用户点击即落库 + 建系统下载任务，worker 按书名扫源池下载（实测中位数约 7 分钟）。
//
// 与 POST /api/download 的关系：那条路径以 labeledBookId 为入口（要求书已在书库），
// 找书候选没有这个 id；这里复用 importLabelWithSystemTask 的 UPSERT（书库行 + 系统
// 任务一条语句原子完成），与批次打标入库走同一写入路径、同一幂等键，不新增第二套入库。
//
// source_url 用 book15 占位（与 retrofix/gapfill 手工批次同形态）：builtin 任务的选源
// 不看这个 URL 的内容，wrapPrecheck 直接按书名扫引擎池；占位只须过 checkSourceUrl 的
// 结构门。下载结果与批次书完全同链路（换源、退避、发布、donedup 收口）。
export const maxDuration = 30;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 200;
/** 搜索种子 URL：builtin host 的规范 origin（supported-sources 识别集合内）。 */
const SEARCH_SEED_URL = 'https://book15.net/';

async function handlePOST(req: NextRequest) {
  return withFindAccess(req, 25_000, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const title = boundedString(body?.title, MAX_TITLE_LENGTH) ?? '';
    // 与 shelf 路由同款 author 边界（authval42）：非字符串/超长显式 400，缺失/空串走佚名。
    const rawAuthor = body?.author ?? '';
    if (boundedString(rawAuthor, MAX_AUTHOR_LENGTH) === null) {
      return NextResponse.json({ error: 'invalid author', code: 'INVALID_AUTHOR' }, { status: 400 });
    }
    const author = boundedString(rawAuthor, MAX_AUTHOR_LENGTH) || '佚名';
    if (!title) {
      return NextResponse.json({ error: 'missing title', code: 'MISSING_TITLE' }, { status: 400 });
    }
    try {
      await access.run(ensureSchema);
      const outcome = await access.commit((write) =>
        write((sql) => importLabelWithSystemTask(asImporterSql(sql), {
          record: {
            title, author,
            category: '', finishStatus: '', sourceSite: '书源池搜索', sourceUrl: SEARCH_SEED_URL,
            charsLabeled: 0, labels: {}, primaryGenre: '', subTags: [], quality: null,
          },
          marker: 'ready',
          task: { policyVersion: DEFAULT_POLICY_VERSION, sourceKind: 'builtin', sourceId: null, sourceRevision: 'finddl-1113' },
        })));
      return NextResponse.json({
        ok: true,
        bookId: outcome.labeledBookId,
        taskId: outcome.taskId,
        taskOutcome: outcome.taskOutcome,
        // 201 与 POST /api/download 同语义：请求被接受且下载任务已在队列中
        //（含 existing/artifact_exists——对用户都是「任务在，等完成」）。
      }, { status: 201 });
    } catch (error) {
      if (personalError(error).status !== 500) throw error;
      return NextResponse.json({ error: 'internal error', code: 'DB_ERROR' }, { status: 500 });
    }
  });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const POST = withDbQuotaGuard(handlePOST);
