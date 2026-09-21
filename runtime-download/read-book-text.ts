// T8 接线:readBookText —— 引擎 adapter 读完后的整本读回。
//
// 落盘位置(engine-download.mjs:35,行号对应当前仓库):
//   const dir = resolve(args.out ?? 'engine-download',
//     hash(args.source + canonicalBookKey(args.title, args.author)).slice(0, 24));
// 即引擎在 adapter 传入的 args.out **之下再建一层自己的 hash 子目录**,book.txt/manifest.json
// 都写在那层里(engine-download.mjs:150)。
//
// adapter 侧的 out(src/lib/download-worker.ts:360)用的是另一套输入
// `${source_url}|${title}|${author}`,与引擎的 `source + canonicalBookKey(title,author)` 不同,
// 两个 hash 不相等。所以「out/book.txt」必然 ENOENT(生产实证:任务 8 十/十章全下完、
// book.txt 260880 字节已落 out/<engineHash>/book.txt,仍 failed = ENOENT out/book.txt)。
//
// 修法:不在 adapter 侧重算引擎 hash(canonicalBookKey 的规范化在引擎侧,复刻必漂移),
// 而是在 out 直下未命中时,退一步找 out 下**唯一**含目标文件的子目录。三种结果分别报错,
// 便于区分「引擎没写文件」与「目录结构意外」:
//   - 恰好 1 个候选 → 读它;
//   - 0 个          → 引擎未写入;
//   - ≥2 个         → 目录结构意外。

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function readBookText(
  manifest: { artifact: { file: string } },
  options: { out: string },
): Promise<string> {
  const file = basename(manifest.artifact.file);
  // 直下命中:兼容引擎未来的扁平布局,也让本函数的行为对既有调用保持不变。
  const direct = join(options.out, file);
  if (existsSync(direct)) return readFile(direct, 'utf8');

  let entries;
  try {
    entries = await readdir(options.out, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`read_book_text: 结果目录不存在(${options.out}),引擎未写入 ${file}`);
    }
    throw error;
  }
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(options.out, entry.name))
    .filter(dir => existsSync(join(dir, file)));
  if (candidates.length === 1) return readFile(join(candidates[0], file), 'utf8');
  if (candidates.length === 0) {
    throw new Error(`read_book_text: 引擎未写入 ${file}(out 直下与各子目录内均无此文件)`);
  }
  throw new Error(`read_book_text: 目录结构意外,out 下有 ${candidates.length} 个子目录含 ${file}`);
}
