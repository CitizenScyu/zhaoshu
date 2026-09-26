// 重排接地（41-rerankgnd）：候选命中书库（labeled_books）时，把打标产物压缩成短证据喂给
// 重排模型；画像硬雷点与标签能确定性对上时，在重排前直接否决。
//
// 与 F14（书源补验压缩进重排，见 find/route.ts compactSourceEvidence）同一模式：
// 只带短字段、有证据才出现字段、证明力边界写进 rerankSystem。
//
// 身份口径复用 find/exact：JS 侧用 book-identity 的归一函数算键，SQL 侧按生成列
// title_key/author_key 等值匹配（唯一索引 labeled_books_identity_idx）。不做「只按书名」兜底：
// 同名书会把别人的雷点安到这本头上。
import type { PersonalQuery } from './personal-write';
import { canonicalBookKey, normalizeBookAuthor, normalizeBookTitle } from './book-identity';
import type { Candidate } from './types';

const NUL = String.fromCharCode(0);

// 与 canonicalBookKey 同形（NUL 分隔）。库里的 title_key/author_key 已是归一结果，不能再过一遍
// canonicalBookKey（剥《》不幂等，见 book-identity.ts），所以行侧直接拼。
function rowKey(titleKey: string, authorKey: string): string {
  return `${titleKey}${NUL}${authorKey}`;
}

/** 默认开；只有显式 `0`/`false`/`off` 关闭。关闭时 rerank 不查库、提示词与接入前逐字节一致。 */
export function libraryGroundingEnabled(): boolean {
  const raw = process.env.RERANK_LIBRARY_GROUNDING?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/** 查询只选重排要用的列：labels 整个 jsonb 里还有 protagonist/worldbuilding/证据片段等，不取。 */
export interface LibraryLabelRow {
  title_key: string;
  author_key: string;
  weaknesses: unknown;
  strengths: unknown;
  tone: string | null;
  pace: string | null;
  sub_tags: unknown;
  quality: number | null;
}

/**
 * 一次往返查完整批候选（≤ MAX_CANDIDATES）。键在 JS 侧算好再 unnest，服务端只做索引等值 JOIN；
 * 候选按键去重，避免同一本书在参数里出现两次。
 */
export function libraryLabelsForCandidatesQuery(sql: PersonalQuery, candidates: Pick<Candidate, 'title' | 'author'>[]) {
  const seen = new Set<string>();
  const titles: string[] = [];
  const authors: string[] = [];
  for (const { title, author } of candidates) {
    const t = normalizeBookTitle(title);
    const a = normalizeBookAuthor(author);
    const key = rowKey(t, a);
    if (!t || seen.has(key)) continue;
    seen.add(key);
    titles.push(t);
    authors.push(a);
  }
  return sql`SELECT lb.title_key, lb.author_key,
      lb.labels->'weaknesses' AS weaknesses, lb.labels->'strengths' AS strengths,
      lb.labels->>'tone' AS tone, lb.labels->>'pace' AS pace, lb.sub_tags, lb.quality
    FROM unnest(${titles}::text[], ${authors}::text[]) AS c(title_key, author_key)
    JOIN labeled_books lb ON lb.title_key = c.title_key AND lb.author_key = c.author_key`;
}

/* ---------- 压缩证据 ---------- */

/** 进重排提示词的书库证据。字段名与打标 SYSTEM_PROMPT（scripts/labeler.py）一致，便于模型对齐语义。 */
export interface LibraryEvidence {
  quality?: number;
  weaknesses?: string[];
  tone?: string;
  pace?: string;
  strengths?: string[];
}

// 上限（全部按 JSON.stringify 后的字符数计）：临时库实测 weaknesses 平均 70 字/最长 221、
// strengths 平均 96/最长 291、tone 15、pace 12/最长 52（报告 §1）。单条 28 字能保住一条
// 雷点的主干（「后宫倾向明显，主角…」）。单本 200：临时库 507 本实测压缩后中位 181、p90 196；
// 整批 2400 = 12 本 × 200，满批正常全带，只在候选数上调或单本上限被改大时才起作用。
export const LIBRARY_ITEM_MAX_CHARS = 28;
export const LIBRARY_WEAKNESSES_MAX = 3;
export const LIBRARY_STRENGTHS_MAX = 2;
export const LIBRARY_BOOK_MAX_CHARS = 200;
export const LIBRARY_BATCH_MAX_CHARS = 2400;

// 按码点截断，不切开代理对。
function clip(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// 进提示词前的轻量净化：去掉换行/控制字符、折叠连续空白。标签文本是书库数据、不是指令，
// 这里只做格式清理（防换行伪造提示词结构），语义边界另由 rerankSystem 第 13 条声明。
function sanitizeEvidenceText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 存量里 labels.weaknesses/strengths 既有数组也有整段字符串（临时库 22/461 行是字符串）。
function textList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function size(evidence: LibraryEvidence): number {
  return JSON.stringify(evidence).length;
}

/**
 * 按优先级逐项加入，任何一步会让单本超限就跳过该项：quality → weaknesses → tone → pace → strengths。
 * weaknesses 排在 strengths 前：产品理念是「雷点比萌点更能定义一个人」，截断时先丢萌点。
 * 什么都没有时返回 null（字段不出现，与 F14「无证据不出字段」一致）。
 */
export function compactLibraryEvidence(row: LibraryLabelRow): LibraryEvidence | null {
  const evidence: LibraryEvidence = {};
  const tryAdd = (apply: () => void, undo: () => void) => {
    apply();
    if (size(evidence) > LIBRARY_BOOK_MAX_CHARS) undo();
  };
  if (typeof row.quality === 'number' && Number.isFinite(row.quality)) {
    evidence.quality = Math.round(row.quality * 10) / 10;
  }
  const pushItems = (field: 'weaknesses' | 'strengths', items: string[], max: number) => {
    for (const item of items.slice(0, max)) {
      const text = clip(sanitizeEvidenceText(item), LIBRARY_ITEM_MAX_CHARS);
      tryAdd(
        () => { (evidence[field] ??= []).push(text); },
        () => { evidence[field]!.pop(); if (evidence[field]!.length === 0) delete evidence[field]; },
      );
    }
  };
  pushItems('weaknesses', textList(row.weaknesses), LIBRARY_WEAKNESSES_MAX);
  for (const field of ['tone', 'pace'] as const) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) {
      tryAdd(() => { evidence[field] = clip(sanitizeEvidenceText(value), LIBRARY_ITEM_MAX_CHARS); }, () => { delete evidence[field]; });
    }
  }
  pushItems('strengths', textList(row.strengths), LIBRARY_STRENGTHS_MAX);
  return Object.keys(evidence).length > 0 ? evidence : null;
}

