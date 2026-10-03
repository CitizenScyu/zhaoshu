"""630 严格隔离离线门启动器（gate630-hardening，修 627 合同缺口后的 628 launcher）。

对 628 launcher（6a1c99f）的改动只服务门合同，不放宽任何东西：
1. 环境白名单不变（空映射起步、逐键取 PATH/SYSTEMROOT/WINDIR/COMSPEC/PATHEXT/
   OS/PROCESSOR_ARCHITECTURE；TEMP/TMP 重定向本树假目录；编码键字面量），
   **删掉** 628 的 LABELER_DATA_DIR=scripts 钉法——630 门不再需要它（套件
   测试各自用 mock LABELER_DATA_DIR 指向自造夹具），留着只会误导。取而代之
   显式设 TMPDIR/TEMP/TMP=本树 verify630-tmp，让 tempfile.TemporaryDirectory
   的合成 .env 夹具全部落在门允许的目录内（第一次严格全量跑的真实失败事实：
   86 errors——套件在系统 TEMP 建合成 .env 被门拒；修法=把假 TEMP 钉进树，
   不是放宽门）。
2. 子进程仍然只发一次受控 `python -I -B verify628_gate.py --suite`（630 裁定 3：
   门内子进程一律拒绝，自门再入白名单已删——628 那段匹配的事件形态在真实
   CPython 里不存在）。
3. 假 HOME/APPDATA 指本树 verify630-fake-home（与 628 同）。

用法（隔离树根）：
    python verify628_launcher.py               # 一次严格全量门
    python verify628_launcher.py --selfcheck   # 只跑门自检正负控制
退出码：0=门全过；非 0=未通过（日志 verify628-gate.log）。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

TREE = Path(__file__).resolve().parent
GATE = TREE / 'verify628_gate.py'
LOG = TREE / 'verify628-gate.log'

# 只允许这些真实系统键进子进程（逐键取，不枚举后脱敏）。编码键用字面量。
ENV_KEY_WHITELIST = (
    'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS',
    'PROCESSOR_ARCHITECTURE',
)

FAKE_HOME = TREE / 'verify630-fake-home'
FAKE_HOME.mkdir(exist_ok=True)
FAKE_TMP = TREE / 'verify630-tmp'
FAKE_TMP.mkdir(exist_ok=True)


def build_child_env() -> tuple[dict, list[str]]:
    """空映射起步，逐键取白名单系统键；其余真实键一概不进子进程。"""
    child_env: dict = {}
    taken: list[str] = []
    for key in ENV_KEY_WHITELIST:
        val = os.environ.get(key)
        if val is not None:
            child_env[key] = val
            taken.append(key)
    # TEMP/TMP/TMPDIR 一律钉本树假临时目录（合成夹具落点可判）。
    for key in ('TEMP', 'TMP', 'TMPDIR'):
        child_env[key] = str(FAKE_TMP)
    taken += ['TEMP=FAKE', 'TMP=FAKE', 'TMPDIR=FAKE']
    # 字面量编码键（不读真实值）。
    child_env['PYTHONIOENCODING'] = 'utf-8'
    child_env['PYTHONUTF8'] = '1'
    child_env['LC_ALL'] = 'C.UTF-8'
    taken += ['PYTHONIOENCODING=LITERAL', 'PYTHONUTF8=LITERAL', 'LC_ALL=LITERAL']
    # 假用户目录（本树内）。
    for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'):
        child_env[key] = str(FAKE_HOME)
    taken += ['HOME=FAKE', 'USERPROFILE=FAKE', 'APPDATA=FAKE',
              'LOCALAPPDATA=FAKE']
    return child_env, taken


def run_gate(extra_args: list[str]) -> int:
    child_env, taken = build_child_env()
    # 唯一一次受控子进程：-I（隔离模式，不读用户 site）-B（不写 pyc）。
    cmd = [sys.executable, '-I', '-B', str(GATE), *extra_args]
    with LOG.open('w', encoding='utf-8', newline='\n') as log:
        log.write('# verify630 gate log (synthetic, isolated tree, '
                  'business SHA 6a1c99f8cc61b183cb614f8edb36ae3efe44e21b)\n')
        log.write(f"# whitelist keys taken from real env (names only): "
                  f"{', '.join(sorted(t for t in taken if '=' not in t))}\n")
        log.write(f"# overridden/literal keys: "
                  f"{', '.join(sorted(t for t in taken if '=' in t))}\n\n")
        log.flush()
        proc = subprocess.run(
            cmd, env=child_env, cwd=str(TREE),
            stdout=log, stderr=subprocess.STDOUT,
        )
    return proc.returncode


def main() -> int:
    args = sys.argv[1:]
    if '--selfcheck' not in args:
        # 全量门必须在 SUITE 相跑（第一次全量跑的真实失败事实：launcher 忘传
        # --suite，套件落进 SELFCHK 相，suiteViolations=0 是空洞通过。修法=
        # launcher 补相位参数 + 门侧硬拒非 SUITE 相跑套件，双向钉死）。
        args.append('--suite')
    rc = run_gate(args)
    sys.stdout.write(f'verify630 gate exit={rc}; log={LOG.name}\n')
    return rc


if __name__ == '__main__':
    raise SystemExit(main())
