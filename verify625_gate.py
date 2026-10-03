"""625 门体：进程级网络护栏 + unittest discover（在 -I -B 空白名单环境下运行）。

护栏分三层，全部在导入任何 scripts/ 测试或业务模块**之前**安装：
1) socket 层：socket.create_connection / connect / connect_ex / create_server
   一律抛 NetworkGuardError（真实 TCP/UDP 连接出不了进程）。
2) DNS 层：socket.getaddrinfo / gethostbyname / gethostbyname_ex / gethostbyaddr
   抛 NetworkGuardError（不做真实解析）。
3) audit hook 层：sys.addaudithook 拦 urllib.request.urlopen（event
   'urllib.Request'）、http.client 连接、socket.connect —— 双保险，
   防业务模块在 import 期就自己 import socket 后拿了原始引用（我们覆盖在先，
   但 audit hook 不依赖引用被替换）。

计数：BLOCKED（拦截到的出网尝试）与 PASSED（护栏明确放行的零出网操作，如
loopback 上限内绑定时被拒绝也计入 BLOCKED）分开累计，只在进程内统计、退出前
打印计数行，不打印任何地址/凭据原文（TEST 合成 URL 也只记类别）。

正控制（--selfcheck 或跑门前自动执行一次）：用合成调用证明护栏确实拒绝——
socket.create_connection、getaddrinfo、urllib.request.urlopen 各试一次，
必须全抛 NetworkGuardError，否则门失败退出非 0（护栏未生效就不许跑测试）。
负控制：一个纯本地无网操作（如 str 拼接/内存 dict）必须照常成功，证明护栏
只拦网络不拦正常执行。

白名单子进程约束：本门内任何 subprocess 调用都被 audit hook 白名单化——
只允许白名单解释器 -I -B 自门（本文件）再入，其余一律抛错。测试套件自身
mock 掉的 subprocess.run 不会真起进程；若有测试真调 subprocess 起 python，
仅当命令 = 本树 python -I -B 本门文件 时放行（计 PASSED_PROCESS）。
"""
from __future__ import annotations

import builtins
import os
import socket
import subprocess as _subprocess
import sys
import unittest
import urllib.request

TREE = os.path.dirname(os.path.abspath(__file__))

STATS = {'BLOCKED_NET': 0, 'BLOCKED_DNS': 0, 'BLOCKED_PROC': 0,
         'ALLOWED_PROC': 0}


class NetworkGuardError(RuntimeError):
    """护栏拒绝：任何真实出网/DNS/未白名单子进程。"""


def _block(kind: str, why: str) -> None:
    STATS[f'BLOCKED_{kind}'] = STATS.get(f'BLOCKED_{kind}', 0) + 1
    raise NetworkGuardError(f'guard blocked {kind}: {why}')


# ---- 1) socket 连接层 ----
_orig_create_connection = socket.create_connection
_orig_connect = socket.socket.connect
_orig_connect_ex = socket.socket.connect_ex
_orig_create_server = socket.create_server


def _guard_create_connection(address, *a, **kw):
    _block('NET', 'socket.create_connection')


def _guard_sock_connect(self, address):
    _block('NET', 'socket.connect')


def _guard_sock_connect_ex(self, address):
    _block('NET', 'socket.connect_ex')


def _guard_create_server(*a, **kw):
    _block('NET', 'socket.create_server')


socket.create_connection = _guard_create_connection
socket.socket.connect = _guard_sock_connect
socket.socket.connect_ex = _guard_sock_connect_ex
socket.create_server = _guard_create_server

# ---- 2) DNS 层 ----
_orig_getaddrinfo = socket.getaddrinfo
_orig_gethostbyname = socket.gethostbyname
_orig_gethostbyname_ex = socket.gethostbyname_ex
_orig_gethostbyaddr = socket.gethostbyaddr


def _guard_getaddrinfo(*a, **kw):
    _block('DNS', 'socket.getaddrinfo')


def _guard_gethostbyname(*a, **kw):
    _block('DNS', 'socket.gethostbyname')


def _guard_gethostbyname_ex(*a, **kw):
    _block('DNS', 'socket.gethostbyname_ex')


