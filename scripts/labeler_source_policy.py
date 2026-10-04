#!/usr/bin/env python3
"""统一源策略（617）：Python 打标链「停用 / 临时冷却」的单一判据入口。

背景（用户 2026-09-29 授权「尽快合集解决 book15 类似问题」）：book15.net 长期整站失效时，
打标链每轮仍在队头对它重复发搜索（SEARCH_RETRY=3 次，每次内层 http_get 再 1+HTTP_RETRY、
默认 30s 超时）；引擎侧的源失效设施（SourceGiveupTracker / DeadHostMemory，lblspeed41）
只覆盖引擎分支，Python 独立直连（book15 搜索 / 详情 / 章节 / 旧 URL 重试）完全不受它管。
本模块把「这个源现在还能不能发请求」收敛成一个入口，调用方（labeler 的传输门 +
douban_list.search_book15 搜索层）都只问它，不各写 if：

  blocked(host) / blocked_url(url)   —— 停用（持久）或冷却中（有界 TTL）都算拦；
  record_failure(host, reason)       —— 网络/5xx/超时类**临时失败**累计，达阈值进冷却；
  record_success(host)               —— 拿到页面即清冷却（正常 miss 也调它：搜到页面
                                        但没有这本书不是源的失败，不封站）；
  disable(host) / enable(host)       —— 运维侧持久停用 / 恢复。

两类状态刻意分开（任务书 §2、主协调裁定）：
  · 停用是**决策**：book15 属于**静态 retired 集合**（与 618 TS 侧同语义：普通环境配置、
    冷却到期、HTTP 成功、DB enabled 都**不能**解除；恢复需另一次明确的生命周期变更，
    不在本批造旁路）。除此之外的任意 host 可经 env 清单或 disable() 用同一策略停用——
    这部分是「运维停用」，enable() / 人工删 labels-source-disabled.json 可恢复。停用态落
    独立状态文件 labels-source-disabled.json（原子写；坏文件安全降级为空态，不拖垮整轮）。
  · 冷却是**保护**：临时网络失败的有界退避。**不另造第二份冷却文件**——跨轮载体复用
    lblspeed41 的既有 labels-dead-hosts.json（DeadHostMemory）：record_failure 达阈值时
    经注入的 dead_host_sink（labeler 侧 = dead_host_memory.add + save）落判死，冷却查询
    = 本轮 fail 计数 + DeadHostMemory 的未过期 host，与引擎分支共享同一份状态与同一
    个 TTL（LABELER_DEAD_HOST_TTL_SEC）。TTL 到期自动放行重试（有限恢复）；取消 / 预算
    耗尽 / 正常 miss 一律**不**记 failure（见 record_failure 的调用约定）。

冷却计数本身不落盘（进程内存）：跨轮持久性全由 DeadHostMemory 承担，避免同一事实
两处记账互不一致。纯策略模块：不联网、不读 .env、导入零副作用；时钟经 clock= 注入
（默认 time.time），便于假时钟离线单测。注意 urllib 的 timeout 是**单次请求**超时，
不是整轮墙钟上限——本模块不承诺后者（冷却 TTL 才是跨轮的界）。
"""
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Callable, Iterable

# book15 一族 host（站点同时响应裸域与 www；停用必须一起停，否则漏网直连）。
# 静态 retired 集合（617，对齐 618 TS 侧语义）：整站已定性弃用，普通环境配置 /
# 冷却到期 / HTTP 成功 / DB enabled 均不解除；恢复需另一次明确的生命周期变更。
BOOK15_HOSTS = ('book15.net', 'www.book15.net')
BOOK15_HOST = BOOK15_HOSTS[0]
RETIRED_HOSTS = frozenset(BOOK15_HOSTS)

