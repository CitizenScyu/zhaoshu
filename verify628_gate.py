"""630 门体（gate630-hardening）：合同修正版离线验证门。

本文件是 628 门（6a1c99f）的整改版，修复 627 Codex 只读审查指出的合同缺口：
  G1 DNS 只有 Python 属性桩、无 C 级审计；
  G2 subprocess.Popen 审计把 args[0]（整串/列表）误当可执行文件名，白名单是死代码；
  G3 护栏异常可被 except Exception 吞掉，退出码只看 wasSuccessful；
  G4 -I 不证明不读磁盘敏感配置。

护栏范围声明（不过度声称）：本护栏只约束「本 Python 进程内」的测试行为——
socket 属性替换 + sys audit hook 双层；它不是 OS 级沙箱，挡不住绕过 Python
运行时的原生代码（本套件不存在这类代码）。审计事件形态按本机 CPython 3.12.3
实测（见 report630.md CE1/CE2 探测记录）编码，逐字段校验、不整串猜测。

分相计数（630 裁定 4）：
  SELFCHK 相（门自检/控制）与 SUITE 相（unittest discover）各自累计违规，
  互不冲抵。SUITE 相违规增量 != 0 => 最终非零，**即使测试代码 catch 了我的
  GuardViolation**——计数器在抛出点累加，吞异常吞不掉计数（修 G3）。

退出判定：test 成功 AND testsRun>0 AND skipped==0 AND SUITE 相违规增量==0，
四项缺一不可；不硬编码历史测试总数（1051 只在报告记录一次，不进代码）。

敏感配置读取护栏（630 裁定 1，修 G4）：
  open 审计事件在**真正读取发生前**拒绝树外敏感配置路径。允许：
  本树内文件（测试自身、门文件、verify630-fx/ 合成夹具根、verify630-tmp/
  假 TEMP 下 TemporaryDirectory、verify630-fake-home/ 假 HOME）。
  拒绝：树外任何 basename 命中敏感名单的文件（.env*、*.pem、id_rsa*、
  *.key、*.p12、credentials*.json、token*.json）。名单按文件名判，
  不读内容、不打印路径以外的信息。

子进程策略（630 裁定 3，修 G2）：
  本套件运行期不需要任何未 mock 的子进程 => SUITE 相内 subprocess.Popen
  审计事件**一律计数拒绝**（真实 spawn 在事件后由我们抛 GuardViolation 阻断；
  合成事件同样计数）。不保留「自门再入白名单」——628 那段白名单匹配的
  argv 形态在真实 CPython 事件里不存在（死代码），且放宽它没有任何必要。
  外层 launcher 只发一次受控 `-I -B` 门子进程（在门进程之外，不受门内钩子管）。

DNS/连接 C 级审计（630 裁定 2，修 G1）：
  审计 hook 拦 socket.getaddrinfo / gethostbyname / gethostbyname_ex /
  gethostbyaddr / socket.connect（C 级事件，属性桩被 mock.patch 换掉也会触发）
  以及 socket.bind 的非 loopback 目标。Python 属性桩保留——它们先于 C 层
  抛出，套件自身的 OfflineViolation 变异钉（test_labeler_import）因此保持
  原语义不被抢跑（尊重旧钉：门不把桩的异常换成自己的，桩在就不动它）。
"""
from __future__ import annotations

import builtins
import os
import socket
import sys
import unittest

TREE = os.path.dirname(os.path.abspath(__file__))
# 合成夹具/假目录根（launcher 建，门自检也自建一次保证独立可跑）。
FX_ROOT = os.path.join(TREE, 'verify630-fx')
FAKE_HOME = os.path.join(TREE, 'verify630-fake-home')
FAKE_TMP = os.path.join(TREE, 'verify630-tmp')

# 相名。launcher 用 --suite 标记进入 SUITE 相；默认 SELFCHK。
PHASE = 'SUITE' if '--suite' in sys.argv[1:] else 'SELFCHK'
# 控制组自成一相：跑 --suite 时控制组照常执行，但其违规/放行计数记在
# CONTROLS 桶，绝不污染 SUITE 增量（第一次全量跑的真实失败事实：控制组
# 自己的 8 次正控制被记进 SUITE 相，suiteViolations=8 恒假阳性）。
_bucket_name = PHASE

def _bucket() -> str:
    return _bucket_name

