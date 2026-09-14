// Keep in sync with the download worker's sanitizeFilename.
export function sanitizeBookFilename(value: string): string {
  const name = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-\s]+$/, '');
  return name.length > 80 ? name.slice(0, 80).replace(/[-\s]+$/, '') : name;
}

export function bookFilename(title: string, author: string): string {
  return `${sanitizeBookFilename(`${title}-${author}`)}.txt`;
}

export function findBookFilename(names: string[], title: string, author: string): string | null {
  const exact = bookFilename(title, author);
  if (names.includes(exact)) return exact;
  const prefix = sanitizeBookFilename(title);
  if (!prefix) return null;
  const matches = names.filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.txt'));
  return matches.length === 1 ? matches[0] : null;
}
