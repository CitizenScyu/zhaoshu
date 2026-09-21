// T3 验收测试:发布器五阶段(快照卷/清单/规范卷/指针)+ 合成 HTTP 故障注入 + 晋升门槛 + 分卷(设计 v2 §六)。
// 不真实联网:GitHubContents 为内存实现,故障按阶段注入。
import { describe, expect, it } from 'vitest';
import {
  CHARS_PROMOTION_RATIO, CHAPTER_PROMOTION_RATIO, ManifestVersionConflictError, PublicationStageError,
  LeaseLostError, gitBlobSha, manifestIsWorse, publishBookVersion, snapshotPaths, splitBookVolumes,
  type GitHubContents, type PublishCandidate, type SnapshotManifest,
} from './download-publisher';
import { parseTxtChapters } from './txt-chapters';

const TITLE = '测试书';
const AUTHOR = '佚名';
const guardOk = { check: async () => {} };

/** 生成可被 parseTxtChapters 识别的多章正文(每章一行标题 + 正文)。 */
function bookText(chapterCount: number, perChapter = 400): string {
  const lines = [TITLE, AUTHOR, ''];
  for (let i = 0; i < chapterCount; i++) lines.push(`【第${i + 1}章 合成】`, '', '正文'.repeat(perChapter));
  return lines.join('\n');
}

function candidate(overrides: Partial<PublishCandidate> = {}): PublishCandidate {
  return {
    taskId: 42, title: TITLE, author: AUTHOR,
    txt: bookText(3), chaptersDone: 3, chaptersTotal: 3, charsTotal: 2400,
    ...overrides,
  };
}

class MemoryGitHub implements GitHubContents {
  files = new Map<string, string>();
  calls: { path: string; op: 'put' | 'get'; message?: string }[] = [];
  constructor(public failures: Partial<Record<'snapshot' | 'manifest' | 'canonical' | 'pointer', Error>> = {}) {}
  // 阶段识别:按路径形态归类(与 publishBookVersion 的调用顺序无关,靠路径可区分)。
  private matches(stage: string, path: string): boolean {
    if (stage === 'snapshot') return /^books\/\.snapshots\/[^/]+\/v-[a-f0-9]{8}\.txt$/.test(path);
    if (stage === 'manifest') return /^books\/\.snapshots\/[^/]+\/[a-f0-9]{8}\.json$/.test(path);
    if (stage === 'canonical') return /^books\/[^/]+\/(?:vol-\d{3}\.txt|index\.json)$/.test(path);
    return path.endsWith('current.json');
  }
  private check(stage: 'snapshot' | 'manifest' | 'canonical' | 'pointer', path: string): void {
    const failure = this.failures[stage];
    if (failure && this.matches(stage, path)) throw failure;
  }
  async put(path: string, text: string, message: string): Promise<void> {
    this.calls.push({ path, op: 'put', message });
    if (this.matches('snapshot', path)) this.check('snapshot', path);
    if (this.matches('manifest', path)) this.check('manifest', path);
    if (this.matches('canonical', path)) this.check('canonical', path);
    if (path.endsWith('current.json')) this.check('pointer', path);
    this.files.set(path, text);
  }
  async getBytes(path: string): Promise<Buffer | null> {
    this.calls.push({ path, op: 'get' });
    if (this.matches('manifest', path)) this.check('manifest', path);
    if (path.endsWith('current.json')) this.check('pointer', path);
    const text = this.files.get(path);
    return text === undefined ? null : Buffer.from(text, 'utf8');
  }
}

/** 用发布器本身落一份「旧但更好」的版本作为基线,再由候选去比。 */
async function seedPublished(
  github: MemoryGitHub, { chapters, chars, taskId = 41 }: { chapters: number; chars: number; taskId?: number },
) {
  const txt = bookText(chapters, 1000);
  const result = await publishBookVersion(github, guardOk, {
    taskId, title: TITLE, author: AUTHOR, txt, chaptersDone: chapters, chaptersTotal: chapters, charsTotal: chars,
  });
  if (!result.promoted) throw new Error('seed must promote');
  github.calls.length = 0;
  return { version: result.version, seedText: txt, manifest: result.manifest };
}