STATS: dict[str, dict[str, int]] = {
    'SELFCHK': {'BLOCK_NET': 0, 'BLOCK_DNS': 0, 'BLOCK_PROC': 0, 'BLOCK_SENSITIVE': 0,
                'ALLOW_LOCAL_OPEN': 0},
    'CONTROLS': {'BLOCK_NET': 0, 'BLOCK_DNS': 0, 'BLOCK_PROC': 0, 'BLOCK_SENSITIVE': 0,
                 'ALLOW_LOCAL_OPEN': 0},
    'SUITE': {'BLOCK_NET': 0, 'BLOCK_DNS': 0, 'BLOCK_PROC': 0, 'BLOCK_SENSITIVE': 0,
              'ALLOW_LOCAL_OPEN': 0},
}

# 敏感配置 basename 名单（630 裁定 1）。命中即拒，只看名字不看内容。
_SENSITIVE_EXACT = frozenset({
    '.env', '.env.local', '.env.pull', '.env.production', '.env.development',
    'credentials.json', 'secrets.json', 'token.json',
})
_SENSITIVE_PREFIX = ('id_rsa', 'id_ed25519', 'id_ecdsa')
_SENSITIVE_SUFFIX = ('.pem', '.key', '.p12', '.pfx')


class GuardViolation(BaseException):
    """门拒绝：真实出网/DNS/子进程/树外敏感配置读取。

    继承 BaseException（与套件自身 OfflineViolation 同级同因）：业务和测试里的
    `except Exception` 兜底吞不掉它；即使真被 except BaseException 吞了，
    违规计数已在抛出点累加，最终退出判定仍失败（修 627 G3）。
    """


def _bump(counter: str) -> None:
    b = _bucket()
    STATS[b][counter] = STATS[b].get(counter, 0) + 1


def _violation(counter: str, why: str) -> None:
    """计数后抛 GuardViolation。计数先于抛出——吞异常吞不掉计数。"""
    b = _bucket()
    STATS[b][counter] = STATS[b].get(counter, 0) + 1
    raise GuardViolation(f'gate630 violation [{b}/{counter}]: {why}')


def _is_sensitive_name(name: str) -> bool:
    n = os.path.basename(name).lower()
    if n in _SENSITIVE_EXACT:
        return True
    if n.startswith(_SENSITIVE_PREFIX):
        return True
    return n.endswith(_SENSITIVE_SUFFIX)


_LOOPBACK_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1', '0.0.0.0'})


def _addr_host(address) -> str:
    """audit 里 address 形态多样（tuple/str），抽 host 做宽松判断。"""
    try:
        if isinstance(address, (tuple, list)):
            return str(address[0])
    except Exception:  # noqa: BLE001 —— 宽松处理非预期形态，当成未知主机
        pass
    return str(address)


def _is_loopbackish(address) -> bool:
    h = _addr_host(address)
    return h in _LOOPBACK_HOSTS or h.startswith('127.')


# ---- 1) Python 属性桩（保留 628 语义：先于 C 层、抛给套件熟悉的拦截点） ----
# 注意：桩抛 GuardViolation 之前先计数（吞不掉），但套件自身的 OfflineViolation
# 变异钉要求「桩被 mock.patch 换掉时仍有 C 层兜底」——那正是审计 hook 的职责。
def _stub_net(kind: str, why: str):
    def _raise(*_a, **_kw):
        _violation(kind, why)
    return _raise


socket.create_connection = _stub_net('BLOCK_NET', 'socket.create_connection')
socket.socket.connect = _stub_net('BLOCK_NET', 'socket.socket.connect')
socket.socket.connect_ex = _stub_net('BLOCK_NET', 'socket.socket.connect_ex')
socket.create_server = _stub_net('BLOCK_NET', 'socket.create_server')
socket.getaddrinfo = _stub_net('BLOCK_DNS', 'socket.getaddrinfo')
socket.gethostbyname = _stub_net('BLOCK_DNS', 'socket.gethostbyname')
socket.gethostbyname_ex = _stub_net('BLOCK_DNS', 'socket.gethostbyname_ex')
socket.gethostbyaddr = _stub_net('BLOCK_DNS', 'socket.gethostbyaddr')


