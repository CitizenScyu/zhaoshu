"""628 严格隔离离线门启动器（labeler628-opus）。

机制（task 第 3/4 条）：
1) 从空映射构造子进程环境，只逐键取白名单系统键（PATH/SYSTEMROOT/WINDIR/TEMP/TMP/
   COMSPEC/PATHEXT/OS/PROCESSOR_ARCHITECTURE）；编码键用字面量，不读真实值。
   HOME/USERPROFILE/APPDATA 等指到本树内假目录，杜绝真实 env 透传。
2) 子进程用 python -I -B 运行 verify628_gate.py：在导入任何测试/业务代码**之前**
   装进程级网络护栏（socket.create_connection/connect_ex + socket.getaddrinfo/
   gethostbyname* 打桩拒绝 + audit hook 拦 urllib.request.urlopen/
   http.client.HTTPConnection / ssl），真实 DNS/连接/urllib 请求一律不出进程；
   护栏先跑正控制（合成调用必须被拒绝）再跑 unittest discover。
3) 白名单子进程：不继承真实 env；任何额外子进程同样经白名单 env + -I -B + 护栏。
   无法受控的子进程启动直接抛错使门失败（宁可失败不放松护栏）。

用法（在隔离树根，本文件即入口）：
    python verify628_launcher.py
    python verify628_launcher.py --selfcheck   # 只跑护栏正负控制
退出码：0=门全过；非 0=未通过（详见 verify628-gate.log）。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

TREE = Path(__file__).resolve().parent
GATE = TREE / 'verify628_gate.py'
LOG = TREE / 'verify628-gate.log'

# 只允许这些真实系统键进子进程（任务书第 3 条：只取必要系统键，不枚举后脱敏）。
# 编码键不用真实值——字面量注入。
ENV_KEY_WHITELIST = (
    'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS',
    'PROCESSOR_ARCHITECTURE', 'TEMP', 'TMP',
)

# 假目录（本树内）——HOME/USERPROFILE 类用户目录若被读也只落在受控假路径。
FAKE_DIR = TREE / 'verify628-fake-home'
FAKE_DIR.mkdir(exist_ok=True)
FAKE_TMP = TREE / 'verify628-tmp'
FAKE_TMP.mkdir(exist_ok=True)


def build_child_env() -> dict:
    """空映射起步，逐键取白名单系统键；其余键名只记录不取值。"""
    child_env: dict = {}
    taken: list[str] = []
    for key in ENV_KEY_WHITELIST:
        val = os.environ.get(key)
        if val is not None:
            child_env[key] = val
            taken.append(key)
    # TEMP/TMP 一律重定向到本树假临时目录（即使真实键存在也覆盖），
    # 防测试临时文件落进系统 TEMP。
    child_env['TEMP'] = str(FAKE_TMP)
    child_env['TMP'] = str(FAKE_TMP)
    taken = [k for k in taken if k not in ('TEMP', 'TMP')] + ['TEMP=FAKE', 'TMP=FAKE']
    # 字面量编码键（不读真实值）。
    child_env['PYTHONIOENCODING'] = 'utf-8'
    child_env['PYTHONUTF8'] = '1'
    child_env['LC_ALL'] = 'C.UTF-8'
    # 假用户目录。
    child_env['HOME'] = str(FAKE_DIR)
    child_env['USERPROFILE'] = str(FAKE_DIR)
    child_env['APPDATA'] = str(FAKE_DIR)
    child_env['LOCALAPPDATA'] = str(FAKE_DIR)
    # 显式关闭一切可能让子进程发网的已知开关（假值，非透传）。
    child_env['LABELER_DATA_DIR'] = str(TREE / 'scripts')  # 数据目录钉在本树 scripts
    taken.append('PYTHONIOENCODING=LITERAL')
    taken.append('PYTHONUTF8=LITERAL')
    taken.append('LC_ALL=LITERAL')
    return child_env, taken


def run_gate(extra_args: list[str]) -> int:
    child_env, taken = build_child_env()
    cmd = [sys.executable, '-I', '-B', str(GATE), *extra_args]
    with LOG.open('w', encoding='utf-8', newline='\n') as log:
        log.write(f'# verify628 gate log (synthetic, generated in isolated tree)\n')
        log.write(f'# whitelist keys taken from real env: {", ".join(sorted(set(t for t in taken if "=" not in t)))}\n')
        log.write(f'# overridden/literal keys: {", ".join(sorted(t for t in taken if "=" in t))}\n\n')
        log.flush()
        proc = subprocess.run(
            cmd, env=child_env, cwd=str(TREE),
            stdout=log, stderr=subprocess.STDOUT,
        )
    return proc.returncode


def main() -> int:
    args = sys.argv[1:]
    rc = run_gate(args)
    sys.stdout.write(
        f'verify628 gate exit={rc}; log={LOG.name}\n')
    return rc


if __name__ == '__main__':
    raise SystemExit(main())
