// T8 接线：readBookText —— 引擎 adapter 读完后的整本读回。
// book.txt 由 engine-download.mjs 在校验通过后原子写入 out 目录（artifact.file 恒为 book.txt）。

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function readBookText(
  manifest: { artifact: { file: string } },
  options: { out: string },
): Promise<string> {
  const file = basename(manifest.artifact.file);
  return readFile(join(options.out, file), 'utf8');
}