describe('T3 发布器:五阶段与合成 HTTP 故障', () => {
  it('首次发布按 快照卷→manifest→规范卷→清单→指针 顺序全量落地', async () => {
    const github = new MemoryGitHub();
    const result = await publishBookVersion(github, guardOk, candidate());
    expect(result.promoted).toBe(true);
    const { canonicalPath, dir, volumePath, snapshotVolumePath } = snapshotPaths(TITLE, AUTHOR);
    expect(result.version).toMatch(/^[a-f0-9]{8}$/);
    expect(result.promoted === true && result.snapshotPath).toBe(`${dir}/${result.version}.json`);
    const puts = github.calls.filter(call => call.op === 'put').map(call => call.path);
    const at = (path: string) => puts.indexOf(path);
    // 快照卷在 manifest 前、manifest 在规范卷前、规范卷在清单前、清单在指针前
    const snapshotVolumePath0 = puts.find(path => /^books\/\.snapshots\/[^/]+\/v-[a-f0-9]{8}\.txt$/.test(path))!;
    expect(snapshotVolumePath0).toBeDefined();
    expect(at(snapshotVolumePath0)).toBeLessThan(at(`${dir}/${result.version}.json`));
    expect(at(`${dir}/${result.version}.json`)).toBeLessThan(at(volumePath(0)));
    expect(at(volumePath(0))).toBeLessThan(at(canonicalPath));
    expect(at(canonicalPath)).toBeLessThan(at(`${dir}/current.json`));
    void snapshotVolumePath;
    // 指针内容:current=新版本,history 含它
    const pointer = JSON.parse(github.files.get(`${dir}/current.json`)!);
    expect(pointer.current).toBe(result.version);
    expect(pointer.history).toEqual([result.version]);
    // 快照 manifest 记录 task_id 与完整 hash(快照清单 = 该版本完整描述)
    const manifest = JSON.parse(github.files.get(`${dir}/${result.version}.json`)!);
    expect(manifest.task_id).toBe(42);
    expect(manifest.blob_sha).toBe(result.blobSha);
    // 规范清单是 v2 形状:chapter_index + volumes,规范内容 = 本次候选
    const canonical = JSON.parse(github.files.get(canonicalPath)!);
    expect(canonical.format).toBe('volumes');
    expect(canonical.blob_sha).toBe(result.blobSha);
    expect(canonical.chapter_index.length).toBeGreaterThan(0);
    expect(canonical.volumes.length).toBe(result.promoted === true ? result.volumeCount : -1);
    // 规范卷拼接 === 候选原文(逐字节)
    const joined = canonical.volumes.map((v: { path: string }) => github.files.get(v.path)).join('');
    expect(joined).toBe(candidate().txt);
  });

  it('绝不把快照卷当 getBytes 读(内容寻址幂等 PUT;整本永不读回)', async () => {
    const github = new MemoryGitHub();
    await publishBookVersion(github, guardOk, candidate());
    const snapshotGets = github.calls.filter(
      call => call.op === 'get' && /^books\/\.snapshots\/[^/]+\/v-[a-f0-9]{8}\.txt$/.test(call.path),
    );
    expect(snapshotGets).toHaveLength(0);
  });

  it.each(['snapshot', 'manifest', 'canonical', 'pointer'] as const)(
    '阶段 %s 失败时以阶段错误码抛出且规范/指针不被静默写坏', async stage => {
      const github = new MemoryGitHub({ [stage]: new Error('ECONNRESET') });
      await expect(publishBookVersion(github, guardOk, candidate())).rejects.toBeInstanceOf(PublicationStageError);
      if (stage === 'snapshot' || stage === 'manifest' || stage === 'canonical') {
        // 早期阶段失败:指针零写入(规范清单 = 提交点,不会在指针失败前先落坏)
        expect([...github.files.keys()].some(path => path.endsWith('current.json'))).toBe(false);
      }
    });

  it('同一内容重试:manifest 保留原始字节(task_id/generated_at 不被改写),指针与规范不重写', async () => {
    const github = new MemoryGitHub();
    const first = await publishBookVersion(github, guardOk, candidate());
    expect(first.promoted).toBe(true);
    github.calls.length = 0;
    // 模拟另一个任务重发完全相同的内容
    const second = await publishBookVersion(github, guardOk, candidate({ taskId: 99 }));
    expect(second.promoted).toBe(true);
    const { dir, canonicalPath, snapshotVolumePath } = snapshotPaths(TITLE, AUTHOR);
    const manifest = JSON.parse(github.files.get(`${dir}/${first.version}.json`)!);
    expect(manifest.task_id).toBe(42); // 原始 task_id 保留
    expect(manifest.generated_at).toBe(first.manifest.generated_at);
    // 重试只落快照卷 PUT(幂等内容),manifest/规范/指针全部跳过
    const puts = github.calls.filter(call => call.op === 'put').map(call => call.path);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(/^books\/\.snapshots\/[^/]+\/v-[a-f0-9]{8}\.txt$/);
    void snapshotVolumePath;
    // 规范清单内容未被重写
    expect(JSON.parse(github.files.get(canonicalPath)!).task_id).toBe(42);
  });

  it('同短版本(sha8)不同完整 hash 拒绝写入:ManifestVersionConflict', async () => {
    const github = new MemoryGitHub();
    const { dir } = snapshotPaths(TITLE, AUTHOR);
    const real = candidate();
    const realVersion = gitBlobSha(real.txt).slice(0, 8);
    // 恶意/损坏现场:同 sha8 目录已有一个指向其他完整 hash 的 manifest
    github.files.set(`${dir}/${realVersion}.json`, JSON.stringify({
      version: realVersion, blob_sha: 'f'.repeat(40), chapters: 3, chars: 2400,
    }, null, 2) + '\n');
    await expect(publishBookVersion(github, guardOk, real)).rejects.toBeInstanceOf(ManifestVersionConflictError);
    expect([...github.files.keys()].some(path => path.endsWith('current.json'))).toBe(false);
  });

  it('90%/70% 门槛:旧 100 章候选 80 章 → 不晋升,规范与指针保持旧版,快照留档', async () => {
    const github = new MemoryGitHub();
    const seeded = await seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false, reason: 'superseded_by_incomplete' });
    const { canonicalPath, dir } = snapshotPaths(TITLE, AUTHOR);
    // 规范清单内容 = 旧版(未被覆盖)
    expect(JSON.parse(github.files.get(canonicalPath)!).blob_sha).toBe(gitBlobSha(seeded.seedText));
    // 指针仍指向旧版本
    expect(JSON.parse(github.files.get(`${dir}/current.json`)!).current).toBe(seeded.version);
    // 候选快照 manifest 留档(供人工晋升)
    expect(JSON.parse(github.files.get(`${dir}/${result.version}.json`)!).chapters).toBe(80);
    // 零规范/指针 PUT
    const canonicalPuts = github.calls.filter(call => call.op === 'put' && call.path === canonicalPath);
    const pointerPuts = github.calls.filter(call => call.op === 'put' && call.path.endsWith('current.json'));
    expect(canonicalPuts).toHaveLength(0);
    expect(pointerPuts).toHaveLength(0);
  });

  it('门槛边界:章数比恰 0.9 且字数比 ≥0.7 → 晋升;字数比 <0.7 单独触发拒绝', async () => {
    const ok = new MemoryGitHub();
    await seedPublished(ok, { chapters: 100, chars: 80_000 });
    const promoted = await publishBookVersion(ok, guardOk, candidate({ chaptersDone: 90, chaptersTotal: 90, charsTotal: 72_000 }));
    expect(promoted.promoted).toBe(true);
    const worse = new MemoryGitHub();
    await seedPublished(worse, { chapters: 100, chars: 76_000 });
    const rejected = await publishBookVersion(worse, guardOk, candidate({ chaptersDone: 95, chaptersTotal: 95, charsTotal: 52_250 }));
    expect(rejected).toMatchObject({ promoted: false, reason: 'superseded_by_incomplete' });
    expect(CHAPTER_PROMOTION_RATIO).toBe(0.9);
    expect(CHARS_PROMOTION_RATIO).toBe(0.7);
  });

  it('正常晋升:旧 50 章新 60 章 → 规范更新、指针前移、history 含两代', async () => {
    const github = new MemoryGitHub();
    const seeded = await seedPublished(github, { chapters: 50, chars: 50 * 800 });
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 60, chaptersTotal: 60, charsTotal: 48_000 }));
    expect(result.promoted).toBe(true);
    const { canonicalPath, dir } = snapshotPaths(TITLE, AUTHOR);
    expect(JSON.parse(github.files.get(canonicalPath)!).blob_sha).toBe(gitBlobSha(candidate().txt));
    const pointer = JSON.parse(github.files.get(`${dir}/current.json`)!);
    expect(pointer.current).toBe(result.version);
    expect(pointer.history).toEqual(expect.arrayContaining([seeded.version, result.version]));
  });

  it('指针损坏(current.json 坏 JSON)→ 阶段错误,绝不静默放行覆盖', async () => {
    const github = new MemoryGitHub();
    const { dir } = snapshotPaths(TITLE, AUTHOR);
    github.files.set(`${dir}/current.json`, 'not-json{{');
    await expect(publishBookVersion(github, guardOk, candidate())).rejects.toMatchObject({
      name: 'PublicationStageError', stage: 'pointer',
    });
  });

  it('无指针但规范清单已有旧版本(历史现场)→ 兜底对账按清单 version 找回旧 manifest 仍拒更差候选', async () => {
    const github = new MemoryGitHub();
    const seeded = await seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const { dir } = snapshotPaths(TITLE, AUTHOR);
    github.files.delete(`${dir}/current.json`); // 模拟指针丢失
    github.calls.length = 0;
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false });
    // 找回的 oldManifest 正是规范清单自述 version 对应的快照 manifest
    expect(result.promoted === false && result.oldManifest?.chapters).toBe(100);
    // v2 分支:先读规范清单的 version,再取 `${dir}/${version}.json`(不是内容 hash)
    expect(github.calls.some(call => call.op === 'get' && call.path === `${dir}/${seeded.version}.json`)).toBe(true);
  });

  it('指针 current 畸形(合法 JSON 但非 8-hex)→ 同「指针不可用」走兜底对账,不降级晋升保护', async () => {
    const github = new MemoryGitHub();
    await seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const { dir } = snapshotPaths(TITLE, AUTHOR);
    github.files.set(`${dir}/current.json`, JSON.stringify({ current: 'not-a-version', history: [] }));
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false });
    expect(result.promoted === false && result.oldManifest?.chapters).toBe(100);
  });

  it('指针 current 非字符串(合法 JSON)→ 同「指针不可用」走兜底(非硬失败),晋升保护仍在', async () => {
    const github = new MemoryGitHub();
    const seeded = await seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const { dir } = snapshotPaths(TITLE, AUTHOR);
    github.files.set(`${dir}/current.json`, JSON.stringify({ current: 5, history: [seeded.version] }));
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false });
    expect(result.promoted === false && result.oldManifest?.chapters).toBe(100);
  });

  it('指针 history 非数组(合法 JSON)→ 兜底且不透传坏 history,新指针 history 干净', async () => {
    const github = new MemoryGitHub();
    const { dir } = snapshotPaths(TITLE, AUTHOR);
    // current 是合法 8-hex、但 history 是字符串(非数组);无规范旧文件 → 兜底后正常晋升。
    github.files.set(`${dir}/current.json`, JSON.stringify({ current: 'aaaaaaaa', history: 'polluted' }));
    const result = await publishBookVersion(github, guardOk, candidate());
    expect(result.promoted).toBe(true);
    const pointer = JSON.parse(github.files.get(`${dir}/current.json`)!);
    expect(pointer.history).toEqual([result.version]);
    expect(pointer.history).not.toContain('p');
  });

  it('size_limit 预检:超限在第一个 PUT 之前失败(零 PUT 零 GET)', async () => {
    const github = new MemoryGitHub();
    // 仅测试注入 maxBookBytes;生产上限 64 MiB,这里收缩到 1 MiB 触发同一预检分支。
    const big = candidate({ txt: bookText(1, 500_000) }); // 单章正文约 1.5 MiB > 1 MiB 上限
    await expect(publishBookVersion(github, guardOk, big, { maxBookBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ stage: 'snapshot', detail: 'size_limit' });
    expect(github.calls).toHaveLength(0);
  });

  it('任一阶段写前失租约 → LeaseLostError 原样上抛,后续阶段不再执行', async () => {
    const github = new MemoryGitHub();
    let calls = 0;
    const guard = { check: async () => { if (++calls === 1) throw new LeaseLostError(); } };
    await expect(publishBookVersion(github, guard, candidate())).rejects.toBeInstanceOf(LeaseLostError);
    expect(github.calls).toHaveLength(0); // 零 PUT 零 GET
    const guard2 = { check: async () => { if (++calls === 3) throw new LeaseLostError(); } };
    await expect(publishBookVersion(github, guard2, candidate())).rejects.toBeInstanceOf(LeaseLostError);
    expect([...github.files.keys()].some(path => path.endsWith('current.json'))).toBe(false);
  });

  it('manifestIsWorse 纯函数:缺失/畸形旧 manifest 不拒绝(不锁死存量书)', () => {
    const current = { chaptersDone: 1, charsTotal: 1 };
    expect(manifestIsWorse(null, current)).toBe(false);
    expect(manifestIsWorse({ version: 'v', blob_sha: 'x', chapters: 0, chars: 0 } as SnapshotManifest, current)).toBe(false);
    expect(manifestIsWorse({ version: 'v', blob_sha: 'x', chapters: 10, chars: 1000 } as SnapshotManifest, { chaptersDone: 10, charsTotal: 699 })).toBe(true);
  });
});

