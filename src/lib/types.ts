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
}

// 重排后的最终推荐
export interface RerankedItem {
  title: string;
  author: string;
  category: string;
  wordCount: string; // 召回模型描述，待核验
  douban?: DoubanInfo;
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
