import type { ReaderChapter, ReaderPart } from './reader-types';
import type { SourceCatalog } from './source-reader';
import { matchSourceChapter } from './source-parser';

/**
 * H7:章内换源成功时,把新源目录附进同一个响应。
 *
 * 目录**只从库里读**(source_read_catalogs,换源成功时已由 saveSourceCatalog 固化),
 * 零上游请求;章节列表复用 sourceReaderIndex 的同一序列化口径
 * ({ index, title, startByte: 0, endByte: 0, partCount: 1 }),不把上游 URL 等
 * index 资源不暴露的字段带出去。本次交付的这一章在新目录里的序号一并给出,
 * 前端据此一次性替换旧目录并迁移阅读位置。
 *
 * 目录读不到(过期/缺失),或本章在新目录里按服务端同款分档判据(matchSourceChapter)
 * 对不上时,原样返回 part —— 退回旧响应形状,前端走既有行为 + 标题防线,绝不附一份对不上的目录。
 */
export async function attachSwitchedCatalog(
  part: ReaderPart,
  loadCatalog: (session: string) => Promise<SourceCatalog | null>,
): Promise<ReaderPart> {
  if (!part.sourceSession) return part;
  const catalog = await loadCatalog(part.sourceSession);
  if (!catalog) return part;
  // 与服务端换源对齐(source-reader.ts 的 matchSourceChapter 调用)逐参数同型:
  // 旧标题对新目录、旧序号作同分破平。严格标题相等会在章名漂移时静默不附目录(复审必修 A)。
  const at = matchSourceChapter(catalog.chapters, part.title, part.chapterIndex);
  if (at === null) return part;
  const chapters: ReaderChapter[] = catalog.chapters.map((chapter, index) => ({
    index, title: chapter.title, startByte: 0, endByte: 0, partCount: 1,
  }));
  return { ...part, switchedChapters: chapters, switchedChapterIndex: at };
}