describe('分卷切分(splitBookVolumes;设计 v2 §六)', () => {
  it('按章贪心装箱:卷边界落在章起点,卷拼接 === 原文逐字节', () => {
    // 4 章、每章约 2400 B;软目标 4 KiB → 每卷约 1 章(2 章 = 4.8 KiB > 4 KiB)。
    const txt = bookText(4, 400); // 每章 '正文'.repeat(400) = 2400 B
    const buf = Buffer.from(txt, 'utf8');
    const chapters = parseTxtChapters(buf);
    const ranges = splitBookVolumes(buf, chapters, 4096);
    expect(ranges.length).toBeGreaterThan(1);
    // 首尾相接且覆盖整本
    expect(ranges[0].startByte).toBe(0);
    expect(ranges.at(-1)!.endByte).toBe(buf.byteLength);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].startByte).toBe(ranges[i - 1].endByte);
    // 拼接无损
    const joined = Buffer.concat(ranges.map(r => buf.subarray(r.startByte, r.endByte)));
    expect(joined.equals(buf)).toBe(true);
    // 每个卷边界(除首)落在某章起点
    const chapterStarts = new Set(chapters.map(c => c.startByte));
    for (let i = 1; i < ranges.length; i++) expect(chapterStarts.has(ranges[i].startByte)).toBe(true);
  });

  it('单章 > 软目标但 ≤ 硬上限 → 独占一卷(不切开)', () => {
    // 无前言单章:整本 ≈ 24 KB > 软目标 8 KiB,但远小于 16 MiB 硬上限 ⇒ 一卷。
    const txt = '【第1章 合成】\n\n' + '正文'.repeat(4000);
    const buf = Buffer.from(txt, 'utf8');
    const chapters = parseTxtChapters(buf);
    expect(chapters).toHaveLength(1);
    const ranges = splitBookVolumes(buf, chapters, 8192);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].endByte - ranges[0].startByte).toBe(buf.byteLength);
  });

  it('注入 maxVolumeBytes=1 MiB:Σvolumes.bytes===bytes、拼接字节===输入、每卷 ≤ 软目标', async () => {
    const github = new MemoryGitHub();
    // 3 章,每章约 420 KB ⇒ 整本 > 1 MiB,软目标 1 MiB ⇒ 至少 2 卷。
    const txt = bookText(3, 70_000);
    const buf = Buffer.from(txt, 'utf8');
    expect(buf.byteLength).toBeGreaterThan(1024 * 1024);
    const result = await publishBookVersion(github, guardOk,
      candidate({ txt, chaptersDone: 3, chaptersTotal: 3 }), { maxVolumeBytes: 1024 * 1024 });
    expect(result.promoted).toBe(true);
    const { canonicalPath } = snapshotPaths(TITLE, AUTHOR);
    const canonical = JSON.parse(github.files.get(canonicalPath)!);
    // Σvolumes.bytes === 全书字节
    const sum = canonical.volumes.reduce((acc: number, v: { bytes: number }) => acc + v.bytes, 0);
    expect(sum).toBe(buf.byteLength);
    expect(canonical.bytes).toBe(buf.byteLength);
    expect(canonical.volumes.length).toBeGreaterThan(1);
    // 拼接字节 === 输入(逐字节)
    const joined = canonical.volumes.map((v: { path: string }) => github.files.get(v.path)).join('');
    expect(joined).toBe(txt);
    // 每卷 ≤ 软目标(这些是整章装箱卷,不会触硬上限)
    for (const v of canonical.volumes as { bytes: number }[]) expect(v.bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('>maxBookBytes:第一个 PUT 之前失败,零 PUT 零 GET', async () => {
    const github = new MemoryGitHub();
    const big = candidate({ txt: bookText(1, 500_000) }); // 单章正文约 1.5 MiB > 1 MiB
    await expect(publishBookVersion(github, guardOk, big, { maxBookBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ stage: 'snapshot', detail: 'size_limit' });
    expect(github.calls.filter(c => c.op === 'put')).toHaveLength(0);
    expect(github.calls.filter(c => c.op === 'get')).toHaveLength(0);
  });

  it('同内容重试:规范/清单/指针区零 PUT(只有内容寻址快照卷 PUT)', async () => {
    const github = new MemoryGitHub();
    const first = await publishBookVersion(github, guardOk, candidate());
    expect(first.promoted).toBe(true);
    github.calls.length = 0;
    const second = await publishBookVersion(github, guardOk, candidate({ taskId: 99 }));
    expect(second.promoted).toBe(true);
    const { dir, canonicalPath } = snapshotPaths(TITLE, AUTHOR);
    const isnapshot = (p: string) => /^books\/\.snapshots\/[^/]+\/v-[a-f0-9]{8}\.txt$/.test(p);
    const nonSnapshotPuts = github.calls.filter(c => c.op === 'put' && !isnapshot(c.path));
    // 规范卷 / manifest / 清单 / 指针一律不重写(清单最后写 = 提交点,重试不重提交)
    expect(nonSnapshotPuts).toHaveLength(0);
    expect(nonSnapshotPuts.some(c => c.path === canonicalPath)).toBe(false);
    expect(github.calls.some(c => c.op === 'put' && c.path.endsWith('current.json'))).toBe(false);
    void dir;
  });

  it('更差候选:规范清单零写、指针零写,候选快照 manifest 留档', async () => {
    const github = new MemoryGitHub();
    await seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    github.calls.length = 0;
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false, reason: 'superseded_by_incomplete' });
    const { canonicalPath, dir } = snapshotPaths(TITLE, AUTHOR);
    const writes = github.calls.filter(c => c.op === 'put' && (c.path === canonicalPath || c.path.endsWith('current.json')));
    expect(writes).toHaveLength(0); // 规范区与指针零写
    // 候选快照 manifest 留档(够人工晋升)
    expect(github.files.has(`${dir}/${result.version}.json`)).toBe(true);
    expect(JSON.parse(github.files.get(`${dir}/${result.version}.json`)!).chapters).toBe(80);
  });

  it('fallbackBaseline 的 v2 JSON 分支:指针缺失时按规范清单自述 version 找回旧 manifest', async () => {
    const github = new MemoryGitHub();
    const seeded = await seedPublished(github, { chapters: 100, chars: 100 * 2000 });
    const { dir, canonicalPath } = snapshotPaths(TITLE, AUTHOR);
    github.files.delete(`${dir}/current.json`); // 指针丢失
    github.calls.length = 0;
    const result = await publishBookVersion(github, guardOk, candidate({ chaptersDone: 80, chaptersTotal: 80 }));
    expect(result).toMatchObject({ promoted: false });
    // v2 分支:读规范清单 JSON 的 version → 取 `${dir}/${version}.json`,不是内容 hash
    expect(github.calls.some(c => c.op === 'get' && c.path === canonicalPath)).toBe(true);
    expect(github.calls.some(c => c.op === 'get' && c.path === `${dir}/${seeded.version}.json`)).toBe(true);
    expect(result.promoted === false && result.oldManifest?.chapters).toBe(100);
  });

  it('单章 > 16 MiB 硬上限 → 按行/码点边界切开,该章跨卷', () => {
    // 无标题 ⇒ 整本一章「正文」,总量 > 16 MiB ⇒ 触发硬上限切分。
    const line = 'x'.repeat(79) + '\n';
    const total = 16 * 1024 * 1024 + 4096;
    const txt = line.repeat(Math.ceil(total / line.length));
    const buf = Buffer.from(txt, 'utf8');
    const chapters = parseTxtChapters(buf, 64 * 1024 * 1024);
    expect(chapters).toHaveLength(1);
    const ranges = splitBookVolumes(buf, chapters, 8 * 1024 * 1024);
    expect(ranges.length).toBeGreaterThan(1);
    // 拼接无损,且每卷 ≤ 硬上限
    const joined = Buffer.concat(ranges.map(r => buf.subarray(r.startByte, r.endByte)));
    expect(joined.equals(buf)).toBe(true);
    for (const r of ranges) expect(r.endByte - r.startByte).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