DISABLED_FILENAME = 'labels-source-disabled.json'
# 跨轮累计多少次临时失败进入冷却（经 dead_host_sink 落判死）。取 3：单次抖动不封，
# 连续 3 次头部全失败才封——比单轮熔断（Book15Breaker 默认 5 本）更早出手，因为它跨轮记。
COOLDOWN_FAIL_THRESHOLD = 3
# 运维可经 env 追加停用 host（逗号分隔，只影响本轮进程；持久停用走 disable()/状态文件）。
DISABLED_HOSTS_ENV = 'LABELER_SOURCE_DISABLED_HOSTS'
MAX_HOSTS = 256
_DISABLED_VERSION = 1
# 状态文件 / env 清单里的 host 键白名单形态：DNS 标签序列（数字字母开头结尾、点分、
# 允许连字符），单标签（localhost）也合法。挡住 '..' / 'bad host!' / 超长键撑大文件。
_HOST_RE = re.compile(
    r'^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?'
    r'(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$')


class SourceBlockedError(RuntimeError):
    """统一停用门拦截：该 host 已停用或冷却中，**未发任何网络请求**。

    消息只含 URL 与原因（host 级判据），不含凭据。调用方（labeler 主循环）按失败分类
    计数后继续下一本，不对它退避重试——策略拦截是确定性的，重试结果不变。"""

    def __init__(self, url: str, reason: str):
        super().__init__(f'源策略拦截: {url}（{reason}，未发请求）')
        self.url, self.reason = url, reason


def host_of(url: str) -> str:
    """URL → 小写 host（去尾点）。解析失败 / 无 host → ''（blocked('') 永远不拦）。

    尾点必须剥（620 反例②）：DNS 里 `book15.net.` 与 `book15.net` 同一 host，
    若保留原样，`https://book15.net./x` 会绕过按字符串匹配的停用判断。
    无 scheme 的 URL 不放宽：urlsplit 解不出 host 就返回 ''，交调用方按普通错误处理。"""
    try:
        host = (urllib.parse.urlsplit(url).hostname or '').lower()
    except ValueError:
        return ''
    return host.rstrip('.')


def resolve_book15_enabled(env: dict | None = None) -> bool:
    """book15 是否可用。617 静态 retired：恒 False——book15 属 RETIRED_HOSTS，
    普通环境配置不提供解除入口（对齐 618 TS 侧语义）；保留函数是为了让调用点的
    装配代码可读（「按生命周期判定」而不是散落的 if），未来恢复时改这一处即可。"""
    return False


def parse_disabled_hosts(env: dict | None = None) -> tuple[str, ...]:
    """LABELER_SOURCE_DISABLED_HOSTS 逗号表 → 停用 host 元组（小写、去空、保序去重）。

    env 参数（含空 dict / 空值）一旦显式传入，**以它为唯一来源**——不回退 os.environ
    （620 反例④：测试注入假环境时，回退真环境会破坏隔离、把真进程环境的停用清单
    偷偷带进来）。env=None 才表示「调地方没有环境字典」，用进程环境。
    形态不合法的项跳过并告警（不因一个坏值丢掉整张清单）。"""
    if env is None:
        raw = (os.environ.get(DISABLED_HOSTS_ENV) or '').strip()
    else:
        raw = str(env.get(DISABLED_HOSTS_ENV) or '').strip()
    if not raw:
        return ()
    out: list[str] = []
    for item in raw.split(','):
        host = item.strip().lower()
        if not host:
            continue
        if not _HOST_RE.match(host):
            print(f'  提示: {DISABLED_HOSTS_ENV} 里的「{item.strip()}」不是合法 host，跳过',
                  file=sys.stderr)
            continue
        if host not in out:
            out.append(host)
    return tuple(out)


def _read_json(path) -> dict | None:
    """读状态文件 → dict；文件不存在 / 损坏 / 非对象 → None（调用方按空态处理，不外抛）。"""
    try:
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        print(f'  提示: 源策略状态文件 {Path(path).name} 读取失败（按空态处理，不影响本轮）: {e}',
              file=sys.stderr)
        return None
    return payload if isinstance(payload, dict) else None


