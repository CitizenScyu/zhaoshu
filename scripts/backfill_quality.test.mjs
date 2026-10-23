// scripts/backfill_quality.mjs 的端点接线用例（42-endpoint：M8 存活变异补的洞）。
//
// 为什么需要这个文件：backfill_quality.mjs 不是零覆盖——import_labels.test.mjs 已经导入并测了
// parseQualityResponse。但**端点**这条线（resolveLlmUrl → run() → llmQuality → fetch）一处都没测，
// 于是变异「llmQuality(apiKey, model, text) 少传第 4 参 llmUrl」现有 63 例 Node 用例全绿
// （实测存活；离线复现：三次 fetch 的参数都是 undefined → 三次 Invalid URL → 完成: 0/1）。
// 端点恰恰是这次改造的核心：这个脚本会把 LLM_API_KEY 和抓来的正文一起发出去，发去哪必须钉住。
//
// run() 没有导出（它是 CLI 入口），所以接线部分用 node:vm 在合成上下文里加载**源文件本身**，
// 把 env 文件 / DB / fetch / 计时器全部换成假的，离线跑完一整轮：这样测的是真实接线，
// 不是把 run() 的逻辑抄一份到测试里。手法同 runtime-prefetch-template.test.mjs。
// ⚠ 需要 --experimental-vm-modules。`npm run test:scripts`（scripts/run-mjs-tests.mjs）会自举
//   该 flag；直接 `node --test` 跑本文件会因缺 flag 而加载失败。
//
// 复跑：npm run test:scripts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { resolveLlmUrl } from './backfill_quality.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'backfill_quality.mjs');
const CONFIGURED = 'http://127.0.0.1:13999/v1/chat/completions';  // 端口刻意与真实中转不同，防串台
const LOCAL_DEFAULT = 'http://127.0.0.1:13001/v1/chat/completions';
const BOOK_URL = 'https://fixture.invalid/book';
const FAKE_KEY = 'test-key-not-real-0123456789';

// 一轮里会打的三次 fetch：书目页 → 章节页 → LLM。前两条决定抓到的字数够不够过 10000 字门。
const CATALOG_HTML = '<dd><a href="/chapter/index1-1.html">第一章</a></dd>';
const CHAPTER_HTML = 'chapter-content-panel<p>' + '字'.repeat(12000) + '</p>';
const LLM_SSE = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"overall":8}' } }] }) + '\n';

/** 在合成上下文里跑一整轮 run()，返回它实际打出去的 URL、写库次数与日志。
 *  envLines: 合成 .env 的内容（不含 LLM_API_KEY/DATABASE_URL，那两条这里固定给假值）。
 *  不联网、不读真实配置文件、不写库。 */
