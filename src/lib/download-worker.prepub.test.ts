// prepub1102：发布前 identity 落位预检（全合成：无 PGlite、无网络、无真实凭据）。
//
// 生产实测：书 3658《笑傲江湖》下完 42/42 章后发布撞 ARTIFACT_IDENTITY_CONFLICT 落 failed。
// 成因是 identity_key 唯一 ⇒ 每本书只一条落位，而 reserveArtifactPath 的 ON CONFLICT 只在
// 「书库记录 + 仓 + 分支 + 路径」与既有行全等时放行；既有行挂在别的书库记录下时，本次发布
// 无论重下多少次都注定失败。断言四件事：
//   a. 预检开 + 既有落位挂在别的书库记录 ⇒ 抓取前直接 failed，adapter/reserve/发布零调用；
//   b. 预检开 + 路径口径变了 ⇒ 同样 failed（差异文案点名存档路径）；
//   c. 预检开 + 无既有落位 / 与本任务完全一致 ⇒ 行为与引入前一致（照常下载发布）；
//   d. 预检关 或 storage 未实现 ⇒ findArtifactIdentityOwner 零调用；查询报错 ⇒ fail-open 照常下载。

import { describe, expect, it, vi } from 'vitest';
import {
  runDownloadTask,
  type AdapterOutcome, type SourceAdapter, type TaskRow, type WorkerOptions, type WorkerStorage,
} from './download-worker';
import { snapshotPaths } from './download-publisher';
import type { ArtifactIdentityOwner } from './artifact-registry';

const lease: Parameters<typeof runDownloadTask>[1] = {
  id: 8040, leaseOwner: 'synthetic-worker', leaseGeneration: 2, attemptCount: 1,
};
const task: TaskRow = {
  id: 8040, book_id: 3658, title: '合成书', author: '合成作者', status: 'running',
  source_url: 'https://reader.test/book', source_kind: 'engine', source_id: null, requested_by: 'user',
};
const complete: AdapterOutcome = { kind: 'complete', txt: '合成正文', chaptersTotal: 1, chaptersDone: 1, charsTotal: 4 };

