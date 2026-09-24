/** TXT byte ranges are UTF-8, with an exclusive end. Online directory sizes are unknown (0). */
export type ReadingSession = { kind: 'download'; taskId: number }
  | { kind: 'source'; title: string; author: string; bookUrl?: string; sourceUrl?: string };

export type ReaderOrigin = 'library' | 'shelf' | 'find';

export interface ReaderSource {
  id: string;
  name: string;
  url: string;
  session: string;
}

export interface ReaderChapter {
  index: number;
  title: string;
  startByte: number;
  endByte: number;
  partCount: number;
}

export interface ReaderIndex {
  taskId: number | null;
  source?: ReaderSource;
  title: string;
  author: string;
  version: string;
  totalBytes: number;
  chapters: ReaderChapter[];
}

export interface ReaderPart {
  taskId: number | null;
  sourceId?: string;
  servedFrom?: string;
  /**
   * 目录会话版本(catalog.version)。**只在章内换源成功时出现**:服务端已把备用源目录
   * 固化(catalog 落库)并把本次正文换成新源,前端据此把阅读目录切成新源(洞 2)。
   */
  sourceSession?: string;
  /**
   * 换源响应附带的新源目录(形状与 index 资源的 ReaderIndex.chapters 完全一致)。
   * **只在章内换源成功时出现**:前端据此一次性替换旧目录并迁移阅读位置(H7),
   * 避免「旧序号 +1 打新目录」在新旧目录序号错位时静默交付错章或重复章。
   * 旧响应形状(未换源 / 未升级的服务端)不带此字段,前端退回既有行为。
   */
  switchedChapters?: ReaderChapter[];
  /**
   * 本次交付的这一章在**新目录**里的序号(switchedChapters 的下标)。
   * 与 switchedChapters 成对出现;前端把当前位置迁到这个序号。
   */
  switchedChapterIndex?: number;
  version: string;
  chapterIndex: number;
  partIndex: number;
  partCount: number;
  title: string;
  startByte: number;
  endByte: number;
  text: string;
}