def _atomic_write_json(path, payload: dict) -> None:
    """原子写 JSON（mkstemp 临时文件 + os.replace）。任何 OSError 只告警不外抛：
    状态文件是优化不是依赖，写坏不能拖垮整轮。不留临时文件（Windows 上不关 fd 会锁文件）。"""
    path = Path(path)
    fd = tmp = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix='.source-policy-')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            fd = None                    # fdopen 接管后别再由 except 关第二次
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)
        tmp = None
    except OSError as e:
        print(f'  提示: 源策略状态写入失败（不影响本轮）: {e}', file=sys.stderr)
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


class SourcePolicy:
    """源策略：停用（持久）+ 冷却（有界 TTL，复用 DeadHostMemory 跨轮）→ blocked() 单一判据。

    参数：
      builtin_disabled  —— 静态 retired / 生命周期停用决策（labeler 装配 book15 一族；
                           **没有任何运行时开关能解除**——enable()、env、冷却到期、HTTP
                           成功都不行，恢复 = 改代码里的 RETIRED_HOSTS 再走一次评审）。
      extra_disabled    —— env 清单停用（**仅本进程**，不落状态文件；与 disable() 写入的
                           运维停用分开——620 反例①：env 临时项混进文件持久集合后，
                           任何一次 disable(other) 保存都会把它永久落盘）。
      dead_host_sink    —— 冷却跨轮回调（host, now) → None：labeler 侧接
                           DeadHostMemory.add+save。None = 冷却只在进程内计数（测试用）。
      dead_hosts_reader —— () → set[str]：跨轮已判死 host 查询（DeadHostMemory.dead_hosts）。
                           可选 dead_host_deadline —— () → {host: 判死时刻}（DeadHostMemory
                           .dead_at）；给不了真实剩余秒数时 cooldown_remaining 只报「在冷却」
                           而不伪装秒数（620 反例③）。
      cooldown_ttl      —— 冷却秒数（语义同 DeadHostMemory.ttl_sec；<=0 = 关闭冷却，
                           停用门不受影响）。与 dead_host 侧共用 LABELER_DEAD_HOST_TTL_SEC。
      clock             —— 可注入假时钟（默认 time.time）。

    冷却判定 = 跨轮死源（dead_hosts_reader，含 TTL 过期自恢复）∪ 本轮 fail 计数达阈值。
    冷却计数不落盘：跨轮持久性由 DeadHostMemory 一处承担。"""

    def __init__(self, base_dir=None, builtin_disabled: Iterable = (),
                 extra_disabled: Iterable = (),
                 cooldown_ttl: int = 0,
                 threshold: int = COOLDOWN_FAIL_THRESHOLD,
                 dead_host_sink: Callable[[str, float], None] | None = None,
                 dead_hosts_reader: Callable[[], set] | None = None,
                 dead_host_deadline: Callable[[], dict] | None = None,
                 clock: Callable[[], float] | None = None):
        self.base = Path(base_dir) if base_dir is not None else None
        self.builtin = frozenset(str(h).lower() for h in builtin_disabled)
        self.ttl = int(cooldown_ttl)
        self.threshold = max(1, int(threshold))
        self._sink = dead_host_sink
        self._reader = dead_hosts_reader
        self._reader_deadline = dead_host_deadline
        self._clock = clock
        self._fails: dict[str, int] = {}
        self._cooled: dict[str, float] = {}  # 本轮已达阈值进冷却的 host → 判死时刻
        self._env_disabled: set[str] = set()   # env 清单停用（仅本进程，绝不落盘）
        self._disabled: dict[str, dict] = {}   # disable() 写入的运维停用（落状态文件）
        self._loaded = False
        for h in extra_disabled:
            host = str(h).lower()
            if _HOST_RE.match(host):
                self._env_disabled.add(host)

    # ---- 内部 ----
    def _now(self) -> float:
        return time.time() if self._clock is None else float(self._clock())

    def _disabled_path(self):
        return None if self.base is None else self.base / DISABLED_FILENAME

    def _ensure_loaded(self) -> None:
        if self._loaded or self.base is None:
            return
        payload = _read_json(self._disabled_path())
        if payload:
            raw = payload.get('hosts')
            if isinstance(raw, dict):
                keep: dict[str, dict] = {}
                for h, meta in raw.items():
                    host = str(h).lower()
                    if not _HOST_RE.match(host) or not isinstance(meta, dict):
                        continue
                    keep[host] = {'reason': str(meta.get('reason') or '')[:100],
                                  'at': _as_float(meta.get('at'))}
                ranked = sorted(keep.items(), key=lambda kv: kv[1]['at'], reverse=True)
                self._disabled.update(dict(ranked[:MAX_HOSTS]))
        self._loaded = True

    def _save_disabled(self) -> None:
        if self.base is None:
            return
        ranked = sorted(self._disabled.items(), key=lambda kv: kv[1]['at'], reverse=True)
        _atomic_write_json(self._disabled_path(),
                           {'version': _DISABLED_VERSION, 'hosts': dict(ranked[:MAX_HOSTS])})

    # ---- 查询 ----
    def is_disabled(self, host: str) -> bool:
        """持久停用（builtin 决策 ∪ 文件运维清单 ∪ env 临时清单）。HTTP 成功与冷却到期
        都不影响它。空 host 恒不拦（URL 解析失败的兜底，交调用方按普通错误处理）。"""
        h = (host or '').lower()
        if not h:
            return False
        if h in self.builtin:
            return True
        if h in self._env_disabled:
            return True
        self._ensure_loaded()
        return h in self._disabled

    def cooldown_remaining(self, host: str) -> int:
        """冷却剩余秒（>0 = 冷却中；0 = 不在冷却——含已到期，到期即放行重试）。

        只有能算出**真实剩余**时才报秒数：跨轮部分经 dead_host_deadline()（判死时刻 +
        ttl − now）；本轮进程内判冷却的 host 没有到期时刻（轮内不会过期），如实报 ttl
        整段剩余。给不出 deadline 的注入形态（旧调用只给 reader 集合）**不伪装秒数**——
        620 反例③：宁可报 1（=「在冷却，剩余未知」），也不把 ttl 当剩余谎报。
        ttl<=0（冷却关闭）恒 0。"""
        if self.ttl <= 0:
            return 0
        h = (host or '').lower()
        if not h:
            return 0
        if h in self._cooled:
            moment = self._cooled[h]
            # now= 注入过假时刻的失败（测试）没有推进注入时钟：剩余按「自判死时刻起
            # 完整 ttl」计——判死就是刚刚发生的这一刻，不是 self._now()（那可能是真墙钟）。
            anchor = moment if self._clock is None else self._now()
            remaining = int(self.ttl - (anchor - moment))
            if remaining > 0:
                return remaining
            self._cooled.pop(h, None)      # 轮内也按 TTL 到期（假时钟长推进时的自洽）
        if self._reader is not None and h in (self._reader() or set()):
            # reader（DeadHostMemory.dead_hosts）本身已按 TTL 过滤：在里面 = 冷却中。
            # 有 deadline 注入就算真实剩余；算不出/给不了就只报 1（「在冷却，剩余未知」），
            # 绝不把 ttl 伪装成剩余秒数。
            if self._reader_deadline is not None:
                try:
                    dead_at = (self._reader_deadline() or {}).get(h)
                except Exception:      # noqa: BLE001 —— 查询失败按「在冷却」保守处理
                    dead_at = None
                if isinstance(dead_at, (int, float)):
                    remaining = int(self.ttl - (self._now() - float(dead_at)))
                    if remaining > 0:
                        return remaining
            return 1
        return 0

    def blocked(self, host: str) -> tuple[bool, str]:
        """(是否拦截, 原因)。停用优先于冷却；两者都不命中 → (False, '')。
        这是所有取文/搜索入口该问的唯一问题。"""
        h = (host or '').lower()
        if self.is_disabled(h):
            return True, '停用'
        if self.cooldown_remaining(h) > 0:
            return True, '冷却中'
        return False, ''

    def blocked_url(self, url: str) -> tuple[bool, str]:
        return self.blocked(host_of(url))

    def disabled_hosts(self) -> set[str]:
        """当前停用 host 全集（builtin ∪ 文件运维清单 ∪ env 临时清单）——启动日志与巡检用。"""
        self._ensure_loaded()
        return set(self.builtin) | set(self._disabled) | set(self._env_disabled)

    def fail_count(self, host: str) -> int:
        """该 host 本轮已累计的临时失败数（诊断/测试用；跨轮判死见 dead_hosts_reader）。"""
        return self._fails.get((host or '').lower(), 0)

    # ---- 记录 ----
    def record_failure(self, host: str, reason: str = '', now: float | None = None) -> None:
        """一次临时失败（网络异常/5xx/超时——**不是**正常 miss、不是取消/预算结束）。
        本轮累计达 threshold → 进冷却并经 dead_host_sink 落跨轮判死（DeadHostMemory）。
        已停用的 host 不记（停用已覆盖，不污染计数）；ttl<=0（冷却关闭）不记。
        「临时失败」的判别在调用方（douban_list.search_book15：重试全失败才记；
        正常 miss / 拿到页面 → record_success）。"""
        h = (host or '').lower()
        if not h or self.ttl <= 0 or self.is_disabled(h):
            return
        self._fails[h] = self._fails.get(h, 0) + 1
        if self._fails[h] >= self.threshold:
            moment = self._now() if now is None else float(now)
            self._cooled[h] = moment
            print(f'  源冷却: {h} 本轮已 {self._fails[h]} 次临时失败'
                  f'（阈值 {self.threshold}），冷却 {self.ttl}s 内不再请求', flush=True)
            if self._sink is not None:
                try:
                    self._sink(h, moment)
                except Exception as e:      # 落盘失败不拖垮本轮（跨轮记忆是优化）
                    print(f'  提示: 冷却跨轮落盘失败（不影响本轮拦截）: {e}', file=sys.stderr)

    def record_success(self, host: str) -> None:
        """一次有效响应（含「页面拿到但无匹配结果」的正常 miss）→ 清该 host 的本轮
        计数与冷却。**绝不动停用态与跨轮判死**：停用只能 enable()/人工恢复；跨轮判死
        由 DeadHostMemory 的 TTL 自然过期（同引擎分支语义）。无可清内容时零副作用。"""
        h = (host or '').lower()
        self._fails.pop(h, None)
        self._cooled.pop(h, None)

    # ---- 运维 ----
    def disable(self, host: str, reason: str = 'manual', now: float | None = None) -> bool:
        """持久停用一个 host（写状态文件，跨轮生效；只写这一个 host，不带走 env 临时项）。
        builtin 已覆盖 / 形态不合法 → False。"""
        h = (host or '').lower()
        if not h or not _HOST_RE.match(h) or h in self.builtin:
            return False
        self._ensure_loaded()
        moment = self._now() if now is None else now
        self._disabled[h] = {'reason': str(reason)[:100], 'at': float(moment)}
        self._save_disabled()
        return True

    def enable(self, host: str) -> bool:
        """恢复一个**运维停用**的 host（从 labels-source-disabled.json 移除）。
        builtin/静态 retired（book15 一族）与 env 清单项不归本方法管——retired 的恢复 =
        改 RETIRED_HOSTS 走一次明确的生命周期变更；env 项随进程消失。返回是否真移除了条目。"""
        h = (host or '').lower()
        if not h or h in self.builtin:
            return False
        self._ensure_loaded()
        removed = self._disabled.pop(h, None) is not None
        if removed:
            self._save_disabled()
        return removed

    def summary_line(self) -> str:
        """启动日志一行：book15 状态 / 停用清单 / 冷却参数。"""
        if BOOK15_HOST in self.builtin:
            b15 = 'retired（静态停用，本批无运行时恢复入口）'
        elif self.is_disabled(BOOK15_HOST):
            b15 = '停用（清单）'
        else:
            b15 = '启用'
        cd = (f'开（{self.ttl}s TTL、{self.threshold} 次失败进冷却，复用死源侧车）'
              if self.ttl > 0 else '关闭')
        return (f'源策略: book15 {b15}；停用清单 {len(self.disabled_hosts())} host；'
                f'临时冷却 {cd}')


def _as_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
