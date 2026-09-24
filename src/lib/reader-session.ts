import type { ReaderChapter, ReaderIndex, ReaderOrigin, ReaderPart, ReadingSession } from './reader-types';
import type { ReadingPosition } from './reader-preferences';
import { matchSourceChapter } from './source-parser';

export function bookReadingHref(book: { taskId?: number | null; title: string; author: string; from: ReaderOrigin }): string {
  if (book.taskId && Number.isSafeInteger(book.taskId) && book.taskId > 0) return `/read/${book.taskId}?from=${book.from}`;
  return '/read/source?' + new URLSearchParams({ title: book.title, author: book.author, from: book.from });
}

export function readingSessionKey(session: ReadingSession): string {
  return session.kind === 'download' ? 'download:' + session.taskId : JSON.stringify(['source', session.title, session.author]);
}

export function readerIndexUrl(session: ReadingSession): string {
  if (session.kind === 'download') return `/api/read/${session.taskId}/index`;
  const query = new URLSearchParams({ title: session.title, author: session.author });
  // 模糊候选点选后的确认重放：book_url 告诉服务端这是用户已确认的详情页。
  if (session.bookUrl) query.set('book_url', session.bookUrl);
  return '/api/read/source/index?' + query;
}

export function readerChapterUrl(index: ReaderIndex, position: ReadingPosition): string {
  const query = new URLSearchParams({ chapter: String(position.chapterIndex), part: String(position.partIndex), version: index.version });
  if (index.source) query.set('session', index.source.session);
  return `/api/read/${index.source ? 'source' : index.taskId}/chapter?${query}`;
}

/**
 * 章内换源后的目录身份(洞 2 的前端半边):服务端在 part 上带出新源的目录会话版本时,
 * 以**服务端为权威**构造新 index —— 版本/sourceId/会话全部换新源,后续章节直接用新源。
 * 无变化(未换源 / 下载类)时原样返回,既有路径逐点不变。
 *
 * H7:服务端同时附带新源目录(switchedChapters)与本章在新目录里的序号(switchedChapterIndex)时,
 * 用新目录**替换**旧 chapters —— 否则新旧目录序号错位(备用站多一个「序言」)时,
 * 前端按「旧序号 +1」请求新 session 会静默交付错章或重复章。
 * 旧响应形状(不带新目录)时 chapters 原样保留,退回既有行为(纵深防御见 readerPartMatches)。
 */
export function switchedReaderIndex(index: ReaderIndex, part: ReaderPart): ReaderIndex {
  if (!index.source || !part.sourceSession || part.sourceSession === index.source.session) return index;
  const chapters = catalogOf(part);
  return {
    ...index,
    version: part.version,
    source: { ...index.source, session: part.sourceSession, ...(part.sourceId ? { id: part.sourceId } : {}) },
    ...(chapters ? { chapters } : {}),
  };
}

/**
 * H7:目录被替换(switchedReaderIndex 采纳了新目录)时,交付段仍按**请求时的旧目录序号**标记
 * (服务端 readSourceChapter 原样回带请求的 chapterIndex)。把它改记为服务端给的新目录序号
 * (switchedChapterIndex),让阅读窗口与新目录同一套序号 —— activePart、下一章、续读、预取、
 * 进度都从段序号算,留着旧序号就会在新目录里落到错章或重复章。目录未替换时原样返回。
 *
 * U4a:序号改记的同时,把标题也改记为**新目录 at 章标题**。交付段此刻的 title 仍是旧目录标题
 * (服务端 readSourceChapter 在换源前从请求所用的旧目录取 chapter.title),而序号已属新目录 ——
 * 标题与序号分属两套目录,后续任何以「本段(标题, 序号)」对新目录做的比对都可能自相矛盾
 * (服务端对齐到 A、前端按新序号破平却选 B)。改记后 (标题, 序号) 同属新目录,跨目录比对自洽;
 * 顺带让正文首行(新源章名,等于 at 章标题)能被 bodyText 正确剥掉,不再重复显示章名。
 */
export function switchedReaderPart(index: ReaderIndex, adopted: ReaderIndex, part: ReaderPart): ReaderPart {
  if (adopted.chapters === index.chapters || typeof part.switchedChapterIndex !== 'number') return part;
  const at = part.switchedChapterIndex;
  const title = adopted.chapters[at]?.title;
  return { ...part, chapterIndex: at, ...(title ? { title } : {}) };
}

/**
 * 换源响应附带的新目录(只在形状完整且自洽时采纳):
 * 章节列表非空、每章字段齐全、序号从 0 连续、且本次交付章的新序号落在目录内。
 * 任一条件不满足 ⇒ 返回 null(调用方保留旧目录,退回既有行为,不采纳半份数据)。
 */
function catalogOf(part: ReaderPart): ReaderChapter[] | null {
  const chapters = part.switchedChapters;
  const at = part.switchedChapterIndex;
  if (!chapters || !chapters.length) return null;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at >= chapters.length) return null;
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter || chapter.index !== i || typeof chapter.title !== 'string'
      || !Number.isSafeInteger(chapter.partCount) || chapter.partCount < 1) return null;
  }
  return chapters;
}

export function readerPartMatches(index: ReaderIndex, part: ReaderPart, position: ReadingPosition): boolean {
  // 唯一的合法例外:章内换源(sourceSession===part.version 由服务端对备用源标注)。
  // 无此标记而来源/版本不符仍判「内容与目录不一致」(既有语义不变)。
  const switched = !!index.source && !!part.sourceSession && part.sourceSession === part.version;
  const ownership = index.source
    ? part.taskId === null && (part.sourceId === index.source.id || switched)
    : part.taskId === index.taskId && !part.sourceId;
  // H7 纵深防御:换源状态下额外比对标题。调用与服务端 attach **逐字同款**的
  // matchSourceChapter(目录, 交付章标题, 序号)——参数顺序必须一致:chapterTier 的包含档
  // 对参数顺序不对称(归一化键恰 4 字时下限不同),顺序相反会让服务端判匹配的章在前端判不符 → 409
  // (复审小修 A2)。放行同章写法漂移,拒绝真正不同的章(「序言」对「第一章」)。
  // 新目录已被采纳时序号即新目录序号,标题天然同章,此比对不改变结果。
  // 命中的必须**正是交付序号那一章**(序号兼作重名章的同分破平):只判「目录里有同名章」会放过
  // 重复章 —— 旧目录 [第一章, 第二章] 在序号 1 交付「第一章」(H7 第四轮)。
  const titleOk = !switched || matchSourceChapter(
    index.chapters.map((chapter) => ({ url: '', title: chapter.title })), part.title, part.chapterIndex,
  ) === part.chapterIndex;
  return ownership && titleOk && (part.version === index.version || switched)
    && part.chapterIndex === position.chapterIndex
    && part.partIndex === position.partIndex && typeof part.text === 'string';
}
