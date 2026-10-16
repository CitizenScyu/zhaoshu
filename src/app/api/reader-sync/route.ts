import { NextRequest, NextResponse } from 'next/server';
import { withFindAccess } from '@/lib/personal-request';
import { ensureSchema, getReaderSyncForUser, saveReaderSyncForUser } from '@/lib/db';
import { readJsonBody } from '@/lib/http';
import { normalizeReaderSyncEntry, READER_SYNC_MAX_ENTRIES, type ReaderSyncEntry } from '@/lib/reader-sync';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

export const maxDuration = 30;

// 进度 + 设置两类合起来也只到几 KB；32KB 的正文上限对「批量补推」留了整本书的余量，
// 又不至于让一次误传把请求体撑到别的路由那个量级。
const MAX_BODY_BYTES = 32 * 1024;
const READER_SYNC_BUDGET_MS = 10_000;

async function handleGET(req: NextRequest) {
  return withFindAccess(req, READER_SYNC_BUDGET_MS, async (access) => {
    await access.run(ensureSchema);
    const entries = await access.run(() => getReaderSyncForUser(access.principal.userId));
    // 出口只回本人自己的进度/设置；不附 userId、角色、服务器 updated_at 等身份或运维字段。
    return NextResponse.json({ entries });
  });
}

async function handlePUT(req: NextRequest) {
  return withFindAccess(req, READER_SYNC_BUDGET_MS, async (access) => {
    const body = await access.run(() => readJsonBody(req, MAX_BODY_BYTES, access.signal));
    const raw = body?.entries;
    if (!Array.isArray(raw) || !raw.length || raw.length > READER_SYNC_MAX_ENTRIES) {
      return NextResponse.json({ error: `entries must be an array of 1..${READER_SYNC_MAX_ENTRIES} items` }, { status: 400 });
    }
    // 逐条归一：任一条形状/体积不合法就整批拒（400），不做「挑几条能用的塞进去」——
    // 部分写入会让客户端以为同步完了，实际丢掉几条且无从得知。
    const parsed = Array.isArray(raw) ? raw.map(normalizeReaderSyncEntry) : [];
    const invalid = parsed.findIndex((entry) => entry === null);
    if (invalid >= 0) {
      return NextResponse.json({ error: `entries[${invalid}] is not a valid reader sync entry`, code: 'READER_SYNC_ENTRY_INVALID' }, { status: 400 });
    }
    const entries = parsed.filter((entry): entry is ReaderSyncEntry => entry !== null);
    const { userId } = access.principal;
    await access.run(ensureSchema);
    const stored = await access.commit((write) => saveReaderSyncForUser(userId, entries, write));
    // 回读服务端真值而非「写成功」：last-write-wins 下陈旧写入会被静默丢弃，客户端需要的是
    // 收敛依据（云端较新时它据此覆盖本地），而不是一个乐观的 ok。
    return NextResponse.json({ entries: stored });
  });
}

// 数据库配额闸（41-q402fix）：导出/写入的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
export const PUT = withDbQuotaGuard(handlePUT);