async function runBackfill(envLines) {
  const requests = [];
  const logs = [];
  let updates = 0;
  let finish;
  let abort;
  const done = new Promise((ok, bad) => { finish = ok; abort = bad; });
  const fakeEnv = [
    'DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/test',
    `LLM_API_KEY=${FAKE_KEY}`,
    'LLM_MODEL=m-1',
    ...envLines,
  ].join('\n');

  const context = createContext({
    // argv[1] === 源文件绝对路径 ⇒ 被测模块的 isDirectRun 成立，evaluate 即启动 run()。
    process: {
      argv: ['node', SCRIPT, '--env', 'synthetic-fixture.env'],
      env: {},                                   // 进程环境刻意全空：端点只该来自 env 文件
      exit: (code) => abort(new Error(`意外 process.exit(${code})`)),
    },
    console: {
      log: (...a) => {
        const line = a.join(' ');
        logs.push(line);
        if (line.startsWith('完成:')) finish();   // run() 的最后一行 = 这轮结束
      },
      error: (...a) => logs.push(a.join(' ')),
    },
    AbortSignal,
    URL,
    setTimeout: (fn) => { fn(); return 0; },      // 章节间隔/重试退避/30s 频率限制全部立即返回
    fetch: async (url) => {
      requests.push(url === undefined ? '<undefined>' : url);
      new URL(url);                               // 与真 fetch 一样先校验 URL（undefined 会抛）
      let text;
      if (url === BOOK_URL) text = CATALOG_HTML;
      else if (url === 'https://fixture.invalid/chapter/index1-1.html') text = CHAPTER_HTML;
      else text = LLM_SSE;
      return { ok: true, text: async () => text };
    },
  });

  const source = readFileSync(SCRIPT, 'utf8');
  const identifier = pathToFileURL(SCRIPT).href;
  const mod = new SourceTextModule(source, {
    context,
    identifier,
    initializeImportMeta: (meta) => { meta.url = identifier; },
  });
  const mocks = new Map([
    ['@neondatabase/serverless', {
      neon: () => async (strings) => {
        if (strings.join('').includes('SELECT')) {
          return [{ id: 1, title: '测试书', source_url: BOOK_URL }];
        }
        updates += 1;
        return [];
      },
    }],
    ['node:fs', { readFileSync: () => fakeEnv }],
    ['node:path', { resolve }],
    ['node:url', { pathToFileURL }],
    ['./import_labels.mjs', {
      parseQuality: (n) => (typeof n === 'number' && n >= 0 && n <= 10 ? n : null),
    }],
  ]);
  await mod.link(async (specifier) => {
    const exports = mocks.get(specifier);
    assert.ok(exports, `被测模块 import 了未预期的 ${specifier}——请把它一并换成假的`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await mod.evaluate();
  await withTimeout(done, 15_000, 'run() 一轮');
  return { requests, updates, logs };
}

/** 挂住时也要变红，而不是把 60s 用例超时耗掉再报一个看不出原因的错。 */
function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms}ms 未结束`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const llmRequests = (requests) => requests.filter((u) => String(u).includes('/v1/chat/completions'));

describe('resolveLlmUrl：端点只认 env 文件', () => {
  it('文件里的值优先', () => {
    assert.equal(resolveLlmUrl({ LLM_URL: CONFIGURED }), CONFIGURED);
  });

  it('缺失/空白/非字符串都回落本机默认端点', () => {
    for (const env of [{}, { LLM_URL: '' }, { LLM_URL: '   ' }, { LLM_URL: null },
                       { LLM_URL: 42 }, undefined, null]) {
      assert.equal(resolveLlmUrl(env), LOCAL_DEFAULT, JSON.stringify(env));
    }
    assert.equal(resolveLlmUrl({ LLM_URL: `  ${CONFIGURED}  ` }), CONFIGURED);  // 去首尾空白
  });

  it('默认端点是打标机本机那台 new-api 的 loopback 入口', () => {
    // 断言字面值：默认端点是本用例的**规格**，拿被测常量断言自己是同义反复。
    // 13001 = 部署机 `docker ps` 里 new-api 的 127.0.0.1:13001->3000。
    assert.equal(LOCAL_DEFAULT, 'http://127.0.0.1:13001/v1/chat/completions');
    assert.equal(resolveLlmUrl({}), LOCAL_DEFAULT);
    assert.ok(!resolveLlmUrl({}).includes('cloud.us.kg'));
  });

  it('进程环境不参与解析（与 labeler.resolve_llm_url 同口径）', () => {
    // 这条钉的是「统一口径」本身：原先这里是 env.LLM_URL || process.env.LLM_URL || 默认，
    // 是端点三处解析里唯一读进程环境的（DATABASE_URL/LLM_API_KEY/LLM_MODEL 在同一函数里
    // 全都只从文件取，Python 侧也只认 load_env() 的文件字典）。同一个键两种「谁赢」的口径，
    // 排查时必然误判，所以去掉那一层，并在这里写死。
    const saved = process.env.LLM_URL;
    process.env.LLM_URL = CONFIGURED;
    try {
      assert.equal(resolveLlmUrl({}), LOCAL_DEFAULT);
    } finally {
      if (saved === undefined) delete process.env.LLM_URL;
      else process.env.LLM_URL = saved;
    }
  });
});

describe('run() → llmQuality：解析出的端点真的落到 fetch 上', () => {
  it('env 文件写了 LLM_URL：请求打那个地址，日志印那个地址，补分写库一次', async () => {
    const { requests, updates, logs } = await runBackfill([`LLM_URL=${CONFIGURED}`]);
    // 核心断言：少传 llmUrl 的变异会让 fetch 收到 undefined（三次 Invalid URL、updates=0）。
    assert.deepEqual(llmRequests(requests), [CONFIGURED]);
    assert.ok(!requests.includes('<undefined>'), `有请求的 URL 是 undefined：${requests.join(', ')}`);
    assert.equal(updates, 1);
    assert.ok(logs.some((l) => l === `LLM 端点: ${CONFIGURED}`), logs.join('\n'));
    assert.ok(logs.some((l) => l.startsWith('完成: 1/1')), logs.join('\n'));
  });

  it('env 文件没写 LLM_URL：回落本机默认端点，而不是 undefined', async () => {
    const { requests, updates, logs } = await runBackfill([]);
    assert.deepEqual(llmRequests(requests), [LOCAL_DEFAULT]);
    assert.equal(updates, 1);
    assert.ok(logs.some((l) => l === `LLM 端点: ${LOCAL_DEFAULT}`), logs.join('\n'));
  });

  it('env 文件把 LLM_URL 写成空白：同样回落本机默认端点', async () => {
    const { requests } = await runBackfill(['LLM_URL=   ']);
    assert.deepEqual(llmRequests(requests), [LOCAL_DEFAULT]);
  });
});
