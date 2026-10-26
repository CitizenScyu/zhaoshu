// 源规则 → CompiledRules（逐字段编译 + 装饰字段 skip 标记 + LRU 缓存）。
// 设计依据：m1-engine-design.md §1 架构（compile.ts）、§7.1 的 EngineSource.compiled。
// 缓存键 = 语义版本化 sourceRevision（P0 引入 engineVersionedKey；P1a 起语义版本随
// ENGINE_SYNTAX_OR 联动——off=1 / on=2）：规则原文或引擎语义任一变化，键即变，旧编译
// 产物自然失效，不存在「|| 开关打开后仍复用 off 态编译缓存」的窗口。
import { sourceRevision } from '@/lib/source-revision';
import { parseFieldRule, type ParseOptions } from './parse';
import type { CompiledRules } from './types';
import {
  engineSemanticsVersion, engineSyntaxOrEnabled, engineSyntaxXPathEnabled, ENGINE_SEMANTICS_VERSION,
} from './syntax-flags';
import { ruleMayUseXPath } from './xpath-subset';

export { ENGINE_SEMANTICS_VERSION };

/** 版本化缓存键（P0 口径）：semanticsVersion:contentRevision。 */
export function engineVersionedKey(contentRevision: string, semanticsVersion = ENGINE_SEMANTICS_VERSION): string {
  return `${semanticsVersion}:${contentRevision}`;
}

/**
 * 内容 identity 与引擎语义 identity 的唯一组合口径（语义版本随 || 开关联动，P1a）。
 * orsrc1027：语义版本按源判定——开关 on 且规则组里出现 `||` 的源才是版本 2，其余源恒为 1。
 * xpath1027：同理，ENGINE_SYNTAX_XPATH on 且规则组可能含 XPath 段的源再加 XPath 位（3/4），其余源不变。
 */
export function engineSourceRevision(
  source: { url: string; searchUrl: unknown; rules: Record<string, unknown> },
  options: ParseOptions = {},
): string {
  const orEnabled = options.orEnabled ?? engineSyntaxOrEnabled();
  const xpathEnabled = options.xpathEnabled ?? engineSyntaxXPathEnabled();
  return engineVersionedKey(sourceRevision(source), engineSemanticsVersion(
    orEnabled && sourceUsesOrSyntax(source.rules),
    xpathEnabled && sourceUsesXPathSyntax(source.rules),
  ));
}

const RULE_GROUPS = ['ruleSearch', 'ruleBookInfo', 'ruleContent', 'ruleToc', 'ruleExplore'] as const;

function someRule(rules: Record<string, unknown>, test: (rule: string) => boolean): boolean {
  for (const group of RULE_GROUPS) {
    const fields = rules[group];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const rule of Object.values(fields as Record<string, unknown>)) {
      if (typeof rule === 'string' && test(rule)) return true;
    }
  }
  return false;
}

/**
 * 源的规则组里是否有字段文本含 `||`（orsrc1027）。不含 `||` 的规则 on/off 两态编译逐字同路
 * （off 的 splitTopLevel 与 on 的 tokenizeOrBranches 都只切出一段），语义没变，identity 就不该变：
 * 否则开闸会把全部准入行判成「规则已变」，清掉 conn_fail 退避并整池重探。只看子串、宁宽勿漏——
 * 括号/引号内的 `||` 也算，多算只是多重探一次。
 */
export function sourceUsesOrSyntax(rules: Record<string, unknown>): boolean {
  return someRule(rules, (rule) => rule.includes('||'));
}

/** 源的规则组里是否可能有 XPath 段（xpath1027，口径见 ruleMayUseXPath；理由同 sourceUsesOrSyntax）。 */
export function sourceUsesXPathSyntax(rules: Record<string, unknown>): boolean {
  return someRule(rules, ruleMayUseXPath);
}

/** LRU 上限：单测/低并发下足够；无关热路径，只防规则对象无限积累。 */
const CACHE_LIMIT = 64;
const cache = new Map<string, CompiledRules>();

/**
 * 把一个源的规则原文编译成 `字段全名 → FieldIr`（设计 §7.1）。
 * 单字段编译失败（RULE_UNSUPPORTED）不抛出，标 `skipped:'unsupported'`——核心/装饰字段的
 * 阻断语义由准入（滤网 1）与字段层（§3.4）决定，此处只做无异常的物化。
 * `orEnabled`（默认读 ENGINE_SYNTAX_OR，off）/`xpathEnabled`（默认读 ENGINE_SYNTAX_XPATH，off）逐次求值：
 * 切换开关会换缓存键，各态编译产物在同一进程内共存互不污染。
 */
export function compileSource(
  source: { url: string; searchUrl: unknown; rules: Record<string, unknown> },
  options: ParseOptions = {},
): CompiledRules {
  const orEnabled = options.orEnabled ?? engineSyntaxOrEnabled();
  const xpathEnabled = options.xpathEnabled ?? engineSyntaxXPathEnabled();
  const key = engineSourceRevision(source, { orEnabled, xpathEnabled });
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // 触达即续期（Map 插入序 = LRU 序）
    cache.set(key, hit);
    return hit;
  }
  const compiled: CompiledRules = new Map();
  for (const group of RULE_GROUPS) {
    const rules = source.rules[group];
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) continue;
    for (const [field, rule] of Object.entries(rules as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !rule.trim()) continue;
      const name = `${group}.${field}`;
      try {
        compiled.set(name, parseFieldRule(rule, { orEnabled, xpathEnabled }));
      } catch {
        compiled.set(name, { skipped: 'unsupported' });
      }
    }
  }
  cache.set(key, compiled);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return compiled;
}