/* ---------- 确定性否决 ---------- */

// 同义词组：只收「书有这个元素」主体无歧义的。降智/圣母/注水/黑暗这类，标签写的可能是
// 反派降智、配角圣母、略显注水，与用户厌恶的对象或程度对不上——交给模型判断，不做确定性。
const VETO_GROUPS: { label: string; terms: string[] }[] = [
  { label: '后宫', terms: ['后宫', '多女主', '种马'] },
  { label: '绿帽', terms: ['绿帽', 'ntr'] },
  { label: '耽美', terms: ['耽美'] },
  { label: '百合', terms: ['百合'] },
];

// 画像行里出现这些限定词，说明不是无条件的一票否决（「少量后宫可以接受」），整行交给模型。
const PROFILE_QUALIFIER = /不介意|可接受|能接受|可以接受|不排斥|不反感|除非|除外|例外|也行|都行|无所谓|少量|轻度|适度/;

// 标签侧的否定 / 弱化 / 限定标记（结构性判据，不再靠固定窗口）：命中词所在子句里只要出现任一标记，
// 就不把这个子句算命中，整条交给模型判断。这样「没有任何后宫元素」「不含任何后宫情节」「反后宫」
// 「接受度因人而异」都能被识别为非硬命中，而不是靠逐种写法打补丁。
// 宁可漏否决，不可误否决：单字标记（如「别」也命中「特别」、「弱」也命中「薄弱」、「反」也命中「反复」）
// 会顺带放过一些真雷点，这是刻意选的安全方向——误杀（把好书硬删且不可见）代价远大于漏杀（退回模型判断）。
const LABEL_SUPPRESS =
  /[无没非不未零拒避反免别少缺略稍淡弱]|偶尔|轻微|克制|有限|接受度|因人而异|视人|看人|可接受|可选|部分|疑似|争议/;

// 子句切分：中英文句读与换行。子句是否定作用域的近似——把否定/弱化限制在同一子句内，
// 「前期无后宫，中期后宫扩张过快」的后半句仍能命中。
const CLAUSE_SEP = /[。！？；，、,;!?\r\n]+/;

const HEADING = /^\s*#{1,6}\s*(.*)$/;

