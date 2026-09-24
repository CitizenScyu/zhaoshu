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

// 实际通过数下限(41-PYGATE-P1 改造:原先比的是 `Ran`,而 `Ran` **含 skipped 与非通过项**)。
// 接入时实测 367 例(116+65+4+45+44+27+17+16+22+11)且无跳过、无预期失败,故实际通过也是 367,
// 取 350:留 ~5% 余量,删掉零散几例会触发,但不会因为个别用例的正常增删误红。确需下调请一并说明原因。
const MIN_EXPECTED_TESTS = 350;

// 逐文件实际通过数下限:最小的文件 test_import_one_wiring.py 是 4 例。取 1 —— 只要求「这文件里
// 真的有用例跑过并通过」,拦住「文件还在、用例被清空」(`Ran 0 tests` → `NO TESTS RAN`)
// 以及「整个文件全被 skip」(Ran 不变、但实际通过为 0)。
// 不取更高值是因为各文件规模差异大,写死会随正常重构反复误红。
const MIN_TESTS_PER_FILE = 1;

// 环境变量白名单:被测代码读的环境变量在这里**显式清空**,让用例的离线契约不依赖
// 「调用者恰好没设这些变量」。设了它们会让 labeler/import 走真网络与真库分支。
// DATABASE_URL / TEST_DATABASE_URL 在 CI 里本来就是空的(见 ci.yml 顶部注释),本地可能被设,
// 所以这里统一清掉,保证同一份代码在哪里跑都是同一条路径。
//
// 【41-PYGATE-P1】加上 `LABELER_DATA_DIR`:复审第 4 节的边界——`test_labeler_import.py` 会自己
//   去读 `LABELER_DATA_DIR` 指到的目录里的 `.env`。清掉它,「用例只在本仓目录下读固定文件」这条
//   离线契约就不再依赖调用者的环境。读到的值只用于断言、不连库,故原先风险低;清了更干净。
const SCRUBBED_ENV_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'LABELER_ENGINE_CLI',
  'LABELER_ENGINE_FALLBACK',
  'NF_PGLITE_OPTIONAL',
  'LABELER_DATA_DIR',
];

// ---------------------------------------------------------------------------
// 找解释器(41-PYGATE)。Windows 上可能是 `python`(本机 3.12.3 有)或 `py`;
// CI 的 ubuntu runner 自带 `python3`。任一个都试,试不出来就判红——不静默跳过。
// ---------------------------------------------------------------------------
// 【41-PYGATE-P1】顺序改为 python3 → python → py -3。原先 python 优先,是照本机(只有 python.exe)
//   来的;CI 的 ubuntu runner 只有 python3,把它放最前更贴近实际形态。
//   顺带说明为什么这里**不能**靠 `.cmd` 垫片兜底:node 的 spawnSync 不套 PATHEXT,PATH 里只有
//   `python3.cmd`/`python.cmd`(而不是 .exe)时 spawnSync 直接 ENOENT,而同一 PATH 下 shell 能跑。
//   这只在「Windows + 只有垫片形态安装」时把「装了 Python」误判成「没装」,方向是误红(fail-closed),
//   且 ubuntu 的 `python3` 无扩展名、不受影响;要覆盖垫片就得 shell:true,那会引入注入面,故不用。
//   本机实测 python3/python/py 三个都在(3.12.3)。
const candidates = [];
if (process.env.PYTHON) candidates.push({ cmd: process.env.PYTHON, args: [] });
candidates.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] });

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