class MemoryGitHub {
  files = new Map<string, string>();
  async put(path: string, text: string): Promise<void> { this.files.set(path, text); }
  async getBytes(path: string): Promise<Buffer | null> {
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
  async del(path: string): Promise<void> { this.files.delete(path); }
}

function fixture(over: {
  prePublishCheck?: boolean;
  owner?: ArtifactIdentityOwner | null | (() => Promise<ArtifactIdentityOwner | null>);
  withOwnerPort?: boolean;
} = {}) {
  const owner = over.owner;
  const ownerPort: NonNullable<WorkerStorage['findArtifactIdentityOwner']> = typeof owner === 'function'
    ? owner
    : async () => owner ?? null;
  const storage = {
    claim: vi.fn<WorkerStorage['claim']>().mockResolvedValue(null),
    taskRow: vi.fn<WorkerStorage['taskRow']>().mockResolvedValue(task),
    heartbeat: vi.fn<WorkerStorage['heartbeat']>().mockResolvedValue(true),
    progress: vi.fn<WorkerStorage['progress']>().mockResolvedValue(true),
    finish: vi.fn<WorkerStorage['finish']>().mockResolvedValue(true),
    defer: vi.fn<WorkerStorage['defer']>().mockResolvedValue(null),
    reserveArtifactPath: vi.fn<WorkerStorage['reserveArtifactPath']>().mockResolvedValue(11),
    findArtifactBinding: vi.fn<WorkerStorage['findArtifactBinding']>().mockResolvedValue(null),
    registerArtifact: vi.fn<WorkerStorage['registerArtifact']>().mockResolvedValue('registered'),
    ...(over.withOwnerPort === false ? {} : {
      findArtifactIdentityOwner: vi.fn<NonNullable<WorkerStorage['findArtifactIdentityOwner']>>(ownerPort),
    }),
  };
  const download = vi.fn<SourceAdapter['download']>(async () => complete);
  const adapter: SourceAdapter = { kind: 'engine', download };
  const options: WorkerOptions = {
    storage, github: new MemoryGitHub(), adapters: [adapter],
    repositoryId: 1, branch: 'main',
    ...(over.prePublishCheck ? { prePublishCheck: true } : {}),
  };
  return { storage, options, download, run: () => runDownloadTask(options, lease) };
}

const { canonicalPath: CURRENT_PATH } = snapshotPaths(task.title, task.author);

describe('prepub1102 发布前 identity 落位预检', () => {
  it('a. 既有落位挂在别的书库记录 ⇒ 抓取前直接 failed，adapter/reserve/发布零调用', async () => {
    const { storage, download, run } = fixture({
      prePublishCheck: true,
      owner: { labeledBookId: 3447, repositoryId: 3, branch: 'main', canonicalPath: CURRENT_PATH },
    });
    const result = await run();
    expect(result).toMatchObject({ processed: true, terminal: 'failed', reason: 'ARTIFACT_IDENTITY_CONFLICT' });
    expect(download).not.toHaveBeenCalled();
    expect(storage.reserveArtifactPath).not.toHaveBeenCalled();
    expect(storage.registerArtifact).not.toHaveBeenCalled();
    const written = storage.finish.mock.calls[0][1];
    expect(written.status).toBe('failed');
    // 详情区按码转中文（failcode1102），码必须留在行首原样可读。
    expect(written.error).toContain('ARTIFACT_IDENTITY_CONFLICT');
    expect(written.error).toContain('3447');
  });

  it('b. 路径口径变了 ⇒ 同样 failed，差异文案点名存档路径', async () => {
    const stalePath = 'books/%E5%8F%A6%E4%B8%80%E4%B8%AA%E4%B9%A6%E5%90%8D/index.json';
    const { storage, download, run } = fixture({
      prePublishCheck: true,
      owner: { labeledBookId: task.book_id, repositoryId: 3, branch: 'main', canonicalPath: stalePath },
    });
    const result = await run();
    expect(result).toMatchObject({ terminal: 'failed', reason: 'ARTIFACT_IDENTITY_CONFLICT' });
    expect(download).not.toHaveBeenCalled();
    expect(storage.finish.mock.calls[0][1].error).toContain(stalePath);
  });

  it('c. 无既有落位或与本任务完全一致 ⇒ 照常下载发布', async () => {
    const none = fixture({ prePublishCheck: true, owner: null });
    expect((await none.run()).terminal).toBe('done');
    expect(none.storage.findArtifactIdentityOwner).toHaveBeenCalledOnce();

    const same = fixture({
      prePublishCheck: true,
      owner: { labeledBookId: task.book_id, repositoryId: 1, branch: 'main', canonicalPath: CURRENT_PATH },
    });
    const result = await same.run();
    expect(result.terminal).toBe('done');
    expect(same.storage.reserveArtifactPath).toHaveBeenCalledOnce();
  });

  it('d. 预检关 / storage 未实现 ⇒ 零查询；查询报错 ⇒ fail-open 照常下载', async () => {
    const off = fixture({ owner: { labeledBookId: 3447, repositoryId: 3, branch: 'main', canonicalPath: CURRENT_PATH } });
    expect((await off.run()).terminal).toBe('done');
    expect(off.storage.findArtifactIdentityOwner).not.toHaveBeenCalled();
    expect(off.download).toHaveBeenCalledOnce();

    const noPort = fixture({ prePublishCheck: true, withOwnerPort: false });
    expect((await noPort.run()).terminal).toBe('done');
    expect(noPort.download).toHaveBeenCalledOnce();

    const broken = fixture({ prePublishCheck: true, owner: async () => { throw new Error('synthetic query failure'); } });
    expect((await broken.run()).terminal).toBe('done');
    expect(broken.download).toHaveBeenCalledOnce();
  });
});
