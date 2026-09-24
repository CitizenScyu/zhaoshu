// scripts 下 Python unittest 用例入口(41-PYGATE)。
//
// 为什么需要这个 runner,而不是把 `python -m unittest discover ...` 直接写进 package.json:
//   1) fail-closed。`unittest discover` 在**发现 0 个文件**时打印 `Ran 0 tests` 并**退出 0**
//      ——护栏静默消失,正是本仓最忌讳的失效模式(见 ci.yml 里对 pglite 用例静默跳过的断言)。
//      这里显式列出文件,对文件数、用例数、逐文件用例数做下限断言。
//   2) 缺解释器必须判红。没有 python 时不能「跳过这一步」蒙混过去——CI 上 python3 是自带的,
//      本地用 python / py(见下),缺了就是环境坏了,要报出来。
//   3) 离线。用例本身的契约是「不联网、不连库、不读 .env、不调真模型」(各文件 docstring 里写明),
//      runner 只负责跑它们,不注入任何凭据;被测模块的网络入口(urlopen 等)在用例内被 mock 替换。
//
// 为什么用「每个文件单独跑一次」而不是一次 `discover` 整批:
//   逐文件跑才能对**每个文件**断言「Ran N tests,N ≥ 1」,拦住「某个文件被删空/用例被清空
//   却仍能通过」。一次整批跑只能拿到全局总数,一个文件掉光、另一个文件涨几例就能掩盖过去。
//   代价是启动 10 次解释器(实测合计 < 5s),对本仓规模可忽略。
//
// 为什么用 git 列文件而不是 glob `scripts/test_*.py`:
//   同 run-mjs-tests.mjs —— git 清单用仓库自己的 .gitignore,不维护第二份排除表;文件名里的
//   特殊字符不会被转义或截断;列不出来就 fail-closed(枚举不出就不能保证「没有漏跑的文件」)。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);

// 接入时的既有文件数:10 个。删/改名/新增时这个下限会相应触发,报错文案里写明改哪里。
// 新增文件**不需要**改这里;只有掉到 10 以下才拦(那正是要拦的情况)。
const MIN_EXPECTED_FILES = 10;

// 用例数下限。接入时实测 367 例(116+65+4+45+44+27+17+16+22+11),取 350:留 ~5% 余量,
// 删掉零散几例会触发,但不会因为个别用例的正常增删误红。确需下调请一并说明原因。
const MIN_EXPECTED_TESTS = 350;

// 逐文件用例数下限:最小的文件 test_import_one_wiring.py 是 4 例。取 1 —— 只要求「这文件里
// 真的跑了用例」,拦住「文件还在、用例被清空」(输出会变成 `Ran 0 tests`,被判红)。
// 不取更高值是因为各文件规模差异大,写死会随正常重构反复误红。
const MIN_TESTS_PER_FILE = 1;

// 环境变量白名单:被测代码读的环境变量在这里**显式清空**,让用例的离线契约不依赖
// 「调用者恰好没设这些变量」。设了它们会让 labeler/import 走真网络与真库分支。
// DATABASE_URL / TEST_DATABASE_URL 在 CI 里本来就是空的(见 ci.yml 顶部注释),本地可能被设,
// 所以这里统一清掉,保证同一份代码在哪里跑都是同一条路径。
const SCRUBBED_ENV_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'LABELER_ENGINE_CLI',
  'LABELER_ENGINE_FALLBACK',
  'NF_PGLITE_OPTIONAL',
];

// ---------------------------------------------------------------------------
// 找解释器(41-PYGATE)。Windows 上可能是 `python`(本机 3.12.3 有)或 `py`;
// CI 的 ubuntu runner 自带 `python3`。任一个都试,试不出来就判红——不静默跳过。
// ---------------------------------------------------------------------------
const candidates = [];
if (process.env.PYTHON) candidates.push({ cmd: process.env.PYTHON, args: [] });
candidates.push({ cmd: 'python', args: [] }, { cmd: 'python3', args: [] }, { cmd: 'py', args: ['-3'] });