/** 画像 Markdown 里「雷点」一节命中的同义词组（去重）。画像没有这一节就返回空。 */
export function profileHardDislikes(profile: string): string[] {
  const hits = new Set<string>();
  let inSection = false;
  for (const line of profile.split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      // 「雷点」是标准写法；「排雷」「不看」是常见变体。多认几种节标题只会多否决候选（安全方向），
      // 含「萌点」的节一律不认（保守）。
      const title = heading[1];
      inSection = (title.includes('雷点') || title.includes('排雷') || title.includes('不看')) && !title.includes('萌点');
      continue;
    }
    if (!inSection || PROFILE_QUALIFIER.test(line)) continue;
    // 括号里多是「证据：弃《某书》」，书名里的字不代表用户的雷点。
    const body = line.replace(/（[^）]*）|\([^)]*\)|《[^》]*》/g, '').toLowerCase();
    for (const group of VETO_GROUPS) {
      if (group.terms.some((term) => body.includes(term))) hits.add(group.label);
    }
  }
  return [...hits];
}

// 文本里第一个「干净」命中的子句：子句含命中词、且整个子句不含任何否定/弱化/限定标记。
// 返回该子句原文（供理由片段），没有返回 null。按子句判断而非固定窗口，才能覆盖
// 「没有任何后宫」「不含任何后宫情节」这类否定词与命中词隔多字的写法。
function cleanClause(text: string, term: string): string | null {
  const clauses = text.split(CLAUSE_SEP);
  const lowerClauses = text.toLowerCase().split(CLAUSE_SEP); // 与原文等长切分，索引对齐
  for (let i = 0; i < lowerClauses.length; i += 1) {
    const clause = lowerClauses[i];
    if (!clause.includes(term)) continue;
    if (LABEL_SUPPRESS.test(clause)) continue;
    return clauses[i].trim();
  }
  return null;
}

export interface LibraryVeto {
  dislike: string;
  reason: string;
}

/** 画像雷点 × 书库标签（weaknesses / sub_tags）。拿不准一律返回 null，由模型判断。 */
export function libraryVeto(dislikes: string[], row: LibraryLabelRow): LibraryVeto | null {
  if (dislikes.length === 0) return null;
  const weaknesses = textList(row.weaknesses);
  const tags = Array.isArray(row.sub_tags) ? row.sub_tags.filter((tag): tag is string => typeof tag === 'string') : [];
  for (const group of VETO_GROUPS) {
    if (!dislikes.includes(group.label)) continue;
    for (const term of group.terms) {
      for (const text of weaknesses) {
        const clause = cleanClause(text, term);
        if (clause) {
          return { dislike: group.label, reason: `书库标签的雷点风险写着「${clip(clause, LIBRARY_ITEM_MAX_CHARS)}」，命中你画像里的雷点「${group.label}」` };
        }
      }
      // sub_tags 是短标签，整值判断：标签里含任一否定/弱化标记（「反后宫」「非后宫」）就不参与否决。
      const tag = tags.find((text) => {
        const lower = text.toLowerCase();
        return lower.includes(term) && !LABEL_SUPPRESS.test(lower);
      });
      if (tag) {
        return { dislike: group.label, reason: `书库题材标签「${clip(tag, LIBRARY_ITEM_MAX_CHARS)}」命中你画像里的雷点「${group.label}」` };
      }
    }
  }
  return null;
}

/* ---------- 整批规划 ---------- */

export interface VetoedCandidate {
  title: string;
  author: string;
  reason: string;
}

export interface LibraryGroundingPlan {
  /** 键 = canonicalBookKey(title, author)，与 route 的 bookKey 同源。 */
  evidence: Map<string, LibraryEvidence>;
  vetoed: VetoedCandidate[];
  vetoedKeys: Set<string>;
}

/**
 * 候选按输入顺序处理：先判否决（被否决的不带证据、不占整批额度），再按整批上限挂证据；
 * 某本超出剩余额度就不带，后面更短的仍可带上。
 */
export function planLibraryGrounding(
  candidates: Pick<Candidate, 'title' | 'author'>[],
  rows: LibraryLabelRow[],
  profile: string,
): LibraryGroundingPlan {
  const byKey = new Map(rows.map((row) => [rowKey(row.title_key, row.author_key), row]));
  const dislikes = profileHardDislikes(profile);
  const plan: LibraryGroundingPlan = { evidence: new Map(), vetoed: [], vetoedKeys: new Set() };
  let budget = LIBRARY_BATCH_MAX_CHARS;
  for (const { title, author } of candidates) {
    const key = canonicalBookKey(title, author);
    const row = byKey.get(key);
    if (!row || plan.vetoedKeys.has(key) || plan.evidence.has(key)) continue;
    const veto = libraryVeto(dislikes, row);
    if (veto) {
      plan.vetoedKeys.add(key);
      plan.vetoed.push({ title, author, reason: veto.reason });
      continue;
    }
    const evidence = compactLibraryEvidence(row);
    if (!evidence) continue;
    const cost = size(evidence);
    if (cost > budget) continue;
    budget -= cost;
    plan.evidence.set(key, evidence);
  }
  return plan;
}
