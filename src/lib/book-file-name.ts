// Keep in sync with zhaoshu-books/book-file-name.mjs; verify with test:contracts.
export function sanitizeBookFilename(value: string): string {
  const name = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '�')
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-\s]+$/, '');
  let short = name.slice(0, 80);
  if (/[\ud800-\udbff]$/.test(short)) short = short.slice(0, -1);
  return short.replace(/[-\s]+$/, '');
}

export function normalizeBookIdentity(title: string, author: string): { title: string; author: string } {
  return { title: String(title ?? '').trim() || '未命名', author: String(author ?? '').trim() || '佚名' };
}

export function bookFilename(title: string, author: string): string {
  const identity = normalizeBookIdentity(title, author);
  return `${sanitizeBookFilename(`${identity.title}-${identity.author}`)}.txt`;
}

/** Canonical worker name first, then exact legacy names; never invent another author. */
export function bookFilenameCandidates(title: string, author: string): string[] {
  const identity = normalizeBookIdentity(title, author);
  return [...new Set([
    bookFilename(title, author),
    `${sanitizeBookFilename(`${title}-${author}`)}.txt`,
    ...(identity.author === '佚名' ? [`${sanitizeBookFilename(identity.title)}.txt`] : []),
  ])];
}

export function findBookFilename(names: string[], title: string, author: string): string | null {
  for (const exact of bookFilenameCandidates(title, author)) {
    if (names.includes(exact)) return exact;
  }
  const prefix = sanitizeBookFilename(normalizeBookIdentity(title, author).title);
  if (!prefix) return null;
  const matches = names.filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.txt'));
  return matches.length === 1 ? matches[0] : null;
}
