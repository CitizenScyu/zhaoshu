// engine-fetch.mjs 契约测试（T4）。CLI 是装配层：mock DB/网络太重，这里只钉「契约」——
// 参数解析、退出码、stdout 只放数据、凭据不外泄。全部走不依赖外网的路径（无 DATABASE_URL /
// 参数错 / URL 非法，都在任何 DB/fetch 之前返回）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
// --import 需要 file:// URL：Windows 下裸绝对路径 `D:\...` 会被当成协议 `d:`（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const hook = pathToFileURL(resolve(scriptsDir, 'ts-esm-loader.mjs')).href;
const cli = resolve(scriptsDir, 'engine-fetch.mjs');

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env };
  // 无 DATABASE_URL 分支：显式删掉继承来的值。
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const r = spawnSync(process.execPath, ['--import', hook, cli, ...args], {
    cwd: repoRoot, env: childEnv, encoding: 'utf8',
  });
  // strip-types/typeless 的 stderr 噪声不参与断言。
  const noise = /Experimental|trace-warnings|MODULE_TYPELESS|Reparsing|add "type"/;
  const stderr = r.stderr.split('\n').filter((l) => !noise.test(l)).join('\n').trim();
  return { status: r.status, stdout: r.stdout.trim(), stderr };
}

describe('engine-fetch CLI 契约', () => {
  it('无 DATABASE_URL → 退出码 2，stderr 点名 DATABASE_URL，stdout 空', () => {
    const r = run(['search', '--title', 'X'], { DATABASE_URL: undefined });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DATABASE_URL');
    expect(r.stdout).toBe('');
  });

  it('未知子命令 → 退出码 2', () => {
    const r = run(['frobnicate'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知子命令');
    expect(r.stdout).toBe('');
  });

  it('未知参数 → 退出码 2', () => {
    const r = run(['search', '--title', 'X', '--bogus'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知参数');
  });

  it('search 缺 --title → 退出码 2', () => {
    const r = run(['search'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--title');
  });

  it('toc 缺 --url → 退出码 2', () => {
    const r = run(['toc'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--url');
  });

  it('content 缺 --url → 退出码 2', () => {
    const r = run(['content'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--url');
  });

  it('content --url 非法 → 退出码 2（DB/fetch 之前返回）', () => {
    const r = run(['content', '--url', 'not a url'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('host');
  });

  it('🔴 凭据红线：任何错误路径的 stdout/stderr 都不含连接串/口令', () => {
    const secret = 'postgres://leak_user:leak_secret@db.internal.example/finder';
    const r = run(['content', '--url', 'not a url'], { DATABASE_URL: secret });
    expect(r.status).toBe(2);
    for (const stream of [r.stdout, r.stderr]) {
      expect(stream).not.toContain('leak_secret');
      expect(stream).not.toContain('leak_user');
      expect(stream).not.toContain(secret);
    }
  });
});
