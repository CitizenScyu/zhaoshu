// engine-fetch.mjs 契约测试（T4）。CLI 是装配层：mock DB/网络太重，这里只钉「契约」——
// 参数解析、退出码、stdout 只放数据、凭据不外泄。全部走不依赖外网的路径（无 DATABASE_URL /
// 参数错 / URL 非法，都在任何 DB/fetch 之前返回）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
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

// POSIX 管道语义模拟（Windows 管道是同步写，不加夹具复现不了 phoenix 上的 64KB 截断）。
const pipeShim = pathToFileURL(resolve(scriptsDir, 'fixtures', 'posix-pipe-shim.mjs')).href;
const stdioExit = pathToFileURL(resolve(scriptsDir, 'stdio-exit.mjs')).href;

function runUnderPipe(nodeArgs: string[], env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const r = spawnSync(process.execPath, ['--import', pipeShim, ...nodeArgs], {
    cwd: repoRoot, env: childEnv, maxBuffer: 1 << 26,
  });
  return { status: r.status, stdout: r.stdout as Buffer, stderr: r.stderr.toString('utf8') };
}

// 200KB+ 的多字节中文 JSON：超过 64KB 管道缓冲，且截断点会切在 UTF-8 字符中间（phoenix 症状同形）。
const BIG_JSON_SNIPPET = "const big = JSON.stringify({ text: '第一章 正文'.repeat(15000) }) + '\\n';";

