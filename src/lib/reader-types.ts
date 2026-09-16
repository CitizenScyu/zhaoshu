/** TXT byte ranges are UTF-8, with an exclusive end. Online directory sizes are unknown (0). */
export type ReadingSession = { kind: 'download'; taskId: number }
  | { kind: 'source'; title: string; author: string };

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
  version: string;
  chapterIndex: number;
  partIndex: number;
  partCount: number;
  title: string;
  startByte: number;
  endByte: number;
  text: string;
}
