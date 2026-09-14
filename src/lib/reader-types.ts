/** Public reader API shapes. Byte ranges are UTF-8, with an exclusive end. */
export interface ReaderChapter {
  index: number;
  title: string;
  startByte: number;
  endByte: number;
  partCount: number;
}

export interface ReaderIndex {
  taskId: number;
  title: string;
  author: string;
  version: string;
  totalBytes: number;
  chapters: ReaderChapter[];
}

export interface ReaderPart {
  taskId: number;
  version: string;
  chapterIndex: number;
  partIndex: number;
  partCount: number;
  title: string;
  startByte: number;
  endByte: number;
  text: string;
}