// ---------------------------------------------------------------------------
// 解析 unittest 的汇总行(41-PYGATE-P1 重写)
// ---------------------------------------------------------------------------
// unittest 把结果与汇总写到 **stderr**(实测:stdout 为空)。逐个文件跑完,末尾是
//
//     Ran 367 tests in 0.431s
//     <空行>
//     OK                                     ← 全过
//     OK (skipped=1)                         ← 有跳过(本门视为红,见下)
//     OK (expected failures=1)               ← 有预期失败(本门视为红)
//     FAILED (failures=1, errors=2, ...)     ← 有失败/错误
//     NO TESTS RAN                           ← 一个用例都没跑到(此时退出码 5)
//
// 为什么不用「退出码兜底」:退出码对**全部跳过**(exit 0)和**全部预期失败**(exit 0)都是绿,
// 正是 P1 要堵的两种;而 `discover` 找不到文件时又是 `Ran 0 tests` + exit 0(见文件头第 1 条)。
// 所以判据必须是这行汇总文本本身。
//
// 【P1 的根因与修法】原先 `RAN_RE` 取**第一处** `Ran N`、`OK_RE` 用 `\(skipped=\d+\)` 分支
//   主动放行带 skipped 的 OK,且 N 含 skipped —— 于是「一个用例被 `@unittest.skip`」乃至
//   「整个文件全 skip」都 exit 0、汇总照报 367 例全过。现在改成与 mjs 侧 S1 同口径的四条:
//
//   1) 结尾锚定:只看**最后一个** `Ran N tests in` 之后的那段文本。
//   2) 全局零跳过:结尾出现 `skipped=` 且数字 > 0 即判红,并在汇总里单列「跳过 N」。
//   3) 实际通过数:Ran 里含 skipped 与非通过项,逐文件与总量都按
//      `实际通过 = Ran − skipped − 其他非通过` 算,要求每文件 ≥ 1、总量 ≥ MIN_EXPECTED_TESTS。
//   4) 非通过项一律判红:expected failures / unexpected successes 既不算通过也不许放行。
//      理由——`@unittest.expectedFailure` 只是把「已知失败」登记下来,门禁的价值在于「代码真的
//      跑过并通过」;预期失败意味着那条用例此刻是失败的,把它算成绿等于让门禁对已知失败免疫。
//      当前仓内一处都没用(实测 grep 无命中),这里的从严没有误红代价。
//
// 【只「锚定最后一个 Ran」还不够,须配合「汇总行恰好一条」】实测反例:某个用例真失败之后,
//   用 `atexit` 在**真汇总之后再补写** `Ran 9999 tests in …\n\nOK\n`——补写的那条成了「最后一个
//   Ran」,只看它就 exit 0(老 runner 同样绿,它取第一处但 OK 是子串匹配)。同理只补一行裸 `OK`
//   也能骗过「取最后一条汇总行」。故再加一条:整段输出里 `OK`/`FAILED`/`NO TESTS RAN` 这类
//   汇总行**必须恰好一条**。正常 unittest 逐文件跑永远只有一条;出现第二条就说明有人在汇总后
//   追加内容,一律判红(fail-closed)。两条合起来把「汇总后再补」这类伪造路径关死。
//   (残余:若伪造者先把真汇总从管道里抹掉、再自己写一条完整的假汇总,本 runner 无法分辨——
//    那已经不是「解析脆」而是「进程输出不可信」,超出文本解析能保证的范围。)
const RAN_RE = /^Ran (\d+) tests? in /gm;
const SUMMARY_RE = /^OK\b[^\n]*$|^(?:FAILED|NO TESTS RAN)\b[^\n]*$/gm;

// 从 `OK (skip=…, expected failures=…, …)` / `FAILED (…)` 的括号里取一个计数字段;取不到按 0。
const countField = (line, name) => {
  const m = line && line.match(new RegExp(`(?:^|[\\s(])${name}=(\\d+)`));
  return m ? Number(m[1]) : 0;
};

/** @returns {{ran:number|null, passed:number|null, skipped:number, failed:number, kind:string, summaryLines:number}} */
const parseSummary = (raw) => {
  const text = raw.replace(/\r\n/g, '\n');
  // 汇总行条数:正常恰好 1 条,>1 视为被追加过(见上方说明)。
  const summaryLines = [...text.matchAll(SUMMARY_RE)].length;
  const base = { ran: null, passed: null, skipped: 0, failed: 0, summaryLines };

  // 1) 最后一个 `Ran N tests in` —— 它之后才是真汇总。
  const runs = [...text.matchAll(RAN_RE)];
  if (runs.length === 0) return { ...base, kind: 'no-ran' };
  const last = runs[runs.length - 1];
  const ran = Number(last[1]);
  const tail = text.slice(last.index + last[0].length);

  // 2) 结尾的汇总行:取最后一个。
  const lines = [...tail.matchAll(SUMMARY_RE)].map((m) => m[0]);
  if (lines.length === 0) return { ...base, ran, kind: 'no-verdict' };
  const verdict = lines[lines.length - 1];

  // 3) 计数字段。所有名称都是 unittest 的既有字段名(`FAILED (failures=1, errors=2)`、
  //    `OK (skipped=3, expected failures=1, unexpected successes=2)`)。
  const skipped = countField(verdict, 'skipped');
  const expectedFailures = countField(verdict, 'expected failures');
  const unexpectedSuccesses = countField(verdict, 'unexpected successes');
  const failures = countField(verdict, 'failures');
  const errors = countField(verdict, 'errors');
  const nonPass =
    skipped + expectedFailures + unexpectedSuccesses + failures + errors;
  const passed = Math.max(0, ran - nonPass);
  const kind = verdict.startsWith('OK') ? 'ok' : verdict.startsWith('NO TESTS RAN') ? 'no-tests' : 'failed';
  return {
    ran,
    passed,
    skipped,
    failed: failures + errors,
    kind,
    verdict,
    expectedFailures,
    unexpectedSuccesses,
    summaryLines,
  };
};

