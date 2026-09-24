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

import labeler

DIR = Path(__file__).parent
LABELER_CMD = ['python3', '-u', str(DIR / 'labeler.py'), '--source', 'webnovel', '--limit', '242']
PROBE_INTERVAL = 600      # 两次探测间隔（秒）
PASS_N = 2                # 连续通过次数才放行
FAIL_M = 2                # labeler 退出后若渠道连挂这次数，继续等窗口
PROBE_CHARS = 250_000     # 与 labeler SEGMENT_CHARS 一致
PROBE_TIMEOUT = 280       # 单次探测超时（CF 524 在 ~125s，280 足够判死）
# 探测模型链不再硬编码：这里曾经写死 ['deepseek-v4-flash-bohe','grok-4.6-hei',
# 'deepseek-v4.1-flash-hei','glm-5.3-agent']，与 labeler 实际使用的 .env LLM_MODELS 各自演化，
# 结果只剩链尾 glm 能过探测——glm 一挂，门卫就永远停在等窗口。现在从 .env 读同一份配置
# （复用 labeler 的解析函数，见 resolve_probe_models），彻底消除两处漂移。

EXIT_NO_MODELS = 3        # .env 未给模型链：fail-closed，不放行 labeler
# 探测链要不要带上数据库 app_settings.label_model（链首）？labeler 启动时走
# `resolve_models(env, use_db=not args.no_db_model)`，而 LABELER_CMD 未带 `--no-db-model`，
# 所以 labeler 实际 use_db=True。门卫探测必须用同一条链，否则「探测的就是要跑的」不成立
# （复审 F2：DB 模型是链里唯一活的时，门卫会永远等窗口）。门卫与 labeler 同目录、同一份 .env，
# 读库途径（Neon HTTPS）完全一致；读库失败 labeler 自身也是静默回落 env 链，行为相同。
USE_DB_MODEL = True


def resolve_probe_models(env: dict) -> tuple[list[str], str]:
    """探测模型链 = labeler 实际运行时使用的模型链，复用 labeler.resolve_models 解析
    （同一个 LLM_MODELS 逗号列表 / 旧 LLM_MODEL 单值兜底逻辑，不另写一套解析）。

    返回 (模型链, 来源键)。来源键取 'LLM_MODELS' / 'LLM_MODEL'（哪把 .env 键让门卫决定放行）；
    两者都没给（或解析为空）时返回 ([], 'none')，由调用方 fail-closed——刻意**不**退回硬编码旧链：
    静默退回会把「.env 配置缺失/被改坏」这一真实故障伪装成「探测正常」，正是本次要修的失效模式。

    判定用**逗号切分后的非空列表**而不是原始字符串的真值：LLM_MODELS 写成 ',' 或 ' , , '
    时字符串非空但解析出 0 个模型，若按真值判定就会放行到 labeler.resolve_models，
    后者静默回落到 labeler.MODELS 常量链——正是本函数要堵的那个洞。

    旧 LLM_MODEL 分支只认**单值兜底**（值不在 labeler.MODELS 内）：labeler._env_models 的语义是
    「LLM_MODEL 不在 MODELS 内才按单值兜底，否则 return list(MODELS)」，所以 LLM_MODEL 恰为
    MODELS 成员时 labeler 会走硬编码常量链。门卫若照单全收，就会拿常量链放行、日志却标来源
    'LLM_MODEL'——「探测的就是要跑的」虽仍成立（两边都是常量链），但日志读起来像「按 .env 的
    LLM_MODEL 探测」，且与本文档声称的 fail-closed 不符（复审 F1）。这里明确取 fail-closed：
    旧 LLM_MODEL 已被 LLM_MODELS 取代，其值落在常量链里说明用户并未在 .env 显式指定要探测什么，
    此时静默放行常量链只会掩盖配置缺失。"""
    legacy = (env.get('LLM_MODEL') or '').strip()
    if [m for m in (env.get('LLM_MODELS') or '').split(',') if m.strip()]:
        key = 'LLM_MODELS'
    elif legacy and legacy not in labeler.MODELS:
        key = 'LLM_MODEL'
    else:
        return [], 'none'
    # use_db 与 labeler 默认一致：探测的就是 labeler 会跑的链（见 USE_DB_MODEL 说明）。
    models, _ = labeler.resolve_models(env, use_db=USE_DB_MODEL)
    return (models, key) if models else ([], 'none')


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


def probe(api_key: str, models: list[str]) -> bool:
    """对整个模型链各探测一次；任一模型探测通过即视为窗口可用。
    逐模型记录结果（probe_one 内部打印单模型行，这里再打一行汇总），
    便于事后从 gate.log 看出是「链里哪个模型在扛」。"""
    ok = []
    for m in models:
        good = probe_one(api_key, m)
        ok.append((m, good))
        print(f'  [探测] {m}: {"通过" if good else "失败"}', flush=True)
    passed = any(g for _, g in ok)
    print(f'  [探测汇总] 通过 {sum(1 for _, g in ok if g)}/{len(ok)} -> '
          f'{"窗口可用" if passed else "全灭，继续等下一轮"}', flush=True)
    return passed


def main() -> int:
    # 与 labeler 同一途径读 .env（含引号剥离/必需键校验），避免两套解析漂移。
    env = labeler.load_env()
    key = env['LLM_API_KEY']
    models, src_key = resolve_probe_models(env)
    if not models:
        # fail-closed：配置缺失/被改坏时不放行 labeler。若这里退回硬编码旧链，
        # 「.env 没有模型链」会被伪装成「探测正常」，正是本门卫要防的静默失效。
        print(f'错误: .env 未提供模型链（{src_key}）；探测模型表无法确定，'
              f'拒绝放行 labeler（fail-closed）。请在 .env 设置 LLM_MODELS=模型1,模型2,...',
              file=sys.stderr, flush=True)
        return EXIT_NO_MODELS
    # 不变式（复审 F3）：被探测的链必须**就是**从 .env 解析出的链，而不是任何硬编码常量链。
    # 少了这条断言，「把 probe 改回探测 labeler.MODELS」这类回归（原始 bug 形态）测试全绿；
    # 探测链与运行链一旦漂移，门卫就会放行一个 labeler 跑不动的窗口（或反之永远等窗口）。
    expected_models, _ = labeler.resolve_models(env, use_db=USE_DB_MODEL)
    assert models == expected_models, (
        f'探测链与 .env 解析链不一致（探测 {models!r} vs .env {expected_models!r}）；'
        f'门卫必须探测 labeler 实际会跑的模型链')
    print(f'探测模型链来源: {src_key} -> {",".join(models)}', flush=True)
    consecutive_ok = 0
    round_no = 0
    while True:
        round_no += 1
        print(f'== 等待好窗口（round {round_no}）==', flush=True)
        consecutive_ok = 0
        # 等待连续 PASS_N 次通过
        while consecutive_ok < PASS_N:
            if probe(key, models):
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
                if probe(key, models):
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
    sys.exit(main())
