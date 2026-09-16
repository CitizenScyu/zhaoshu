import type { SeedBook } from './types';
import { bookKey } from './sanitize';

/** Count duplicates too; replacing one author with another is a removal + addition. */
export function removedSeedBooks(previous: SeedBook[], next: SeedBook[]): SeedBook[] {
  const remaining = new Map<string, number>();
  for (const seed of next) {
    if (!seed.title.trim()) continue;
    const key = bookKey(seed.title, seed.author ?? '');
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return previous.filter((seed) => {
    const key = bookKey(seed.title, seed.author ?? '');
    const count = remaining.get(key) ?? 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

export function seedRemovalMessage(previous: SeedBook[], next: SeedBook[]): string {
  const removed = removedSeedBooks(previous, next);
  return `种子书单将从 ${previous.length} 本变为 ${next.length} 本。以下 ${removed.length} 本将被移除：\n\n`
    + removed.map((seed) => `《${seed.title}》${seed.author ? ' · ' + seed.author : ''}`).join('\n')
    + '\n\n确认保存这次改动？';
}