def _guard_gethostbyaddr(*a, **kw):
    _block('DNS', 'socket.gethostbyaddr')


socket.getaddrinfo = _guard_getaddrinfo
socket.gethostbyname = _guard_gethostbyname
socket.gethostbyname_ex = _guard_gethostbyname_ex
socket.gethostbyaddr = _guard_gethostbyaddr

# ---- 3) audit hook 层（不依赖引用替换；同时白名单子进程） ----
_GATED_PY = os.path.abspath(__file__)


def _audit(event, args):
    if event == 'urllib.Request':
        _block('NET', 'urllib.request.urlopen (audit)')
    if event == 'socket.connect':
        _block('NET', 'socket.connect (audit)')
    if event == 'subprocess.Popen':
        # 白名单子进程：只允许「白名单解释器 -I -B 本门文件」形态。
        try:
            argv = list(args[0] or [])
        except Exception:
            argv = []
        ok = (
            argv and os.path.basename(str(argv[0])).lower().startswith('python')
            and '-I' in [str(x) for x in argv]
            and '-B' in [str(x) for x in argv]
            and any(os.path.abspath(str(x)) == _GATED_PY for x in argv[1:])
        )
        if ok:
            STATS['ALLOWED_PROC'] += 1
            return
        _block('PROC', f'subprocess.Popen (argv0 only)')


sys.addaudithook(_audit)


# ---- 正负控制 ----
def run_controls() -> list[str]:
    results: list[str] = []
    # 正控制 1：create_connection 必须被拒。
    try:
        socket.create_connection(('192.0.2.1', 80), timeout=0)
        results.append('POS-FAIL create_connection not blocked')
    except NetworkGuardError:
        results.append('POS-OK create_connection blocked')
    # 正控制 2：DNS 必须被拒。
    try:
        socket.getaddrinfo('guard-synthetic.invalid', 80)
        results.append('POS-FAIL getaddrinfo not blocked')
    except NetworkGuardError:
        results.append('POS-OK getaddrinfo blocked')
    # 正控制 3：urlopen 必须被拒（audit hook 触发）。
    try:
        urllib.request.urlopen('http://guard-synthetic.invalid/x', timeout=0)
        results.append('POS-FAIL urlopen not blocked')
    except NetworkGuardError:
        results.append('POS-OK urlopen blocked (audit)')
    except Exception as e:  # noqa: BLE001 —— 有异常但不是护栏类=护栏没拦住
        results.append(f'POS-FAIL urlopen raised other: {type(e).__name__}')
    # 负控制：无网本地操作不受影响。
    try:
        assert {'a': 1}.get('a') == 1
        results.append('NEG-OK local op unaffected')
    except Exception as e:  # noqa: BLE001
        results.append(f'NEG-FAIL local op broken: {type(e).__name__}')
    return results


def main() -> int:
    print('== verify625 gate ==')
    print('== controls ==')
    controls = run_controls()
    for line in controls:
        print(line)
    pos_failed = any(l.startswith('POS-FAIL') or l.startswith('NEG-FAIL')
                     for l in controls)
    if '--selfcheck' in sys.argv:
        print_stats()
        return 1 if pos_failed else 0
    if pos_failed:
        print('CONTROLS FAILED — gate refuses to run tests')
        print_stats()
        return 2

    print('== unittest discover -s scripts -t scripts -p test_*.py ==')
    loader = unittest.TestLoader()
    suite = loader.discover('scripts', top_level_dir='scripts',
                            pattern='test_*.py')
    runner = unittest.TextTestRunner(verbosity=1)
    result = runner.run(suite)
    print_stats()
    rc = 0 if result.wasSuccessful() else 1
    print(f'GATE_EXIT={rc} tests={result.testsRun} '
          f'failures={len(result.failures)} errors={len(result.errors)} '
          f'skipped={len(result.skipped)}')
    return rc


def print_stats() -> None:
    print('== guard stats ==')
    for k in sorted(STATS):
        print(f'{k}={STATS[k]}')


if __name__ == '__main__':
    raise SystemExit(main())