const probe = (c) => spawnSync(c.cmd, [...c.args, '--version'], { encoding: 'utf8' });
const found = candidates.find((c) => {
  const r = probe(c);
  return !r.error && r.status === 0;
});

if (!found) {
  console.error(
    `✖ 找不到 Python 解释器(试过 ${candidates.map((c) => c.cmd).join(' / ')};` +
      '可用环境变量 PYTHON 指定绝对路径)。\n' +
      '  这道门靠真跑 Python unittest 用例来保证 scripts/test_*.py 没坏;没有解释器就不能保证,\n' +
      '  故 fail-closed,而不是跳过这一步。CI 的 ubuntu runner 自带 python3;本地装一个即可。',
  );
  process.exit(1);
}
const pythonVersion = (probe(found).stdout || '').trim();
console.log(`▶ Python 解释器:${found.cmd} ${found.args.join(' ')} → ${pythonVersion}`);

// ---------------------------------------------------------------------------
// 清点仓库里的 test_*.py(与 run-mjs-tests.mjs 同款:交给 git 和 .gitignore)
// ---------------------------------------------------------------------------
const listed = spawnSync(
  'git',
  ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.py'],
  { encoding: 'utf8' },
);

if (listed.error || listed.status !== 0) {
  console.error(
    `✖ 无法用 git 清点仓库里的 *.py(${listed.error ? listed.error.message : `git 退出码 ${listed.status}`})。\n` +
      '  这道门靠 git 的文件清单保证「全仓 test_*.py 都交代过」,枚举不出来就不能保证没漏跑,故 fail-closed。\n' +
      '  请确认在 git 工作副本里跑(CI 有 checkout;pre-push 钩子本身要求 git)。',
  );
  process.exit(1);
}

// git 输出仓库根相对、以 `/` 分隔的路径;统一成平台分隔符便于按目录判断与展示。
const repoPyFiles = listed.stdout.split('\0').filter(Boolean).map((p) => p.split('/').join(sep));

const isTestModule = (relPath) =>
  basename(relPath).startsWith('test_') && basename(relPath).endsWith('.py');

const testFiles = repoPyFiles.filter(isTestModule).sort();

// 认定口径:整个仓库里所有 test_*.py 都必须在 scripts/ 顶层。放别处既不在本门禁里,
// 也说明位置不符合约定,故 fail-closed(而不是自动纳入)——理由同 run-mjs-tests.mjs:
// 扫描范围漂移会让契约悄悄变化,该由人来决定挪不挪。
const misplaced = testFiles.filter((p) => {
  const parts = p.split(sep);
  return !(parts.length === 2 && parts[0] === 'scripts');
});
if (misplaced.length > 0) {
  console.error(
    `✖ 发现 ${misplaced.length} 个 test_*.py 不在 scripts/ 顶层(不在本门禁或不符合约定):\n` +
      misplaced.map((p) => `    - ${p}`).join('\n') +
      '\n  这道门只跑 scripts/ 顶层的 Python 用例。请挪到 scripts/ 顶层后重跑。',
  );
  process.exit(1);
}

if (testFiles.length < MIN_EXPECTED_FILES) {
  console.error(
    `✖ scripts 的 Python unittest 用例只剩 ${testFiles.length} 个(期望 ≥ ${MIN_EXPECTED_FILES}):` +
      `${testFiles.join(', ') || '(无)'}\n` +
      '  文件被删除或改名会让这条门静默变空,故 fail-closed。若确实要下线某个用例文件,\n' +
      '  请同步下调 scripts/run-py-tests.mjs 的 MIN_EXPECTED_FILES 并说明原因。',
  );
  process.exit(1);
}

