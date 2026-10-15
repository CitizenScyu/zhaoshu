import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// dlfail42 回归：pnpm 锁文件里 cheerio 链解析到 nth-check@2.0.1（CJS-only），Node ESM
// default 导入拿到 namespace 对象 ⇒ cheerio 一切 `:nth-*` 伪类选择器编译即抛（book.qq
// TOC `ul:nth-of-type(2)` 速败根因，池内 75 源受影响）。ts-esm-loader 把裸 'nth-check'
// 重定向到 2.1.1 ESM 入口；本测试钉住该行为，锁文件若漂移回坏组合立即红。
test('nth 伪类选择器经 ts-esm-loader 可用（dlfail42 互操作回归）', () => {
  const out = execFileSync(process.execPath, [
    '--import', pathToFileURL(join(here, 'ts-esm-loader.mjs')).href,
    '--input-type=module', '-e',
    'import * as cheerio from "cheerio";'
    + 'const $ = cheerio.load("<div><ul><li>1</li></ul><ul><li>2</li></ul></div>");'
    + 'console.log($("ul:nth-of-type(2)").length);',
  ], { cwd: repoRoot, encoding: 'utf8' });
  expect(out.trim()).toBe('1');
}, { timeout: 60_000 });