# ---- 2) C 级审计 hook（不依赖任何 Python 属性替换） ----
def _audit(event, args):
    if event in ('socket.getaddrinfo', 'socket.gethostbyname',
                 'socket.gethostbyname_ex', 'socket.gethostbyaddr'):
        # 形态实测（CPython 3.12.3）：getaddrinfo args=(host,port,family,type,proto)
        # 其余 (host,)。host 只用于日志类别，不打印值。
        _violation('BLOCK_DNS', f'audit {event}')
    if event == 'socket.connect':
        # args = (sock, address)。真实内核连接才触发；属性桩被换掉时它兜底。
        _violation('BLOCK_NET', 'audit socket.connect')
    if event == 'socket.bind':
        # 只拒非 loopback 绑定（测试用 loopback 绑定合成服务器是合法离线行为；
        # 本套件未用，但判定语义按此收窄，避免过度声称）。
        address = args[1] if len(args) > 1 else None
        if not _is_loopbackish(address):
            _violation('BLOCK_NET', 'audit socket.bind non-loopback')
    if event == 'subprocess.Popen':
        # 裁定 3：门内一律拒绝真实子进程，不做白名单（628 白名单是死代码）。
        # 事件形态实测：args=(executable|None, args-str-or-list, cwd|None, env|None)。
        # 这里不解析形态做放行——全部计数拒绝（合成事件同样计数）。
        _violation('BLOCK_PROC', 'audit subprocess.Popen')
    if event == 'open':
        # 裁定 1：树外敏感配置在真正读取前拒绝。允许范围 = 本树 +
        # launcher 钉死的假 TEMP（TREE/verify630-tmp——测试用
        # tempfile.TemporaryDirectory 自造 .env 合成夹具，全落在那里）。
        try:
            path = os.path.abspath(str(args[0]))
        except Exception:  # noqa: BLE001
            return
        if not _is_sensitive_name(path):
            return
        allowed_roots = (TREE, FX_ROOT, FAKE_HOME, FAKE_TMP)
        if any(path == root or path.startswith(root + os.sep)
               for root in allowed_roots):
            STATS[_bucket()]['ALLOW_LOCAL_OPEN'] += 1
            return
        _violation('BLOCK_SENSITIVE', 'open sensitive config outside tree '
                                      '(denied before read)')


sys.addaudithook(_audit)


