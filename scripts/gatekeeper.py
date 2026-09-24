#!/usr/bin/env python3
"""bohe 渠道门卫：探测基线通过才跑 labeler，失败即停。

背景（2026-09-14 实测）：x666 上游 deepseek-v4-flash-bohe 间歇性过载，
坏窗口里 1000 tokens 也 524，与 prompt 大小无关；CF 100s 无首字节即砍。
门卫策略：25 万字段探测，连续 PASS_N 次通过才放行 labeler；
labeler 跑完或渠道转坏（探测 FAIL_M 次连挂）则等待下一窗口。

用法（建议 nohup 后台）:
  nohup python3 -u gatekeeper.py > gate.log 2>&1 &
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DIR = Path(__file__).parent
ENV_PATH = DIR / '.env'
LABELER_CMD = ['python3', '-u', str(DIR / 'labeler.py'), '--source', 'webnovel', '--limit', '242']
PROBE_INTERVAL = 600      # 两次探测间隔（秒）
PASS_N = 2                # 连续通过次数才放行
FAIL_M = 2                # labeler 退出后若渠道连挂这次数，继续等窗口
PROBE_CHARS = 250_000     # 与 labeler SEGMENT_CHARS 一致
PROBE_TIMEOUT = 280       # 单次探测超时（CF 524 在 ~125s，280 足够判死）
# 与 labeler 一致的模型链；只要链中任意一个模型探测通过，就视为窗口可用。
MODELS = ['deepseek-v4-flash-bohe', 'grok-4.6-hei', 'deepseek-v4.1-flash-hei', 'glm-5.3-agent']


def load_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith('LLM_API_KEY='):
            return line.split('=', 1)[1].strip()
    sys.exit('LLM_API_KEY not found in .env')


def probe_one(api_key: str, model: str) -> bool:
    """对单个模型做 25 万字段探测；首字节即判活。"""
    body = json.dumps({
        'model': model, 'stream': True, 'max_tokens': 50,
        'messages': [{'role': 'user', 'content': '重复' * (PROBE_CHARS // 2)}],
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://api.cloud.us.kg/v1/chat/completions', data=body, method='POST',
        headers={'Content-Type': 'application/json',
                 'Authorization': f'Bearer {api_key}',
                 'User-Agent': 'Mozilla/5.0 (compatible, zhaoshu-labeler/1.0)'})
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as res:
            for _ in res:      # 首字节即判活
                return True
    except Exception as e:
        print(f'    [探测] {model} 失败: {e}', flush=True)
    return False


def probe(api_key: str) -> bool:
    """对整个模型链各探测一次；任一模型探测通过即视为窗口可用。"""
    ok = []
    for m in MODELS:
        good = probe_one(api_key, m)
        ok.append((m, good))
        print(f'  [探测] {m}: {"通过" if good else "失败"}', flush=True)
    passed = any(g for _, g in ok)
    print(f'  [探测汇总] 通过 {sum(1 for _, g in ok if g)}/{len(ok)} -> '
          f'{"窗口可用" if passed else "全灭，继续等下一轮"}', flush=True)
    return passed


def main() -> int:
    key = load_key()
    consecutive_ok = 0
    round_no = 0
    while True:
        round_no += 1
        print(f'== 等待好窗口（round {round_no}）==', flush=True)
        consecutive_ok = 0
        # 等待连续 PASS_N 次通过
        while consecutive_ok < PASS_N:
            if probe(key):
                consecutive_ok += 1
                print(f'  探测通过 {consecutive_ok}/{PASS_N}', flush=True)
            else:
                consecutive_ok = 0
            time.sleep(PROBE_INTERVAL)
        print(f'渠道就绪，启动 labeler round {round_no}', flush=True)
        t0 = time.time()
        r = subprocess.run(LABELER_CMD, cwd=str(DIR))
        mins = (time.time() - t0) / 60
        print(f'labeler 退出: code={r.returncode} 用时 {mins:.0f} 分钟', flush=True)
        if r.returncode == 0:
            # 正常跑完一轮；继续下一轮（断点续传会跳过已完成的）
            print('一轮跑完，10 分钟后探测下一轮', flush=True)
            time.sleep(PROBE_INTERVAL)
            continue
        if r.returncode == 2:
            # 整轮零成功：渠道已转坏，不空转，直接回等待窗口
            print('整轮零成功（渠道转坏），回到等待窗口', flush=True)
            continue
        # 异常退出：渠道活着就真的重启 labeler（再异常则继续本循环处理），
        # 连挂 FAIL_M 次探测才回等待窗口
        while True:
            alive = False
            for _ in range(FAIL_M):
                if probe(key):
                    alive = True
                    break
                time.sleep(60)
            if not alive:
                print('渠道转坏，回到等待窗口', flush=True)
                break
            print('  渠道仍活，重启 labeler', flush=True)
            t0 = time.time()
            r = subprocess.run(LABELER_CMD, cwd=str(DIR))
            mins = (time.time() - t0) / 60
            print(f'labeler 退出: code={r.returncode} 用时 {mins:.0f} 分钟', flush=True)
            if r.returncode in (0, 2):
                break


if __name__ == '__main__':
    main()
