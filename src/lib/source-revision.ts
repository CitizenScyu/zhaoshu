// 源 identity 版本口径的唯一实现（M1 任务 4，收口 M1 任务 3 复审 P1-1）。
//
// source-reader.ts 的目录版本 sourceRevision 与 source_admission.rules_hash 必须走**同一函数**
// （m2-scaleout-design §5.2 第 2 条 / §9 M2-3 验收 5）。两套判据一旦漂移，会出现「准入说规则变了、
// 目录说没变」（或反之）：用户拿到陈旧目录或无故 409，且只在线上规则刷新后才暴露。
//
// 实现逐字节取自 source-reader.ts 原 `revision(source)`：
//   sha1(JSON.stringify([source.url, source.searchUrl, source.rules]))
// **禁止**改成键排序序列化——那会改变全部在线书的目录版本、把读者进度打回第一章。
import { createHash } from 'node:crypto';

export interface SourceRevisionInput {
  url: string;
  /**
   * 源搜索模板原文。类型放宽为 unknown 以逐字节复用 reader 的既有入参
   * （ReadingSource.searchUrl: unknown）；序列化结果不受类型标注影响。
   */
  searchUrl: unknown;
  /** 源规则原文（shuyuan_sources.source 原对象；不裁剪、不重排，m2-scaleout §5.2 第 1 条）。 */
  rules: unknown;
}

/** sha1([url, searchUrl, rules]) —— 引擎阅读路径与准入共用，不得分叉。 */
export function sourceRevision(source: SourceRevisionInput): string {
  return createHash('sha1').update(JSON.stringify([source.url, source.searchUrl, source.rules])).digest('hex');
}
