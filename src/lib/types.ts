// 口味画像的种子输入
export interface SeedBook {
  title: string;
  author?: string;
  kind: 'love' | 'drop'; // 最爱 | 弃书
  reason?: string; // 为什么爱 / 为什么弃
}

// LLM 召回的候选书
export interface Candidate {
  title: string;
  author: string;
  category: string; // 题材/流派标签
  wordCount: string; // 字数规模，如 "约300万字，完结"
  why: string; // 推荐理由
  source: 'llm'; // 召回来源
}

// 豆瓣验证结果
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
  wordCount: string;
  douban?: DoubanInfo;
  matchScore: number; // 0-100
  hitLikes: string[]; // 命中的萌点
  risks: string; // 风险/雷点提示
  reason: string; // 一句话"对你值不值得开"
  why: string; // 召回理由（保留溯源）
  hallucinationRisk?: boolean;
}

// 书架状态
export type ShelfStatus = 'new' | 'want' | 'reading' | 'done' | 'dropped';

export type FeedbackStatus = Exclude<ShelfStatus, 'new'>;