const failedFiles = [];
let totalRan = 0;
let totalPassed = 0;
let totalSkipped = 0;

for (const name of files) {
  const r = spawnSync(
    found.cmd,
    [...found.args, '-m', 'unittest', 'discover', '-s', scriptsDir, '-t', scriptsDir, '-p', name],
    { cwd: repoRoot, env, encoding: 'utf8' },
  );

  const raw = `${r.stdout || ''}${r.stderr || ''}`;
  const s = parseSummary(raw);
  // 逐个判红项收集,报错文案里逐条列清「这文件为什么不算通过」。
  const reasons = [];
  if (r.error) {
    reasons.push(`启动失败:${r.error.message}`);
  } else if (s.summaryLines > 1) {
    // 汇总行超过一条:正常输出只会有一条,多出来的是在真汇总之后追加的内容(见 parseSummary 上方说明)。
    reasons.push(
      `输出里有 ${s.summaryLines} 条汇总行(OK/FAILED/NO TESTS RAN),正常只应有一条` +
        '——疑为真汇总之后被追加了假汇总,判红',
    );
  } else if (s.ran === null) {
    reasons.push('未识别到 `Ran N tests` 行(进程没跑完 unittest,或输出被截断)');
  } else if (s.kind === 'no-tests') {
    reasons.push('`NO TESTS RAN`:一个用例都没跑到');
  } else if (s.kind !== 'ok') {
    reasons.push(
      `结尾是失败汇总「${s.verdict}」(failures=${s.failed ?? 0}、errors 已并入)`,
    );
  } else {
    // kind === 'ok',逐项检查「OK」背后藏着的非通过项。
    if (s.skipped > 0) reasons.push(`有 ${s.skipped} 例被 skip(基线零跳过)`);
    if (s.expectedFailures > 0) reasons.push(`有 ${s.expectedFailures} 例预期失败(expected failures)`);
    if (s.unexpectedSuccesses > 0)
      reasons.push(`有 ${s.unexpectedSuccesses} 例意外成功(unexpected successes)`);
    if (s.passed < MIN_TESTS_PER_FILE)
      reasons.push(`实际通过 ${s.passed} 例(Ran=${s.ran} 减去非通过项后,每文件要求 ≥ ${MIN_TESTS_PER_FILE})`);
  }

  if (reasons.length > 0) failedFiles.push({ name, reasons, out: raw });

  totalRan += s.ran || 0;
  totalPassed += s.passed || 0;
  totalSkipped += s.skipped || 0;

  const status = reasons.length > 0 ? '✖' : '✔';
  console.log(
    `  ${status} ${name}:` +
      (s.ran === null
        ? '未识别到 Ran 行'
        : `${s.ran} 例(通过 ${s.passed ?? '?'}${s.skipped ? `、跳过 ${s.skipped}` : ''})`),
  );
}

if (failedFiles.length > 0) {
  for (const f of failedFiles) {
    console.error(`\n✖ ${f.name}:`);
    for (const reason of f.reasons) console.error(`    · ${reason}`);
    console.error('    ── 原始输出 ──');
    console.error(f.out.trimEnd());
  }
  console.error(
    `\n  ${failedFiles.length} 个文件未通过。这道门要求每个 test_*.py 都真跑过、以纯 OK 结尾、` +
      '且没有任何一例被跳过或标为预期失败——\n' +
      '  「跳过」和「预期失败」都不算通过,宁可红也不要静默放行。',
  );
  process.exit(1);
}

if (totalPassed < MIN_EXPECTED_TESTS) {
  console.error(
    `✖ scripts 的 Python 用例实际只通过 ${totalPassed} 例(期望 ≥ ${MIN_EXPECTED_TESTS};` +
      `Ran 合计 ${totalRan}、其中跳过 ${totalSkipped})。\n` +
      '  用例被批量删除、被 skip、或某个文件被清空都会这样——文件数下限拦不住,故再加一条实际通过数下限。\n' +
      '  确需下调请同步改 MIN_EXPECTED_TESTS 并说明原因。',
  );
  process.exit(1);
}

console.log(
  `▶ 汇总:${testFiles.length}/${testFiles.length} 个文件、实际通过 ${totalPassed} 例` +
    `(Ran 合计 ${totalRan}、跳过 ${totalSkipped})` +
    `(下限:文件 ≥ ${MIN_EXPECTED_FILES}、实际通过 ≥ ${MIN_EXPECTED_TESTS}、每文件通过 ≥ ${MIN_TESTS_PER_FILE}、全局跳过 = 0)`,
);