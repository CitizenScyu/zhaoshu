// T3 验收测试：发布器五阶段（快照/manifest/规范/指针）+ 合成 HTTP 故障注入 + 晋升门槛。
// 不真实联网：GitHubContents 为内存实现，故障按阶段注入。
import { describe, expect, it } from 'vitest';
import {
  CHARS_PROMOTION_RATIO, CHAPTER_PROMOTION_RATIO, ManifestVersionConflictError, PublicationStageError,
  LeaseLostError, gitBlobSha, manifestIsWorse, publishBookVersion, snapshotPaths,
  type GitHubContents, type SnapshotManifest,
} from './download-publisher';

class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  calls: { path: string; op: 'put' | 'get'; message?: string }[] = [];
  constructor(public failures: Partial<Record<'snapshot' | 'manifest' | 'canonical' | 'pointer', Error>> = {}) {}
  private check(stage: 'snapshot' | 'manifest' | 'canonical' | 'pointer', path: string): void {
    // 阶段识别：按路径形态归类（与 publishBookVersion 的调用顺序无关，靠路径可区分）。
    const failure = this.failures[stage];
    if (failure && this.matches(stage, path)) throw failure;
  }
  private matches(stage: string, path: string): boolean {
    if (stage === 'snapshot') return /^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.txt$/.test(path);
    if (stage === 'manifest') return /^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.json$/.test(path);
    if (stage === 'canonical') return /^books\/[^/]+\.txt$/.test(path);
    return path.endsWith('current.json');
  }
  async put(path: string, text: string, message: string): Promise<void> {
    this.calls.push({ path, op: 'put', message });
    if (/^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.txt$/.test(path)) this.check('snapshot', path);
    if (/^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.json$/.test(path)) this.check('manifest', path);
    if (/^books\/[^/]+\.txt$/.test(path)) this.check('canonical', path);
    if (path.endsWith('current.json')) this.check('pointer', path);
    this.files.set(path, text);
  }
  async getBytes(path: string): Promise<Buffer | null> {
    this.calls.push({ path, op: 'get' });
    if (/^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.json$/.test(path)) this.check('manifest', path);
    if (path.endsWith('current.json')) this.check('pointer', path);
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

const guardOk = { check: async () => {} };

function candidate(overrides: Partial<Parameters<typeof publishBookVersion>[2]> = {}) {
  return {
    taskId: 42, title: '测试书', author: '佚名',
    txt: ['测试书', '佚名', '', '【第1章 合成】\n\n' + '正文'.repeat(400)].join('\n'),
    chaptersDone: 3, chaptersTotal: 3, charsTotal: 2400,
    ...overrides,
  };
}

function seedPublished(github: MemoryGitHub, { chapters, chars, taskId = 41 }: { chapters: number; chars: number; taskId?: number }) {
  const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
  const seedText = ['测试书', '佚名', '', ...Array.from({ length: chapters }, (_, i) => `【第${i + 1}章 旧版。】\n\n${'旧版正文'.repeat(500)}`)].join('\n');
  const blobSha = gitBlobSha(seedText);
  const version = blobSha.slice(0, 8);
  const manifest: SnapshotManifest = {
    version, blob_sha: blobSha, chapters, chapters_total: chapters, chars,
    generated_at: '2026-09-01T00:00:00Z', task_id: taskId,
  };
  github.files.set(`${dir}/${version}.txt`, seedText);
  github.files.set(`${dir}/${version}.json`, JSON.stringify(manifest, null, 2) + '\n');
  github.files.set(`${dir}/current.json`, JSON.stringify({ current: version, history: [version] }, null, 2) + '\n');
  github.files.set(canonicalPath, seedText);
  return { version, blobSha, seedText, manifest };
}

describe('T3 发布器：五阶段与合成 HTTP 故障', () => {
  it('首次发布按 快照→manifest→规范→指针 顺序全量落地', async () => {
    const github = new MemoryGitHub();
    const result = await publishBookVersion(github, guardOk, candidate());
    expect(result.promoted).toBe(true);
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    expect(result.version).toMatch(/^[a-f0-9]{8}$/);
    const puts = github.calls.filter(call => call.op === 'put').map(call => call.path);
    // 顺序断言：快照在 manifest 前、manifest 在规范前、规范在指针前
    const at = (path: string) => puts.indexOf(path);
    expect(at(`${dir}/${result.version}.txt`)).toBeLessThan(at(`${dir}/${result.version}.json`));
    expect(at(`${dir}/${result.version}.json`)).toBeLessThan(at(canonicalPath));
    expect(at(canonicalPath)).toBeLessThan(at(`${dir}/current.json`));
    // 指针内容：current=新版本，history 含它
    const pointer = JSON.parse(github.files.get(`${dir}/current.json`)!);
    expect(pointer.current).toBe(result.version);
    expect(pointer.history).toEqual([result.version]);
    // manifest 记录 task_id 与完整 hash
    const manifest = JSON.parse(github.files.get(`${dir}/${result.version}.json`)!);
    expect(manifest.task_id).toBe(42);
    expect(manifest.blob_sha).toBe(result.blobSha);
    // 快照内容 = 规范内容
    expect(github.files.get(`${dir}/${result.version}.txt`)).toBe(github.files.get(canonicalPath));
  });

  it.each(['snapshot', 'manifest', 'canonical', 'pointer'] as const)('阶段 %s 失败时以阶段错误码抛出且规范/指针不被静默写坏', async stage => {
    const github = new MemoryGitHub({ [stage]: new Error('ECONNRESET') });
    await expect(publishBookVersion(github, guardOk, candidate())).rejects.toBeInstanceOf(PublicationStageError);
    if (stage === 'snapshot' || stage === 'manifest') {
      // 早期阶段失败：规范路径与指针零写入（partial/失败候选零发布）
      expect([...github.files.keys()].some(path => /^books\/[^/]+\.txt$/.test(path))).toBe(false);
      expect([...github.files.keys()].some(path => path.endsWith('current.json'))).toBe(false);
    }
    const error = await publishBookVersion(github, guardOk, candidate()).catch(e => e as PublicationStageError);
    expect(error).toBeInstanceOf(PublicationStageError);
  });

  it('同一内容重试：manifest 保留原始字节（task_id/generated_at 不被改写），指针与规范不重写', async () => {
    const github = new MemoryGitHub();
    const first = await publishBookVersion(github, guardOk, candidate());
    expect(first.promoted).toBe(true);
    github.calls.length = 0;
    // 模拟另一个任务重发完全相同的内容
    const second = await publishBookVersion(github, guardOk, candidate({ taskId: 99 }));
    expect(second.promoted).toBe(true);
    const { dir, canonicalPath } = snapshotPaths('测试书', '佚名');
    const manifestBytes = github.files.get(`${dir}/${first.version}.json`)!;
    const manifest = JSON.parse(manifestBytes);
    expect(manifest.task_id).toBe(42); // 原始 task_id 保留
    expect(manifest.generated_at).toBe(first.manifest.generated_at);
    // 重试只落快照 PUT（幂等内容），manifest/规范/指针全部跳过
    const puts = github.calls.filter(call => call.op === 'put').map(call => call.path);
    expect(puts).toEqual([`${dir}/${first.version}.txt`]);
    expect(github.files.get(canonicalPath)).toBe(candidate().txt);
  });

  it('同短版本（sha8）不同完整 hash 拒绝写入：ManifestVersionConflict', async () => {
    const github = new MemoryGitHub();
    const { dir } = snapshotPaths('测试书', '佚名');
    const real = candidate();
    const realVersion = gitBlobSha(real.txt).slice(0, 8);
    // 恶意/损坏现场：同 sha8 目录已有一个指向其他完整 hash 的 manifest
    github.files.set(`${dir}/${realVersion}.json`, JSON.stringify({
      version: realVersion, blob_sha: 'f'.repeat(40), chapters: 3, chars: 2400,
    }, null, 2) + '\n');
    await expect(publishBookVersion(github, guardOk, real)).rejects.toBeInstanceOf(ManifestVersionConflictError);
    // 规范与指针零写入
    expect([...github.files.keys()].some(path => path.endsWith('current.json'))).toBe(false);
  });

  it('90%/70% 门槛：旧 100 章候选 80 章 → 不晋升，规范与指针保持旧版，快照留档', async () => {
    const github = new MemoryGitHub();
    const seeded = seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false, reason: 'superseded_by_incomplete' });
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    // 规范路径内容 = 旧版（未被覆盖）
    expect(github.files.get(canonicalPath)).toBe(seeded.seedText);
    // 指针仍指向旧版本
    expect(JSON.parse(github.files.get(`${dir}/current.json`)!).current).toBe(seeded.version);
    // 候选快照与 manifest 留档（供人工晋升）
    expect(github.files.has(`${dir}/${result.version}.txt`)).toBe(true);
    expect(JSON.parse(github.files.get(`${dir}/${result.version}.json`)!).chapters).toBe(80);
    // 零规范/指针 PUT
    const canonicalPuts = github.calls.filter(call => call.op === 'put' && call.path === canonicalPath);
    const pointerPuts = github.calls.filter(call => call.op === 'put' && call.path.endsWith('current.json'));
    expect(canonicalPuts).toHaveLength(0);
    expect(pointerPuts).toHaveLength(0);
  });

  it('门槛边界：章数比恰 0.9 且字数比 ≥0.7 → 晋升；字数比 <0.7 单独触发拒绝', async () => {
    // 章数 90/100 = 0.9（不低于阈值）、字数 72000/80000 = 0.9 → 晋升
    const ok = new MemoryGitHub();
    seedPublished(ok, { chapters: 100, chars: 80_000 });
    const promoted = await publishBookVersion(ok, guardOk, candidate({ chaptersDone: 90, chaptersTotal: 90, charsTotal: 72_000 }));
    expect(promoted.promoted).toBe(true);
    // 字数 52250/76000 ≈ 0.6875 < 0.7（章数 95/100 = 0.95 过线）→ 拒绝
    const worse = new MemoryGitHub();
    seedPublished(worse, { chapters: 100, chars: 76_000 });
    const rejected = await publishBookVersion(worse, guardOk, candidate({ chaptersDone: 95, chaptersTotal: 95, charsTotal: 52_250 }));
    expect(rejected).toMatchObject({ promoted: false, reason: 'superseded_by_incomplete' });
    expect(CHAPTER_PROMOTION_RATIO).toBe(0.9);
    expect(CHARS_PROMOTION_RATIO).toBe(0.7);
  });

  it('正常晋升：旧 50 章新 60 章 → 规范更新、指针前移、history 含两代', async () => {
    const github = new MemoryGitHub();
    const seeded = seedPublished(github, { chapters: 50, chars: 50 * 800 });
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 60, chaptersTotal: 60, charsTotal: 48_000 }));
    expect(result.promoted).toBe(true);
    const { canonicalPath, dir } = snapshotPaths('测试书', '佚名');
    expect(github.files.get(canonicalPath)).toBe(candidate().txt);
    const pointer = JSON.parse(github.files.get(`${dir}/current.json`)!);
    expect(pointer.current).toBe(result.version);
    expect(pointer.history).toEqual(expect.arrayContaining([seeded.version, result.version]));
  });

  it('指针损坏（current.json 坏 JSON）→ 阶段错误，绝不静默放行覆盖', async () => {
    const github = new MemoryGitHub();
    const { dir } = snapshotPaths('测试书', '佚名');
    github.files.set(`${dir}/current.json`, 'not-json{{');
    await expect(publishBookVersion(github, guardOk, candidate())).rejects.toMatchObject({
      name: 'PublicationStageError', stage: 'pointer',
    });
  });

  it('无指针但规范路径已有旧文件（历史现场）→ 兜底对账找回旧 manifest 仍能拒绝更差候选', async () => {
    const github = new MemoryGitHub();
    const seeded = seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const { dir } = snapshotPaths('测试书', '佚名');
    github.files.delete(`${dir}/current.json`); // 模拟指针丢失
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false });
    // 找回的 oldManifest 正是规范路径内容对应的快照 manifest
    expect(result.promoted === false && result.oldManifest?.chapters).toBe(100);
    void seeded;
  });

  it('指针 current 畸形（合法 JSON 但非 8-hex）→ 同「指针不可用」走兜底对账，不降级晋升保护', async () => {
    const github = new MemoryGitHub();
    seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const { dir } = snapshotPaths('测试书', '佚名');
    // 原实现（zhaoshu-books worker）对「指针在但 current 不可用」一律走规范路径内容 hash 兜底；
    // 直接返回 manifest:null 会让 manifestIsWorse 恒 false → 80 章更差候选覆盖 100 章规范路径。
    github.files.set(`${dir}/current.json`, JSON.stringify({ current: 'not-a-version', history: [] }));
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false });
    expect(result.promoted === false && result.oldManifest?.chapters).toBe(100);
  });

  it('15 MiB 预检：超限在第一个 PUT 之前失败', async () => {
    const github = new MemoryGitHub();
    const huge = 'x'.repeat(15 * 1024 * 1024 + 1);
    await expect(publishBookVersion(github, guardOk, candidate({ txt: huge })))
      .rejects.toMatchObject({ stage: 'snapshot', detail: 'size_limit' });
    expect(github.calls).toHaveLength(0);
  });

  it('任一阶段写前失租约 → LeaseLostError 原样上抛，后续阶段不再执行', async () => {
    const github = new MemoryGitHub();
    let calls = 0;
    const guard = {
      check: async () => {
        if (++calls === 1) throw new LeaseLostError(); // 快照写前失权
      },
    };
    await expect(publishBookVersion(github, guard, candidate())).rejects.toBeInstanceOf(LeaseLostError);
    expect(github.calls).toHaveLength(0); // 零 PUT 零 GET
    // manifest 阶段前失权：快照已落（内容寻址幂等），但后续零写
    const guard2 = { check: async () => { if (++calls === 3) throw new LeaseLostError(); } };
    await expect(publishBookVersion(github, guard2, candidate())).rejects.toBeInstanceOf(LeaseLostError);
    const putsAfter = github.calls.filter(call => call.op === 'put').map(call => call.path);
    expect(putsAfter.every(path => /^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.txt$/.test(path))).toBe(true);
    expect([...github.files.keys()].some(path => path.endsWith('current.json'))).toBe(false);
  });

  it('manifestIsWorse 纯函数：缺失/畸形旧 manifest 不拒绝（不锁死存量书）', () => {
    const current = { chaptersDone: 1, charsTotal: 1 };
    expect(manifestIsWorse(null, current)).toBe(false);
    expect(manifestIsWorse({ version: 'v', blob_sha: 'x', chapters: 0, chars: 0 }, current)).toBe(false);
    expect(manifestIsWorse({ version: 'v', blob_sha: 'x', chapters: 10, chars: 1000 }, { chaptersDone: 10, charsTotal: 699 })).toBe(true);
  });
});