describe('engine-fetch 管道输出完整性（labelerdiag41：stdout 截在 64KB）', () => {
  it('对照：写完立刻 process.exit 在 POSIX 管道语义下截在 65536 字节（夹具有判别力）', () => {
    const r = runUnderPipe(['--input-type=module', '-e',
      `${BIG_JSON_SNIPPET} process.stdout.write(big); process.exit(0);`]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(65536);
    expect(() => JSON.parse(r.stdout.toString('utf8'))).toThrow();
  }, 60_000);

  it('exitAfterFlush：>64KB 多字节 JSON 经管道完整送达且可解析', () => {
    const r = runUnderPipe(['--input-type=module', '-e',
      `import { exitAfterFlush } from '${stdioExit}'; ${BIG_JSON_SNIPPET} process.stdout.write(big); await exitAfterFlush(0);`]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(200_000);
    expect(JSON.parse(r.stdout.toString('utf8')).text).toHaveLength('第一章 正文'.length * 15000);
  }, 60_000);

  it('exitAfterFlush：错误分支的 stderr 同样刷完再退，退出码保留', () => {
    const r = runUnderPipe(['--input-type=module', '-e',
      `import { exitAfterFlush } from '${stdioExit}'; process.stderr.write('x'.repeat(100000) + 'END\\n'); await exitAfterFlush(2);`]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim().endsWith('END')).toBe(true);
  }, 60_000);

  it('真 CLI 成功路径：stdout 全异步时 doctor --json 不丢输出', () => {
    const r = runUnderPipe(['--import', hook, cli, 'doctor', '--json'], { DATABASE_URL: undefined, PIPE_SHIM_SYNC_BYTES: '0' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.toString('utf8'))).toEqual({ ok: true });
  }, 60_000);

  it('真 CLI 错误路径：stderr 全异步时原因不丢、退出码 2', () => {
    const r = runUnderPipe(['--import', hook, cli, 'search', '--title', 'X'], { DATABASE_URL: undefined, PIPE_SHIM_SYNC_BYTES: '0' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DATABASE_URL');
  }, 60_000);
});

describe('engine-fetch CLI 契约', () => {
  it.each(['source', 'out', 'max-chapters', 'rate-ms', 'timeout-ms', 'budget-ms'])('rejects download-only --%s before DB or env access', flag => {
    for (const command of ['search', 'toc', 'content', 'doctor']) {
      const result = run([command, `--${flag}`, '1', '--env', 'nonexistent-test-env'], { DATABASE_URL: undefined });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`--${flag} 仅用于 download`);
      expect(result.stdout).toBe('');
    }
  }, 60_000);
  it('doctor 真实加载 TS 模块且不访问 DB/网络', () => {
    const r = run(['doctor', '--json'], { DATABASE_URL: undefined });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true });
    expect(r.stderr).toBe('');
  }, 60_000);

  it('download validates usage before DB access', () => {
    for (const args of [[], ['--source', 'book15.net', '--title', 'x', '--author', 'y', '--max-chapters', '0'], ['--source', 'http://book15.net', '--title', 'x', '--author', 'y']]) {
      const r = run(['download', ...args], { DATABASE_URL: undefined });
      expect(r.status).toBe(2); expect(r.stderr).toContain('download');
    }
  }, 60_000);
  it('无 DATABASE_URL → 退出码 2，stderr 点名 DATABASE_URL，stdout 空', () => {
    const r = run(['search', '--title', 'X'], { DATABASE_URL: undefined });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DATABASE_URL');
    expect(r.stdout).toBe('');
  }, 60_000);

  it('未知子命令 → 退出码 2', () => {
    const r = run(['frobnicate'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知子命令');
    expect(r.stdout).toBe('');
  }, 60_000);

  it('未知参数 → 退出码 2', () => {
    const r = run(['search', '--title', 'X', '--bogus'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('未知参数');
  }, 60_000);

  it('search 缺 --title → 退出码 2', () => {
    const r = run(['search'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--title');
  }, 60_000);

  it('espfix41：search 接受 --no-builtin / 可重复 --skip-host（解析通过，落到缺 --title）', () => {
    const r = run(['search', '--no-builtin', '--skip-host', 'a.example', '--skip-host', 'b.example'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--title');
    expect(r.stderr).not.toContain('未知参数');
  }, 60_000);

  it('espfix41：--skip-host 缺值、或用在 search 以外 → 退出码 2（DB 之前）', () => {
    const missing = run(['search', '--title', 'X', '--skip-host'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('缺少参数值：--skip-host');
    for (const args of [['toc', '--url', 'https://a.example/1', '--no-builtin'], ['content', '--url', 'https://a.example/1', '--skip-host', 'a.example']]) {
      const r = run(args, { DATABASE_URL: 'postgres://u:p@h/db' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('仅用于 search');
      expect(r.stdout).toBe('');
    }
  }, 60_000);

  // lblqual41：content 的翻页停止点清单。完整翻页语义由 api.test.ts ⑤⑥ 钉住；这里钉 CLI 的参数契约。
  it('lblqual41：content 接受 --stop-urls-file（解析与读文件都在 DB 之前，落到缺 DATABASE_URL）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-urls-'));
    const file = join(dir, 'toc.txt');
    writeFileSync(file, 'https://a.example/1\r\nhttps://a.example/2\n\nnot-a-url\n');
    const r = run(['content', '--url', 'https://a.example/1', '--stop-urls-file', file], { DATABASE_URL: undefined });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DATABASE_URL');
    expect(r.stderr).not.toContain('未知参数');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('lblqual41：--stop-urls-file 缺值 / 用在 content 以外 / 文件读不了 → 退出码 2（DB 之前）', () => {
    const missing = run(['content', '--url', 'https://a.example/1', '--stop-urls-file'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('缺少参数值：--stop-urls-file');
    const elsewhere = run(['toc', '--url', 'https://a.example/1', '--stop-urls-file', 'x.txt'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(elsewhere.status).toBe(2);
    expect(elsewhere.stderr).toContain('仅用于 content');
    const unreadable = run(['content', '--url', 'https://a.example/1', '--stop-urls-file', join(tmpdir(), 'no-such-dir-lblqual41', 'x.txt')], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain('--stop-urls-file 无法读取');
    expect(unreadable.stdout).toBe('');
  }, 60_000);

  it('toc 缺 --url → 退出码 2', () => {
    const r = run(['toc'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--url');
  }, 60_000);

  it('content 缺 --url → 退出码 2', () => {
    const r = run(['content'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--url');
  }, 60_000);

  it('content --url 非法 → 退出码 2（DB/fetch 之前返回）', () => {
    // "not a url" 无 scheme ⇒ 先撞 scheme 用法错（见下一条用例）；这里用「有 scheme 但无 host」
    // 走 host 解析分支。两条都是 2，但错误信息不同。
    const r = run(['content', '--url', 'not a url'], { DATABASE_URL: 'postgres://u:p@h/db' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('HTTPS');
  }, 60_000);

  // 退出码边界（审查遗留）：scheme 用法错与运行时错分档——http:// 是参数/用法错退 2，
  // 不是运行时错退 1（labeler 把 1 当正常 miss，1 会吞掉这类配置错误）。
  it('toc/content --url 为 http:// scheme → 退出码 2（用法错，非 1）', () => {
    for (const sub of ['toc', 'content']) {
      const r = run([sub, '--url', 'http://book15.net/book/123.html'], { DATABASE_URL: 'postgres://u:p@h/db' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('HTTPS');
      expect(r.stdout).toBe('');
    }
  }, 60_000);

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
  }, 60_000);
});
