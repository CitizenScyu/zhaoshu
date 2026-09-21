// T8 回归:readBookText 的路径错位(生产任务 8 被它挡住)。
//
// 真实结构:adapter 传 out=<outRoot>/<adapterHash>,引擎在 out 下**又建一层**自己的
// hash 子目录(scripts/engine-download.mjs:35/150),book.txt 落在 out/<engineHash>/book.txt。
// 旧实现只 join(out, file) ⇒ ENOENT。本文件用真实临时目录摆出该布局(不 mock 路径拼接),
// 断言新实现能读到;并钉住「0 候选/≥2 候选」两种异常要分开报错。
//
// 不依赖本机构建产物:临时目录里手工摆 book.txt,零 gitignore 依赖。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBookText } from './read-book-text';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 't8-readbook-'));
  dirs.push(dir);
  return dir;
}

const ENGINE_HASH = 'a361cf1907c11580ffe2b3ea'; // 形态同生产(24 位 hex),不必是真值

describe('readBookText:引擎子目录布局下的整本读回', () => {
  it('引擎在 out 之下再建一层 hash 子目录 → 读到那个子目录里的 book.txt(旧实现此处 ENOENT)', async () => {
    const out = tempDir();
    // 引擎真实结构:manifest.json 与 book.txt 同在 out/<engineHash>/ 下
    const engineDir = join(out, ENGINE_HASH);
    mkdirSync(engineDir);
    writeFileSync(join(engineDir, 'book.txt'), '整本合成正文', 'utf8');
    writeFileSync(join(engineDir, 'manifest.json'), '{"status":"done"}', 'utf8');
    // 顺带放个无关子目录,验证筛选只看是否含目标文件
    mkdirSync(join(out, 'scratch'));
    await expect(readBookText({ artifact: { file: 'book.txt' } }, { out })).resolves.toBe('整本合成正文');
  });

  it('out 直下命中(扁平布局)→ 直读,不受子目录影响', async () => {
    const out = tempDir();
    writeFileSync(join(out, 'book.txt'), '扁平布局正文', 'utf8');
    mkdirSync(join(out, ENGINE_HASH));
    writeFileSync(join(out, ENGINE_HASH, 'book.txt'), '不应读到这里', 'utf8');
    await expect(readBookText({ artifact: { file: 'book.txt' } }, { out })).resolves.toBe('扁平布局正文');
  });

  it('没有候选 → 报「引擎未写入」,不误报目录结构', async () => {
    const out = tempDir();
    mkdirSync(join(out, ENGINE_HASH));
    await expect(readBookText({ artifact: { file: 'book.txt' } }, { out }))
      .rejects.toThrow(/引擎未写入 book\.txt/);
  });

  it('两个子目录都含目标文件 → 报「目录结构意外」,不猜', async () => {
    const out = tempDir();
    for (const name of [ENGINE_HASH, '0f5b3b311850a22555404938']) {
      mkdirSync(join(out, name));
      writeFileSync(join(out, name, 'book.txt'), name, 'utf8');
    }
    await expect(readBookText({ artifact: { file: 'book.txt' } }, { out }))
      .rejects.toThrow(/目录结构意外/);
  });

  it('out 目录本身不存在 → 报「引擎未写入」,不抛原始 ENOENT', async () => {
    const out = join(tempDir(), 'missing');
    await expect(readBookText({ artifact: { file: 'book.txt' } }, { out }))
      .rejects.toThrow(/引擎未写入 book\.txt/);
  });
});