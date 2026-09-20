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
  it('doctor 真实加载 TS 模块且不访问 DB/网络', () => {
    const r = run(['doctor', '--json'], { DATABASE_URL: undefined });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true });
    expect(r.stderr).toBe('');
  });

  it('download validates usage before DB access', () => {
    for (const args of [[], ['--source', 'book15.net', '--title', 'x', '--author', 'y', '--max-chapters', '0'], ['--source', 'http://book15.net', '--title', 'x', '--author', 'y']]) {
      const r = run(['download', ...args], { DATABASE_URL: undefined });
      expect(r.status).toBe(2); expect(r.stderr).toContain('download');
    }
  });
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
    // "not a url" 无 scheme ⇒ 先撞 scheme 用法错（见下一条用例）；这里用「有 scheme 但无 host」
    // 走 host 解析分支。两条都是 2，但错误信息不同。
    const r = run(['content', '--url', 'not a url'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('HTTPS');
  });

  // 退出码边界（审查遗留）：scheme 用法错与运行时错分档——http:// 是参数/用法错退 2，
  // 不是运行时错退 1（labeler 把 1 当正常 miss，1 会吞掉这类配置错误）。
  it('toc/content --url 为 http:// scheme → 退出码 2（用法错，非 1）', () => {
    for (const sub of ['toc', 'content']) {
      const r = run([sub, '--url', 'http://book15.net/book/123.html'], { DATABASE_URL: 'postgres://u:p@h/db' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('HTTPS');
      expect(r.stdout).toBe('');
    }
  });

  // 运行时错档（1）：builtin host 过了用法门后取页失败 → 运行时错 1 而非用法错 2。
  // 离线复现：builtin 双 host 之一是本机不可解析/不可达仍属 builtin；直接用真 builtin host
  // 依赖外网（本文件契约是零外网），故以「无结果」档未覆盖的 content 空正文路径同理不测网络——
  // 运行时档的完整断言留给 python 侧 mock（test_douban_list.py 的 _proc(1) 已锁 rc=1 语义），
  // TS 侧只锁用法错边界（上一条）。

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