for (const name of testFiles) {
  if (!existsSync(join(repoRoot, name))) {
    console.error(
      `✖ ${name} 在 git 清单里但工作区不存在(被删了却没提交?)。这道门要求被清点到的文件都真实存在可跑,故 fail-closed。`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 逐个文件跑
// ---------------------------------------------------------------------------
// 环境:在继承的基础上清掉会触网/触库的变量(见 SCRUBBED_ENV_KEYS)。
const env = { ...process.env };
for (const key of SCRUBBED_ENV_KEYS) delete env[key];
// PYTHONIOENCODING:用例本身在 Windows 上输出中文;不设的话控制台编码可能让个别字符抛
// UnicodeEncodeError,把「环境问题」伪装成「用例失败」。UTF-8 是这类问题里最省事的答案,
// 且不影响结果判定(结果行是 ASCII 的 `Ran N tests` / `OK`)。
env.PYTHONIOENCODING = 'utf-8';

const files = testFiles.map((p) => basename(p));
console.log(`▶ scripts 的 Python unittest 用例:${files.length} 个文件 → ${files.join(', ')}`);

// 解析 unittest 的汇总行。unittest 把结果写到 **stderr**:
//   `Ran 367 tests in 0.431s` 然后 `OK`(或 `FAILED (failures=1)`)。
// 只认这两行的组合,而不是看退出码就完事——退出码是必要不充分条件(discover 发现 0 个文件时
// 会打印 `Ran 0 tests` 并退出 0)。
const RAN_RE = /^Ran (\d+) tests? in /m;
const OK_RE = /^OK( \(skipped=\d+\))?$/m;
const failedFiles = [];
let totalTests = 0;

for (const name of files) {
  const r = spawnSync(
    found.cmd,
    [...found.args, '-m', 'unittest', 'discover', '-s', scriptsDir, '-t', scriptsDir, '-p', name],
    { cwd: repoRoot, env, encoding: 'utf8' },
  );

  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ranMatch = out.match(RAN_RE);
  const ran = ranMatch ? Number(ranMatch[1]) : null;
  const ok = OK_RE.test(out);

  if (r.error || ran === null || !ok) {
    failedFiles.push({ name, reason: r.error ? r.error.message : `Ran=${ran === null ? '未识别' : ran}、结尾${ok ? 'OK' : '非 OK'}`, out });
  } else if (ran < MIN_TESTS_PER_FILE) {
    failedFiles.push({ name, reason: `只跑了 ${ran} 例(每文件要求 ≥ ${MIN_TESTS_PER_FILE})`, out });
  }

  totalTests += ran || 0;
  const status = failedFiles.some((f) => f.name === name) ? '✖' : '✔';
  console.log(`  ${status} ${name}:${ran === null ? '未识别到 Ran 行' : `${ran} 例`}`);
}

if (failedFiles.length > 0) {
  for (const f of failedFiles) {
    console.error(`\n✖ ${f.name}:${f.reason}`);
    console.error(f.out.trimEnd());
  }
  console.error(
    `\n  ${failedFiles.length} 个文件未通过。这道门要求每个 test_*.py 都真跑过、且以 OK 结尾,\n` +
      '  宁可红也不要静默放行(缺解释器、发现 0 个文件、被 skip 掉都在这里现形)。',
  );
  process.exit(1);
}

if (totalTests < MIN_EXPECTED_TESTS) {
  console.error(
    `✖ scripts 的 Python 用例一共只跑了 ${totalTests} 例(期望 ≥ ${MIN_EXPECTED_TESTS})。\n` +
      '  用例被批量删掉、或某个文件被清空都会这样——文件数下限拦不住,故再加一条用例数下限。\n' +
      '  确需下调请同步改 MIN_EXPECTED_TESTS 并说明原因。',
  );
  process.exit(1);
}

console.log(
  `▶ 汇总:${testFiles.length}/${testFiles.length} 个文件、${totalTests} 例全过` +
    `(下限:文件 ≥ ${MIN_EXPECTED_FILES}、用例 ≥ ${MIN_EXPECTED_TESTS}、每文件 ≥ ${MIN_TESTS_PER_FILE})`,
);