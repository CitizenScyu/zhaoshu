// 口味画像的种子输入
export interface SeedBook {
  title: string;
  author?: string;
  kind: 'love' | 'drop'; // 最爱 | 弃书
  reason?: string; // 为什么爱 / 为什么弃
}

// updatedAt 是数据库返回的原始版本字符串，不能经 Date 转换而丢失微秒精度。
export interface ProfileSnapshot {
  seeds: SeedBook[];
  content: string;
  updatedAt: string;
}

// 只对当前一次找书生效，不写入长期口味画像。
export interface FindConditions {
  text: string;
}

// F12：找书需求的保留契约。显式声明「只影响本次」还是「记入长期」，不再以 conditions
// 是否为空来推断。session 不写搜索历史、推荐记录的 query 字段不落原文；longterm 两者都写。
// 两条路径都**不**写画像（找书本身从不改画像）。
export type FindRetention = 'session' | 'longterm';

// LLM 召回的候选书
export interface Candidate {
  title: string;
  author: string;
  category: string; // 题材/流派标签
  wordCount: string; // 召回模型提供的字数/状态描述，待核验
  why: string; // 召回模型给出的推荐理由
  source: 'llm'; // 召回来源
}

// 豆瓣外部验证证据
export interface DoubanInfo {
  status: 'verified' | 'not_found' | 'unavailable';
  found: boolean;
  doubanId?: string;
  rating?: number | null;
  ratingCount?: number | null;
  url?: string;
  note?: string; // 未找到/被拦等说明
}

export interface VerifiedCandidate extends Candidate {
  douban: DoubanInfo;
  sourceEvidence?: SourceEvidence;
}

// 书源补验结果的分档码：让「源站没有这本」和「源站本轮挂了」在数据层可区分。
// status 仍是三值并集（前端与清洗白名单按它分支），code 只做更细的失败归因。
export type SourceEvidenceCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_AMBIGUOUS'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_BUDGET_EXCEEDED'
  | 'SOURCE_VERIFY_TIMEOUT'
  | 'SOURCE_VERIFY_ERROR'
  | 'SOURCE_VERIFY_SKIPPED';

// A matching source directory establishes identity/existence, not rating or completeness.
export interface SourceEvidence {
  status: 'matched' | 'not_found' | 'unavailable';
  code?: SourceEvidenceCode;
  sourceName?: string;
  url?: string;
  checkedAt?: string;
  note: string;
}

// 重排后的最终推荐
export interface RerankedItem {
  title: string;
  author: string;
  category: string;
  wordCount: string; // 召回模型描述，待核验
  douban?: DoubanInfo;
  sourceEvidence?: SourceEvidence;
  matchScore: number; // 0-100 的模型个人匹配排序分，不是喜欢概率
  hitLikes: string[]; // 模型判断的萌点命中
  risks: string; // 模型推断的风险/雷点提示，待核验
  reason: string; // 模型给出的一句话结论
  why: string; // 召回模型理由（保留溯源）
  hallucinationRisk?: boolean;
}

// 书架状态
export type ShelfStatus = 'new' | 'want' | 'reading' | 'done' | 'dropped';

export type FeedbackStatus = Exclude<ShelfStatus, 'new'>;