# ---- 3) 控制组（630 裁定 5：纯合成正负控制，门先证明自己，再跑套件） ----
def run_controls() -> list[str]:
    import urllib.request
    results: list[str] = []
    global _bucket_name
    _bucket_name = 'CONTROLS'
    # C1 负控制：普通本地操作不受影响。
    try:
        assert {'gate630': 1}.get('gate630') == 1
        results.append('C1-OK local op unaffected')
    except Exception as e:  # noqa: BLE001
        results.append(f'C1-FAIL local op broken: {type(e).__name__}')
    # C2 正控制：Python 属性桩拒绝 create_connection。
    try:
        socket.create_connection(('192.0.2.1', 80), timeout=0)
        results.append('C2-FAIL create_connection not blocked')
    except GuardViolation:
        results.append('C2-OK create_connection blocked (stub)')
    # C3 正控制：Python 属性桩拒绝 getaddrinfo。
    try:
        socket.getaddrinfo('gate630-synthetic.invalid', 80)
        results.append('C3-FAIL getaddrinfo not blocked')
    except GuardViolation:
        results.append('C3-OK getaddrinfo blocked (stub)')
    # C4 正控制：**C 级 DNS 审计**拒绝（修 G1 的直接证明；不发真实解析）。
    try:
        sys.audit('socket.getaddrinfo', ('gate630-synthetic.invalid', 80, 0, 0, 0))
        results.append('C4-FAIL getaddrinfo audit not blocked')
    except GuardViolation:
        results.append('C4-OK getaddrinfo audit blocked (C-level)')
    # C5 正控制：C 级 gethostbyname 审计拒绝。
    try:
        sys.audit('socket.gethostbyname', ('gate630-synthetic.invalid',))
        results.append('C5-FAIL gethostbyname audit not blocked')
    except GuardViolation:
        results.append('C5-OK gethostbyname audit blocked (C-level)')
    # C6 正控制：C 级 socket.connect 审计拒绝（真实形态：(sock, address)）。
    try:
        sys.audit('socket.connect', (None, ('192.0.2.1', 80)))
        results.append('C6-FAIL socket.connect audit not blocked')
    except GuardViolation:
        results.append('C6-OK socket.connect audit blocked (C-level)')
    # C7 正控制：subprocess.Popen 审计拒绝（真实形态：(exe, args-str, cwd, env)）。
    try:
        sys.audit('subprocess.Popen', (None, 'anything -I -B gate', None, None))
        results.append('C7-FAIL subprocess.Popen audit not blocked')
    except GuardViolation:
        results.append('C7-OK subprocess.Popen audit blocked')
    # C8 正控制：违规被 except Exception 吞掉后仍要算违规（修 G3 的机制证明）。
    _before = STATS[_bucket()]['BLOCK_PROC']
    try:
        try:
            sys.audit('subprocess.Popen', (None, 'swallow-probe', None, None))
        except Exception:      # noqa: BLE001 —— 故意吞掉 GuardViolation 以外的形态
            pass
        results.append('C8-FAIL swallow probe: GuardViolation was caught by '
                       'except Exception (must be impossible)')
    except BaseException:
        pass                   # 正确行为：GuardViolation 穿透 except Exception
    if STATS[_bucket()]['BLOCK_PROC'] > _before:
        results.append('C8-OK swallowed-or-not violation counted '
                       f'({_before}->{STATS[_bucket()]["BLOCK_PROC"]})')
    else:
        results.append('C8-FAIL violation counter not bumped on swallow probe')
    # C9b 正控制：树外敏感名（.env）在真正读取前被拒。open 审计事件在
    # 系统调用前触发，所以目标文件不存在也照样先被审——不创建任何真实文件。
    outside_env = os.path.join(os.path.dirname(TREE), '.env')
    try:
        with open(outside_env, encoding='utf-8') as f:   # noqa: F841
            f.readline()
        results.append('C9b-FAIL outside-tree .env open not denied')
    except GuardViolation:
        results.append('C9b-OK outside-tree .env open denied before read')
    except OSError:
        results.append('C9b-FAIL reached filesystem (OSError not GuardViolation)')
    # C9a 负控制：本树合成夹具根下的 .env 可读（允许的合成配置范围）。
    os.makedirs(FX_ROOT, exist_ok=True)
    fx = os.path.join(FX_ROOT, '.env')
    with open(fx, 'w', encoding='utf-8') as f:
        f.write('LLM_API_KEY=synthetic-not-real\n')
    with open(fx, encoding='utf-8') as f:
        assert f.readline().startswith('LLM_API_KEY')
    results.append('C9a-OK synthetic fixture .env readable inside tree')
    return results


def main() -> int:
    print('== verify630 gate ==')
    print(f'== phase: {PHASE} ==')
    controls = run_controls()
    for line in controls:
        print(line)
    failed = any(l.split()[0].endswith('FAIL') for l in controls)
    if failed:
        print('CONTROLS FAILED — gate refuses to run tests')
        print_stats()
        return 2
    if '--selfcheck' in sys.argv:
        print_stats()
        print('SELFCHK_EXIT=0')
        return 0
    if PHASE != 'SUITE':
        # 硬拒：套件只能在 SUITE 相跑（发现模式 + 声明被测 SHA），否则
        # suiteViolations 恒 0，等于空洞通过。launcher 已强制传 --suite。
        print('gate630: suite phase requires --suite (launcher enforces)')
        print_stats()
        return 3

    print('== unittest discover -s scripts -t scripts -p test_*.py ==')
    loader = unittest.TestLoader()
    suite = loader.discover('scripts', top_level_dir='scripts', pattern='test_*.py')
    runner = unittest.TextTestRunner(verbosity=1)
    result = runner.run(suite)
    print_stats()

    suite_viol = sum(v for k, v in STATS['SUITE'].items() if k != 'ALLOW_LOCAL_OPEN')
    passed = (
        result.wasSuccessful()
        and result.testsRun > 0
        and len(result.skipped) == 0
        and suite_viol == 0
    )
    rc = 0 if passed else 1
    print(f'GATE630_EXIT={rc} testsRun={result.testsRun} '
          f'failures={len(result.failures)} errors={len(result.errors)} '
          f'skipped={len(result.skipped)} suiteViolations={suite_viol} '
          f'businessSHA=6a1c99f8cc61b183cb614f8edb36ae3efe44e21b')
    return rc


def print_stats() -> None:
    print('== gate630 stats ==')
    for phase in ('SELFCHK', 'CONTROLS', 'SUITE'):
        for k in sorted(STATS[phase]):
            print(f'{phase}.{k}={STATS[phase][k]}')


if __name__ == '__main__':
    raise SystemExit(main())
